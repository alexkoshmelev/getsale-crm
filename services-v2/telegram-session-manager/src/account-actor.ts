// @ts-nocheck
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { EventType, type Event } from '@getsale/events';
import { Logger } from '@getsale/logger';
import { RabbitMQClient } from '@getsale/queue';
import { RedisClient } from '@getsale/cache';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, type NewMessageEvent } from 'telegram/events';
import {
  decryptIfNeeded, encryptSession,
  buildTelegramProxy, buildGramJsClientOptions, destroyTelegramClient,
  telegramInvokeWithFloodRetry,
} from '@getsale/telegram';
import { serializeMessage, getMessageText, type SerializedTelegramMessage } from './telegram-serialize';
import { AccountRateLimiter } from './rate-limiter';
import {
  TelegramCommand, CommandType, AccountState,
  SendMessagePayload, TypingPayload, MarkReadPayload,
  SearchGroupsPayload, GetParticipantsPayload, ResolveUsernamePayload,
  DeleteMessagePayload, SendReactionPayload, SaveDraftPayload,
  ForwardMessagePayload, SendBulkPayload, LoadOlderHistoryPayload,
  AccountLifecyclePayload, SyncHistoryPayload,
} from './command-types';

const FATAL_AUTH_ERRORS = [
  'AUTH_KEY_UNREGISTERED',
  'AUTH_KEY_DUPLICATED',
  'SESSION_REVOKED',
  'AUTH_KEY_INVALID',
  'USER_DEACTIVATED',
  'PHONE_NUMBER_BANNED',
];

const SESSION_SAVE_INTERVAL_MS = 5 * 60_000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const MAX_KEEPALIVE_FAILURES = 3;

export interface AccountActorConfig {
  accountId: string;
  organizationId: string;
  pool: Pool;
  rabbitmq: RabbitMQClient;
  redis: RedisClient;
  log: Logger;
  apiId: number;
  apiHash: string;
}

export class AccountActor {
  public readonly accountId: string;
  public state: AccountState = 'disconnected';
  private organizationId: string;
  private pool: Pool;
  private rabbitmq: RabbitMQClient;
  private redis: RedisClient;
  private log: Logger;
  private rateLimiter: AccountRateLimiter;
  private running = false;
  private commandQueue: string;
  private client: TelegramClient | null = null;
  private sessionSaveInterval: NodeJS.Timeout | null = null;
  private keepaliveInterval: NodeJS.Timeout | null = null;
  private keepaliveFailures = 0;

  constructor(config: AccountActorConfig) {
    this.accountId = config.accountId;
    this.organizationId = config.organizationId;
    this.pool = config.pool;
    this.rabbitmq = config.rabbitmq;
    this.redis = config.redis;
    this.log = config.log;
    this.rateLimiter = new AccountRateLimiter(30, 60_000, 30);
    this.commandQueue = `telegram:commands:${this.accountId}`;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.state = 'connecting';

    this.log.info({ message: `Actor starting for account ${this.accountId}` });

    try {
      await this.connect();
      this.state = 'connected';
      this.log.info({ message: `Actor connected for account ${this.accountId}` });

      await this.pool.query(
        "UPDATE bd_accounts SET connection_state = 'connected' WHERE id = $1",
        [this.accountId],
      );

      await this.startCommandConsumer();
    } catch (err) {
      this.state = 'error';
      this.log.error({ message: `Actor failed to start for ${this.accountId}`, error: String(err) });
    }
  }

  getClient(): TelegramClient | null {
    return this.client;
  }

  private async connect(): Promise<void> {
    const { rows } = await this.pool.query(
      `SELECT session_string, session_encrypted, phone_number, proxy_config,
              api_id, api_hash, telegram_id, username, bio
       FROM bd_accounts WHERE id = $1`,
      [this.accountId],
    );

    if (!rows.length) {
      throw new Error(`BD account ${this.accountId} not found`);
    }

    const row = rows[0];
    const sessionString = decryptIfNeeded(row.session_string, !!row.session_encrypted);
    if (!sessionString) {
      throw new Error(`BD account ${this.accountId} has no session`);
    }

    const apiId = row.api_id ? Number(row.api_id) : undefined;
    const apiHash = row.api_hash || undefined;
    const proxy = buildTelegramProxy(row.proxy_config);
    const clientOpts = buildGramJsClientOptions(proxy);

    const session = new StringSession(sessionString);
    this.client = new TelegramClient(session, apiId!, apiHash!, clientOpts);

    await this.client.connect();
    const me = await this.client.getMe();
    if (!me) throw new Error(`getMe() returned null for account ${this.accountId}`);

    this.registerInboundHandler();
    this.registerReadReceiptHandler();
    await this.updateProfileInfo(me, row.phone_number);
    this.startSessionSaveLoop();
    this.startKeepaliveLoop();

    this.state = 'connected';
  }

  private registerInboundHandler(): void {
    this.client!.addEventHandler(
      async (event: NewMessageEvent) => {
        try {
          await this.handleInboundMessage(event);
        } catch (err) {
          this.log.error({ message: 'Inbound message handler error', error: String(err) });
        }
      },
      new NewMessage({ incoming: true }),
    );
  }

  private registerReadReceiptHandler(): void {
    this.client!.addEventHandler(async (update: any) => {
      try {
        const cn = update?.className;
        if (cn === 'UpdateReadHistoryOutbox') {
          const peer = update.peer;
          let channelId = '';
          if (peer?.userId != null) channelId = String(peer.userId.value ?? peer.userId);
          else if (peer?.chatId != null) channelId = String(peer.chatId.value ?? peer.chatId);
          else if (peer?.channelId != null) channelId = String(peer.channelId.value ?? peer.channelId);
          if (!channelId) return;
          const maxId = update.maxId ?? 0;
          await this.handleReadOutbox(channelId, maxId);
        } else if (cn === 'UpdateReadChannelOutbox') {
          const channelIdRaw = update.channelId;
          const channelId = channelIdRaw != null ? String(channelIdRaw.value ?? channelIdRaw) : '';
          if (!channelId) return;
          const maxId = update.maxId ?? 0;
          await this.handleReadOutbox(channelId, maxId);
        }
      } catch (err) {
        this.log.warn({ message: 'Read receipt handler error', error: String(err) });
      }
    });
  }

  private async handleReadOutbox(channelId: string, maxId: number): Promise<void> {
    if (!maxId || maxId <= 0) return;
    try {
      const result = await this.pool.query(
        `UPDATE messages
         SET status = 'read', updated_at = NOW()
         WHERE organization_id = $1 AND bd_account_id = $2
           AND channel_id = $3 AND direction = 'outbound'
           AND telegram_message_id IS NOT NULL
           AND telegram_message_id ~ '^[0-9]+$'
           AND telegram_message_id::bigint <= $4
           AND status <> 'read'`,
        [this.organizationId, this.accountId, channelId, maxId],
      );
      if (result.rowCount && result.rowCount > 0) {
        this.log.info({ message: 'Marked messages as read', accountId: this.accountId, channelId, maxId, count: result.rowCount });
        await this.invalidateCampaignStatsForChannel(channelId);
      }
    } catch (err) {
      this.log.warn({ message: 'handleReadOutbox failed', channelId, maxId, error: String(err) });
    }
  }

  private async invalidateCampaignStatsForChannel(channelId: string): Promise<void> {
    try {
      const res = await this.pool.query(
        `SELECT DISTINCT cp.campaign_id FROM campaign_participants cp
         WHERE cp.bd_account_id = $1 AND cp.channel_id = $2`,
        [this.accountId, channelId],
      );
      for (const row of res.rows as { campaign_id: string }[]) {
        await this.redis.del(`campaign:stats:${row.campaign_id}`);
      }
    } catch (_) { /* best-effort */ }
  }

  private async handleInboundMessage(event: NewMessageEvent): Promise<void> {
    const msg = event.message;
    if (!msg) return;

    const chatId = msg.chatId?.toString() ?? '';
    const text = msg.text ?? '';
    const messageId = randomUUID();

    await this.pool.query(
      `INSERT INTO messages
        (id, organization_id, content, direction, bd_account_id, channel_id, channel, telegram_message_id, created_at)
       VALUES ($1, $2, $3, 'inbound', $4, $5, 'telegram', $6, NOW())`,
      [messageId, this.organizationId, text, this.accountId, chatId, msg.id],
    );

    await this.rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.MESSAGE_RECEIVED,
      timestamp: new Date(),
      organizationId: this.organizationId,
      userId: '',
      data: {
        messageId,
        channel: 'telegram',
        channelId: chatId,
        bdAccountId: this.accountId,
        content: text,
        direction: 'inbound',
        telegramMessageId: msg.id,
      },
    } as unknown as Event);
  }

  private async updateProfileInfo(me: Api.User, dbPhone: string | null): Promise<void> {
    const telegramId = me.id?.toString() ?? null;
    const username = me.username ?? null;
    const phone = me.phone ?? dbPhone;

    await this.pool.query(
      `UPDATE bd_accounts
       SET telegram_id = COALESCE($1, telegram_id),
           username     = COALESCE($2, username),
           phone_number = COALESCE($3, phone_number)
       WHERE id = $4`,
      [telegramId, username, phone, this.accountId],
    );
  }

  private startSessionSaveLoop(): void {
    this.sessionSaveInterval = setInterval(async () => {
      try {
        const saved = await this.client!.session.save();
        const sessionStr = typeof saved === 'string' ? saved : String(saved);
        const encrypted = encryptSession(sessionStr);

        await this.pool.query(
          `UPDATE bd_accounts
           SET session_string = $1, session_encrypted = true
           WHERE id = $2`,
          [encrypted, this.accountId],
        );
      } catch (err) {
        this.log.error({ message: `Session save failed for ${this.accountId}`, error: String(err) });
      }
    }, SESSION_SAVE_INTERVAL_MS);
  }

  private startKeepaliveLoop(): void {
    this.keepaliveInterval = setInterval(async () => {
      try {
        await this.client!.invoke(new Api.updates.GetState());
        this.keepaliveFailures = 0;
      } catch (err) {
        this.keepaliveFailures++;
        this.log.warn({
          message: `Keepalive failed for ${this.accountId}`,
          failures: this.keepaliveFailures,
          error: String(err),
        });

        if (this.isFatalAuthError(err)) {
          await this.markReauthRequired();
          return;
        }

        if (this.keepaliveFailures >= MAX_KEEPALIVE_FAILURES) {
          this.log.warn({ message: `Max keepalive failures reached for ${this.accountId}, reconnecting` });
          this.keepaliveFailures = 0;
          try {
            await this.client!.connect();
          } catch (reconnectErr) {
            this.log.error({ message: `Reconnect failed for ${this.accountId}`, error: String(reconnectErr) });
            if (this.isFatalAuthError(reconnectErr)) {
              await this.markReauthRequired();
            }
          }
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private isFatalAuthError(err: unknown): boolean {
    const msg = String(err);
    return FATAL_AUTH_ERRORS.some((code) => msg.includes(code));
  }

  private async markReauthRequired(): Promise<void> {
    this.log.error({ message: `Fatal auth error for ${this.accountId}, marking reauth_required` });
    await this.pool.query(
      `UPDATE bd_accounts SET connection_state = 'reauth_required' WHERE id = $1`,
      [this.accountId],
    ).catch(() => {});
    this.state = 'reauth_required';
    await this.stop();
  }

  private async startCommandConsumer(): Promise<void> {
    await this.rabbitmq.consumeQueue<TelegramCommand>(
      this.commandQueue,
      async (command) => {
        await this.processCommand(command);
      },
      1,
    );
  }

  private static readonly HEAVYWEIGHT_COMMANDS = new Set([
    CommandType.SEND_MESSAGE,
    CommandType.SEND_BULK,
    CommandType.FORWARD_MESSAGE,
    CommandType.GET_PARTICIPANTS,
  ]);

  private async processCommand(command: TelegramCommand): Promise<void> {
    const isHeavy = AccountActor.HEAVYWEIGHT_COMMANDS.has(command.type as CommandType);

    if (this.state === 'flood_wait') {
      const wait = this.rateLimiter.getFloodWaitRemaining();
      if (wait > 0) {
        this.log.warn({
          message: `Account ${this.accountId} in flood_wait, delaying command`,
          command_type: command.type,
          wait_ms: wait,
        });
        await new Promise((r) => setTimeout(r, Math.min(wait, 30_000)));
      }
    }

    if (isHeavy) {
      if (!this.rateLimiter.canConsume()) {
        const delay = this.rateLimiter.timeUntilAvailable();
        this.log.warn({ message: `Rate limit hit for ${this.accountId}, waiting ${delay}ms` });
        await new Promise((r) => setTimeout(r, delay));
      }
      this.rateLimiter.consume();
    }

    try {
      switch (command.type) {
        case CommandType.SEND_MESSAGE:
          await this.handleSendMessage(command.payload as SendMessagePayload);
          break;
        case CommandType.TYPING:
          await this.handleTyping(command.payload as TypingPayload);
          break;
        case CommandType.MARK_READ:
          await this.handleMarkRead(command.payload as MarkReadPayload);
          break;
        case CommandType.SYNC_CHATS:
          await this.handleSyncChats();
          break;
        case CommandType.SEARCH_GROUPS:
          await this.handleSearchGroups(command.payload as SearchGroupsPayload);
          break;
        case CommandType.GET_PARTICIPANTS:
          await this.handleGetParticipants(command.payload as GetParticipantsPayload);
          break;
        case CommandType.RESOLVE_USERNAME:
          await this.handleResolveUsername(command.payload as ResolveUsernamePayload);
          break;
        case CommandType.DELETE_MESSAGE:
          await this.handleDeleteMessage(command.payload as DeleteMessagePayload);
          break;
        case CommandType.SEND_REACTION:
          await this.handleSendReaction(command.payload as SendReactionPayload);
          break;
        case CommandType.SAVE_DRAFT:
          await this.handleSaveDraft(command.payload as SaveDraftPayload);
          break;
        case CommandType.FORWARD_MESSAGE:
          await this.handleForwardMessage(command.payload as ForwardMessagePayload);
          break;
        case CommandType.SEND_BULK:
          await this.handleSendBulk(command.payload as SendBulkPayload);
          break;
        case CommandType.LOAD_OLDER_HISTORY:
          await this.handleLoadOlderHistory(command.payload as LoadOlderHistoryPayload);
          break;
        case CommandType.DISCONNECT:
          await this.handleDisconnect(command.payload as AccountLifecyclePayload);
          break;
        case CommandType.RECONNECT:
          await this.handleReconnect(command.payload as AccountLifecyclePayload);
          break;
        case CommandType.SPAMBOT_CHECK:
          await this.handleSpambotCheck(command.payload as AccountLifecyclePayload);
          break;
        case CommandType.SYNC_HISTORY:
          await this.syncHistory((command.payload as SyncHistoryPayload).organizationId);
          break;
        default:
          this.log.warn({ message: `Unknown command type: ${command.type}` });
      }
    } catch (err: unknown) {
      if (isFloodWaitError(err)) {
        const seconds = getFloodWaitSeconds(err);
        this.rateLimiter.applyFloodWait(seconds);
        this.state = 'flood_wait';
        this.log.warn({
          message: `FloodWait for account ${this.accountId}`,
          flood_seconds: seconds,
          command_type: command.type,
        });

        this.rabbitmq.publishEvent({
          id: randomUUID(),
          type: 'bd_account.flood' as EventType,
          timestamp: new Date(),
          organizationId: this.organizationId,
          userId: '',
          data: { accountId: this.accountId, floodSeconds: seconds },
        } as unknown as Event).catch(() => {});

        // Re-queue the command with delay
        await this.rabbitmq.publishCommand(this.commandQueue, {
          ...command,
          priority: command.priority,
        });
      } else {
        this.log.error({
          message: `Command execution failed for ${this.accountId}`,
          command_type: command.type,
          error: String(err),
        });
      }
    }
  }

  private peerInput(chatId: string): number | string {
    const n = Number(chatId);
    return Number.isNaN(n) ? chatId : n;
  }

  private async resolvePeer(chatId: string): Promise<any> {
    const client = this.client!;
    const peerVal = this.peerInput(chatId);

    try {
      return await client.getInputEntity(peerVal);
    } catch {
      this.log.info({ message: 'getInputEntity failed, priming with getDialogs', accountId: this.accountId, chatId });
      await client.getDialogs({ limit: 100 });
      return await client.getInputEntity(peerVal);
    }
  }

  private async handleSendMessage(payload: SendMessagePayload): Promise<void> {
    if (!this.client?.connected) {
      throw new Error(`Client not connected for account ${this.accountId}`);
    }

    const chatId = (payload.channelId || payload.conversationId || '').trim();
    this.log.info({
      message: `Sending message via account ${this.accountId}`,
      chatId,
      conversation_id: payload.conversationId,
    });

    let peer: any;
    const usernameHint = (payload as any).usernameHint as string | undefined;
    if (usernameHint && !/^\d+$/.test(chatId)) {
      try {
        peer = await this.client!.getInputEntity(usernameHint.replace(/^@/, ''));
      } catch {
        peer = await this.resolvePeer(chatId);
      }
    } else {
      peer = await this.resolvePeer(chatId);
    }

    const params: Record<string, unknown> = { message: payload.text };
    if (payload.replyTo) {
      params.replyTo = payload.replyTo;
    }

    const sentMessage = await telegramInvokeWithFloodRetry(
      this.log,
      this.accountId,
      'SendMessage',
      () => this.client!.sendMessage(peer, params),
    );

    const telegramMessageId = sentMessage?.id ?? null;
    const messageId = payload.messageId || randomUUID();

    if (payload.messageId) {
      try {
        await this.pool.query(
          `UPDATE messages
           SET telegram_message_id = $1, status = 'delivered', updated_at = NOW()
           WHERE id = $2 AND organization_id = $3`,
          [telegramMessageId, messageId, payload.organizationId],
        );
      } catch (updateErr) {
        this.log.warn({ message: 'Message update failed', error: String(updateErr), messageId });
      }
    } else {
      try {
        await this.pool.query(
          `INSERT INTO messages
            (id, organization_id, content, direction, bd_account_id, channel_id, channel, telegram_message_id, status, created_at)
           VALUES ($1, $2, $3, 'outbound', $4, $5, 'telegram', $6, 'delivered', NOW())`,
          [messageId, payload.organizationId, payload.text, this.accountId, chatId, telegramMessageId],
        );
      } catch (insertErr) {
        this.log.warn({ message: 'Message insert failed (possible duplicate)', error: String(insertErr), messageId });
      }
    }

    await this.rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.MESSAGE_SENT,
      timestamp: new Date(),
      organizationId: payload.organizationId,
      userId: payload.userId,
      data: {
        messageId,
        channel: 'telegram',
        channelId: chatId,
        bdAccountId: this.accountId,
        content: payload.text,
        direction: 'outbound',
        telegramMessageId,
      },
    } as unknown as Event);

    if ((payload as any).participantId) {
      try {
        await this.pool.query(
          `UPDATE campaign_sends SET message_id = $1
           WHERE id = (
             SELECT id FROM campaign_sends
             WHERE campaign_participant_id = $2 AND message_id IS NULL
             ORDER BY sent_at DESC LIMIT 1
           )`,
          [messageId, (payload as any).participantId],
        );
      } catch (linkErr) {
        this.log.warn({ message: 'Failed to link message to campaign_sends', error: String(linkErr), messageId });
      }
    }

    await this.pool.query(
      'UPDATE bd_accounts SET last_activity = NOW() WHERE id = $1',
      [this.accountId],
    );
  }

  private async handleTyping(payload: TypingPayload): Promise<void> {
    if (!this.client?.connected) return;

    try {
      const peer = await this.client.getInputEntity(this.peerInput(payload.channelId));
      await this.client.invoke(
        new Api.messages.SetTyping({
          peer,
          action: new Api.SendMessageTypingAction(),
        }),
      );
    } catch (err) {
      this.log.warn({ message: 'setTyping failed', accountId: this.accountId, channelId: payload.channelId, error: String(err) });
    }
  }

  private async handleMarkRead(payload: MarkReadPayload & { maxId?: number }): Promise<void> {
    if (!this.client?.connected) return;

    const maxId = (payload as any).maxId > 0
      ? (payload as any).maxId
      : payload.messageIds?.length
        ? Math.max(...payload.messageIds.filter((n) => Number.isFinite(n) && n > 0))
        : 0;

    try {
      const peer = await this.resolvePeer(payload.channelId);

      if (peer?.className === 'InputPeerChannel') {
        await telegramInvokeWithFloodRetry(
          this.log,
          this.accountId,
          'channels.ReadHistory',
          () => this.client!.invoke(
            new Api.channels.ReadHistory({ channel: peer, maxId }),
          ),
        );
      } else {
        await telegramInvokeWithFloodRetry(
          this.log,
          this.accountId,
          'messages.ReadHistory',
          () => this.client!.invoke(
            new Api.messages.ReadHistory({ peer, maxId }),
          ),
        );
      }
    } catch (err) {
      this.log.warn({ message: 'markAsRead failed', accountId: this.accountId, channelId: payload.channelId, error: String(err) });
    }
  }

  private async handleSyncChats(): Promise<void> {
    if (!this.client?.connected) return;

    this.log.info({ message: `Syncing chats for account ${this.accountId}` });

    const dialogs = await this.client.getDialogs({ limit: 100 });

    let synced = 0;
    for (const dialog of dialogs) {
      const entity = (dialog as any).entity;
      const isUser = dialog.isUser ?? (entity?.className === 'User');
      const isGroup = dialog.isGroup ?? false;
      const isChannel = dialog.isChannel ?? false;

      if (!isUser && !isGroup && !isChannel) continue;

      const chatId = String(dialog.id);
      const title = dialog.name || dialog.title || 'Unknown';
      const peerType = isUser ? 'user' : isGroup ? 'chat' : 'channel';
      const unreadCount = dialog.unreadCount || 0;
      const lastMessageAt = dialog.message?.date
        ? new Date(typeof dialog.message.date === 'number'
            ? dialog.message.date > 1e10 ? dialog.message.date : dialog.message.date * 1000
            : dialog.message.date)
        : null;

      const accessHash = entity?.accessHash != null
        ? String(entity.accessHash)
        : null;

      await this.pool.query(
        `INSERT INTO bd_account_sync_chats
          (bd_account_id, telegram_chat_id, title, peer_type, telegram_unread_count, telegram_last_message_at, access_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (bd_account_id, telegram_chat_id) DO UPDATE SET
           title = EXCLUDED.title,
           telegram_unread_count = EXCLUDED.telegram_unread_count,
           telegram_last_message_at = EXCLUDED.telegram_last_message_at,
           access_hash = EXCLUDED.access_hash`,
        [this.accountId, chatId, title, peerType, unreadCount, lastMessageAt, accessHash],
      );
      synced++;
    }

    await this.rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.BD_ACCOUNT_SYNC_COMPLETED,
      timestamp: new Date(),
      organizationId: this.organizationId,
      userId: '',
      data: {
        bdAccountId: this.accountId,
        totalChats: synced,
      },
    } as unknown as Event);

    this.log.info({ message: `Sync completed for account ${this.accountId}`, totalChats: synced });
  }

  private async ensureContactEnrichedFromTelegram(
    organizationId: string,
    telegramId: string,
  ): Promise<string | null> {
    if (!telegramId?.trim()) return null;
    const existing = await this.pool.query(
      'SELECT id FROM contacts WHERE telegram_id = $1 AND organization_id = $2 LIMIT 1',
      [telegramId, organizationId],
    );
    if (existing.rows.length > 0) return (existing.rows[0] as { id: string }).id;

    let firstName = '';
    let lastName: string | null = null;
    let username: string | null = null;
    let phone: string | null = null;

    const userIdNum = parseInt(telegramId, 10);
    if (this.client?.connected && Number.isInteger(userIdNum) && userIdNum > 0) {
      try {
        const peer = await this.client.getInputEntity(userIdNum);
        const entity = await this.client.getEntity(peer) as any;
        if (entity?.className === 'User' || entity?._ === 'user') {
          firstName = (entity.firstName ?? '').trim();
          lastName = (entity.lastName ?? '').trim() || null;
          username = (entity.username ?? '').trim() || null;
          phone = entity.phone != null ? String(entity.phone).trim() || null : null;
        }
      } catch {
        // Entity resolution failed, insert with minimal data
      }
    }

    const insert = await this.pool.query(
      `INSERT INTO contacts (organization_id, telegram_id, first_name, last_name, username, phone)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (organization_id, telegram_id) WHERE (telegram_id IS NOT NULL AND trim(telegram_id) <> '')
       DO UPDATE SET
         first_name = COALESCE(NULLIF(trim(EXCLUDED.first_name), ''), contacts.first_name),
         last_name = COALESCE(EXCLUDED.last_name, contacts.last_name),
         username = COALESCE(EXCLUDED.username, contacts.username),
         phone = COALESCE(EXCLUDED.phone, contacts.phone),
         updated_at = NOW()
       RETURNING id`,
      [organizationId, telegramId, firstName || '', lastName, username, phone],
    );
    return insert.rows.length > 0 ? (insert.rows[0] as { id: string }).id : null;
  }

  private async ensureConversation(params: {
    organizationId: string; bdAccountId: string; channel: string; channelId: string; contactId: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO conversations (id, organization_id, bd_account_id, channel, channel_id, contact_id, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (organization_id, bd_account_id, channel, channel_id)
       DO UPDATE SET contact_id = COALESCE(EXCLUDED.contact_id, conversations.contact_id), updated_at = NOW()`,
      [params.organizationId, params.bdAccountId, params.channel, params.channelId, params.contactId],
    );
  }

  public async syncHistory(organizationId: string): Promise<void> {
    const SYNC_DELAY_MS = 1100;
    const SYNC_INITIAL_MESSAGES_PER_CHAT = parseInt(process.env.SYNC_INITIAL_MESSAGES_PER_CHAT || '100', 10) || 100;

    if (!this.client?.connected) {
      throw new Error(`Client not connected for account ${this.accountId}`);
    }

    const accRow = await this.pool.query<{ created_by_user_id: string | null }>(
      'SELECT created_by_user_id FROM bd_accounts WHERE id = $1',
      [this.accountId],
    );
    const createdByUserId = accRow.rows[0]?.created_by_user_id ?? null;

    const chatsResult = await this.pool.query(
      'SELECT telegram_chat_id, title, peer_type FROM bd_account_sync_chats WHERE bd_account_id = $1 ORDER BY created_at',
      [this.accountId],
    );
    const chats = chatsResult.rows as { telegram_chat_id: string; title: string; peer_type: string }[];

    if (chats.length === 0) {
      this.log.warn({ message: `No sync chats selected for account ${this.accountId}` });
      return;
    }

    const totalChats = chats.length;

    await this.pool.query(
      `UPDATE bd_accounts SET sync_status = 'syncing', sync_progress_total = $1, sync_progress_done = 0, sync_started_at = NOW(), sync_error = NULL, sync_completed_at = NULL WHERE id = $2`,
      [totalChats, this.accountId],
    );

    this.log.info({ message: `Starting sync history for account ${this.accountId}`, totalChats });

    await this.rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.BD_ACCOUNT_SYNC_STARTED,
      timestamp: new Date(),
      organizationId,
      data: { bdAccountId: this.accountId, totalChats },
    } as unknown as Event);

    if (this.redis && createdByUserId) {
      this.redis.publish(`events:${createdByUserId}`, JSON.stringify({
        event: 'sync_progress',
        data: { bdAccountId: this.accountId, done: 0, total: totalChats },
      })).catch(() => {});
    }

    let totalMessages = 0;
    let failedChatsCount = 0;

    try {
      for (let i = 0; i < chats.length; i++) {
        const chat = chats[i];
        const isUserChat = (chat.peer_type || 'user').toLowerCase() === 'user';
        let fetched = 0;
        const done = i + 1;

        try {
          const peer = await this.resolvePeer(chat.telegram_chat_id);

          if (isUserChat && Number(chat.telegram_chat_id) > 0) {
            await this.ensureContactEnrichedFromTelegram(organizationId, chat.telegram_chat_id);
          }

          let offsetId = 0;
          const cap = SYNC_INITIAL_MESSAGES_PER_CHAT;
          const batchSize = Math.min(100, cap);

          while (fetched < cap) {
            let historyResult: any;
            try {
              historyResult = await telegramInvokeWithFloodRetry(
                this.log, this.accountId, 'GetHistory(sync)',
                () => this.client!.invoke(
                  new Api.messages.GetHistory({
                    peer,
                    limit: Math.min(batchSize, cap - fetched),
                    offsetId,
                    offsetDate: 0,
                    addOffset: 0,
                    maxId: 0,
                    minId: 0,
                    hash: BigInt(0),
                  }),
                ),
              );
            } catch (floodErr: any) {
              if (floodErr?.seconds != null && typeof floodErr.seconds === 'number') {
                await new Promise((r) => setTimeout(r, floodErr.seconds * 1000));
                continue;
              }
              throw floodErr;
            }

            const rawMessages = (historyResult as any)?.messages;
            if (!Array.isArray(rawMessages)) break;

            const list: Api.Message[] = rawMessages.filter(
              (m: any) => m && typeof m === 'object' && (m.className === 'Message' || m instanceof Api.Message)
            );

            for (const msg of list) {
              if (fetched >= cap) break;
              const hasText = !!getMessageText(msg).trim();
              if (!hasText && !msg.media) continue;

              let chatId = chat.telegram_chat_id;
              let senderId = '';
              if (msg.peerId) {
                if (msg.peerId instanceof Api.PeerUser) chatId = String(msg.peerId.userId);
                else if (msg.peerId instanceof Api.PeerChat) chatId = String(msg.peerId.chatId);
                else if (msg.peerId instanceof Api.PeerChannel) chatId = String(msg.peerId.channelId);
              }
              if (msg.fromId instanceof Api.PeerUser) senderId = String(msg.fromId.userId);

              const contactTelegramId = isUserChat ? chatId : (senderId || chatId);
              const contactId = await this.ensureContactEnrichedFromTelegram(organizationId, contactTelegramId);

              const direction = (msg as any).out === true ? 'outbound' : 'inbound';
              const serialized = serializeMessage(msg);

              await this.ensureConversation({
                organizationId,
                bdAccountId: this.accountId,
                channel: 'telegram',
                channelId: chatId,
                contactId,
              });

              const messageId = randomUUID();
              try {
                await this.pool.query(
                  `INSERT INTO messages (
                    id, organization_id, bd_account_id, contact_id, channel, channel_id, direction, content, status, unread,
                    metadata, telegram_message_id, telegram_date, loaded_at, reply_to_telegram_id,
                    telegram_entities, telegram_media, telegram_extra, created_at
                  ) VALUES ($1, $2, $3, $4, 'telegram', $5, $6, $7, 'delivered', false,
                    $8, $9, $10, NOW(), $11, $12, $13, $14, COALESCE($10, NOW()))`,
                  [
                    messageId,
                    organizationId,
                    this.accountId,
                    contactId,
                    chatId,
                    direction,
                    serialized.content,
                    JSON.stringify({ senderId, hasMedia: !!msg.media }),
                    serialized.telegram_message_id || null,
                    serialized.telegram_date,
                    serialized.reply_to_telegram_id,
                    serialized.telegram_entities ? JSON.stringify(serialized.telegram_entities) : null,
                    serialized.telegram_media ? JSON.stringify(serialized.telegram_media) : null,
                    Object.keys(serialized.telegram_extra).length ? JSON.stringify(serialized.telegram_extra) : null,
                  ],
                );
                fetched++;
                totalMessages++;
              } catch {
                // Skip duplicates / constraint violations on re-sync
              }
            }

            if (list.length === 0) break;
            offsetId = Number((list[list.length - 1] as any).id) || 0;
            await new Promise((r) => setTimeout(r, SYNC_DELAY_MS));
          }

          this.log.info({
            message: `Chat ${done}/${totalChats} done: ${chat.title}, messages: ${fetched}`,
            account_id: this.accountId,
            chat_id: chat.telegram_chat_id,
          });
        } catch (chatErr: any) {
          failedChatsCount++;
          this.log.warn({
            message: `Failed to sync chat ${chat.telegram_chat_id}`,
            account_id: this.accountId,
            error: chatErr?.message || String(chatErr),
          });
        }

        await this.pool.query(
          'UPDATE bd_accounts SET sync_progress_done = $1 WHERE id = $2',
          [done, this.accountId],
        );

        await this.rabbitmq.publishEvent({
          id: randomUUID(),
          type: EventType.BD_ACCOUNT_SYNC_PROGRESS,
          timestamp: new Date(),
          organizationId,
          data: { bdAccountId: this.accountId, done, total: totalChats, currentChatId: chat.telegram_chat_id, currentChatTitle: chat.title },
        } as unknown as Event);

        if (this.redis && createdByUserId) {
          this.redis.publish(`events:${createdByUserId}`, JSON.stringify({
            event: 'sync_progress',
            data: { bdAccountId: this.accountId, done, total: totalChats },
          })).catch(() => {});
        }

        if (i < chats.length - 1) {
          await new Promise((r) => setTimeout(r, SYNC_DELAY_MS));
        }
      }

      await this.pool.query(
        `UPDATE bd_accounts SET sync_status = 'completed', sync_progress_done = $1, sync_completed_at = NOW() WHERE id = $2`,
        [totalChats, this.accountId],
      );

      await this.rabbitmq.publishEvent({
        id: randomUUID(),
        type: EventType.BD_ACCOUNT_SYNC_COMPLETED,
        timestamp: new Date(),
        organizationId,
        data: { bdAccountId: this.accountId, totalChats, totalMessages, failedChats: failedChatsCount },
      } as unknown as Event);

      if (this.redis && createdByUserId) {
        this.redis.publish(`events:${createdByUserId}`, JSON.stringify({
          event: 'sync_progress',
          data: { bdAccountId: this.accountId, done: totalChats, total: totalChats, completed: true },
        })).catch(() => {});
      }

      this.log.info({ message: `Sync history completed for account ${this.accountId}`, totalChats, totalMessages, failedChatsCount });
    } catch (err) {
      await this.pool.query(
        `UPDATE bd_accounts SET sync_status = 'error', sync_error = $1 WHERE id = $2`,
        [String(err).slice(0, 500), this.accountId],
      ).catch(() => {});
      throw err;
    }
  }

  private async handleSearchGroups(payload: SearchGroupsPayload): Promise<void> {
    if (!this.client?.connected) return;

    const query = (payload.query || '').trim();
    const limit = Math.min(payload.limit || 50, 100);

    this.log.info({ message: `Searching groups for account ${this.accountId}`, query });

    const result = await telegramInvokeWithFloodRetry(
      this.log,
      this.accountId,
      'contacts.Search',
      () => this.client!.invoke(new Api.contacts.Search({ q: query, limit })),
    ) as any;

    const chats = result?.chats ?? [];
    const mapped = chats.map((c: any) => ({
      chatId: String(c.id),
      title: (c.title ?? c.name ?? '').trim(),
      peerType: c.broadcast ? 'channel' : c.megagroup ? 'group' : 'chat',
      membersCount: c.participantsCount ?? c.participants_count ?? undefined,
      username: (c.username ?? '').trim() || undefined,
    }));

    this.log.info({ message: `Search completed for account ${this.accountId}`, query, results: mapped.length });
  }

  private async handleGetParticipants(payload: GetParticipantsPayload): Promise<void> {
    if (!this.client?.connected) return;

    const limit = Math.min(payload.limit || 200, 200);
    const offset = payload.offset || 0;

    this.log.info({ message: `Getting participants for account ${this.accountId}`, chatId: payload.chatId });

    const entity = await this.client.getEntity(this.peerInput(payload.chatId));

    const result = await telegramInvokeWithFloodRetry(
      this.log,
      this.accountId,
      'channels.GetParticipants',
      () => this.client!.invoke(
        new Api.channels.GetParticipants({
          channel: entity,
          filter: new Api.ChannelParticipantsRecent(),
          offset,
          limit,
          hash: BigInt(0),
        }),
      ),
    ) as any;

    const participants = result?.participants ?? [];
    const users = result?.users ?? [];
    const userMap = new Map<number, any>();
    for (const u of users) {
      const id = u.id ?? u.userId;
      if (id != null) userMap.set(Number(id), u);
    }

    const mapped = participants
      .map((p: any) => {
        const uid = p.userId;
        if (uid == null) return null;
        const u = userMap.get(Number(uid));
        if (u?.deleted || u?.bot) return null;
        return {
          telegramId: String(uid),
          username: (u?.username ?? '').trim() || undefined,
          firstName: (u?.firstName ?? u?.first_name ?? '').trim() || undefined,
          lastName: (u?.lastName ?? u?.last_name ?? '').trim() || undefined,
        };
      })
      .filter(Boolean);

    this.log.info({ message: `GetParticipants completed for account ${this.accountId}`, chatId: payload.chatId, count: mapped.length });
  }

  private async handleResolveUsername(payload: ResolveUsernamePayload): Promise<void> {
    if (!this.client?.connected) return;

    const username = (payload.username ?? '').trim().replace(/^@/, '');
    this.log.info({ message: `Resolving username for account ${this.accountId}`, username });

    const entity = await this.client.getEntity(username) as any;

    const resolved = {
      id: entity.id != null ? String(entity.id) : null,
      className: entity.className ?? null,
      username: entity.username ?? null,
      firstName: entity.firstName ?? entity.first_name ?? null,
      lastName: entity.lastName ?? entity.last_name ?? null,
      title: entity.title ?? null,
      phone: entity.phone ?? null,
    };

    this.log.info({ message: `Username resolved for account ${this.accountId}`, username, resolved_id: resolved.id });
  }

  private async handleDeleteMessage(payload: DeleteMessagePayload): Promise<void> {
    if (!this.client?.connected) return;

    const peer = await this.resolvePeer(payload.channelId);

    if (peer?.className === 'InputPeerChannel') {
      await telegramInvokeWithFloodRetry(this.log, this.accountId, 'channels.DeleteMessages', () =>
        this.client!.invoke(new Api.channels.DeleteMessages({
          channel: peer,
          id: [payload.telegramMessageId],
        })),
      );
    } else {
      await telegramInvokeWithFloodRetry(this.log, this.accountId, 'messages.DeleteMessages', () =>
        this.client!.invoke(new Api.messages.DeleteMessages({
          id: [payload.telegramMessageId],
          revoke: true,
        })),
      );
    }

    this.log.info({ message: `Deleted message ${payload.telegramMessageId}`, accountId: this.accountId, channelId: payload.channelId });
  }

  private async handleSendReaction(payload: SendReactionPayload): Promise<void> {
    if (!this.client?.connected) return;

    const peer = await this.resolvePeer(payload.chatId);
    const reactionObjects = payload.reaction.map(
      (emoji) => new Api.ReactionEmoji({ emoticon: emoji }),
    );

    try {
      await telegramInvokeWithFloodRetry(this.log, this.accountId, 'SendReaction', () =>
        this.client!.invoke(new Api.messages.SendReaction({
          peer,
          msgId: payload.telegramMessageId,
          reaction: reactionObjects,
        })),
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      if (errMsg.includes('REACTION_INVALID') || (err as any)?.errorMessage === 'REACTION_INVALID') {
        this.log.warn({ message: 'Reaction not applied (REACTION_INVALID)', accountId: this.accountId });
        return;
      }
      throw err;
    }
  }

  private async handleSaveDraft(payload: SaveDraftPayload): Promise<void> {
    if (!this.client?.connected) return;

    const peer = await this.resolvePeer(payload.channelId);
    const replyToMsgId = payload.replyToMsgId != null ? Number(payload.replyToMsgId) : undefined;

    await telegramInvokeWithFloodRetry(this.log, this.accountId, 'SaveDraft', () =>
      this.client!.invoke(new Api.messages.SaveDraft({
        peer,
        message: payload.text || '',
        ...(replyToMsgId ? { replyToMsgId } : {}),
      })),
    );

    this.log.info({ message: 'Draft saved', accountId: this.accountId, channelId: payload.channelId });
  }

  private async handleForwardMessage(payload: ForwardMessagePayload): Promise<void> {
    if (!this.client?.connected) return;

    const fromPeer = await this.resolvePeer(payload.fromChatId);
    const toPeer = await this.resolvePeer(payload.toChatId);

    await telegramInvokeWithFloodRetry(this.log, this.accountId, 'ForwardMessages', () =>
      this.client!.invoke(new Api.messages.ForwardMessages({
        fromPeer,
        toPeer,
        id: [payload.telegramMessageId],
        randomId: [BigInt(Math.floor(Math.random() * 2 ** 52))],
      })),
    );

    this.log.info({ message: 'Message forwarded', accountId: this.accountId, from: payload.fromChatId, to: payload.toChatId });
  }

  private async handleSendBulk(payload: SendBulkPayload): Promise<void> {
    if (!this.client?.connected) return;

    let sent = 0;
    for (const channelId of payload.channelIds) {
      try {
        const peer = await this.resolvePeer(channelId);
        await telegramInvokeWithFloodRetry(this.log, this.accountId, 'SendMessage', () =>
          this.client!.sendMessage(peer, { message: payload.text }),
        );
        sent++;
      } catch (err: unknown) {
        this.log.warn({ message: 'send-bulk: failed for channel', accountId: this.accountId, channelId, error: String(err) });
        if (isFloodWaitError(err)) throw err;
      }
    }

    this.log.info({ message: `Bulk send completed`, accountId: this.accountId, sent, total: payload.channelIds.length });
  }

  private async handleLoadOlderHistory(payload: LoadOlderHistoryPayload): Promise<void> {
    if (!this.client?.connected) return;

    const peer = await this.resolvePeer(payload.chatId);

    const oldestMsg = await this.pool.query(
      `SELECT MIN(telegram_message_id::int) AS min_id FROM messages
       WHERE bd_account_id = $1 AND channel_id = $2 AND channel = 'telegram' AND telegram_message_id IS NOT NULL`,
      [this.accountId, payload.chatId],
    );
    const offsetId = Number(oldestMsg.rows[0]?.min_id) || 0;

    const messages = await telegramInvokeWithFloodRetry(this.log, this.accountId, 'GetHistory(load-older)', () =>
      this.client!.invoke(new Api.messages.GetHistory({
        peer,
        offsetId,
        offsetDate: 0,
        addOffset: 0,
        limit: 50,
        maxId: 0,
        minId: 0,
        hash: BigInt(0),
      })),
    ) as any;

    const rawMsgs = messages?.messages ?? [];
    const list: Api.Message[] = rawMsgs.filter(
      (m: any) => m && typeof m === 'object' && (m.className === 'Message' || m instanceof Api.Message)
    );
    let inserted = 0;
    for (const msg of list) {
      const hasText = !!getMessageText(msg).trim();
      if (!hasText && !msg.media) continue;

      let senderId = '';
      if (msg.fromId instanceof Api.PeerUser) senderId = String(msg.fromId.userId);

      const contactId = await this.ensureContactEnrichedFromTelegram(payload.organizationId, senderId || payload.chatId);
      const direction = (msg as any).out === true ? 'outbound' : 'inbound';
      const serialized = serializeMessage(msg);
      const messageId = randomUUID();

      try {
        await this.pool.query(
          `INSERT INTO messages (
            id, organization_id, bd_account_id, contact_id, channel, channel_id, direction, content, status, unread,
            metadata, telegram_message_id, telegram_date, loaded_at, reply_to_telegram_id,
            telegram_entities, telegram_media, telegram_extra, created_at
          ) VALUES ($1, $2, $3, $4, 'telegram', $5, $6, $7, 'delivered', false,
            $8, $9, $10, NOW(), $11, $12, $13, $14, COALESCE($10, NOW()))`,
          [
            messageId,
            payload.organizationId,
            this.accountId,
            contactId,
            payload.chatId,
            direction,
            serialized.content,
            JSON.stringify({ senderId, hasMedia: !!msg.media }),
            serialized.telegram_message_id || null,
            serialized.telegram_date,
            serialized.reply_to_telegram_id,
            serialized.telegram_entities ? JSON.stringify(serialized.telegram_entities) : null,
            serialized.telegram_media ? JSON.stringify(serialized.telegram_media) : null,
            Object.keys(serialized.telegram_extra).length ? JSON.stringify(serialized.telegram_extra) : null,
          ],
        );
        inserted++;
      } catch {
        // Duplicate or constraint violation — skip
      }
    }

    const exhausted = list.length === 0 || list.length < 50;
    if (exhausted) {
      await this.pool.query(
        'UPDATE bd_account_sync_chats SET history_exhausted = true WHERE bd_account_id = $1 AND telegram_chat_id = $2',
        [this.accountId, payload.chatId],
      ).catch(() => {});
    }

    this.log.info({ message: 'Loaded older history', accountId: this.accountId, chatId: payload.chatId, fetched: list.length, inserted, exhausted });
  }

  private async handleDisconnect(_payload: AccountLifecyclePayload): Promise<void> {
    this.log.info({ message: `Disconnect command received for ${this.accountId}` });
    await this.stop();
    await this.pool.query(
      "UPDATE bd_accounts SET connection_state = 'disconnected' WHERE id = $1",
      [this.accountId],
    ).catch(() => {});
  }

  private async handleReconnect(_payload: AccountLifecyclePayload): Promise<void> {
    this.log.info({ message: `Reconnect command received for ${this.accountId}` });

    if (this.client?.connected) {
      await destroyTelegramClient(this.client);
      this.client = null;
    }

    try {
      await this.connect();
      this.state = 'connected';
      await this.pool.query(
        "UPDATE bd_accounts SET connection_state = 'connected', is_active = true WHERE id = $1",
        [this.accountId],
      );
    } catch (err) {
      this.state = 'error';
      this.log.error({ message: `Reconnect failed for ${this.accountId}`, error: String(err) });
      await this.pool.query(
        "UPDATE bd_accounts SET connection_state = 'error', disconnect_reason = $1 WHERE id = $2",
        [String(err).slice(0, 500), this.accountId],
      ).catch(() => {});
    }
  }

  private async handleSpambotCheck(_payload: AccountLifecyclePayload): Promise<void> {
    if (!this.client?.connected) return;

    const SPAMBOT = 'SpamBot';

    try {
      const entity = await this.client.getInputEntity(SPAMBOT);
      await this.client.sendMessage(entity, { message: '/start' });

      await new Promise((r) => setTimeout(r, 3000));

      const history = await this.client.invoke(new Api.messages.GetHistory({
        peer: entity,
        offsetId: 0,
        offsetDate: 0,
        addOffset: 0,
        limit: 3,
        maxId: 0,
        minId: 0,
        hash: BigInt(0),
      })) as any;

      const msgs = history?.messages ?? [];
      const botReply = msgs.find((m: any) => !m.out && m.message)?.message ?? '';
      const isFree = /free|no limits|good news|нет ограничений/i.test(botReply);

      await this.pool.query(
        `UPDATE bd_accounts SET last_spambot_check_at = NOW(), last_spambot_result = $1 WHERE id = $2`,
        [isFree ? 'free' : 'restricted', this.accountId],
      );

      if (!isFree) {
        await this.pool.query(
          `UPDATE bd_accounts SET spam_restricted_at = COALESCE(spam_restricted_at, NOW()), spam_restriction_source = 'spambot_check' WHERE id = $1`,
          [this.accountId],
        );
      }

      this.log.info({ message: `SpamBot check completed`, accountId: this.accountId, result: isFree ? 'free' : 'restricted' });
    } catch (err) {
      this.log.warn({ message: 'SpamBot check failed', accountId: this.accountId, error: String(err) });
    }
  }

  async stop(): Promise<void> {
    this.running = false;

    if (this.sessionSaveInterval) {
      clearInterval(this.sessionSaveInterval);
      this.sessionSaveInterval = null;
    }
    if (this.keepaliveInterval) {
      clearInterval(this.keepaliveInterval);
      this.keepaliveInterval = null;
    }

    if (this.client) {
      await destroyTelegramClient(this.client);
      this.client = null;
    }

    if (this.state !== 'reauth_required') {
      this.state = 'disconnected';
    }
    this.log.info({ message: `Actor stopped for account ${this.accountId}` });
  }
}

function isFloodWaitError(err: unknown): boolean {
  if (err instanceof Error) {
    return err.message.includes('FloodWait') || err.constructor.name === 'FloodWaitError';
  }
  return false;
}

function getFloodWaitSeconds(err: unknown): number {
  if (err && typeof err === 'object' && 'seconds' in err) {
    return (err as { seconds: number }).seconds;
  }
  const match = String(err).match(/(\d+)\s*seconds?/i);
  return match ? parseInt(match[1], 10) : 60;
}
