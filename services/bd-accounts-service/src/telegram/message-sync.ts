// @ts-nocheck — GramJS types are incomplete
import { Api } from 'telegram';
import { randomUUID } from 'crypto';
import {
  EventType,
  type BDAccountSyncStartedEvent,
  type BDAccountSyncProgressEvent,
  type BDAccountSyncCompletedEvent,
} from '@getsale/events';
import { MessageChannel, MessageDirection, MessageStatus } from '@getsale/types';
import { serializeMessage, getMessageText } from '../telegram-serialize';
import type { TelegramManagerDeps, TelegramClientInfo, StructuredLog } from './types';
import { telegramInvokeWithFloodRetry } from './telegram-invoke-flood';
import type { ContactManager } from './contact-manager';
import type { MessageDb } from './message-db';
import type { Pool } from 'pg';
import type { RabbitMQClient, RedisClient } from '@getsale/utils';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class MessageSync {
  private readonly pool: Pool;
  private readonly rabbitmq: RabbitMQClient;
  private readonly redis: RedisClient | null;
  private readonly log: StructuredLog;
  private readonly clients: Map<string, TelegramClientInfo>;

  private contactManager!: ContactManager;
  private messageDb!: MessageDb;

  private readonly SYNC_DELAY_MS = 1100;
  private readonly SYNC_INITIAL_MESSAGES_PER_CHAT = parseInt(process.env.SYNC_INITIAL_MESSAGES_PER_CHAT || '100', 10) || 100;
  /** Legacy: depth in days for syncHistoryForChat / other paths; initial sync uses SYNC_INITIAL_MESSAGES_PER_CHAT only. */
  private readonly SYNC_MESSAGES_MAX_AGE_DAYS = parseInt(process.env.SYNC_MESSAGES_MAX_AGE_DAYS || '365', 10) || 365;
  /** Safety cap: max messages per chat when loading older on demand (load-older-history). */
  private readonly SYNC_MESSAGES_PER_CHAT_CAP = parseInt(process.env.SYNC_MESSAGES_PER_CHAT_CAP || '50000', 10) || 50000;

  constructor(private readonly deps: TelegramManagerDeps) {
    this.pool = deps.pool;
    this.rabbitmq = deps.rabbitmq;
    this.redis = deps.redis;
    this.log = deps.log;
    this.clients = deps.clients;
  }

  setContactManager(cm: ContactManager): void {
    this.contactManager = cm;
  }

  setMessageDb(mdb: MessageDb): void {
    this.messageDb = mdb;
  }

  /**
   * Run initial history sync for selected chats: one page of messages per chat (SYNC_INITIAL_MESSAGES_PER_CHAT).
   * Older history loads on demand when user scrolls up (load-older-history).
   */
  async syncHistory(
    accountId: string,
    organizationId: string,
    onProgress?: (done: number, total: number, currentChatId?: string, currentChatTitle?: string) => void
  ): Promise<{ totalChats: number; totalMessages: number }> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }

    const client = clientInfo.client;
    const accRow = await this.pool.query<{ created_by_user_id: string | null }>(
      'SELECT created_by_user_id FROM bd_accounts WHERE id = $1',
      [accountId]
    );
    const createdByUserId = accRow.rows[0]?.created_by_user_id ?? null;

    const rows = await this.pool.query(
      'SELECT telegram_chat_id, title, peer_type FROM bd_account_sync_chats WHERE bd_account_id = $1 ORDER BY created_at',
      [accountId]
    );
    const chats = rows.rows as { telegram_chat_id: string; title: string; peer_type?: string }[];
    const totalChats = chats.length;
    if (totalChats === 0) {
      return { totalChats: 0, totalMessages: 0 };
    }

    await this.pool.query(
      `UPDATE bd_accounts SET sync_status = $1, sync_error = NULL, sync_progress_total = $2, sync_progress_done = 0, sync_started_at = NOW(), sync_completed_at = NULL WHERE id = $3`,
      ['syncing', totalChats, accountId]
    );

    const startedEvent: BDAccountSyncStartedEvent = {
      id: randomUUID(),
      type: EventType.BD_ACCOUNT_SYNC_STARTED,
      timestamp: new Date(),
      organizationId,
      data: { bdAccountId: accountId, totalChats },
    };
    await this.rabbitmq.publishEvent(startedEvent);
    if (this.redis && createdByUserId) {
      this.redis.publish(`events:${createdByUserId}`, JSON.stringify({
        event: 'sync_progress',
        data: { bdAccountId: accountId, done: 0, total: totalChats },
      })).catch(() => {});
    }
    this.log.info({ message: `Sync started for account ${accountId}, ${totalChats} chats` });

    let totalMessages = 0;
    let failedChatsCount = 0;

    for (let i = 0; i < chats.length; i++) {
      const { telegram_chat_id: telegramChatId, title, peer_type: peerType } = chats[i];
      const isUserChat = (peerType || 'user').toLowerCase() === 'user';
      let fetched = 0;
      const chatNum = i + 1;
      this.log.info({ message: `Processing chat ${chatNum}/${totalChats}: ${title} (id=${telegramChatId})` });

      try {
        const peerIdNum = Number(telegramChatId);
        const peerInput = Number.isNaN(peerIdNum) ? telegramChatId : peerIdNum;
        const peer = await client.getInputEntity(peerInput);
        let offsetId = 0;
        const cap = this.SYNC_INITIAL_MESSAGES_PER_CHAT;
        const batchSize = Math.min(100, cap);

        if (isUserChat && Number(telegramChatId) > 0) {
          await this.contactManager.ensureContactEnrichedFromTelegram(organizationId, accountId, telegramChatId);
        }

        while (fetched < cap) {
          try {
            const result = await telegramInvokeWithFloodRetry(this.log, accountId, 'GetHistory(initial-sync)', () =>
              client.invoke(
                new Api.messages.GetHistory({
                  peer,
                  limit: Math.min(batchSize, cap - fetched),
                  offsetId,
                  offsetDate: 0,
                  maxId: 0,
                  minId: 0,
                  addOffset: 0,
                  hash: BigInt(0),
                })
              )
            );

            const rawMessages = (result as any).messages;
            if (!Array.isArray(rawMessages)) break;

            const list: Api.Message[] = rawMessages.filter((m: any) => m && typeof m === 'object' && (m.className === 'Message' || m instanceof Api.Message));
            for (const msg of list) {
              if (fetched >= cap) break;
              const hasText = !!getMessageText(msg).trim();
              if (!hasText && !msg.media) continue;
              let chatId = telegramChatId;
              let senderId = '';
              if (msg.peerId) {
                if (msg.peerId instanceof Api.PeerUser) chatId = String(msg.peerId.userId);
                else if (msg.peerId instanceof Api.PeerChat) chatId = String(msg.peerId.chatId);
                else if (msg.peerId instanceof Api.PeerChannel) chatId = String(msg.peerId.channelId);
              }
              if (msg.fromId instanceof Api.PeerUser) senderId = String(msg.fromId.userId);

              const contactTelegramId = isUserChat ? chatId : (senderId || chatId);
              const contactId = await this.contactManager.ensureContactEnrichedFromTelegram(organizationId, accountId, contactTelegramId);

              const direction = (msg as any).out === true ? MessageDirection.OUTBOUND : MessageDirection.INBOUND;
              const serialized = serializeMessage(msg);
              await this.messageDb.saveMessageToDb({
                organizationId,
                bdAccountId: accountId,
                contactId,
                channel: MessageChannel.TELEGRAM,
                channelId: chatId,
                direction,
                status: MessageStatus.DELIVERED,
                unread: false,
                serialized,
                metadata: { senderId, hasMedia: !!msg.media },
              });
              fetched++;
              totalMessages++;
            }

            if (list.length === 0) break;
            offsetId = Number((list[list.length - 1] as any).id) || 0;
          } catch (err: any) {
            if (err?.seconds != null && typeof err.seconds === 'number') {
              await sleep(err.seconds * 1000);
              continue;
            }
            throw err;
          }
          await sleep(this.SYNC_DELAY_MS);
        }
      } catch (err: any) {
        failedChatsCount++;
        this.log.error({ message: `Sync error for chat ${chatNum}/${totalChats} (${title}, id=${telegramChatId})`, error: err?.message || String(err) });
        const done = i + 1;
        await this.pool.query(
          'UPDATE bd_accounts SET sync_progress_done = $1 WHERE id = $2',
          [done, accountId]
        );
        const progressEvent: BDAccountSyncProgressEvent = {
          id: randomUUID(),
          type: EventType.BD_ACCOUNT_SYNC_PROGRESS,
          timestamp: new Date(),
          organizationId,
          data: { bdAccountId: accountId, done, total: totalChats, currentChatId: telegramChatId, currentChatTitle: title, error: err?.message || String(err) },
        };
        await this.rabbitmq.publishEvent(progressEvent);
        if (this.redis && createdByUserId) {
          this.redis.publish(`events:${createdByUserId}`, JSON.stringify({ event: 'sync_progress', data: progressEvent.data })).catch(() => {});
        }
        onProgress?.(done, totalChats, telegramChatId, title);
        await sleep(this.SYNC_DELAY_MS);
        continue;
      }

      const done = i + 1;
      await this.pool.query(
        'UPDATE bd_accounts SET sync_progress_done = $1 WHERE id = $2',
        [done, accountId]
      );
      const progressEvent: BDAccountSyncProgressEvent = {
        id: randomUUID(),
        type: EventType.BD_ACCOUNT_SYNC_PROGRESS,
        timestamp: new Date(),
        organizationId,
        data: { bdAccountId: accountId, done, total: totalChats, currentChatId: telegramChatId, currentChatTitle: title },
      };
      await this.rabbitmq.publishEvent(progressEvent);
      if (this.redis && createdByUserId) {
        this.redis.publish(`events:${createdByUserId}`, JSON.stringify({ event: 'sync_progress', data: progressEvent.data })).catch(() => {});
      }
      onProgress?.(done, totalChats, telegramChatId, title);
      this.log.info({ message: `Chat ${done}/${totalChats} done: ${title}, messages: ${fetched}` });
      await sleep(this.SYNC_DELAY_MS);
    }

    await this.pool.query(
      `UPDATE bd_accounts SET sync_status = $1, sync_progress_done = $2, sync_completed_at = NOW() WHERE id = $3`,
      ['completed', totalChats, accountId]
    );
    const completedEvent: BDAccountSyncCompletedEvent = {
      id: randomUUID(),
      type: EventType.BD_ACCOUNT_SYNC_COMPLETED,
      timestamp: new Date(),
      organizationId,
      data: { bdAccountId: accountId, totalChats, totalMessages, failedChats: failedChatsCount },
    };
    await this.rabbitmq.publishEvent(completedEvent);
    if (this.redis && createdByUserId) {
      this.redis.publish(`events:${createdByUserId}`, JSON.stringify({ event: 'sync_progress', data: { bdAccountId: accountId, done: totalChats, total: totalChats, completed: true } })).catch(() => {});
    }
    this.log.info({ message: `Sync completed for account ${accountId}: ${totalChats} chats, ${totalMessages} messages, ${failedChatsCount} chats failed` });
    return { totalChats, totalMessages };
  }

  /**
   * Sync message history for a single chat (e.g. after auto-adding a contact from a folder).
   */
  async syncHistoryForChat(
    accountId: string,
    organizationId: string,
    chatId: string
  ): Promise<{ messagesCount: number }> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) return { messagesCount: 0 };

    const row = await this.pool.query(
      'SELECT telegram_chat_id, title FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
      [accountId, chatId]
    );
    if (row.rows.length === 0) return { messagesCount: 0 };

    const client = clientInfo.client;
    const { telegram_chat_id: telegramChatId, title } = row.rows[0];
    let fetched = 0;

    try {
      const peerIdNum = Number(telegramChatId);
      const peerInput = Number.isNaN(peerIdNum) ? telegramChatId : peerIdNum;
      const peer = await client.getInputEntity(peerInput);
      let offsetId = 0;
      let hasMore = true;
      const cutoffDate = Math.floor(Date.now() / 1000) - this.SYNC_MESSAGES_MAX_AGE_DAYS * 24 * 3600;

      while (hasMore) {
        try {
          const result = await telegramInvokeWithFloodRetry(this.log, accountId, 'GetHistory(syncHistoryForChat)', () =>
            client.invoke(
              new Api.messages.GetHistory({
                peer,
                limit: Math.min(100, this.SYNC_MESSAGES_PER_CHAT_CAP - fetched),
                offsetId,
                offsetDate: 0,
                maxId: 0,
                minId: 0,
                addOffset: 0,
                hash: BigInt(0),
              })
            )
          );
          const rawMessages = (result as any).messages;
          if (!Array.isArray(rawMessages)) break;

          const list: Api.Message[] = rawMessages.filter((m: any) => m && typeof m === 'object' && (m.className === 'Message' || m instanceof Api.Message));
          for (const msg of list) {
            const hasText = !!getMessageText(msg).trim();
            if (!hasText && !msg.media) continue;
            let cid = telegramChatId;
            let senderId = '';
            if (msg.peerId) {
              if (msg.peerId instanceof Api.PeerUser) cid = String(msg.peerId.userId);
              else if (msg.peerId instanceof Api.PeerChat) cid = String(msg.peerId.chatId);
              else if (msg.peerId instanceof Api.PeerChannel) cid = String(msg.peerId.channelId);
            }
            if (msg.fromId instanceof Api.PeerUser) senderId = String(msg.fromId.userId);

            const contactId = await this.contactManager.ensureContactEnrichedFromTelegram(organizationId, accountId, senderId || cid);
            const direction = (msg as any).out === true ? MessageDirection.OUTBOUND : MessageDirection.INBOUND;
            const serialized = serializeMessage(msg);
            await this.messageDb.saveMessageToDb({
              organizationId,
              bdAccountId: accountId,
              contactId,
              channel: MessageChannel.TELEGRAM,
              channelId: cid,
              direction,
              status: MessageStatus.DELIVERED,
              unread: false,
              serialized,
              metadata: { senderId, hasMedia: !!msg.media },
            });
            fetched++;
          }
          if (list.length === 0) break;
          offsetId = Number((list[list.length - 1] as any).id) || 0;
          const oldestMsgDate = (list[list.length - 1] as any).date;
          if (typeof oldestMsgDate === 'number' && oldestMsgDate < cutoffDate) break;
          if (fetched >= this.SYNC_MESSAGES_PER_CHAT_CAP) break;
        } catch (err: any) {
          if (err?.seconds != null && typeof err.seconds === 'number') {
            await sleep(err.seconds * 1000);
            continue;
          }
          throw err;
        }
        await sleep(this.SYNC_DELAY_MS);
      }
      if (fetched > 0) {
        this.log.info({ message: `syncHistoryForChat: ${fetched} messages for chat ${chatId}, account ${accountId}` });
      }
    } catch (err: any) {
      this.log.warn({ message: `syncHistoryForChat failed for ${accountId}/${chatId}`, error: err?.message });
    }
    return { messagesCount: fetched };
  }

  /**
   * Load one page of older messages from Telegram for a chat (on scroll-up).
   * Returns { added, exhausted }. If exhausted — Telegram has no more messages for this chat.
   */
  async fetchOlderMessagesFromTelegram(
    accountId: string,
    organizationId: string,
    chatId: string
  ): Promise<{ added: number; exhausted: boolean }> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }

    const tryIds: string[] = [chatId];
    const fullIdNum = Number(chatId);
    if (!Number.isNaN(fullIdNum)) {
      if (fullIdNum > 0) tryIds.push(String(-1000000000 - fullIdNum));
      else if (fullIdNum < 0 && fullIdNum > -1000000000) tryIds.push(String(-1000000000 + fullIdNum));
    }
    let syncRow: { telegram_chat_id: string; history_exhausted?: boolean; access_hash?: string | null } | null = null;
    for (const tid of tryIds) {
      const r = await this.pool.query(
        'SELECT telegram_chat_id, history_exhausted, access_hash FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
        [accountId, tid]
      );
      if (r.rows.length > 0) {
        syncRow = r.rows[0] as any;
        break;
      }
    }
    if (syncRow == null) {
      await this.pool.query(
        `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id)
         VALUES ($1, $2, '', 'user', false, null)
         ON CONFLICT (bd_account_id, telegram_chat_id) DO NOTHING`,
        [accountId, chatId]
      );
      for (const tid of tryIds) {
        const r = await this.pool.query(
          'SELECT telegram_chat_id, history_exhausted, access_hash FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
          [accountId, tid]
        );
        if (r.rows.length > 0) {
          syncRow = r.rows[0] as any;
          break;
        }
      }
    }
    if (syncRow == null) {
      return { added: 0, exhausted: true };
    }
    const storedChatId = syncRow.telegram_chat_id;
    if (syncRow.history_exhausted === true) {
      return { added: 0, exhausted: true };
    }

    const oldestRow = await this.pool.query(
      `SELECT telegram_message_id, telegram_date, created_at FROM messages
       WHERE bd_account_id = $1 AND channel_id = $2
       ORDER BY COALESCE(telegram_date, created_at) ASC NULLS LAST
       LIMIT 1`,
      [accountId, chatId]
    );

    const client = clientInfo.client;
    let offsetId = 0;
    let offsetDate = 0;
    if (oldestRow.rows.length > 0) {
      const row = oldestRow.rows[0] as any;
      if (row.telegram_message_id != null) offsetId = parseInt(String(row.telegram_message_id), 10) || 0;
      if (row.telegram_date != null || row.created_at != null) {
        let ts: number;
        const raw = row.telegram_date ?? row.created_at;
        if (raw instanceof Date) ts = Math.floor(raw.getTime() / 1000);
        else if (typeof raw === 'number') ts = raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
        else ts = Math.floor(new Date(raw).getTime() / 1000);
        offsetDate = Math.max(-2147483648, Math.min(2147483647, ts));
      }
    }

    const limit = 100;
    const peerInput = Number.isNaN(fullIdNum) ? chatId : fullIdNum;
    const accessHashRaw = syncRow.access_hash;

    const doGetHistory = async (peer: any) =>
      telegramInvokeWithFloodRetry(this.log, accountId, 'GetHistory(load-older)', () =>
        client.invoke(
          new Api.messages.GetHistory({
            peer,
            limit,
            offsetId,
            offsetDate,
            maxId: 0,
            minId: 0,
            addOffset: 0,
            hash: BigInt(0),
          })
        )
      );

    let result: any;
    let peer: any;
    if (accessHashRaw != null && accessHashRaw !== '') {
      const storedFull = Number(storedChatId);
      const rawChannelId = Number.isNaN(storedFull) ? 0 : -1000000000 - storedFull;
      peer = new Api.InputPeerChannel({ channelId: rawChannelId, accessHash: BigInt(accessHashRaw) });
    } else {
      peer = await client.getInputEntity(peerInput);
    }
    try {
      result = await doGetHistory(peer);
    } catch (firstErr: any) {
      const msg = firstErr?.message ?? String(firstErr);
      if (msg.includes('PEER_ID_INVALID')) {
        try {
          await client.getDialogs({ limit: 100 });
          if (accessHashRaw != null && accessHashRaw !== '') {
            const storedFull = Number(storedChatId);
            const rawChannelId = Number.isNaN(storedFull) ? 0 : -1000000000 - storedFull;
            peer = new Api.InputPeerChannel({ channelId: rawChannelId, accessHash: BigInt(accessHashRaw) });
          } else {
            peer = await client.getInputEntity(peerInput);
          }
          result = await doGetHistory(peer);
        } catch (retryErr: any) {
          this.log.warn({ message: `fetchOlderMessagesFromTelegram failed for ${accountId}/${chatId}`, error: retryErr?.message ?? String(retryErr) });
          return { added: 0, exhausted: true };
        }
      } else {
        throw firstErr;
      }
    }

    try {

      const rawMessages = (result as any).messages;
      if (!Array.isArray(rawMessages)) {
        await this.pool.query(
          'UPDATE bd_account_sync_chats SET history_exhausted = true WHERE bd_account_id = $1 AND telegram_chat_id = $2',
          [accountId, storedChatId]
        );
        return { added: 0, exhausted: true };
      }

      const list: Api.Message[] = rawMessages.filter((m: any) => m && typeof m === 'object' && (m.className === 'Message' || m instanceof Api.Message));
      let added = 0;

      for (const msg of list) {
        const hasText = !!getMessageText(msg).trim();
        if (!hasText && !msg.media) continue;
        let senderId = '';
        if (msg.fromId instanceof Api.PeerUser) senderId = String(msg.fromId.userId);
        try {
          const contactId = await this.contactManager.ensureContactEnrichedFromTelegram(organizationId, accountId, senderId || chatId);
          const direction = (msg as any).out === true ? MessageDirection.OUTBOUND : MessageDirection.INBOUND;
          const serialized = serializeMessage(msg);
          await this.messageDb.saveMessageToDb({
            organizationId,
            bdAccountId: accountId,
            contactId,
            channel: MessageChannel.TELEGRAM,
            channelId: chatId,
            direction,
            status: MessageStatus.DELIVERED,
            unread: false,
            serialized,
            metadata: { senderId, hasMedia: !!msg.media },
          });
          added++;
        } catch (saveErr: unknown) {
          const msgErr = saveErr instanceof Error ? saveErr.message : String(saveErr);
          this.log.warn({ message: 'fetchOlderMessagesFromTelegram: skip message (save failed)', chatId, accountId, error: msgErr });
        }
      }

      const exhausted = list.length === 0 || list.length < limit;
      if (exhausted) {
        await this.pool.query(
          'UPDATE bd_account_sync_chats SET history_exhausted = true WHERE bd_account_id = $1 AND telegram_chat_id = $2',
          [accountId, storedChatId]
        );
      }

      if (added > 0) {
        this.log.info({ message: `fetchOlderMessagesFromTelegram: +${added} for chat ${chatId}, account ${accountId}, exhausted=${exhausted}` });
      }
      return { added, exhausted };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      this.log.warn({ message: `fetchOlderMessagesFromTelegram failed for ${accountId}/${chatId}`, error: msg });
      // Return empty so caller gets 200 and does not retry (e.g. entity not in cache, messaging down)
      return { added: 0, exhausted: true };
    }
  }
}
