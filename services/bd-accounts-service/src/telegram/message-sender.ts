// @ts-nocheck — GramJS types are incomplete
import { Api } from 'telegram';
import { getErrorMessage } from '../helpers';
import type { TelegramManagerDeps, TelegramClientInfo, StructuredLog } from './types';
import type { Pool } from 'pg';

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

    try {
      const peer = await this.resolvePeer(accountId, chatId);
      const message = await client.sendMessage(peer, params);
      clientInfo.lastActivity = new Date();
      await this.pool.query(
        'UPDATE bd_accounts SET last_activity = NOW() WHERE id = $1',
        [accountId]
      );
      return message;
    } catch (firstError: unknown) {
      const errMsg = getErrorMessage(firstError);
      const isEntityNotFound =
        typeof errMsg === 'string' &&
        (errMsg.includes('Could not find the input entity') ||
          errMsg.includes('input entity') ||
          errMsg.includes('PEER_ID_INVALID'));
      // Созданный общий чат не в кэше; getDialogs() подгрузит его (как при синхронизации), после ретрая отправка работает.
      if (isEntityNotFound) {
        try {
          await client.getDialogs({ limit: 100 });
          const peerRetry = await this.resolvePeer(accountId, chatId);
          const message = await client.sendMessage(peerRetry, params);
          clientInfo.lastActivity = new Date();
          await this.pool.query(
            'UPDATE bd_accounts SET last_activity = NOW() WHERE id = $1',
            [accountId]
          );
          this.log.info({ message: 'sendMessage succeeded after getDialogs cache prime', accountId, chatId });
          return message;
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
        : await clientInfo.client.getInputEntity(peerResolved);
      await clientInfo.client.invoke(
        new Api.messages.SetTyping({ peer, action: new Api.SendMessageTypingAction() })
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
        : await clientInfo.client.getInputEntity(peerResolved);
      if ((entity as any).className === 'InputPeerChannel') {
        await clientInfo.client.invoke(
          new Api.channels.ReadHistory({ channel: entity as any, maxId: 0 })
        );
      } else {
        await clientInfo.client.invoke(
          new Api.messages.ReadHistory({ peer: entity, maxId: 0 })
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
      await client.invoke(
        new ApiAny.messages.SaveDraft({
          peer,
          message: text || '',
          ...(replyTo ? { replyTo } : {}),
        })
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
    const result = await client.invoke(
      new Api.messages.ForwardMessages({
        fromPeer,
        toPeer,
        id: [telegramMessageId],
        randomId: [randomId],
      })
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
