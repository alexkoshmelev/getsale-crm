import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { EventType, type Event } from '@getsale/events';
import { Logger } from '@getsale/logger';
import { RabbitMQClient } from '@getsale/queue';
import { RedisClient } from '@getsale/cache';
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { NewMessage, Raw, type NewMessageEvent } from 'telegram/events';
import {
  decryptIfNeeded, encryptSession,
  buildTelegramProxy, buildGramJsClientOptions, destroyTelegramClient,
  telegramInvokeWithFloodRetry,
  isFloodWaitError, getFloodWaitSeconds,
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
  CreateSharedChatPayload,
} from './command-types';
import { executeCreateSharedChatTelegram } from './create-shared-chat-executor';
import { doSpambotCheck, handleSpambotCheckWithBackoff } from './spambot-checker';

export { handleSyncHistory, type SyncHandlerDeps } from './sync-handler';

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
  private _spambotCheckInFlight = { current: false };

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
    this.registerOutboundHandler();
    this.registerReadReceiptHandler();
    this.registerDeleteHandler();
    this.registerEditHandler();
    this.registerPresenceHandlers();
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

  private static channelIdFromPeer(peer: any): string | null {
    if (!peer) return null;
    if (peer.userId != null) return String(peer.userId.value ?? peer.userId);
    if (peer.chatId != null) return String(peer.chatId.value ?? peer.chatId);
    if (peer.channelId != null) return String(peer.channelId.value ?? peer.channelId);
    return null;
  }

  private static maxIdFromReadUpdate(event: any): number {
    const n = Number(event?.maxId ?? event?.max_id ?? 0);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  private static normalizeTelegramMessageIds(raw: unknown): number[] {
    const arr = Array.isArray(raw) ? raw : [];
    const out: number[] = [];
    for (const x of arr) {
      const n = typeof x === 'object' && x != null && 'value' in x ? Number((x as { value: unknown }).value) : Number(x);
      if (Number.isFinite(n) && n > 0) out.push(n);
    }
    return [...new Set(out)];
  }

  private registerReadReceiptHandler(): void {
    try {
      this.client!.addEventHandler(
        async (event: any) => {
          try {
            if (!this.client?.connected) return;
            const channelId = AccountActor.channelIdFromPeer(event?.peer);
            const maxId = AccountActor.maxIdFromReadUpdate(event);
            if (!channelId || maxId <= 0) return;
            await this.handleReadOutbox(channelId, maxId, 'UpdateReadHistoryOutbox');
          } catch (err) {
            this.log.warn({ message: 'UpdateReadHistoryOutbox handler error', error: String(err) });
          }
        },
        new Raw({ types: [Api.UpdateReadHistoryOutbox], func: () => true }),
      );
    } catch (err) {
      this.log.warn({ message: 'Could not register UpdateReadHistoryOutbox handler', error: String(err) });
    }

    try {
      this.client!.addEventHandler(
        async (event: any) => {
          try {
            if (!this.client?.connected) return;
            const channelIdRaw = event?.channelId ?? event?.channel_id;
            const channelId = channelIdRaw != null ? String(channelIdRaw.value ?? channelIdRaw) : '';
            const maxId = AccountActor.maxIdFromReadUpdate(event);
            if (!channelId || maxId <= 0) return;
            await this.handleReadOutbox(channelId, maxId, 'UpdateReadChannelOutbox');
          } catch (err) {
            this.log.warn({ message: 'UpdateReadChannelOutbox handler error', error: String(err) });
          }
        },
        new Raw({ types: [Api.UpdateReadChannelOutbox], func: () => true }),
      );
    } catch (err) {
      this.log.warn({ message: 'Could not register UpdateReadChannelOutbox handler', error: String(err) });
    }

    try {
      this.client!.addEventHandler(
        async (event: any) => {
          try {
            if (!this.client?.connected) return;
            const ids = AccountActor.normalizeTelegramMessageIds(event?.messages);
            if (ids.length === 0) return;
            const dateRaw = event?.date ?? event?.Date;
            const readAt =
              dateRaw != null && Number(dateRaw) > 0
                ? new Date(Number(dateRaw) * 1000)
                : new Date();
            await this.handleReadMessageContentsByIds(ids, {
              channelId: null,
              readAt,
              updateKind: 'UpdateReadMessagesContents',
            });
          } catch (err) {
            this.log.warn({ message: 'UpdateReadMessagesContents handler error', error: String(err) });
          }
        },
        new Raw({ types: [Api.UpdateReadMessagesContents], func: () => true }),
      );
    } catch (err) {
      this.log.warn({ message: 'Could not register UpdateReadMessagesContents handler', error: String(err) });
    }

    const UpdateChannelReadMessagesContents = (Api as any).UpdateChannelReadMessagesContents;
    if (UpdateChannelReadMessagesContents) {
      try {
        this.client!.addEventHandler(
          async (event: any) => {
            try {
              if (!this.client?.connected) return;
              const channelIdRaw = event?.channelId ?? event?.channel_id;
              const channelId = channelIdRaw != null ? String(channelIdRaw.value ?? channelIdRaw) : '';
              const ids = AccountActor.normalizeTelegramMessageIds(event?.messages);
              if (!channelId || ids.length === 0) return;
              const dateRaw = event?.date ?? event?.Date;
              const readAt =
                dateRaw != null && Number(dateRaw) > 0
                  ? new Date(Number(dateRaw) * 1000)
                  : new Date();
              await this.handleReadMessageContentsByIds(ids, {
                channelId,
                readAt,
                updateKind: 'UpdateChannelReadMessagesContents',
              });
            } catch (err) {
              this.log.warn({ message: 'UpdateChannelReadMessagesContents handler error', error: String(err) });
            }
          },
          new Raw({ types: [UpdateChannelReadMessagesContents], func: () => true }),
        );
      } catch (err) {
        this.log.warn({ message: 'Could not register UpdateChannelReadMessagesContents handler', error: String(err) });
      }
    }
  }

  private async isChatAllowed(channelId: string): Promise<boolean> {
    if (!channelId) return false;
    const res = await this.pool.query(
      'SELECT 1 FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
      [this.accountId, channelId],
    );
    return res.rows.length > 0;
  }

  private async tryMigrateSyncChatUsernameAliases(numericChatId: string, username: string | null | undefined): Promise<void> {
    const u = (username || '').trim();
    if (!u) return;
    const aliases = [`@${u}`, u];
    try {
      await this.pool.query(
        `UPDATE bd_account_sync_chats SET telegram_chat_id = $3, sync_list_origin = 'outbound_send'
         WHERE bd_account_id = $1 AND telegram_chat_id = ANY($2::text[])`,
        [this.accountId, aliases, numericChatId],
      );
      await this.pool.query(
        `UPDATE messages SET channel_id = $3, updated_at = NOW()
         WHERE bd_account_id = $1 AND channel = 'telegram' AND channel_id = ANY($2::text[])`,
        [this.accountId, aliases, numericChatId],
      );
      await this.pool.query(
        `UPDATE conversations SET channel_id = $3, updated_at = NOW()
         WHERE bd_account_id IS NOT DISTINCT FROM $1::uuid AND channel = 'telegram' AND channel_id = ANY($2::text[])
           AND NOT EXISTS (
             SELECT 1 FROM conversations c2
             WHERE c2.organization_id = conversations.organization_id
               AND c2.bd_account_id IS NOT DISTINCT FROM $1::uuid
               AND c2.channel = 'telegram' AND c2.channel_id = $3
           )`,
        [this.accountId, aliases, numericChatId],
      );
    } catch (err) {
      this.log.warn({ message: 'tryMigrateSyncChatUsernameAliases failed', numericChatId, username: u, error: String(err) });
    }
  }

  private async isChatAllowedWithMigration(chatId: string, event: any): Promise<boolean> {
    let allowed = await this.isChatAllowed(chatId);
    if (!allowed && /^[0-9]+$/.test(chatId) && this.client?.connected) {
      try {
        const ent = await this.client.getEntity(parseInt(chatId, 10));
        if (ent && (ent as { className?: string }).className === 'User') {
          await this.tryMigrateSyncChatUsernameAliases(chatId, (ent as Api.User).username ?? undefined);
          allowed = await this.isChatAllowed(chatId);
        }
      } catch {}
    }
    return allowed;
  }

  private registerOutboundHandler(): void {
    try {
      this.client!.addEventHandler(
        async (event: NewMessageEvent) => {
          try {
            await this.handleOutboundMessage(event);
          } catch (err) {
            this.log.warn({ message: 'Outbound message handler error', error: String(err) });
          }
        },
        new NewMessage({ incoming: false }),
      );
    } catch (err) {
      this.log.warn({ message: `Could not register outbound handler for ${this.accountId}`, error: String(err) });
    }
  }

  private async handleOutboundMessage(event: NewMessageEvent): Promise<void> {
    const msg = event.message;
    if (!msg) return;

    const chatId = msg.chatId?.toString() ?? '';
    if (!chatId) return;

    const text = msg.text ?? '';
    const messageId = randomUUID();
    const serialized = serializeMessage(msg);

    await this.pool.query(
      `INSERT INTO messages
        (id, organization_id, content, direction, bd_account_id, channel_id, channel, telegram_message_id,
         telegram_entities, telegram_media, reply_to_telegram_id, created_at)
       VALUES ($1, $2, $3, 'outbound', $4, $5, 'telegram', $6, $7, $8, $9, NOW())
       ON CONFLICT DO NOTHING`,
      [messageId, this.organizationId, text, this.accountId, chatId, msg.id,
       serialized.telegram_entities, serialized.telegram_media, serialized.reply_to_telegram_id],
    );

    await this.ensureConversation({
      organizationId: this.organizationId,
      bdAccountId: this.accountId,
      channel: 'telegram',
      channelId: chatId,
      contactId: null,
    });

    await this.rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.MESSAGE_SENT,
      timestamp: new Date(),
      organizationId: this.organizationId,
      userId: '',
      data: {
        messageId,
        channel: 'telegram',
        channelId: chatId,
        bdAccountId: this.accountId,
        content: text,
        direction: 'outbound',
        telegramMessageId: msg.id,
      },
    } as unknown as Event);
  }

  private registerDeleteHandler(): void {
    try {
      this.client!.addEventHandler(
        async (event: any) => {
          try {
            if (!this.client?.connected) return;
            const ids = event?.messages ?? [];
            if (!Array.isArray(ids) || ids.length === 0) return;
            const telegramIds = ids.map((id: any) => Number(id)).filter((id: number) => id > 0);
            if (telegramIds.length === 0) return;

            const deleted = await this.pool.query(
              `DELETE FROM messages
               WHERE bd_account_id = $1 AND organization_id = $2
                 AND telegram_message_id::text = ANY($3::text[])
               RETURNING id, organization_id, channel_id, telegram_message_id`,
              [this.accountId, this.organizationId, telegramIds.map(String)],
            );

            for (const row of deleted.rows as { id: string; organization_id: string; channel_id: string; telegram_message_id: string }[]) {
              await this.rabbitmq.publishEvent({
                id: randomUUID(),
                type: EventType.MESSAGE_DELETED,
                timestamp: new Date(),
                organizationId: row.organization_id,
                data: { messageId: row.id, bdAccountId: this.accountId, channelId: row.channel_id, telegramMessageId: row.telegram_message_id },
              } as unknown as Event);
            }
          } catch (err) {
            this.log.warn({ message: 'Delete handler error', error: String(err) });
          }
        },
        new Raw({ types: [Api.UpdateDeleteMessages], func: () => true }),
      );
    } catch (err) {
      this.log.warn({ message: `Could not register delete handler for ${this.accountId}`, error: String(err) });
    }

    try {
      const UpdateDeleteChannelMessages = (Api as any).UpdateDeleteChannelMessages;
      if (UpdateDeleteChannelMessages) {
        this.client!.addEventHandler(
          async (event: any) => {
            try {
              if (!this.client?.connected) return;
              const channelIdRaw = event?.channelId;
              const ids = event?.messages ?? [];
              if (channelIdRaw == null || !Array.isArray(ids) || ids.length === 0) return;
              const channelIdStr = String(channelIdRaw.value ?? channelIdRaw);
              const telegramIds = ids.map((id: any) => Number(id)).filter((id: number) => id > 0);
              if (telegramIds.length === 0) return;

              const deleted = await this.pool.query(
                `DELETE FROM messages
                 WHERE bd_account_id = $1 AND organization_id = $2 AND channel_id = $3
                   AND telegram_message_id::text = ANY($4::text[])
                 RETURNING id, organization_id, channel_id, telegram_message_id`,
                [this.accountId, this.organizationId, channelIdStr, telegramIds.map(String)],
              );

              for (const row of deleted.rows as { id: string; organization_id: string; channel_id: string; telegram_message_id: string }[]) {
                await this.rabbitmq.publishEvent({
                  id: randomUUID(),
                  type: EventType.MESSAGE_DELETED,
                  timestamp: new Date(),
                  organizationId: row.organization_id,
                  data: { messageId: row.id, bdAccountId: this.accountId, channelId: row.channel_id, telegramMessageId: row.telegram_message_id },
                } as unknown as Event);
              }
            } catch (err) {
              this.log.warn({ message: 'Delete channel handler error', error: String(err) });
            }
          },
          new Raw({ types: [UpdateDeleteChannelMessages], func: () => true }),
        );
      }
    } catch {
      // UpdateDeleteChannelMessages may not exist in some GramJS versions
    }
  }

  private registerEditHandler(): void {
    try {
      const EditTypes = [Api.UpdateEditMessage, (Api as any).UpdateEditChannelMessage].filter(Boolean);
      if (EditTypes.length === 0) return;

      this.client!.addEventHandler(
        async (update: any) => {
          try {
            if (!this.client?.connected) return;
            const message = update?.message;
            if (!message?.id) return;

            let channelId = '';
            if (message.peerId) {
              if (message.peerId instanceof Api.PeerUser) channelId = String(message.peerId.userId);
              else if (message.peerId instanceof Api.PeerChat) channelId = String(message.peerId.chatId);
              else if (message.peerId instanceof Api.PeerChannel) channelId = String(message.peerId.channelId);
            }

            const content = getMessageText(message) || '';
            const telegramEntities = message.entities ? JSON.stringify(message.entities) : null;
            const telegramMedia = message.media ? JSON.stringify((message.media as any).toJSON?.() ?? message.media) : null;

            const result = await this.pool.query(
              `UPDATE messages
               SET content = $1, telegram_entities = $2, telegram_media = $3, updated_at = NOW()
               WHERE bd_account_id = $4 AND organization_id = $5
                 AND channel_id = $6 AND telegram_message_id = $7::text
               RETURNING id, organization_id`,
              [content, telegramEntities, telegramMedia, this.accountId, this.organizationId, channelId, String(message.id)],
            );

            if (result.rows.length > 0) {
              const row = result.rows[0] as { id: string; organization_id: string };
              await this.rabbitmq.publishEvent({
                id: randomUUID(),
                type: EventType.MESSAGE_EDITED,
                timestamp: new Date(),
                organizationId: row.organization_id,
                data: { messageId: row.id, bdAccountId: this.accountId, channelId, content, telegramMessageId: message.id },
              } as unknown as Event);
            }
          } catch (err) {
            this.log.warn({ message: 'Edit handler error', error: String(err) });
          }
        },
        new Raw({ types: EditTypes, func: () => true }),
      );
    } catch (err) {
      this.log.warn({ message: `Could not register edit handler for ${this.accountId}`, error: String(err) });
    }
  }

  private registerPresenceHandlers(): void {
    const ApiAny = Api as any;
    const publishUpdate = async (data: Record<string, any>) => {
      await this.rabbitmq.publishEvent({
        id: randomUUID(),
        type: EventType.BD_ACCOUNT_TELEGRAM_UPDATE,
        timestamp: new Date(),
        organizationId: this.organizationId,
        data: { ...data, bdAccountId: this.accountId, organizationId: this.organizationId },
      } as unknown as Event);
    };

    // User typing
    if (ApiAny.UpdateUserTyping) {
      try {
        this.client!.addEventHandler(async (event: any) => {
          try {
            const userId = event?.userId ?? event?.user_id;
            const channelId = userId != null ? String(userId.value ?? userId) : '';
            if (!channelId) return;
            const action = event?.action?.className ?? '';
            await publishUpdate({ updateKind: 'typing', channelId, userId: channelId, action: action || undefined });
          } catch {}
        }, new Raw({ types: [ApiAny.UpdateUserTyping], func: () => true }));
      } catch {}
    }

    // Chat typing
    if (ApiAny.UpdateChatUserTyping) {
      try {
        this.client!.addEventHandler(async (event: any) => {
          try {
            const chatIdRaw = event?.chatId ?? event?.chat_id;
            const channelId = chatIdRaw != null ? String(chatIdRaw.value ?? chatIdRaw) : '';
            if (!channelId) return;
            const fromId = event?.fromId ?? event?.from_id;
            let userId: string | undefined;
            if (fromId?.userId != null) userId = String(fromId.userId.value ?? fromId.userId);
            const action = event?.action?.className ?? '';
            await publishUpdate({ updateKind: 'typing', channelId, userId, action: action || undefined });
          } catch {}
        }, new Raw({ types: [ApiAny.UpdateChatUserTyping], func: () => true }));
      } catch {}
    }

    // User status (online/offline)
    if (ApiAny.UpdateUserStatus) {
      try {
        this.client!.addEventHandler(async (event: any) => {
          try {
            const userId = event?.userId ?? event?.user_id;
            if (userId == null) return;
            const status = event?.status?.className ?? '';
            const expires = event?.status?.expires ?? event?.status?.until ?? undefined;
            await publishUpdate({ updateKind: 'user_status', userId: String(userId.value ?? userId), status: status || undefined, expires: typeof expires === 'number' ? expires : undefined });
          } catch {}
        }, new Raw({ types: [ApiAny.UpdateUserStatus], func: () => true }));
      } catch {}
    }

    // Read inbox
    if (ApiAny.UpdateReadHistoryInbox) {
      try {
        this.client!.addEventHandler(async (event: any) => {
          try {
            const peer = event?.peer;
            let channelId = '';
            if (peer?.userId != null) channelId = String(peer.userId.value ?? peer.userId);
            else if (peer?.chatId != null) channelId = String(peer.chatId.value ?? peer.chatId);
            else if (peer?.channelId != null) channelId = String(peer.channelId.value ?? peer.channelId);
            if (!channelId) return;
            const maxId = event?.maxId ?? event?.max_id ?? 0;
            await publishUpdate({ updateKind: 'read_inbox', channelId, maxId });
          } catch {}
        }, new Raw({ types: [ApiAny.UpdateReadHistoryInbox], func: () => true }));
      } catch {}
    }

    // Read channel inbox
    if (ApiAny.UpdateReadChannelInbox) {
      try {
        this.client!.addEventHandler(async (event: any) => {
          try {
            const channelIdRaw = event?.channelId ?? event?.channel_id;
            const channelId = channelIdRaw != null ? String(channelIdRaw.value ?? channelIdRaw) : '';
            if (!channelId) return;
            const maxId = event?.maxId ?? event?.max_id ?? 0;
            await publishUpdate({ updateKind: 'read_channel_inbox', channelId, maxId });
          } catch {}
        }, new Raw({ types: [ApiAny.UpdateReadChannelInbox], func: () => true }));
      } catch {}
    }

    // Draft messages
    if (ApiAny.UpdateDraftMessage) {
      try {
        this.client!.addEventHandler(async (event: any) => {
          try {
            const peer = event?.peer;
            let channelId = '';
            if (peer?.userId != null) channelId = String(peer.userId.value ?? peer.userId);
            else if (peer?.chatId != null) channelId = String(peer.chatId.value ?? peer.chatId);
            if (!channelId) return;
            await publishUpdate({ updateKind: 'draft', channelId });
          } catch {}
        }, new Raw({ types: [ApiAny.UpdateDraftMessage], func: () => true }));
      } catch {}
    }
  }

  private async handleReadOutbox(
    channelId: string,
    maxId: number,
    updateKind: string,
  ): Promise<void> {
    if (!maxId || maxId <= 0) return;
    const readAt = new Date();
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
      const msgCount = result.rowCount ?? 0;
      if (msgCount > 0) {
        this.log.info({
          message: 'Marked messages as read',
          accountId: this.accountId,
          channelId,
          maxId,
          updateKind,
          count: msgCount,
        });
        await this.invalidateCampaignStatsForChannel(channelId);
      } else {
        this.log.info({
          message: 'handleReadOutbox: no message rows updated',
          accountId: this.accountId,
          channelId,
          maxId,
          updateKind,
          log_detail: 'read_receipt_no_rows',
        });
      }

      const csResult = await this.pool.query(
        `UPDATE campaign_sends cs
         SET read_at = $4
         FROM messages m
         WHERE cs.message_id = m.id
           AND m.organization_id = $1
           AND m.bd_account_id = $2
           AND m.channel_id = $3
           AND m.direction = 'outbound'
           AND m.telegram_message_id IS NOT NULL
           AND m.telegram_message_id ~ '^[0-9]+$'
           AND m.telegram_message_id::bigint <= $5
           AND cs.read_at IS NULL`,
        [this.organizationId, this.accountId, channelId, readAt, maxId],
      );
      const csCount = csResult.rowCount ?? 0;
      if (csCount === 0) {
        this.log.info({
          message: 'handleReadOutbox: no campaign_sends rows updated',
          accountId: this.accountId,
          channelId,
          maxId,
          updateKind,
          log_detail: 'read_receipt_no_campaign_sends',
        });
      }
    } catch (err) {
      this.log.warn({
        message: 'handleReadOutbox failed',
        channelId,
        maxId,
        updateKind,
        error: String(err),
      });
    }
  }

  private async handleReadMessageContentsByIds(
    telegramIds: number[],
    ctx: { channelId: string | null; readAt: Date; updateKind: string },
  ): Promise<void> {
    const ids = AccountActor.normalizeTelegramMessageIds(telegramIds);
    if (ids.length === 0) return;

    const { channelId, readAt, updateKind } = ctx;
    const idStrs = ids.map(String);

    try {
      let result: { rows: { channel_id: string }[]; rowCount: number | null };
      if (channelId) {
        result = await this.pool.query<{ channel_id: string }>(
          `UPDATE messages
           SET status = 'read', updated_at = NOW()
           WHERE organization_id = $1 AND bd_account_id = $2
             AND channel_id = $3 AND direction = 'outbound'
             AND telegram_message_id IS NOT NULL
             AND telegram_message_id::text = ANY($4::text[])
             AND status <> 'read'
           RETURNING channel_id`,
          [this.organizationId, this.accountId, channelId, idStrs],
        );
      } else {
        result = await this.pool.query<{ channel_id: string }>(
          `UPDATE messages
           SET status = 'read', updated_at = NOW()
           WHERE organization_id = $1 AND bd_account_id = $2
             AND direction = 'outbound'
             AND telegram_message_id IS NOT NULL
             AND telegram_message_id::text = ANY($3::text[])
             AND status <> 'read'
           RETURNING channel_id`,
          [this.organizationId, this.accountId, idStrs],
        );
      }

      const msgCount = result.rowCount ?? 0;
      if (msgCount > 0) {
        const seen = new Set<string>();
        for (const row of result.rows) {
          if (seen.has(row.channel_id)) continue;
          seen.add(row.channel_id);
          await this.invalidateCampaignStatsForChannel(row.channel_id);
        }
        this.log.info({
          message: 'Marked messages as read (contents)',
          accountId: this.accountId,
          channelId,
          updateKind,
          count: msgCount,
          telegramMessageIds: ids,
        });
      } else {
        this.log.info({
          message: 'handleReadMessageContentsByIds: no message rows updated',
          accountId: this.accountId,
          channelId,
          updateKind,
          telegramMessageIds: ids,
          log_detail: 'read_contents_no_messages',
        });
      }

      let csResult: { rowCount: number | null };
      if (channelId) {
        csResult = await this.pool.query(
          `UPDATE campaign_sends cs
           SET read_at = $4
           FROM messages m
           WHERE cs.message_id = m.id
             AND m.organization_id = $1
             AND m.bd_account_id = $2
             AND m.channel_id = $3
             AND m.direction = 'outbound'
             AND m.telegram_message_id IS NOT NULL
             AND m.telegram_message_id::text = ANY($5::text[])
             AND cs.read_at IS NULL`,
          [this.organizationId, this.accountId, channelId, readAt, idStrs],
        );
      } else {
        csResult = await this.pool.query(
          `UPDATE campaign_sends cs
           SET read_at = $3
           FROM messages m
           WHERE cs.message_id = m.id
             AND m.organization_id = $1
             AND m.bd_account_id = $2
             AND m.direction = 'outbound'
             AND m.telegram_message_id IS NOT NULL
             AND m.telegram_message_id::text = ANY($4::text[])
             AND cs.read_at IS NULL`,
          [this.organizationId, this.accountId, readAt, idStrs],
        );
      }

      const csCount = csResult.rowCount ?? 0;
      if (csCount === 0) {
        this.log.info({
          message: 'handleReadMessageContentsByIds: no campaign_sends rows updated',
          accountId: this.accountId,
          channelId,
          updateKind,
          telegramMessageIds: ids,
          log_detail: 'read_contents_no_campaign_sends',
        });
      }
    } catch (err) {
      this.log.warn({
        message: 'handleReadMessageContentsByIds failed',
        updateKind,
        error: String(err),
      });
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
    if (!chatId) return;

    const text = msg.text ?? '';
    const messageId = randomUUID();

    let senderId = '';
    if (msg.fromId && (msg.fromId as any).userId != null) {
      senderId = String((msg.fromId as any).userId);
    }
    const contactTelegramId = senderId || chatId;
    const contactId = await this.ensureContactEnrichedFromTelegram(this.organizationId, contactTelegramId);

    const serialized = serializeMessage(msg);

    await this.pool.query(
      `INSERT INTO messages
        (id, organization_id, content, direction, bd_account_id, channel_id, channel,
         telegram_message_id, contact_id, telegram_entities, telegram_media, reply_to_telegram_id, created_at)
       VALUES ($1, $2, $3, 'inbound', $4, $5, 'telegram', $6, $7, $8, $9, $10, NOW())
       ON CONFLICT DO NOTHING`,
      [messageId, this.organizationId, text, this.accountId, chatId, msg.id,
       contactId, serialized.telegram_entities, serialized.telegram_media, serialized.reply_to_telegram_id],
    );

    await this.ensureConversation({
      organizationId: this.organizationId,
      bdAccountId: this.accountId,
      channel: 'telegram',
      channelId: chatId,
      contactId,
    });

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
        contactId: contactId ?? undefined,
        content: text,
        direction: 'inbound',
        telegramMessageId: msg.id,
        senderTelegramId: contactTelegramId,
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
    CommandType.CREATE_SHARED_CHAT,
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
        await new Promise((r) => setTimeout(r, wait));
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
        case CommandType.CREATE_SHARED_CHAT:
          await this.handleCreateSharedChat(command.payload as CreateSharedChatPayload);
          break;
        default:
          this.log.warn({ message: `Unknown command type: ${command.type}` });
      }

      if (this.state === 'flood_wait') {
        this.state = 'connected';
        const cleared = await this.pool.query(
          `UPDATE bd_accounts
           SET flood_wait_until = NULL, flood_wait_seconds = NULL, flood_reason = NULL
           WHERE id = $1 AND flood_wait_until IS NOT NULL
           RETURNING id`,
          [this.accountId],
        ).catch(() => ({ rows: [] }));
        if (cleared.rows.length > 0) {
          this.rabbitmq.publishEvent({
            id: randomUUID(),
            type: EventType.BD_ACCOUNT_FLOOD_CLEARED,
            timestamp: new Date(),
            organizationId: this.organizationId,
            userId: '',
            data: { bdAccountId: this.accountId },
          } as unknown as Event).catch(() => {});
          this.log.info({ message: `Flood cleared for account ${this.accountId}` });
        }
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

        // Persist flood_wait_until in DB
        const floodUntil = new Date(Date.now() + seconds * 1000);
        await this.pool.query(
          `UPDATE bd_accounts SET flood_wait_until = $1, flood_wait_seconds = $2,
                  flood_reason = $3, flood_last_at = NOW()
           WHERE id = $4`,
          [floodUntil, seconds, command.type, this.accountId],
        ).catch(() => {});

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
      } else if (isPeerFloodError(err)) {
        this.log.warn({
          message: `PEER_FLOOD for account ${this.accountId}, triggering auto SpamBot check`,
          command_type: command.type,
        });

        this.handleSpambotCheckWithBackoff().catch((e) => {
          this.log.warn({ message: 'Auto SpamBot check after PEER_FLOOD failed', error: String(e) });
        });

        if (command.type === CommandType.SEND_MESSAGE && (command.payload as any)?.participantId) {
          const pid = (command.payload as any).participantId;
          await this.pool.query(
            `UPDATE campaign_sends SET status = 'failed'
             WHERE id = (SELECT id FROM campaign_sends WHERE campaign_participant_id = $1 AND status = 'queued' ORDER BY sent_at DESC LIMIT 1)`,
            [pid],
          ).catch(() => {});
          await this.pool.query(
            "UPDATE campaign_participants SET status = 'failed', failed_at = NOW(), last_error = 'PEER_FLOOD', updated_at = NOW() WHERE id = $1 AND status NOT IN ('replied','sent')",
            [pid],
          ).catch(() => {});
        }
      } else {
        this.log.error({
          message: `Command execution failed for ${this.accountId}`,
          command_type: command.type,
          error: String(err),
        });

        if (command.type === CommandType.SEND_MESSAGE && (command.payload as any)?.participantId) {
          const participantId = (command.payload as any).participantId;
          const errorText = String(err).slice(0, 500);
          await this.pool.query(
            `UPDATE campaign_sends SET status = 'failed'
             WHERE id = (
               SELECT id FROM campaign_sends
               WHERE campaign_participant_id = $1 AND status = 'queued'
               ORDER BY sent_at DESC LIMIT 1
             )`,
            [participantId],
          ).catch(() => {});
          await this.pool.query(
            "UPDATE campaign_participants SET status = 'failed', failed_at = NOW(), last_error = $2, updated_at = NOW() WHERE id = $1 AND status NOT IN ('replied', 'sent')",
            [participantId, errorText],
          ).catch(() => {});
        }
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

  private async handleCreateSharedChat(payload: CreateSharedChatPayload): Promise<void> {
    if (!this.client?.connected) {
      throw new Error(`Client not connected for account ${this.accountId}`);
    }
    const { organizationId, conversationId, title, leadTelegramUserId, leadUsername, extraUsernames } = payload;

    const convRes = await this.pool.query(
      `SELECT id, channel_id, bd_account_id, contact_id, organization_id, shared_chat_created_at
       FROM conversations WHERE id = $1 AND organization_id = $2`,
      [conversationId, organizationId],
    );
    if (!convRes.rows.length) {
      this.log.warn({ message: 'CREATE_SHARED_CHAT: conversation not found', conversationId, organizationId });
      return;
    }
    const row = convRes.rows[0] as {
      channel_id: string;
      bd_account_id: string | null;
      contact_id: string | null;
      shared_chat_created_at: Date | null;
    };
    if (row.shared_chat_created_at != null) {
      this.log.info({ message: 'CREATE_SHARED_CHAT: already created, skipping', conversationId });
      return;
    }
    const bdAccountId = row.bd_account_id ?? this.accountId;
    if (bdAccountId !== this.accountId) {
      this.log.warn({ message: 'CREATE_SHARED_CHAT: bd account mismatch', expected: this.accountId, got: bdAccountId });
      return;
    }

    const result = await executeCreateSharedChatTelegram({
      client: this.client,
      pool: this.pool,
      log: this.log,
      bdAccountId: this.accountId,
      title,
      leadTelegramUserId,
      leadUsername,
      extraUsernames: extraUsernames ?? [],
    });

    const systemContent = `[System] Shared chat created: ${title}`;
    await this.pool.query(
      `UPDATE conversations
       SET shared_chat_created_at = NOW(),
           shared_chat_invite_link = $1,
           shared_chat_channel_id = $2::bigint,
           updated_at = NOW()
       WHERE id = $3 AND organization_id = $4`,
      [result.inviteLink, result.sharedChatChannelIdForDb, conversationId, organizationId],
    );

    await this.pool.query(
      `INSERT INTO messages (id, organization_id, bd_account_id, channel, channel_id, contact_id, direction, content, status, unread, metadata)
       VALUES (gen_random_uuid(), $1, $2, 'telegram', $3, $4, 'outbound', $5, 'delivered', false, $6::jsonb)`,
      [
        organizationId,
        this.accountId,
        row.channel_id,
        row.contact_id,
        systemContent,
        JSON.stringify({ system: true, event: 'shared_chat_created', title }),
      ],
    );

    this.log.info({
      message: 'CREATE_SHARED_CHAT completed',
      conversationId,
      inviteLink: result.inviteLink != null,
    });
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

    let sentMessage: any;

    if (payload.fileBase64 && payload.mediaType) {
      const fileBuffer = Buffer.from(payload.fileBase64, 'base64');
      const sendFileParams: Record<string, unknown> = {
        file: new Api.InputFile({
          id: BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)) as any,
          parts: 1,
          name: payload.fileName || 'file',
          md5Checksum: '',
        }),
        caption: payload.text || '',
        forceDocument: false,
      };
      if (payload.replyTo) sendFileParams.replyTo = payload.replyTo;

      if (payload.mediaType === 'voice') {
        sendFileParams.voiceNote = true;
        sendFileParams.attributes = [new Api.DocumentAttributeAudio({
          voice: true,
          duration: payload.mediaDuration || 0,
        })];
      } else if (payload.mediaType === 'video_note') {
        sendFileParams.videoNote = true;
        sendFileParams.attributes = [new Api.DocumentAttributeVideo({
          roundMessage: true,
          duration: payload.mediaDuration || 0,
          w: 384,
          h: 384,
        })];
      }

      sentMessage = await telegramInvokeWithFloodRetry(
        this.log,
        this.accountId,
        'SendFile',
        () => this.client!.sendFile(peer, { ...sendFileParams, file: fileBuffer }),
      );
    } else {
      const params: Record<string, unknown> = { message: payload.text };
      if (payload.replyTo) {
        params.replyTo = payload.replyTo;
      }

      sentMessage = await telegramInvokeWithFloodRetry(
        this.log,
        this.accountId,
        'SendMessage',
        () => this.client!.sendMessage(peer, params),
      );
    }

    const telegramMessageId = sentMessage?.id ?? null;
    const resolvedChatId = sentMessage?.chatId?.toString() ?? chatId;
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
          [messageId, payload.organizationId, payload.text, this.accountId, resolvedChatId, telegramMessageId],
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
        channelId: resolvedChatId,
        bdAccountId: this.accountId,
        content: payload.text,
        direction: 'outbound',
        telegramMessageId,
      },
    } as unknown as Event);

    if ((payload as any).participantId) {
      try {
        await this.pool.query(
          `UPDATE campaign_sends SET message_id = $1, status = 'sent'
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

      try {
        await this.pool.query(
          `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, peer_type, sync_list_origin)
           VALUES ($1, $2, 'user', 'outbound_send')
           ON CONFLICT (bd_account_id, telegram_chat_id) DO NOTHING`,
          [this.accountId, resolvedChatId],
        );
      } catch (syncErr) {
        this.log.warn({ message: 'Failed to add chat to sync_chats', error: String(syncErr), resolvedChatId });
      }

      if (resolvedChatId !== chatId) {
        try {
          await this.pool.query(
            `UPDATE campaign_participants SET channel_id = $1, updated_at = NOW()
             WHERE id = $2 AND (channel_id IS NULL OR channel_id <> $1)`,
            [resolvedChatId, (payload as any).participantId],
          );
        } catch (chErr) {
          this.log.warn({ message: 'Failed to update participant channel_id', error: String(chErr) });
        }
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

  /**
   * Full implementation lives here; future refactor should delegate to `handleSyncHistory` in
   * `./sync-handler.ts` with a populated `SyncHandlerDeps`.
   */
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
                    hash: BigInt(0) as any,
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
          hash: BigInt(0) as any,
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
        randomId: [BigInt(Math.floor(Math.random() * 2 ** 52)) as any],
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
        hash: BigInt(0) as any,
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
    await doSpambotCheck({
      client: this.client,
      pool: this.pool,
      log: this.log,
      accountId: this.accountId,
      rateLimiter: this.rateLimiter,
    });
  }

  private async handleSpambotCheckWithBackoff(): Promise<void> {
    await handleSpambotCheckWithBackoff({
      pool: this.pool,
      log: this.log,
      accountId: this.accountId,
      organizationId: this.organizationId,
      rabbitmq: this.rabbitmq,
      doSpambotCheck: () =>
        doSpambotCheck({
          client: this.client,
          pool: this.pool,
          log: this.log,
          accountId: this.accountId,
          rateLimiter: this.rateLimiter,
        }),
      spambotCheckInFlight: this._spambotCheckInFlight,
    });
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

function isPeerFloodError(err: unknown): boolean {
  const msg = String(err);
  return msg.includes('PEER_FLOOD') || msg.includes('PeerFloodError');
}
