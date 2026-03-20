// @ts-nocheck — GramJS types are incomplete
import { Api } from 'telegram';
import { getErrorMessage } from '../helpers';
import { isUsernameLike, resolveUsernameToInputPeer } from './resolve-username';
import { telegramInvokeWithFloodRetry } from './telegram-invoke-flood';
import type { TelegramManagerDeps, TelegramClientInfo, StructuredLog } from './types';
import type { Pool } from 'pg';

/** Minimum delay (ms) before send after a resolve/session call to avoid Telegram rate limits. */
const SEND_DELAY_AFTER_RESOLVE_MS = 300;

/**
 * Sending messages, typing, read receipts, drafts.
 */
export class MessageSender {
  private readonly pool: Pool;
  private readonly log: StructuredLog;
  private readonly clients: Map<string, TelegramClientInfo>;

  constructor(private readonly deps: TelegramManagerDeps) {
    this.pool = deps.pool;
    this.log = deps.log;
    this.clients = deps.clients;
  }

  /** GramJS expects numeric peer ids (e.g. -1000012345 for supergroups) as number, not string, else PEER_ID_INVALID. */
  private peerInput(chatId: string): number | string {
    const n = Number(chatId);
    return Number.isNaN(n) ? chatId : n;
  }

  /**
   * Resolve peer for send/typing/read: use InputPeerChannel from DB when access_hash is stored
   * (e.g. newly created shared chat not yet in session cache), else getInputEntity(peerInput).
   * Supports chatId as: full form (-100...), raw (positive), or -raw (e.g. -4873835434); DB stores full form.
   */
  private async resolvePeer(accountId: string, chatId: string): Promise<Api.TypeInputPeer | number | string> {
    const row = await this.resolvePeerRow(accountId, chatId);
    if (row?.access_hash != null && row.access_hash !== '') {
      const storedFull = Number(row.telegram_chat_id);
      const rawChannelId = Number.isNaN(storedFull) ? 0 : -1000000000 - storedFull;
      return new Api.InputPeerChannel({ channelId: rawChannelId, accessHash: BigInt(row.access_hash) });
    }
    return this.peerInput(chatId);
  }

  /** Look up sync_chats row by chatId or normalized form (raw / -raw → full). */
  private async resolvePeerRow(
    accountId: string,
    chatId: string
  ): Promise<{ telegram_chat_id: string; access_hash: string | null } | null> {
    const fullId = Number(chatId);
    const tryIds: string[] = [chatId];
    if (!Number.isNaN(fullId)) {
      if (fullId > 0) tryIds.push(String(-1000000000 - fullId)); // raw → full
      else if (fullId < 0 && fullId > -1000000000) tryIds.push(String(-1000000000 + fullId)); // -raw → full
    }
    for (const tid of tryIds) {
      const r = await this.pool.query(
        'SELECT telegram_chat_id, access_hash FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
        [accountId, tid]
      );
      const row = r.rows[0] as { telegram_chat_id: string; access_hash?: string | null } | undefined;
      if (row) return { telegram_chat_id: row.telegram_chat_id, access_hash: row.access_hash ?? null };
    }
    return null;
  }

  async sendMessage(
    accountId: string,
    chatId: string,
    text: string,
    opts: { replyTo?: number } = {}
  ): Promise<Api.Message> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }

    const client = clientInfo.client;
    const params = {
      message: text,
      ...(opts.replyTo != null ? { replyTo: opts.replyTo } : {}),
    };

    const trySend = async (peer: Api.TypeInputPeer | number | string): Promise<Api.Message> => {
      const message = await telegramInvokeWithFloodRetry(this.log, accountId, 'SendMessage', () =>
        client.sendMessage(peer, params)
      );
      clientInfo.lastActivity = new Date();
      await this.pool.query(
        'UPDATE bd_accounts SET last_activity = NOW() WHERE id = $1',
        [accountId]
      );
      return message;
    };

    try {
      let peer: Api.TypeInputPeer | number | string = await this.resolvePeer(accountId, chatId);

      // Important: for numeric user ids we often don't have access_hash in GramJS session cache.
      // Telegram client resolves access_hash server-side; we mimic that by resolving the entity first.
      if (typeof peer === 'number') {
        try {
          const entity = await client.getEntity(peer);
          peer = await client.getInputEntity(entity as any);
        } catch {
          // Keep original peer (will be retried by outer error handler).
        }
      }

      // Username: resolve via contacts.ResolveUsername first (guaranteed delivery, no cache dependency)
      if (typeof peer === 'string' && peer.length > 0 && isUsernameLike(peer)) {
        const resolved = await resolveUsernameToInputPeer(client, peer, { log: this.log, accountId });
        if (resolved) {
          if (SEND_DELAY_AFTER_RESOLVE_MS > 0) {
            await new Promise((r) => setTimeout(r, SEND_DELAY_AFTER_RESOLVE_MS));
          }
          return trySend(resolved);
        }
        peer = await client.getInputEntity(peer);
        return trySend(peer);
      }

      if (typeof peer === 'string' && peer.length > 0 && Number.isNaN(Number(peer))) {
        peer = await client.getInputEntity(peer);
      }
      return trySend(peer);
    } catch (firstError: unknown) {
      const errMsg = getErrorMessage(firstError);
      const isEntityNotFound =
        typeof errMsg === 'string' &&
        (errMsg.includes('Could not find the input entity') ||
          errMsg.includes('input entity') ||
          errMsg.includes('PEER_ID_INVALID') ||
          errMsg.includes('CHAT_ID_INVALID'));
      // Prime dialog cache (e.g. new shared chat or numeric user id never seen); retry send.
      if (isEntityNotFound) {
        try {
          await client.getDialogs({ limit: 100 });
          if (SEND_DELAY_AFTER_RESOLVE_MS > 0) {
            await new Promise((r) => setTimeout(r, SEND_DELAY_AFTER_RESOLVE_MS));
          }
          let peerRetry: Api.TypeInputPeer | number | string = await this.resolvePeer(accountId, chatId);

          if (typeof peerRetry === 'number') {
            try {
              const entity = await client.getEntity(peerRetry);
              peerRetry = await client.getInputEntity(entity as any);
            } catch {
              // Keep original peer (retry send will rethrow if still not resolvable).
            }
          }

          if (typeof peerRetry === 'string' && peerRetry.length > 0 && isUsernameLike(peerRetry)) {
            const resolved = await resolveUsernameToInputPeer(client, peerRetry, { log: this.log, accountId });
            if (resolved) return trySend(resolved);
            peerRetry = await client.getInputEntity(peerRetry);
          } else if (typeof peerRetry === 'string' && peerRetry.length > 0 && Number.isNaN(Number(peerRetry))) {
            peerRetry = await client.getInputEntity(peerRetry);
          }
          this.log.info({ message: 'sendMessage succeeded after getDialogs cache prime', accountId, chatId });
          return trySend(peerRetry);
        } catch (retryError: unknown) {
          this.log.error({ message: `Error sending message (after cache prime)`, error: getErrorMessage(retryError) });
          throw retryError;
        }
      }
      this.log.error({ message: `Error sending message`, error: errMsg });
      throw firstError;
    }
  }

  async setTyping(accountId: string, chatId: string): Promise<void> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    try {
      const peerResolved = await this.resolvePeer(accountId, chatId);
      const peer = typeof peerResolved === 'object' && peerResolved?.className
        ? peerResolved
        : await (async () => {
          try {
            return await clientInfo.client.getInputEntity(peerResolved as any);
          } catch (e: unknown) {
            // Numeric user ids may require entity resolution to get access_hash.
            if (typeof peerResolved === 'number') {
              const entity = await clientInfo.client.getEntity(peerResolved);
              return await clientInfo.client.getInputEntity(entity as any);
            }
            throw e;
          }
        })();
      await telegramInvokeWithFloodRetry(this.log, accountId, 'SetTyping', () =>
        clientInfo.client.invoke(
          new Api.messages.SetTyping({ peer, action: new Api.SendMessageTypingAction() })
        )
      );
    } catch (error: unknown) {
      this.log.warn({ message: 'setTyping failed', accountId, chatId, error: getErrorMessage(error) });
    }
  }

  async markAsRead(accountId: string, chatId: string): Promise<void> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    try {
      const peerResolved = await this.resolvePeer(accountId, chatId);
      const entity = typeof peerResolved === 'object' && (peerResolved as any)?.className
        ? peerResolved
        : await (async () => {
          try {
            return await clientInfo.client.getInputEntity(peerResolved as any);
          } catch (e: unknown) {
            if (typeof peerResolved === 'number') {
              const resolvedEntity = await clientInfo.client.getEntity(peerResolved);
              return await clientInfo.client.getInputEntity(resolvedEntity as any);
            }
            throw e;
          }
        })();
      if ((entity as any).className === 'InputPeerChannel') {
        await telegramInvokeWithFloodRetry(this.log, accountId, 'channels.ReadHistory', () =>
          clientInfo.client.invoke(
            new Api.channels.ReadHistory({ channel: entity as any, maxId: 0 })
          )
        );
      } else {
        await telegramInvokeWithFloodRetry(this.log, accountId, 'messages.ReadHistory', () =>
          clientInfo.client.invoke(
            new Api.messages.ReadHistory({ peer: entity, maxId: 0 })
          )
        );
      }
    } catch (error: unknown) {
      this.log.warn({ message: 'markAsRead failed', accountId, chatId, error: getErrorMessage(error) });
    }
  }

  async saveDraft(
    accountId: string,
    chatId: string,
    text: string,
    opts: { replyToMsgId?: number } = {}
  ): Promise<void> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const client = clientInfo.client;
    const ApiAny = Api as any;
    try {
      const peerResolved = await this.resolvePeer(accountId, chatId);
      const peer = typeof peerResolved === 'object' && (peerResolved as any)?.className
        ? peerResolved
        : await client.getInputEntity(peerResolved);
      const replyTo = opts.replyToMsgId != null ? { replyToMsgId: opts.replyToMsgId } : undefined;
      await telegramInvokeWithFloodRetry(this.log, accountId, 'SaveDraft', () =>
        client.invoke(
          new ApiAny.messages.SaveDraft({
            peer,
            message: text || '',
            ...(replyTo ? { replyTo } : {}),
          })
        )
      );
      clientInfo.lastActivity = new Date();
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      this.log.warn({ message: 'saveDraft failed (entity not in cache or Telegram error)', accountId, chatId, error: msg });
    }
  }

  async forwardMessage(
    accountId: string,
    fromChatId: string,
    toChatId: string,
    telegramMessageId: number
  ): Promise<Api.Message> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const client = clientInfo.client;
    const fromResolved = await this.resolvePeer(accountId, fromChatId);
    const toResolved = await this.resolvePeer(accountId, toChatId);
    const fromPeer = typeof fromResolved === 'object' && (fromResolved as any)?.className ? fromResolved : await client.getInputEntity(fromResolved);
    const toPeer = typeof toResolved === 'object' && (toResolved as any)?.className ? toResolved : await client.getInputEntity(toResolved);
    const randomId = BigInt(Math.floor(Math.random() * 1e15)) * BigInt(1e5) + BigInt(Math.floor(Math.random() * 1e5));
    const result = await telegramInvokeWithFloodRetry(this.log, accountId, 'ForwardMessages', () =>
      client.invoke(
        new Api.messages.ForwardMessages({
          fromPeer,
          toPeer,
          id: [telegramMessageId],
          randomId: [randomId],
        })
      )
    );
    clientInfo.lastActivity = new Date();
    await this.pool.query(
      'UPDATE bd_accounts SET last_activity = NOW() WHERE id = $1',
      [accountId]
    );
    const updates = result as any;
    const message = updates?.updates?.[0]?.message ?? updates?.updates?.find((u: any) => u.message)?.message;
    if (!message) throw new Error('Forward succeeded but no message in response');
    return message;
  }
}
