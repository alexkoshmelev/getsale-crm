// @ts-nocheck — telegram (GramJS) types are incomplete; remove when @types/telegram or package types are used
import { TelegramClient, Api } from 'telegram';
import { NewMessage, Raw } from 'telegram/events';
import { StringSession } from 'telegram/sessions';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { RabbitMQClient, RedisClient } from '@getsale/utils';
import { encryptSession, decryptIfNeeded } from './crypto';
import { Logger } from '@getsale/logger';
import {
  EventType,
  Event,
  MessageReceivedEvent,
  MessageDeletedEvent,
  MessageEditedEvent,
  BDAccountTelegramUpdateEvent,
  BDAccountSyncStartedEvent,
  BDAccountSyncProgressEvent,
  BDAccountSyncCompletedEvent,
  BDAccountSyncFailedEvent,
} from '@getsale/events';
import { MessageChannel, MessageDirection, MessageStatus } from '@getsale/types';
import { serializeMessage, getMessageText, SerializedTelegramMessage } from './telegram-serialize';

function formatLogArgs(...args: unknown[]): string {
  return args.map(a => {
    if (a instanceof Error) return a.message;
    if (typeof a === 'object' && a !== null) { try { return JSON.stringify(a); } catch { return String(a); } }
    return String(a);
  }).join(' ');
}

interface ProxyConfig {
  type: 'socks5' | 'http';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

function buildTelegramProxy(cfg: ProxyConfig | null | undefined): Record<string, unknown> | undefined {
  if (!cfg || !cfg.host || !cfg.port) return undefined;
  if (cfg.type === 'socks5') {
    return {
      ip: cfg.host,
      port: cfg.port,
      socksType: 5,
      ...(cfg.username ? { username: cfg.username } : {}),
      ...(cfg.password ? { password: cfg.password } : {}),
    };
  }
  return {
    ip: cfg.host,
    port: cfg.port,
    MTProxy: false,
    ...(cfg.username ? { username: cfg.username } : {}),
    ...(cfg.password ? { password: cfg.password } : {}),
  };
}

interface StructuredLog {
  info(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/** Преобразует реакции из telegram_extra.reactions в наш JSONB { "👍": 2, "❤️": 1 }. */
function reactionsFromTelegramExtra(telegram_extra: Record<string, unknown> | undefined): Record<string, number> | null {
  if (!telegram_extra || typeof telegram_extra !== 'object') return null;
  const raw = telegram_extra.reactions as any;
  if (!raw || typeof raw !== 'object') return null;
  const results = Array.isArray(raw.results) ? raw.results : [];
  const out: Record<string, number> = {};
  for (const r of results) {
    if (!r || typeof r !== 'object') continue;
    const count = typeof r.count === 'number' ? r.count : 0;
    const reaction = r.reaction;
    const emoji = reaction?.emoticon ?? reaction?.emoji;
    if (typeof emoji === 'string' && emoji.length > 0 && count > 0) {
      out[emoji] = (out[emoji] || 0) + count;
    }
  }
  return Object.keys(out).length ? out : null;
}

/** Реакции, поставленные текущим пользователем (по chosen_order в results). До 3. */
function ourReactionsFromTelegramExtra(telegram_extra: Record<string, unknown> | undefined): string[] | null {
  if (!telegram_extra || typeof telegram_extra !== 'object') return null;
  const raw = telegram_extra.reactions as any;
  if (!raw || typeof raw !== 'object') return null;
  const results = Array.isArray(raw.results) ? raw.results : [];
  const withOrder: { order: number; emoji: string }[] = [];
  for (const r of results) {
    const order = r?.chosen_order ?? r?.chosenOrder;
    if (order == null || typeof order !== 'number') continue;
    const reaction = r.reaction;
    const emoji = reaction?.emoticon ?? reaction?.emoji;
    if (typeof emoji === 'string' && emoji.length > 0) {
      withOrder.push({ order, emoji });
    }
  }
  if (withOrder.length === 0) return null;
  withOrder.sort((a, b) => a.order - b.order);
  return withOrder.map((x) => x.emoji).slice(0, 3);
}

/** Resolved source for parse flow: type, capabilities, linked discussion group. */
export type TelegramSourceType = 'channel' | 'public_group' | 'private_group' | 'comment_group' | 'unknown';

export interface ResolvedSource {
  input: string;
  type: TelegramSourceType;
  title: string;
  username?: string;
  chatId: string;
  membersCount?: number;
  linkedChatId?: number;
  canGetMembers: boolean;
  canGetMessages: boolean;
}

interface TelegramClientInfo {
  client: TelegramClient;
  accountId: string;
  organizationId: string;
  userId: string;
  phoneNumber: string;
  isConnected: boolean;
  lastActivity: Date;
  reconnectAttempts: number;
  /** Value used for Redis lock (instanceId); used for refresh and release. */
  lockValue?: string;
}

/** Состояние QR-логина (см. https://core.telegram.org/api/qr-login) */
export interface QrLoginState {
  status: 'pending' | 'qr' | 'need_password' | 'success' | 'expired' | 'error';
  loginTokenUrl?: string;
  expiresAt?: number;
  accountId?: string;
  error?: string;
  /** Подсказка для пароля 2FA (показывается на фронте) */
  passwordHint?: string;
}

export class TelegramManager {
  private clients: Map<string, TelegramClientInfo> = new Map();
  private pool: Pool;
  private rabbitmq: RabbitMQClient;
  private log: StructuredLog;
  private reconnectIntervals: Map<string, NodeJS.Timeout> = new Map();
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_DELAY = 5000; // 5 seconds
  /** Debounce: reconnect all clients after TIMEOUT from update loop (restart loops) */
  private reconnectAllTimeout: NodeJS.Timeout | null = null;
  private readonly RECONNECT_ALL_DEBOUNCE_MS = 12000; // 12 sec — не чаще раза в 12 сек
  /** Per-account debounce: reconnect only the account that hit TIMEOUT (avoid killing other accounts' long requests) */
  private reconnectOneAfterTimeoutTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private readonly RECONNECT_ONE_DEBOUNCE_MS = 8000;

  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly CLEANUP_INTERVAL = 60000; // 1 minute

  private sessionSaveInterval: NodeJS.Timeout | null = null;
  private readonly SESSION_SAVE_INTERVAL = 300000; // 5 minutes - save sessions periodically

  /** Интервалы вызова updates.GetState() для поддержания потока апдейтов (Telegram перестаёт слать, если нет активности). */
  private updateKeepaliveIntervals: Map<string, NodeJS.Timeout> = new Map();
  private readonly UPDATE_KEEPALIVE_MS = 60 * 1000; // 1 минута — чаще пинг, меньше TIMEOUT в update loop (см. план TIMEOUT)

  /** Кэш GetDialogFilters по аккаунту (один запрос на getDialogFilters/getDialogFilterRaw/getDialogFilterPeerIds). */
  private dialogFiltersCache: Map<string, { ts: number; filters: any[] }> = new Map();
  private readonly DIALOG_FILTERS_CACHE_TTL_MS = 90 * 1000; // 90 сек

  /** Сессии QR-логина: sessionId -> состояние + резолвер для пароля 2FA */
  private qrSessions: Map<string, QrLoginState & {
    organizationId: string;
    userId: string;
    apiId: number;
    apiHash: string;
    passwordResolve?: (password: string) => void;
  }> = new Map();
  private readonly QR_SESSION_TTL_MS = 120000; // 2 минуты на сканирование
  private readonly redis: RedisClient | null;
  private static readonly QR_REDIS_PREFIX = 'qr:';
  private static readonly QR_REDIS_TTL = 300; // 5 min
  private static readonly QR_PASSWORD_TTL = 120; // 2 min for password submit

  /** Distributed lock so only one instance owns a BD account at a time (horizontal scaling). */
  private static readonly LOCK_KEY_PREFIX = 'bd-account-lock:';
  private static readonly LOCK_TTL_SEC = 45;
  private static readonly LOCK_HEARTBEAT_SEC = 20;
  private readonly instanceId: string;
  private lockHeartbeatIntervals: Map<string, NodeJS.Timeout> = new Map();

  constructor(pool: Pool, rabbitmq: RabbitMQClient, redis?: RedisClient | null, logger?: Logger) {
    this.pool = pool;
    this.rabbitmq = rabbitmq;
    this.redis = redis ?? null;
    this.instanceId = process.env.INSTANCE_ID || `pid-${process.pid}-${randomUUID().slice(0, 8)}`;
    const svcLog: Logger = logger ?? { info() {}, warn() {}, error() {} } as Logger;
    this.log = {
      info: (...args: unknown[]) => svcLog.info({ message: formatLogArgs(...args) }),
      error: (...args: unknown[]) => svcLog.error({ message: formatLogArgs(...args) }),
      warn: (...args: unknown[]) => svcLog.warn({ message: formatLogArgs(...args) }),
    };
    this.startCleanupInterval();
    this.startSessionSaveInterval();
  }

  private lockKey(accountId: string): string {
    return TelegramManager.LOCK_KEY_PREFIX + accountId;
  }

  /** True if redis client supports distributed lock (tryLock/refreshLock). Avoids "tryLock is not a function" when using an older @getsale/utils build. */
  private get redisHasLockSupport(): boolean {
    return !!(
      this.redis &&
      typeof (this.redis as { tryLock?: unknown }).tryLock === 'function' &&
      typeof (this.redis as { refreshLock?: unknown }).refreshLock === 'function'
    );
  }

  private async acquireLock(accountId: string): Promise<boolean> {
    if (!this.redisHasLockSupport) return true;
    const key = this.lockKey(accountId);
    const ok = await this.redis!.tryLock(key, this.instanceId, TelegramManager.LOCK_TTL_SEC);
    if (!ok) this.log.warn({ message: `Could not acquire lock for account ${accountId} (owned by another instance)` });
    return ok;
  }

  private async releaseLock(accountId: string): Promise<void> {
    if (!this.redis || !this.redisHasLockSupport) return;
    await this.redis.del(this.lockKey(accountId));
  }

  private startLockHeartbeat(accountId: string, lockValue: string): void {
    this.stopLockHeartbeat(accountId);
    if (!this.redisHasLockSupport) return;
    const key = this.lockKey(accountId);
    const interval = setInterval(async () => {
      if (!this.redis) return;
      const refreshed = await this.redis.refreshLock(key, lockValue, TelegramManager.LOCK_TTL_SEC);
      if (!refreshed) {
        this.log.warn({ message: `Lock lost for account ${accountId}, stopping heartbeat` });
        this.stopLockHeartbeat(accountId);
      }
    }, TelegramManager.LOCK_HEARTBEAT_SEC * 1000);
    this.lockHeartbeatIntervals.set(accountId, interval);
  }

  private stopLockHeartbeat(accountId: string): void {
    const interval = this.lockHeartbeatIntervals.get(accountId);
    if (interval) {
      clearInterval(interval);
      this.lockHeartbeatIntervals.delete(accountId);
    }
  }

  /**
   * Send authentication code to phone number
   */
  async sendCode(
    accountId: string,
    organizationId: string,
    userId: string,
    phoneNumber: string,
    apiId: number,
    apiHash: string,
    proxyConfigRaw?: ProxyConfig | null
  ): Promise<{ phoneCodeHash: string }> {
    try {
      if (this.clients.has(accountId)) {
        await this.disconnectAccount(accountId);
      }

      const proxy = buildTelegramProxy(proxyConfigRaw);
      const session = new StringSession('');
      const client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
        retryDelay: 1000,
        timeout: 30000,
        ...(proxy ? { proxy } : {}),
      });

      // Connect client with proper error handling for datacenter migration
      try {
        await client.connect();
        this.log.info({ message: `Connected client for sending code to ${phoneNumber}` });
        
        // Wait a bit for connection to stabilize and avoid builder.resolve errors
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error: any) {
        // If connection fails, clean up and rethrow
        this.log.error({ message: `Connection error for ${phoneNumber}`, error: error.message });
        throw error;
      }

      // Send code using the API
      const result = await client.invoke(
        new Api.auth.SendCode({
          phoneNumber,
          apiId,
          apiHash,
          settings: new Api.CodeSettings({}),
        })
      );

      const phoneCodeHash = (result as Api.auth.SentCode).phoneCodeHash;

      // Store temporary client info (not fully connected yet)
      const clientInfo: TelegramClientInfo = {
        client,
        accountId,
        organizationId,
        userId,
        phoneNumber,
        isConnected: false,
        lastActivity: new Date(),
        reconnectAttempts: 0,
      };

      this.clients.set(accountId, clientInfo);

      return { phoneCodeHash };
    } catch (error: any) {
      this.log.error({ message: `Error sending code for account ${accountId}`, error: error?.message || String(error) });
      await this.updateAccountStatus(accountId, 'error', error.message || 'Failed to send code');
      throw error;
    }
  }

  /**
   * Sign in with phone code
   */
  async signIn(
    accountId: string,
    phoneNumber: string,
    phoneCode: string,
    phoneCodeHash: string
  ): Promise<{ requiresPassword: boolean }> {
    try {
      const clientInfo = this.clients.get(accountId);
      if (!clientInfo || !clientInfo.client) {
        throw new Error('Client not found. Please send code first.');
      }

      const client = clientInfo.client;

      // Sign in with code - DO NOT set up event handlers before sign in
      // Event handlers should only be set up AFTER successful authentication
      // to avoid builder.resolve errors during datacenter migration
      let result: Api.auth.Authorization;
      try {
        result = await client.invoke(
          new Api.auth.SignIn({
            phoneNumber,
            phoneCodeHash,
            phoneCode,
          })
        );
      } catch (error: any) {
        // Check for specific Telegram errors
        if (error.errorMessage === 'PHONE_CODE_INVALID') {
          throw new Error('Неверный код подтверждения. Пожалуйста, запросите новый код.');
        }
        if (error.errorMessage === 'PHONE_CODE_EXPIRED') {
          throw new Error('Код подтверждения истек. Пожалуйста, запросите новый код.');
        }
        if (error.errorMessage === 'PHONE_NUMBER_INVALID') {
          throw new Error('Неверный номер телефона.');
        }
        // Check if password is required
        if (error.errorMessage === 'SESSION_PASSWORD_NEEDED' || error.code === 401) {
          return { requiresPassword: true };
        }
        throw error;
      }

      // If we get here, sign in was successful
      if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        throw new Error('Account not found. Please sign up first.');
      }

      const auth = result as Api.auth.Authorization;
      const user = auth.user as Api.User;

      // Update client info
      clientInfo.isConnected = true;
      clientInfo.phoneNumber = phoneNumber;

      // Set up event handlers AFTER successful authentication
      // This prevents builder.resolve errors during datacenter migration
      this.setupEventHandlers(client, accountId, clientInfo.organizationId);

      // Save session immediately after successful sign in
      await this.saveSession(accountId, client);

      // Update account with telegram_id and connection status
      await this.pool.query(
        'UPDATE bd_accounts SET telegram_id = $1, connected_at = NOW(), last_activity = NOW(), is_active = true WHERE id = $2',
        [String(user.id), accountId]
      );

      await this.saveAccountProfile(accountId, client);
      await this.updateAccountStatus(accountId, 'connected', 'Successfully signed in');

      return { requiresPassword: false };
    } catch (error: any) {
      this.log.error({ message: `Error signing in account ${accountId}`, error: error?.message || String(error) });
      await this.updateAccountStatus(accountId, 'error', error.message || 'Sign in failed');
      throw error;
    }
  }

  /**
   * Sign in with 2FA password
   */
  async signInWithPassword(
    accountId: string,
    password: string
  ): Promise<void> {
    try {
      const clientInfo = this.clients.get(accountId);
      if (!clientInfo || !clientInfo.client) {
        throw new Error('Client not found. Please send code first.');
      }

      const client = clientInfo.client;

      // Get password info - DO NOT set up event handlers before password check
      // Event handlers should only be set up AFTER successful authentication
      const passwordResult = await client.invoke(new Api.account.GetPassword());
      
      // Compute password check
      const { computeCheck } = await import('telegram/Password');
      const passwordCheck = await computeCheck(passwordResult, password);

      // Sign in with password
      const result = await client.invoke(
        new Api.auth.CheckPassword({
          password: passwordCheck,
        })
      );

      const auth = result as Api.auth.Authorization;
      const user = auth.user as Api.User;

      // Update client info
      clientInfo.isConnected = true;

      // Set up event handlers AFTER successful authentication
      // This prevents builder.resolve errors during datacenter migration
      this.setupEventHandlers(client, accountId, clientInfo.organizationId);

      // Save session immediately after successful sign in with password
      await this.saveSession(accountId, client);

      // Update account with telegram_id and connection status
      await this.pool.query(
        'UPDATE bd_accounts SET telegram_id = $1, connected_at = NOW(), last_activity = NOW(), is_active = true WHERE id = $2',
        [String(user.id), accountId]
      );

      await this.saveAccountProfile(accountId, client);
      await this.updateAccountStatus(accountId, 'connected', 'Successfully signed in with password');
    } catch (error: any) {
      this.log.error({ message: `Error signing in with password for account ${accountId}`, error: error?.message || String(error) });
      await this.updateAccountStatus(accountId, 'error', error.message || 'Password sign in failed');
      throw error;
    }
  }

  /**
   * Start QR-code login flow (https://core.telegram.org/api/qr-login).
   * Returns sessionId; frontend polls getQrLoginStatus(sessionId) for loginTokenUrl (show QR) and then success/error.
   */
  async startQrLogin(
    organizationId: string,
    userId: string,
    apiId: number,
    apiHash: string,
    proxyConfigRaw?: ProxyConfig | null
  ): Promise<{ sessionId: string }> {
    const sessionId = randomUUID();
    this.qrSessions.set(sessionId, {
      status: 'pending',
      organizationId,
      userId,
      apiId,
      apiHash,
    });
    this.persistQrState(sessionId);

    const proxy = buildTelegramProxy(proxyConfigRaw);
    const session = new StringSession('');
    const client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
      retryDelay: 1000,
      timeout: 30000,
      ...(proxy ? { proxy } : {}),
    });

    (async () => {
      try {
        await client.connect();
        await new Promise((r) => setTimeout(r, 1500));

        const user = await client.signInUserWithQrCode(
          { apiId, apiHash },
          {
            qrCode: async (code: { token: Buffer; expires?: number }) => {
              const tokenB64 = code.token.toString('base64url');
              const loginTokenUrl = `tg://login?token=${tokenB64}`;
              const state = this.qrSessions.get(sessionId);
              if (state) {
                state.status = 'qr';
                state.loginTokenUrl = loginTokenUrl;
                // expires: Telegram sends Unix timestamp (seconds) when token expires; gram.js may call qrCode again with new token
                state.expiresAt = code.expires != null
                  ? (code.expires < 1e10 ? code.expires * 1000 : code.expires)
                  : Date.now() + 30000;
                this.qrSessions.set(sessionId, state);
                this.persistQrState(sessionId);
              }
            },
            password: async (hint?: string) => {
              const state = this.qrSessions.get(sessionId);
              if (state) {
                state.status = 'need_password';
                state.passwordHint = hint || undefined;
                this.qrSessions.set(sessionId, state);
                this.persistQrState(sessionId);
              }
              if (this.redis) {
                for (let i = 0; i < 600; i++) {
                  const p = await this.redis.get<string>(TelegramManager.QR_REDIS_PREFIX + sessionId + ':password');
                  if (p != null && typeof p === 'string') {
                    await this.redis.del(TelegramManager.QR_REDIS_PREFIX + sessionId + ':password');
                    return p;
                  }
                  await new Promise((r) => setTimeout(r, 200));
                }
                return '';
              }
              return await new Promise<string>((resolve) => {
                const s = this.qrSessions.get(sessionId);
                if (s) {
                  s.passwordResolve = resolve;
                  this.qrSessions.set(sessionId, s);
                } else {
                  resolve('');
                }
              });
            },
            onError: async (err: Error) => {
              const msg = err?.message || String(err);
              this.log.error({ message: 'QR login onError', error: msg });
              const state = this.qrSessions.get(sessionId);
              if (state) {
                state.status = 'error';
                if (msg.includes('AUTH_USER_CANCEL') || msg.includes('USER_CANCEL')) {
                  state.error = 'Вход отменён на устройстве. Отсканируйте QR-код снова и нажмите «Войти» (не «Отмена»).';
                } else if (msg.toLowerCase().includes('password') || msg.includes('2FA')) {
                  state.error = 'Для этого аккаунта включена 2FA. Сначала отключите пароль в Telegram или войдите по номеру телефона.';
                } else {
                  state.error = msg;
                }
                this.qrSessions.set(sessionId, state);
                this.persistQrState(sessionId);
              }
              return true; // stop auth
            },
          }
        );

        const state = this.qrSessions.get(sessionId);
        if (!state) return;

        const me = await client.getMe();
        const telegramId = String((me as any).id ?? '');
        const phoneNumber = (me as any).phone ?? `qr-${telegramId}`;
        const sessionString = client.session.save() as string;

        // Проверка: аккаунт уже подключён в другой организации
        const otherOrg = await this.pool.query(
          `SELECT id FROM bd_accounts
           WHERE organization_id != $1 AND is_active = true
             AND (telegram_id = $2 OR phone_number = $3)`,
          [organizationId, telegramId, phoneNumber]
        );
        if (otherOrg.rows.length > 0) {
          await client.disconnect();
          state.status = 'error';
          state.error = 'Этот аккаунт уже подключён в другой организации. Один Telegram-аккаунт можно использовать только в одной организации.';
          this.qrSessions.set(sessionId, state);
          this.persistQrState(sessionId);
          return;
        }

        // Проверка: аккаунт с этим telegram_id или номером уже есть в этой организации
        const existing = await this.pool.query(
          `SELECT id, is_active FROM bd_accounts
           WHERE organization_id = $1 AND (telegram_id = $2 OR phone_number = $3)`,
          [organizationId, telegramId, phoneNumber]
        );

        let accountId: string;
        if (existing.rows.length > 0) {
          const row = existing.rows[0];
          accountId = row.id;
          if (row.is_active) {
            await client.disconnect();
            state.status = 'error';
            state.error = 'Этот аккаунт уже подключён в вашей организации. Выберите его в списке или отключите перед повторным подключением.';
            this.qrSessions.set(sessionId, state);
            this.persistQrState(sessionId);
            return;
          }
          await this.pool.query(
            `UPDATE bd_accounts SET telegram_id = $1, phone_number = $2, api_id = $3, api_hash = $4, session_string = $5, is_active = true, session_encrypted = true, created_by_user_id = COALESCE(created_by_user_id, $6) WHERE id = $7`,
            [telegramId, phoneNumber, String(apiId), encryptSession(apiHash), encryptSession(sessionString), userId, accountId]
          );
        } else {
          const insertResult = await this.pool.query(
            `INSERT INTO bd_accounts (organization_id, telegram_id, phone_number, api_id, api_hash, session_string, is_active, session_encrypted, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, true, true, $7) RETURNING id`,
            [organizationId, telegramId, phoneNumber, String(apiId), encryptSession(apiHash), encryptSession(sessionString), userId]
          );
          accountId = insertResult.rows[0].id;
        }

        await client.disconnect();

        await this.connectAccount(accountId, organizationId, userId, phoneNumber, apiId, apiHash, sessionString);

        state.status = 'success';
        state.accountId = accountId;
        delete state.error;
        this.qrSessions.set(sessionId, state);
        this.persistQrState(sessionId);

        await this.rabbitmq.publishEvent({
          id: randomUUID(),
          type: EventType.BD_ACCOUNT_CONNECTED,
          timestamp: new Date(),
          organizationId,
          userId,
          data: { bdAccountId: accountId, platform: 'telegram', userId },
        } as Event);
      } catch (err: any) {
        const msg = err?.message || String(err);
        this.log.error({ message: 'QR login failed', error: msg, stack: err?.stack });
        const state = this.qrSessions.get(sessionId);
        if (state) {
          state.status = 'error';
          if (msg.includes('AUTH_USER_CANCEL') || msg.includes('USER_CANCEL')) {
            state.error = 'Вход отменён на устройстве. Отсканируйте QR-код снова и нажмите «Войти» (не «Отмена»).';
          } else if (msg.toLowerCase().includes('password') || msg.includes('2FA')) {
            state.error = 'Для этого аккаунта включена 2FA. Войдите по номеру телефона или отключите пароль в Telegram.';
          } else {
            state.error = msg;
          }
          this.qrSessions.set(sessionId, state);
          this.persistQrState(sessionId);
        }
        try {
          await client.disconnect();
        } catch (e: unknown) {
          this.log.debug({ message: 'QR client disconnect ignored', error: String(e) });
        }
      }
    })();

    return { sessionId };
  }

  /** Сохранить сериализуемое состояние QR-сессии в Redis (для нескольких реплик и после рестарта). */
  private persistQrState(sessionId: string): void {
    const full = this.qrSessions.get(sessionId);
    if (!this.redis || !full) return;
    const payload: QrLoginState = {
      status: full.status,
      loginTokenUrl: full.loginTokenUrl,
      expiresAt: full.expiresAt,
      accountId: full.accountId,
      error: full.error,
      passwordHint: full.passwordHint,
    };
    this.redis.set(TelegramManager.QR_REDIS_PREFIX + sessionId, payload, TelegramManager.QR_REDIS_TTL).catch((err) => {
      this.log.error({ message: "Failed to persist QR state to Redis", error: String(err) });
    });
  }

  /**
   * Get current state of a QR login session (for polling from frontend).
   * Читает из памяти; при отсутствии — из Redis (для нескольких реплик).
   */
  async getQrLoginStatus(sessionId: string): Promise<QrLoginState | null> {
    const full = this.qrSessions.get(sessionId);
    if (full) {
      const displayStatus =
        full.status === 'qr' && full.expiresAt && Date.now() > full.expiresAt ? 'expired' : full.status;
      return {
        status: displayStatus,
        loginTokenUrl: full.loginTokenUrl,
        expiresAt: full.expiresAt,
        accountId: full.accountId,
        error: full.error,
        passwordHint: full.passwordHint,
      };
    }
    if (this.redis) {
      const stored = await this.redis.get<QrLoginState>(TelegramManager.QR_REDIS_PREFIX + sessionId);
      if (stored && typeof stored === 'object' && stored.status) {
        const displayStatus =
          stored.status === 'qr' && stored.expiresAt && Date.now() > stored.expiresAt ? 'expired' : stored.status;
        return {
          status: displayStatus,
          loginTokenUrl: stored.loginTokenUrl,
          expiresAt: stored.expiresAt,
          accountId: stored.accountId,
          error: stored.error,
          passwordHint: stored.passwordHint,
        };
      }
    }
    return null;
  }

  /**
   * Передать пароль 2FA для продолжающегося QR-логина (вызывается после того, как фронт получил status need_password).
   */
  async submitQrLoginPassword(sessionId: string, password: string): Promise<boolean> {
    const full = this.qrSessions.get(sessionId);
    if (full?.passwordResolve) {
      full.passwordResolve(password);
      delete full.passwordResolve;
      this.qrSessions.set(sessionId, full);
      return true;
    }
    if (this.redis) {
      await this.redis.set(TelegramManager.QR_REDIS_PREFIX + sessionId + ':password', password, TelegramManager.QR_PASSWORD_TTL);
      return true;
    }
    return false;
  }

  /**
   * Initialize and connect a Telegram account (for existing sessions)
   */
  async connectAccount(
    accountId: string,
    organizationId: string,
    userId: string,
    phoneNumber: string,
    apiId: number,
    apiHash: string,
    sessionString?: string
  ): Promise<TelegramClient> {
    try {
      // Check if client already exists
      if (this.clients.has(accountId)) {
        const existing = this.clients.get(accountId)!;
        if (existing.isConnected) {
          return existing.client;
        }
        // Disconnect old client (releases lock)
        await this.disconnectAccount(accountId);
      }

      const acquired = await this.acquireLock(accountId);
      if (!acquired) {
        throw new Error('Account is managed by another instance; try again later.');
      }

      if (!sessionString) {
        await this.releaseLock(accountId);
        throw new Error('Session string is required for existing accounts');
      }

      let proxyConfig: ProxyConfig | null = null;
      try {
        const proxyRow = await this.pool.query('SELECT proxy_config FROM bd_accounts WHERE id = $1', [accountId]);
        proxyConfig = proxyRow.rows[0]?.proxy_config ?? null;
      } catch { /* proxy is optional */ }

      const session = new StringSession(sessionString);
      const proxy = buildTelegramProxy(proxyConfig);
      const client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
        retryDelay: 1000,
        timeout: 30000,
        ...(proxy ? { proxy } : {}),
      });

      // Connect client first
      await client.connect();
      this.log.info({ message: `Connected account ${accountId} (${phoneNumber})` });

      // Catch GramJS update-loop errors (e.g. TIMEOUT) so they don't become unhandledRejection.
      // Reconnect only this account — otherwise reconnect-all would disconnect others mid-request (e.g. GetDialogs).
      (client as any)._errorHandler = async (err: any) => {
        if (err?.message === 'TIMEOUT' || err?.message?.includes?.('TIMEOUT')) {
          this.log.warn({ message: 'Update loop TIMEOUT (GramJS), scheduling reconnect', accountId });
          this.scheduleReconnectOneAfterTimeout(accountId);
        } else {
          this.log.error({ message: 'Telegram client error', accountId, error: err?.message || String(err) });
        }
      };

      // Wait for connection to stabilize before setting up handlers
      // This helps avoid builder.resolve errors during initialization
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify session is valid by checking if we're authorized
      try {
        await client.getMe();
        this.log.info({ message: `Session verified for account ${accountId}` });
      } catch (error: any) {
        this.log.error({ message: `Session invalid for account ${accountId}`, error: error.message });
        await client.disconnect();
        throw new Error('Invalid session. Please reconnect the account.');
      }

      // Set up event handlers AFTER verifying session is valid and connection is stable
      this.setupEventHandlers(client, accountId, organizationId);
      this.log.info({ message: `Event handlers registered for account ${accountId}` });

      // Best practice: high-level request after handlers so Telegram pushes updates to this client
      try {
        await client.getMe();
        this.log.info({ message: `getMe() after handlers — update stream active for account ${accountId}` });
      } catch (e: any) {
        this.log.warn({ message: `getMe() after handlers failed (non-fatal)`, error: e?.message });
      }

      // Save session immediately after connection
      await this.saveSession(accountId, client);

      await this.saveAccountProfile(accountId, client);

      // Store client info and start lock heartbeat so we keep ownership across instances
      const clientInfo: TelegramClientInfo = {
        client,
        accountId,
        organizationId,
        userId,
        phoneNumber,
        isConnected: true,
        lastActivity: new Date(),
        reconnectAttempts: 0,
        lockValue: this.instanceId,
      };

      this.clients.set(accountId, clientInfo);
      this.startLockHeartbeat(accountId, this.instanceId);

      // Поддержание потока апдейтов: Telegram перестаёт слать updates, если долго нет запросов (см. gramjs client/updates.ts).
      this.startUpdateKeepalive(accountId, client);

      // Update status
      await this.updateAccountStatus(accountId, 'connected', 'Successfully connected');

      return client;
    } catch (error: any) {
      if (!this.clients.has(accountId)) await this.releaseLock(accountId);
      this.log.error({ message: `Error connecting account ${accountId}`, error: error?.message || String(error) });
      await this.updateAccountStatus(accountId, 'error', error.message || 'Connection failed');
      throw error;
    }
  }

  /**
   * Периодический вызов updates.GetState() чтобы Telegram продолжал доставлять апдейты на эту сессию.
   */
  private startUpdateKeepalive(accountId: string, client: TelegramClient): void {
    this.stopUpdateKeepalive(accountId);
    const interval = setInterval(async () => {
      const info = this.clients.get(accountId);
      if (!info?.client?.connected) return;
      try {
        await client.invoke(new Api.updates.GetState());
      } catch (e: any) {
        if (e?.message !== 'TIMEOUT' && !e?.message?.includes('builder.resolve')) {
          this.log.warn({ message: `GetState keepalive failed for ${accountId}`, error: e?.message });
        }
      }
    }, this.UPDATE_KEEPALIVE_MS);
    this.updateKeepaliveIntervals.set(accountId, interval);
  }

  private stopUpdateKeepalive(accountId: string): void {
    const interval = this.updateKeepaliveIntervals.get(accountId);
    if (interval) {
      clearInterval(interval);
      this.updateKeepaliveIntervals.delete(accountId);
    }
  }

  /**
   * Setup event handlers for Telegram client
   * Must be called AFTER client is fully authenticated
   */
  private setupEventHandlers(
    client: TelegramClient,
    accountId: string,
    organizationId: string
  ): void {
    try {
      // Check if client is ready before setting up handlers
      if (!client.connected) {
        this.log.warn({ message: `Client not connected for account ${accountId}, skipping event handlers` });
        return;
      }

      // Лог только апдейтов с сообщениями (без шума UpdateUserStatus/UpdateConnectionState). Важно: второй аргумент — Raw, иначе gram.js ломает цикл.
      try {
        client.addEventHandler(
          (update: any) => {
            const hasMessage = update?.message != null;
            if (!hasMessage) return;
            const name = update?.className ?? update?.constructor?.name ?? (update && typeof update === 'object' ? 'Object' : String(update));
            this.log.info({ message: `Raw update: ${name}, accountId=${accountId}` });
          },
          new Raw({ func: () => true })
        );
      } catch (e: unknown) {
        this.log.debug({ message: 'Raw update handler registration failed', accountId, error: String(e) });
      }

      // UpdateShortMessage / UpdateShortChatMessage — личные и групповые (входящие и исходящие с другого устройства).
      try {
        client.addEventHandler(
          async (update: any) => {
            try {
              if (!client.connected) return;
              await this.handleShortMessageUpdate(update, accountId, organizationId);
            } catch (err: any) {
              if (err?.message === 'TIMEOUT' || err?.message?.includes('TIMEOUT')) return;
              if (err?.message?.includes('builder.resolve')) return;
              this.log.error({ message: `Short message handler error for ${accountId}`, error: err?.message || String(err) });
            }
          },
          new Raw({
            func: (update: any) => {
              try {
                if (!update) return false;
                const name = update.className ?? update.constructor?.name ?? '';
                if (name === 'UpdateShortMessage' || name === 'UpdateShortChatMessage') {
                  const text = (update as any).message;
                  return typeof text === 'string' && text.length > 0;
                }
                return false;
              } catch (_) {
                return false;
              }
            },
          })
        );
      } catch (e: unknown) {
        this.log.debug({ message: 'Short message handler registration failed', accountId, error: String(e) });
      }

      // UpdateNewMessage / UpdateNewChannelMessage — полный объект Message (личные чаты и группы/каналы).
      try {
        client.addEventHandler(
          async (event: any) => {
            try {
              this.log.info({ message: `Raw UpdateNewMessage/UpdateNewChannelMessage, accountId=${accountId}, hasMessage=${!!event?.message}` });
              if (!client.connected) return;

              const accountCheck = await this.pool.query(
                'SELECT id, is_active FROM bd_accounts WHERE id = $1',
                [accountId]
              );
              if (accountCheck.rows.length === 0 || !accountCheck.rows[0].is_active) {
                this.log.info({ message: `Account ${accountId} no longer exists or is inactive, disconnecting...` });
                await this.disconnectAccount(accountId);
                return;
              }

              const message = event?.message;
              const isMessage = message && (message instanceof Api.Message || message.className === 'Message');
              if (isMessage) {
                await this.handleNewMessage(message, accountId, organizationId);
              }
            } catch (error: any) {
              if (error.message === 'TIMEOUT' || error.message?.includes('TIMEOUT')) {
                this.log.warn({ message: `Timeout error for account ${accountId}, will retry`, error: error.message });
                return;
              }
              if (error.message?.includes('builder.resolve') || error.stack?.includes('builder.resolve')) return;
              this.log.error({ message: `Error handling new message for account ${accountId}`, error: error?.message || String(error) });
            }
          },
          new Raw({
            types: [Api.UpdateNewMessage, Api.UpdateNewChannelMessage],
            func: (update: any) => update != null && update.message != null,
          })
        );
      } catch (error: any) {
        if (error.message?.includes('builder.resolve') || error.stack?.includes('builder.resolve')) {
          this.log.warn({ message: `Could not set up UpdateNewMessage handler for ${accountId}, will rely on Short/NewMessage` });
        } else {
          throw error;
        }
      }

      // NewMessage (incoming) — входящие от других
      try {
        client.addEventHandler(
          async (event: any) => {
            try {
              if (!client.connected) return;
              const accountCheck = await this.pool.query(
                'SELECT id, is_active FROM bd_accounts WHERE id = $1',
                [accountId]
              );
              if (accountCheck.rows.length === 0 || !accountCheck.rows[0].is_active) return;
              const message = event?.message;
              if (message && (message.className === 'Message' || message instanceof Api.Message)) {
                await this.handleNewMessage(message, accountId, organizationId);
              }
            } catch (err: any) {
              if (err?.message === 'TIMEOUT' || err?.message?.includes('TIMEOUT')) return;
              if (err?.message?.includes('builder.resolve')) return;
              this.log.error({ message: `NewMessage(incoming) handler error for ${accountId}`, error: err?.message || String(err) });
            }
          },
          new NewMessage({ incoming: true })
        );
        this.log.info({ message: `NewMessage(incoming) handler registered for account ${accountId}` });
      } catch (err: any) {
        if (err?.message?.includes('builder.resolve') || err?.stack?.includes('builder.resolve')) {
          this.log.warn({ message: `Could not set up NewMessage(incoming) handler for ${accountId}` });
        }
      }

      // NewMessage (outgoing) — сообщения, отправленные с другого устройства этого аккаунта
      try {
        client.addEventHandler(
          async (event: any) => {
            try {
              if (!client.connected) return;
              const accountCheck = await this.pool.query(
                'SELECT id, is_active FROM bd_accounts WHERE id = $1',
                [accountId]
              );
              if (accountCheck.rows.length === 0 || !accountCheck.rows[0].is_active) return;
              const message = event?.message;
              if (message && (message.className === 'Message' || message instanceof Api.Message)) {
                await this.handleNewMessage(message, accountId, organizationId);
              }
            } catch (err: any) {
              if (err?.message === 'TIMEOUT' || err?.message?.includes('TIMEOUT')) return;
              if (err?.message?.includes('builder.resolve')) return;
              this.log.error({ message: `NewMessage(outgoing) handler error for ${accountId}`, error: err?.message || String(err) });
            }
          },
          new NewMessage({ incoming: false })
        );
        this.log.info({ message: `NewMessage(outgoing) handler registered for account ${accountId}` });
      } catch (err: any) {
        if (err?.message?.includes('builder.resolve') || err?.stack?.includes('builder.resolve')) {
          this.log.warn({ message: `Could not set up NewMessage(outgoing) handler for ${accountId}` });
        }
      }

      // UpdateDeleteMessages — удаление сообщений в личных чатах/группах (не канал)
      try {
        client.addEventHandler(
          async (event: any) => {
            try {
              if (!client.connected) return;
              const ids = event?.messages ?? [];
              if (!Array.isArray(ids) || ids.length === 0) return;
              const rows = await this.pool.query(
                'SELECT id, organization_id, channel_id, telegram_message_id FROM messages WHERE bd_account_id = $1 AND telegram_message_id = ANY($2::bigint[])',
                [accountId, ids]
              );
              for (const row of rows.rows) {
                await this.pool.query('DELETE FROM messages WHERE id = $1', [row.id]);
                const ev: MessageDeletedEvent = {
                  id: randomUUID(),
                  type: EventType.MESSAGE_DELETED,
                  timestamp: new Date(),
                  organizationId: row.organization_id,
                  data: { messageId: row.id, bdAccountId: accountId, channelId: row.channel_id, telegramMessageId: row.telegram_message_id },
                };
                await this.rabbitmq.publishEvent(ev);
              }
            } catch (err: any) {
              if (err?.message?.includes('builder.resolve')) return;
              this.log.error({ message: `UpdateDeleteMessages handler error for ${accountId}`, error: err?.message });
            }
          },
          new Raw({
            types: [Api.UpdateDeleteMessages],
            func: () => true,
          })
        );
      } catch (err: any) {
        if (err?.message?.includes('builder.resolve')) {
          this.log.warn({ message: `Could not set up UpdateDeleteMessages for ${accountId}` });
        }
      }

      // UpdateDeleteChannelMessages — удаление сообщений в каналах/супергруппах
      try {
        const UpdateDeleteChannelMessages = (Api as any).UpdateDeleteChannelMessages;
        if (UpdateDeleteChannelMessages) {
          client.addEventHandler(
            async (event: any) => {
              try {
                if (!client.connected) return;
                const channelIdRaw = event?.channelId;
                const ids = event?.messages ?? [];
                if (channelIdRaw == null || !Array.isArray(ids) || ids.length === 0) return;
                const channelIdStr = String(channelIdRaw);
                const rows = await this.pool.query(
                  'SELECT id, organization_id, channel_id, telegram_message_id FROM messages WHERE bd_account_id = $1 AND channel_id = $2 AND telegram_message_id = ANY($3::bigint[])',
                  [accountId, channelIdStr, ids]
                );
                for (const row of rows.rows) {
                  await this.pool.query('DELETE FROM messages WHERE id = $1', [row.id]);
                  const ev: MessageDeletedEvent = {
                    id: randomUUID(),
                    type: EventType.MESSAGE_DELETED,
                    timestamp: new Date(),
                    organizationId: row.organization_id,
                    data: { messageId: row.id, bdAccountId: accountId, channelId: row.channel_id, telegramMessageId: row.telegram_message_id },
                  };
                  await this.rabbitmq.publishEvent(ev);
                }
              } catch (err: any) {
                if (err?.message?.includes('builder.resolve')) return;
                this.log.error({ message: `UpdateDeleteChannelMessages handler error for ${accountId}`, error: err?.message });
              }
            },
            new Raw({
              types: [UpdateDeleteChannelMessages],
              func: () => true,
            })
          );
        }
      } catch (err: any) {
        // UpdateDeleteChannelMessages may not exist in some GramJS versions
      }

      // Edited message — use Raw(UpdateEditMessage | UpdateEditChannelMessage); EditedMessage from telegram/events is not a constructor in some GramJS builds
      try {
        const EditTypes = [Api.UpdateEditMessage, Api.UpdateEditChannelMessage].filter(Boolean);
        if (EditTypes.length > 0) {
          client.addEventHandler(
            async (update: any) => {
              try {
                if (!client.connected) return;
                const message = update?.message;
                if (!message?.id) return;
                let channelId = '';
                if (message.peerId) {
                  if (message.peerId instanceof Api.PeerUser) channelId = String(message.peerId.userId);
                  else if (message.peerId instanceof Api.PeerChat) channelId = String(message.peerId.chatId);
                  else if (message.peerId instanceof Api.PeerChannel) channelId = String(message.peerId.channelId);
                }
                const content = getMessageText(message) || '';
                const res = await this.pool.query(
                  `UPDATE messages SET content = $1, updated_at = NOW(), telegram_entities = $2, telegram_media = $3
                   WHERE bd_account_id = $4 AND channel_id = $5 AND telegram_message_id = $6
                   RETURNING id, organization_id`,
                  [
                    content,
                    message.entities ? JSON.stringify(message.entities) : null,
                    message.media ? JSON.stringify((message.media as any).toJSON?.() ?? message.media) : null,
                    accountId,
                    channelId,
                    message.id,
                  ]
                );
                if (res.rows.length > 0) {
                  const row = res.rows[0];
                  const ev: MessageEditedEvent = {
                    id: randomUUID(),
                    type: EventType.MESSAGE_EDITED,
                    timestamp: new Date(),
                    organizationId: row.organization_id,
                    data: { messageId: row.id, bdAccountId: accountId, channelId, content, telegramMessageId: message.id },
                  };
                  await this.rabbitmq.publishEvent(ev);
                }
              } catch (err: any) {
                if (err?.message?.includes('builder.resolve')) return;
                this.log.error({ message: `EditedMessage handler error for ${accountId}`, error: err?.message });
              }
            },
            new Raw({ types: EditTypes, func: () => true })
          );
        }
      } catch (err: any) {
        this.log.warn({ message: `Could not set up edited-message handler for ${accountId}`, error: err?.message });
      }

      // Telegram presence/UI updates: typing, user status, read receipt, draft — только для чатов из sync list, публикуем в RabbitMQ → WebSocket.
      this.setupTelegramPresenceHandlers(client, accountId, organizationId).catch((err) =>
        this.log.warn({ message: "setupTelegramPresenceHandlers failed", error: err?.message })
      );
      this.setupTelegramOtherHandlers(client, accountId, organizationId).catch((err) =>
        this.log.warn({ message: "setupTelegramOtherHandlers failed", error: err?.message })
      );

      // Reconnection and account cleanup are handled in scheduleReconnect, cleanupInactiveClients, and on TIMEOUT.
    } catch (error: any) {
      this.log.error({ message: `Error setting up event handlers`, error: error.message });
      // Don't throw - allow client to continue without event handlers
    }
  }

  /**
   * Обработчики Telegram presence/UI: typing, user status, read receipt, draft. Публикуем только для чатов из sync list.
   */
  private async setupTelegramPresenceHandlers(
    client: TelegramClient,
    accountId: string,
    organizationId: string
  ): Promise<void> {
    const publish = async (data: BDAccountTelegramUpdateEvent['data']) => {
      const ev: BDAccountTelegramUpdateEvent = {
        id: randomUUID(),
        type: EventType.BD_ACCOUNT_TELEGRAM_UPDATE,
        timestamp: new Date(),
        organizationId,
        data: { ...data, bdAccountId: accountId, organizationId },
      };
      await this.rabbitmq.publishEvent(ev);
    };

    const ApiAny = Api as any;

    // UpdateUserTyping — личный чат (user_id = собеседник)
    if (ApiAny.UpdateUserTyping) {
      try {
        client.addEventHandler(
          async (event: any) => {
            try {
              if (!client.connected) return;
              const userId = event?.userId ?? event?.user_id;
              const channelId = userId != null ? String(userId) : '';
              if (!channelId) return;
              const allowed = await this.isChatAllowedForAccount(accountId, channelId);
              if (!allowed) return;
              const action = event?.action?.className ?? event?.action?.constructor?.name ?? '';
              await publish({
                bdAccountId: accountId,
                organizationId,
                updateKind: 'typing',
                channelId,
                userId: String(userId),
                action: action || undefined,
              });
            } catch (e: unknown) {
              this.log.debug({ message: 'UpdateUserTyping handler error', accountId, error: String(e) });
            }
          },
          new Raw({ types: [ApiAny.UpdateUserTyping], func: () => true })
        );
      } catch (e: unknown) {
        this.log.debug({ message: 'UpdateUserTyping registration failed', accountId, error: String(e) });
      }
    }

    // UpdateChatUserTyping — группа/канал (chat_id = чат, from_id = кто печатает)
    if (ApiAny.UpdateChatUserTyping) {
      try {
        client.addEventHandler(
          async (event: any) => {
            try {
              if (!client.connected) return;
              const chatIdRaw = event?.chatId ?? event?.chat_id;
              const channelId = chatIdRaw != null ? String(chatIdRaw) : '';
              if (!channelId) return;
              const allowed = await this.isChatAllowedForAccount(accountId, channelId);
              if (!allowed) return;
              const fromId = event?.fromId ?? event?.from_id;
              let userId: string | undefined;
              if (fromId) {
                if (fromId.userId != null) userId = String(fromId.userId);
                else if (fromId.channelId != null) userId = String(fromId.channelId);
                else userId = String(fromId);
              }
              const action = event?.action?.className ?? event?.action?.constructor?.name ?? '';
              await publish({
                bdAccountId: accountId,
                organizationId,
                updateKind: 'typing',
                channelId,
                userId,
                action: action || undefined,
              });
            } catch (e: unknown) {
              this.log.debug({ message: 'UpdateChatUserTyping handler error', accountId, error: String(e) });
            }
          },
          new Raw({ types: [ApiAny.UpdateChatUserTyping], func: () => true })
        );
      } catch (e: unknown) {
        this.log.debug({ message: 'UpdateChatUserTyping registration failed', accountId, error: String(e) });
      }
    }

    // UpdateUserStatus — онлайн/офлайн (без привязки к чату)
    if (ApiAny.UpdateUserStatus) {
      try {
        client.addEventHandler(
          async (event: any) => {
            try {
              if (!client.connected) return;
              const userId = event?.userId ?? event?.user_id;
              if (userId == null) return;
              const status = event?.status?.className ?? event?.status?.constructor?.name ?? '';
              const expires = (event?.status?.expires ?? event?.status?.until) ?? undefined;
              await publish({
                bdAccountId: accountId,
                organizationId,
                updateKind: 'user_status',
                userId: String(userId),
                status: status || undefined,
                expires: typeof expires === 'number' ? expires : undefined,
              });
            } catch (e: unknown) {
              this.log.debug({ message: 'UpdateUserStatus handler error', accountId, error: String(e) });
            }
          },
          new Raw({ types: [ApiAny.UpdateUserStatus], func: () => true })
        );
      } catch (e: unknown) {
        this.log.debug({ message: 'UpdateUserStatus registration failed', accountId, error: String(e) });
      }
    }

    // UpdateReadHistoryInbox — прочитано в личке/группе (peer + max_id)
    if (ApiAny.UpdateReadHistoryInbox) {
      try {
        client.addEventHandler(
          async (event: any) => {
            try {
              if (!client.connected) return;
              const peer = event?.peer;
              let channelId = '';
              if (peer) {
                if (peer.userId != null) channelId = String(peer.userId);
                else if (peer.chatId != null) channelId = String(peer.chatId);
                else if (peer.channelId != null) channelId = String(peer.channelId);
              }
              if (!channelId) return;
              const allowed = await this.isChatAllowedForAccount(accountId, channelId);
              if (!allowed) return;
              const maxId = event?.maxId ?? event?.max_id ?? 0;
              await publish({
                bdAccountId: accountId,
                organizationId,
                updateKind: 'read_inbox',
                channelId,
                maxId,
              });
            } catch (e: unknown) {
              this.log.debug({ message: 'UpdateReadHistoryInbox handler error', accountId, error: String(e) });
            }
          },
          new Raw({ types: [ApiAny.UpdateReadHistoryInbox], func: () => true })
        );
      } catch (e: unknown) {
        this.log.debug({ message: 'UpdateReadHistoryInbox registration failed', accountId, error: String(e) });
      }
    }

    // UpdateReadChannelInbox — прочитано в канале/супергруппе
    if (ApiAny.UpdateReadChannelInbox) {
      try {
        client.addEventHandler(
          async (event: any) => {
            try {
              if (!client.connected) return;
              const channelIdRaw = event?.channelId ?? event?.channel_id;
              const channelId = channelIdRaw != null ? String(channelIdRaw) : '';
              if (!channelId) return;
              const allowed = await this.isChatAllowedForAccount(accountId, channelId);
              if (!allowed) return;
              const maxId = event?.maxId ?? event?.max_id ?? 0;
              await publish({
                bdAccountId: accountId,
                organizationId,
                updateKind: 'read_channel_inbox',
                channelId,
                maxId,
              });
            } catch (e: unknown) {
              this.log.debug({ message: 'UpdateReadChannelInbox handler error', accountId, error: String(e) });
            }
          },
          new Raw({ types: [ApiAny.UpdateReadChannelInbox], func: () => true })
        );
      } catch (e: unknown) {
        this.log.debug({ message: 'UpdateReadChannelInbox registration failed', accountId, error: String(e) });
      }
    }

    // UpdateDraftMessage — черновик в чате
    if (ApiAny.UpdateDraftMessage) {
      try {
        client.addEventHandler(
          async (event: any) => {
            try {
              if (!client.connected) return;
              const peer = event?.peer;
              let channelId = '';
              if (peer) {
                if (peer.userId != null) channelId = String(peer.userId);
                else if (peer.chatId != null) channelId = String(peer.chatId);
                else if (peer.channelId != null) channelId = String(peer.channelId);
              }
              if (!channelId) return;
              const allowed = await this.isChatAllowedForAccount(accountId, channelId);
              if (!allowed) return;
              const draft = event?.draft;
              let draftText = '';
              let replyToMsgId: number | undefined;
              if (draft) {
                draftText = (draft.message ?? (draft as any).message ?? '') || '';
                replyToMsgId = (draft.replyTo as any)?.replyToMsgId ?? (draft as any).replyToMsgId ?? (draft as any).reply_to_msg_id;
              }
              await publish({
                bdAccountId: accountId,
                organizationId,
                updateKind: 'draft',
                channelId,
                draftText: draftText || undefined,
                replyToMsgId,
              });
            } catch (e: unknown) {
              this.log.debug({ message: 'UpdateDraftMessage handler error', accountId, error: String(e) });
            }
          },
          new Raw({ types: [ApiAny.UpdateDraftMessage], func: () => true })
        );
      } catch (e: unknown) {
        this.log.debug({ message: 'UpdateDraftMessage registration failed', accountId, error: String(e) });
      }
    }
  }

  /**
   * Обработчики прочих Telegram-апдейтов: messageID, read outbox, pinned, notify, user name/phone,
   * participants, scheduled, poll, config, dcOptions, langPack, theme, phoneCall, callbackQuery, channelTooLong.
   */
  private async setupTelegramOtherHandlers(
    client: TelegramClient,
    accountId: string,
    organizationId: string
  ): Promise<void> {
    const publish = async (data: BDAccountTelegramUpdateEvent['data']) => {
      const ev: BDAccountTelegramUpdateEvent = {
        id: randomUUID(),
        type: EventType.BD_ACCOUNT_TELEGRAM_UPDATE,
        timestamp: new Date(),
        organizationId,
        data: { ...data, bdAccountId: accountId, organizationId },
      };
      await this.rabbitmq.publishEvent(ev);
    };

    const ApiAny = Api as any;

    const wrap = (types: any[], handler: (event: any) => Promise<void>) => {
      if (!types.length) return;
      try {
        client.addEventHandler(
          async (event: any) => {
            try {
              if (!client.connected) return;
              await handler(event);
            } catch (e: unknown) {
              this.log.debug({ message: 'Telegram other handler error', accountId, error: String(e) });
            }
          },
          new Raw({ types, func: () => true })
        );
      } catch (e: unknown) {
        this.log.debug({ message: 'Telegram other handler registration failed', accountId, types: types?.length, error: String(e) });
      }
    };

    // UpdateMessageID — подтверждение отправки (temp id → real id)
    wrap([ApiAny.UpdateMessageID], async (event) => {
      const telegramMessageId = event?.id;
      const randomId = event?.randomId ?? event?.random_id;
      if (telegramMessageId == null || randomId == null) return;
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'message_id_confirmed',
        telegramMessageId: typeof telegramMessageId === 'number' ? telegramMessageId : undefined,
        randomId: String(randomId),
      });
    });

    // UpdateReadHistoryOutbox — собеседник прочитал наши сообщения (личка/группа)
    wrap([ApiAny.UpdateReadHistoryOutbox], async (event) => {
      const peer = event?.peer;
      let channelId = '';
      if (peer) {
        if (peer.userId != null) channelId = String(peer.userId);
        else if (peer.chatId != null) channelId = String(peer.chatId);
        else if (peer.channelId != null) channelId = String(peer.channelId);
      }
      if (!channelId) return;
      const allowed = await this.isChatAllowedForAccount(accountId, channelId);
      if (!allowed) return;
      const maxId = event?.maxId ?? event?.max_id ?? 0;
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'read_outbox',
        channelId,
        maxId,
      });
    });

    // UpdateReadChannelOutbox — прочитано в канале/супергруппе (наши сообщения прочитаны)
    wrap([ApiAny.UpdateReadChannelOutbox], async (event) => {
      const channelIdRaw = event?.channelId ?? event?.channel_id;
      const channelId = channelIdRaw != null ? String(channelIdRaw) : '';
      if (!channelId) return;
      const allowed = await this.isChatAllowedForAccount(accountId, channelId);
      if (!allowed) return;
      const maxId = event?.maxId ?? event?.max_id ?? 0;
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'read_channel_outbox',
        channelId,
        maxId,
      });
    });

    // UpdateDialogPinned — закрепление диалога
    wrap([ApiAny.UpdateDialogPinned], async (event) => {
      const peer = event?.peer;
      let channelId = '';
      if (peer) {
        if (peer.userId != null) channelId = String(peer.userId);
        else if (peer.chatId != null) channelId = String(peer.chatId);
        else if (peer.channelId != null) channelId = String(peer.channelId);
      }
      if (!channelId) return;
      const allowed = await this.isChatAllowedForAccount(accountId, channelId);
      if (!allowed) return;
      const pinned = Boolean(event?.pinned);
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'dialog_pinned',
        channelId,
        pinned,
      });
    });

    // UpdatePinnedDialogs — порядок закреплённых диалогов
    wrap([ApiAny.UpdatePinnedDialogs], async (event) => {
      const folderId = event?.folderId ?? event?.folder_id ?? 0;
      const order = event?.order;
      const orderIds = Array.isArray(order) ? order.map((p: any) => {
        if (p?.userId != null) return String(p.userId);
        if (p?.chatId != null) return String(p.chatId);
        if (p?.channelId != null) return String(p.channelId);
        return String(p);
      }).filter(Boolean) : undefined;
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'pinned_dialogs',
        folderId,
        order: orderIds,
      });
    });

    // UpdateNotifySettings — настройки уведомлений
    wrap([ApiAny.UpdateNotifySettings], async (event) => {
      const peer = event?.peer;
      let channelId = '';
      if (peer) {
        if (peer.userId != null) channelId = String(peer.userId);
        else if (peer.chatId != null) channelId = String(peer.chatId);
        else if (peer.channelId != null) channelId = String(peer.channelId);
      }
      const settings = event?.notifySettings ?? event?.notify_settings;
      const notifySettings = settings && typeof settings === 'object' ? (settings as Record<string, unknown>) : undefined;
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'notify_settings',
        channelId: channelId || undefined,
        notifySettings,
      });
    });

    // UpdateUserName — имя/username пользователя
    wrap([ApiAny.UpdateUserName], async (event) => {
      const userId = event?.userId ?? event?.user_id;
      if (userId == null) return;
      const firstName = event?.firstName ?? event?.first_name ?? '';
      const lastName = event?.lastName ?? event?.last_name ?? '';
      const usernames = event?.usernames ?? event?.username;
      const list = Array.isArray(usernames) ? usernames : (typeof usernames === 'string' && usernames ? [usernames] : undefined);
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'user_name',
        userId: String(userId),
        firstName: firstName || undefined,
        lastName: lastName || undefined,
        usernames: list,
      });
    });

    // UpdateUserPhone — телефон пользователя
    wrap([ApiAny.UpdateUserPhone], async (event) => {
      const userId = event?.userId ?? event?.user_id;
      const phone = event?.phone ?? '';
      if (userId == null) return;
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'user_phone',
        userId: String(userId),
        phone: phone || undefined,
      });
    });

    // UpdateChatParticipantAdd — добавлен участник в чат
    wrap([ApiAny.UpdateChatParticipantAdd], async (event) => {
      const chatIdRaw = event?.chatId ?? event?.chat_id;
      const channelId = chatIdRaw != null ? String(chatIdRaw) : '';
      if (!channelId) return;
      const allowed = await this.isChatAllowedForAccount(accountId, channelId);
      if (!allowed) return;
      const userId = event?.userId ?? event?.user_id;
      const inviterIdRaw = event?.inviterId ?? event?.inviter_id;
      let inviterId: string | undefined;
      if (inviterIdRaw != null) {
        if (typeof inviterIdRaw === 'object' && inviterIdRaw.userId != null) inviterId = String(inviterIdRaw.userId);
        else inviterId = String(inviterIdRaw);
      }
      const version = event?.version;
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'chat_participant_add',
        channelId,
        userId: userId != null ? String(userId) : undefined,
        inviterId,
        version: typeof version === 'number' ? version : undefined,
      });
    });

    // UpdateChatParticipantDelete — удалён участник из чата
    wrap([ApiAny.UpdateChatParticipantDelete], async (event) => {
      const chatIdRaw = event?.chatId ?? event?.chat_id;
      const channelId = chatIdRaw != null ? String(chatIdRaw) : '';
      if (!channelId) return;
      const allowed = await this.isChatAllowedForAccount(accountId, channelId);
      if (!allowed) return;
      const userId = event?.userId ?? event?.user_id;
      const version = event?.version;
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'chat_participant_delete',
        channelId,
        userId: userId != null ? String(userId) : undefined,
        version: typeof version === 'number' ? version : undefined,
      });
    });

    // UpdateNewScheduledMessage — новое отложенное сообщение
    wrap([ApiAny.UpdateNewScheduledMessage], async (event) => {
      const message = event?.message;
      let channelId: string | undefined;
      if (message?.peerId) {
        const p = message.peerId;
        if (p?.userId != null) channelId = String(p.userId);
        else if (p?.chatId != null) channelId = String(p.chatId);
        else if (p?.channelId != null) channelId = String(p.channelId);
      }
      if (channelId) {
        const allowed = await this.isChatAllowedForAccount(accountId, channelId);
        if (!allowed) return;
      }
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'scheduled_message',
        channelId,
        poll: message ? (message as any) : undefined,
      });
    });

    // UpdateDeleteScheduledMessages — удалены отложенные сообщения
    wrap([ApiAny.UpdateDeleteScheduledMessages], async (event) => {
      const peer = event?.peer;
      let channelId = '';
      if (peer) {
        if (peer.userId != null) channelId = String(peer.userId);
        else if (peer.chatId != null) channelId = String(peer.chatId);
        else if (peer.channelId != null) channelId = String(peer.channelId);
      }
      const ids = event?.messages ?? event?.messageIds ?? [];
      const messageIds = Array.isArray(ids) ? ids.filter((n: any) => typeof n === 'number') : [];
      if (channelId) {
        const allowed = await this.isChatAllowedForAccount(accountId, channelId);
        if (!allowed) return;
      }
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'delete_scheduled_messages',
        channelId: channelId || undefined,
        messageIds: messageIds.length ? messageIds : undefined,
      });
    });

    // UpdateMessagePoll — обновление опроса
    wrap([ApiAny.UpdateMessagePoll], async (event) => {
      const pollId = event?.pollId ?? event?.poll_id;
      const poll = event?.poll;
      const results = event?.results;
      if (pollId == null) return;
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'message_poll',
        pollId: String(pollId),
        poll: poll && typeof poll === 'object' ? (poll as Record<string, unknown>) : undefined,
        results: results && typeof results === 'object' ? (results as Record<string, unknown>) : undefined,
      });
    });

    // UpdateMessagePollVote — голос в опросе
    wrap([ApiAny.UpdateMessagePollVote], async (event) => {
      const pollId = event?.pollId ?? event?.poll_id;
      const options = event?.options;
      const opts = Array.isArray(options) ? options.map(String) : undefined;
      const qts = event?.qts;
      if (pollId == null) return;
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'message_poll_vote',
        pollId: String(pollId),
        options: opts,
        qts: typeof qts === 'number' ? qts : undefined,
      });
    });

    // UpdateConfig — конфиг
    wrap([ApiAny.UpdateConfig], async () => {
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'config',
      });
    });

    // UpdateDcOptions — опции дата-центров
    wrap([ApiAny.UpdateDcOptions], async () => {
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'dc_options',
      });
    });

    // UpdateLangPack — языковой пакет
    wrap([ApiAny.UpdateLangPack], async () => {
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'lang_pack',
      });
    });

    // UpdateTheme — тема
    wrap([ApiAny.UpdateTheme], async () => {
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'theme',
      });
    });

    // UpdatePhoneCall — звонок
    wrap([ApiAny.UpdatePhoneCall], async (event) => {
      const phoneCall = event?.phoneCall;
      const phoneCallId = phoneCall?.id ?? (phoneCall as any)?.id;
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'phone_call',
        phoneCallId: phoneCallId != null ? String(phoneCallId) : undefined,
      });
    });

    // UpdateBotCallbackQuery — callback от инлайн-кнопки
    wrap([ApiAny.UpdateBotCallbackQuery], async (event) => {
      const queryId = event?.queryId ?? event?.query_id;
      const userId = event?.userId ?? event?.user_id;
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'callback_query',
        queryId: queryId != null ? String(queryId) : undefined,
        userId: userId != null ? String(userId) : undefined,
      });
    });

    // UpdateChannelTooLong — канал/чат «слишком длинный», нужен getDifference
    wrap([ApiAny.UpdateChannelTooLong], async (event) => {
      const channelIdRaw = event?.channelId ?? event?.channel_id;
      const channelId = channelIdRaw != null ? String(channelIdRaw) : '';
      const pts = event?.pts;
      if (!channelId) return;
      const allowed = await this.isChatAllowedForAccount(accountId, channelId);
      if (!allowed) return;
      await publish({
        bdAccountId: accountId,
        organizationId,
        updateKind: 'channel_too_long',
        channelId,
        pts: typeof pts === 'number' ? pts : undefined,
      });
    });
  }

  /**
   * Удалить сообщение в Telegram через client.deleteMessages (подходит для личных чатов, групп и каналов).
   */
  async deleteMessageInTelegram(accountId: string, channelId: string, telegramMessageId: number): Promise<void> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo?.client) throw new Error('Account not connected');
    const client = clientInfo.client;
    const peerInput = (() => {
      const n = Number(channelId);
      if (!Number.isNaN(n)) return n;
      return channelId;
    })();
    const peer = await client.getInputEntity(peerInput);
    await (client as any).deleteMessages(peer, [telegramMessageId], { revoke: true });
  }

  /**
   * Чат в списке выбранных при синхронизации (bd_account_sync_chats). Только по таким чатам публикуем MessageReceivedEvent на фронт.
   */
  private async isChatAllowedForAccount(accountId: string, telegramChatId: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
      [accountId, telegramChatId]
    );
    return result.rows.length > 0;
  }

  /**
   * Чат входит хотя бы в одну папку, отличную от «Все чаты» (folder_id <> 0).
   * Уведомления не шлём по чатам, которые только в фиктивной папке All chats — иначе прилетали бы пуши по всем диалогам.
   */
  private async isChatInNonAllChatsFolder(accountId: string, telegramChatId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM (
        SELECT folder_id FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 AND folder_id IS NOT NULL AND folder_id <> 0
        UNION
        SELECT folder_id FROM bd_account_sync_chat_folders WHERE bd_account_id = $1 AND telegram_chat_id = $2 AND folder_id <> 0
      ) u LIMIT 1`,
      [accountId, telegramChatId]
    );
    return result.rows.length > 0;
  }

  /** ЭТАП 7 — обеспечить наличие conversation перед сохранением сообщения. */
  private async ensureConversation(params: {
    organizationId: string;
    bdAccountId: string;
    channel: string;
    channelId: string;
    contactId: string | null;
  }): Promise<void> {
    await this.pool.query(
      `INSERT INTO conversations (id, organization_id, bd_account_id, channel, channel_id, contact_id, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (organization_id, bd_account_id, channel, channel_id)
       DO UPDATE SET contact_id = COALESCE(EXCLUDED.contact_id, conversations.contact_id), updated_at = NOW()`,
      [params.organizationId, params.bdAccountId, params.channel, params.channelId, params.contactId]
    );
  }

  /**
   * Сохраняет сообщение в БД с полными данными Telegram (entities, media, reply_to, extra).
   * При совпадении (bd_account_id, channel_id, telegram_message_id) обновляет запись.
   */
  private async saveMessageToDb(params: {
    organizationId: string;
    bdAccountId: string;
    contactId: string | null;
    channel: string;
    channelId: string;
    direction: string;
    status: string;
    unread: boolean;
    serialized: SerializedTelegramMessage;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    const {
      organizationId,
      bdAccountId,
      contactId,
      channel,
      channelId,
      direction,
      status,
      unread,
      serialized,
      metadata = {},
    } = params;

    await this.ensureConversation({ organizationId, bdAccountId, channel, channelId, contactId });

    const {
      telegram_message_id,
      telegram_date,
      content,
      telegram_entities,
      telegram_media,
      reply_to_telegram_id,
      telegram_extra,
    } = serialized;

    const reactionsFromTg = reactionsFromTelegramExtra(telegram_extra);
    const reactionsJson = reactionsFromTg ? JSON.stringify(reactionsFromTg) : null;
    const ourReactionsFromTg = ourReactionsFromTelegramExtra(telegram_extra);
    const ourReactionsJson = ourReactionsFromTg?.length ? JSON.stringify(ourReactionsFromTg) : null;

    const result = await this.pool.query(
      `INSERT INTO messages (
        organization_id, bd_account_id, contact_id, channel, channel_id, direction, content, status, unread,
        metadata, telegram_message_id, telegram_date, loaded_at, reply_to_telegram_id, telegram_entities, telegram_media, telegram_extra, reactions, our_reactions
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13, $14, $15, $16, $17, $18)
      ON CONFLICT (bd_account_id, channel_id, telegram_message_id) WHERE (telegram_message_id IS NOT NULL)
      DO UPDATE SET
        content = EXCLUDED.content,
        reply_to_telegram_id = COALESCE(EXCLUDED.reply_to_telegram_id, messages.reply_to_telegram_id),
        telegram_entities = EXCLUDED.telegram_entities,
        telegram_media = EXCLUDED.telegram_media,
        telegram_extra = EXCLUDED.telegram_extra,
        reactions = COALESCE(EXCLUDED.reactions, messages.reactions),
        our_reactions = COALESCE(EXCLUDED.our_reactions, messages.our_reactions),
        unread = EXCLUDED.unread,
        updated_at = NOW()
      RETURNING id`,
      [
        organizationId,
        bdAccountId,
        contactId,
        channel,
        channelId,
        direction,
        content,
        status,
        unread,
        JSON.stringify(metadata),
        telegram_message_id || null,
        telegram_date,
        reply_to_telegram_id,
        telegram_entities ? JSON.stringify(telegram_entities) : null,
        telegram_media ? JSON.stringify(telegram_media) : null,
        Object.keys(telegram_extra).length ? JSON.stringify(telegram_extra) : null,
        reactionsJson,
        ourReactionsJson,
      ]
    );
    return result.rows[0];
  }

  /**
   * Найти или создать контакт по telegram_id; при наличии userInfo — заполнить/обновить first_name, last_name, username, phone, bio, premium из Telegram.
   */
  private async upsertContactFromTelegramUser(
    organizationId: string,
    telegramId: string,
    userInfo?: {
      firstName: string;
      lastName: string | null;
      username: string | null;
      phone?: string | null;
      bio?: string | null;
      premium?: boolean | null;
    }
  ): Promise<string | null> {
    if (!telegramId?.trim()) return null;
    const existing = await this.pool.query(
      'SELECT id, first_name, last_name, username, phone, bio, premium FROM contacts WHERE telegram_id = $1 AND organization_id = $2 LIMIT 1',
      [telegramId, organizationId]
    );
    const firstName = userInfo?.firstName?.trim() ?? '';
    const lastName = (userInfo?.lastName?.trim() || null) ?? null;
    const username = (userInfo?.username?.trim() || null) ?? null;
    const phone = userInfo?.phone != null ? (String(userInfo.phone).trim() || null) : null;
    const bio = userInfo?.bio != null ? (String(userInfo.bio).trim() || null) : null;
    const premium = userInfo?.premium ?? null;

    if (existing.rows.length > 0) {
      const row = existing.rows[0] as { id: string; first_name: string; last_name: string | null; username: string | null; phone: string | null; bio: string | null; premium: boolean | null };
      const id = row.id;
      if (userInfo) {
        const newFirst = firstName || row.first_name || '';
        const newLast = lastName !== null ? lastName : row.last_name;
        const newUsername = username !== null ? username : row.username;
        const newPhone = phone !== null ? phone : row.phone;
        const newBio = bio !== null ? bio : row.bio;
        const newPremium = premium !== null ? premium : row.premium;
        await this.pool.query(
          `UPDATE contacts SET first_name = $2, last_name = $3, username = $4, phone = $5, bio = $6, premium = $7, updated_at = NOW()
           WHERE id = $1 AND organization_id = $8`,
          [id, newFirst, newLast, newUsername, newPhone, newBio, newPremium, organizationId]
        );
      }
      return id;
    }
    try {
      const insert = await this.pool.query(
        `INSERT INTO contacts (organization_id, telegram_id, first_name, last_name, username, phone, bio, premium)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [organizationId, telegramId, firstName || '', lastName, username, phone, bio, premium]
      );
      if (insert.rows.length > 0) return insert.rows[0].id;
    } catch (e: unknown) {
      this.log.debug({ message: 'Contact insert failed, will SELECT', organizationId, telegramId, error: String(e) });
    }
    const again = await this.pool.query(
      'SELECT id FROM contacts WHERE telegram_id = $1 AND organization_id = $2 LIMIT 1',
      [telegramId, organizationId]
    );
    return again.rows.length > 0 ? again.rows[0].id : null;
  }

  /** Устаревший алиас: только обеспечить контакт по telegram_id без данных из TG. */
  private async ensureContactForTelegramId(organizationId: string, telegramId: string): Promise<string | null> {
    return this.upsertContactFromTelegramUser(organizationId, telegramId);
  }

  /**
   * Найти или создать контакт по telegram_id; при возможности запрашивает getEntity (и опционально GetFullUser).
   * Если контакт уже есть в БД с заполненным именем — запросов к Telegram не делаем (снижает нагрузку при синхронизации).
   * skipGetFullUser: true — только getEntity (1 запрос); false — getEntity + GetFullUser (bio, phone из fullUser).
   */
  private async ensureContactEnrichedFromTelegram(
    organizationId: string,
    accountId: string,
    telegramId: string,
    opts?: { skipGetFullUser?: boolean }
  ): Promise<string | null> {
    const existing = await this.pool.query(
      'SELECT id, first_name, last_name FROM contacts WHERE telegram_id = $1 AND organization_id = $2 LIMIT 1',
      [telegramId, organizationId]
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0] as { id: string; first_name: string | null; last_name: string | null };
      const hasName = (row.first_name != null && String(row.first_name).trim() !== '') ||
        (row.last_name != null && String(row.last_name).trim() !== '');
      if (hasName) return row.id;
    }

    const userIdNum = parseInt(telegramId, 10);
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo?.client || !Number.isInteger(userIdNum) || userIdNum <= 0) {
      return this.ensureContactForTelegramId(organizationId, telegramId);
    }
    const skipGetFullUser = opts?.skipGetFullUser !== false;
    try {
      const client = clientInfo.client;
      const peer = await client.getInputEntity(userIdNum);
      const entity = await client.getEntity(peer);
      const isUser = entity && ((entity as any).className === 'User' || (entity as any)._ === 'user');
      if (!isUser) return this.ensureContactForTelegramId(organizationId, telegramId);

      const u = entity as Api.User;
      let phone: string | null = (u.phone != null ? String(u.phone).trim() : null) || null;
      let bio: string | null = null;
      const premiumRaw = (u as any).premium;
      const premium: boolean | null = typeof premiumRaw === 'boolean' ? premiumRaw : null;

      if (!skipGetFullUser) {
        try {
          const fullResult = await client.invoke(
            new Api.users.GetFullUser({ id: peer })
          ) as Api.users.UserFull;
          const fullUser = (fullResult as any).fullUser ?? fullResult?.fullUser;
          if (fullUser?.about != null) bio = String(fullUser.about).trim() || null;
          if (fullUser?.phone != null && !phone) phone = String(fullUser.phone).trim() || null;
        } catch (fullErr: any) {
          if (fullErr?.message !== 'TIMEOUT' && !fullErr?.message?.includes('Could not find')) {
            this.log.warn({ message: 'GetFullUser for contact enrichment', error: fullErr?.message });
          }
        }
      }

      return this.upsertContactFromTelegramUser(organizationId, telegramId, {
        firstName: (u.firstName ?? '').trim(),
        lastName: (u.lastName ?? '').trim() || null,
        username: (u.username ?? '').trim() || null,
        phone,
        bio,
        premium,
      });
    } catch (e: any) {
      if (e?.message !== 'TIMEOUT' && !e?.message?.includes('Could not find')) {
        this.log.warn({ message: "getEntity for contact enrichment", error: e?.message });
      }
      return this.ensureContactForTelegramId(organizationId, telegramId);
    }
  }

  /**
   * Обновить контакт по telegram_id данными из диалога (first_name, last_name, username).
   * Вызывается при синхронизации чатов — обогащение контактов при sync.
   */
  async enrichContactFromDialog(
    organizationId: string,
    telegramId: string,
    userInfo?: { firstName?: string; lastName?: string | null; username?: string | null }
  ): Promise<void> {
    if (!telegramId?.trim()) return;
    const firstName = userInfo?.firstName?.trim() ?? '';
    const lastName = userInfo?.lastName != null ? (userInfo.lastName?.trim() || null) : null;
    const username = userInfo?.username != null ? (userInfo.username?.trim() || null) : null;
    const hasInfo = firstName || lastName || username;
    await this.upsertContactFromTelegramUser(organizationId, telegramId, hasInfo ? { firstName: firstName || '', lastName, username } : undefined);
  }

  /**
   * Обогатить контакты данными из Telegram (first_name, last_name, username) по getEntity.
   * Используется перед запуском кампании по галочке «Обогащать контакты из Telegram».
   */
  async enrichContactsFromTelegram(
    organizationId: string,
    contactIds: string[],
    bdAccountId?: string
  ): Promise<{ enriched: number }> {
    if (!contactIds?.length) return { enriched: 0 };
    let accountId = bdAccountId ?? null;
    if (accountId) {
      const check = await this.pool.query(
        'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2 AND is_active = true LIMIT 1',
        [accountId, organizationId]
      );
      if (check.rows.length === 0) accountId = null;
    }
    if (!accountId) {
      const first = await this.pool.query(
        'SELECT id FROM bd_accounts WHERE organization_id = $1 AND is_active = true LIMIT 1',
        [organizationId]
      );
      accountId = first.rows[0]?.id ?? null;
    }
    if (!accountId || !this.clients.has(accountId)) return { enriched: 0 };
    const rows = await this.pool.query(
      'SELECT id, telegram_id FROM contacts WHERE id = ANY($1) AND organization_id = $2',
      [contactIds, organizationId]
    );
    let enriched = 0;
    for (const row of rows.rows as { id: string; telegram_id: string | null }[]) {
      if (row.telegram_id && parseInt(row.telegram_id, 10) > 0) {
        await this.ensureContactEnrichedFromTelegram(organizationId, accountId, row.telegram_id);
        enriched++;
      }
    }
    return { enriched };
  }

  /**
   * Обогатить контакты по всем личным чатам из bd_account_sync_chats для аккаунта.
   * Вызывается после сохранения выбранных чатов (POST sync-chats), чтобы first_name, last_name, username, phone, bio, premium попали в БД.
   */
  async enrichContactsForAccountSyncChats(
    organizationId: string,
    accountId: string,
    opts?: { delayMs?: number }
  ): Promise<{ enriched: number }> {
    const accountRow = await this.pool.query(
      'SELECT telegram_id FROM bd_accounts WHERE id = $1 AND organization_id = $2 LIMIT 1',
      [accountId, organizationId]
    );
    if (accountRow.rows.length === 0) return { enriched: 0 };
    const selfTelegramId = accountRow.rows[0].telegram_id != null ? String(accountRow.rows[0].telegram_id).trim() : null;

    const chats = await this.pool.query(
      'SELECT telegram_chat_id, peer_type FROM bd_account_sync_chats WHERE bd_account_id = $1 AND peer_type = $2',
      [accountId, 'user']
    );
    const delayMs = typeof opts?.delayMs === 'number' ? Math.max(0, opts.delayMs) : 80;
    let enriched = 0;
    for (const row of chats.rows as { telegram_chat_id: string; peer_type: string }[]) {
      const tid = String(row.telegram_chat_id).trim();
      if (!tid || (selfTelegramId && tid === selfTelegramId)) continue;
      if (parseInt(tid, 10) <= 0) continue;
      try {
        await this.ensureContactEnrichedFromTelegram(organizationId, accountId, tid, { skipGetFullUser: true });
        enriched++;
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      } catch (e: any) {
        this.log.warn({ message: 'enrichContactsForAccountSyncChats single', telegramId: tid, error: e?.message });
      }
    }
    return { enriched };
  }

  /**
   * Handle short update (UpdateShortMessage / UpdateShortChatMessage) — входящие и исходящие с другого устройства.
   */
  private async handleShortMessageUpdate(
    update: any,
    accountId: string,
    organizationId: string
  ): Promise<void> {
    try {
      const isOut = (update as any).out === true;
      const name = update?.className ?? update?.constructor?.name ?? '';
      const userId = (update as any).userId ?? (update as any).user_id;
      const fromId = (update as any).fromId ?? (update as any).from_id;
      const chatIdRaw = (update as any).chatId ?? (update as any).chat_id;
      const msgId = (update as any).id;
      const text = (update as any).message;
      const date = (update as any).date;
      this.log.info({ message: `Short message ${isOut ? 'outgoing' : 'incoming'}: ${name}, accountId=${accountId}, chatId=${chatIdRaw ?? userId}` });
      if (typeof text !== 'string' || !text.trim()) return;

      const chatId = name === 'UpdateShortChatMessage'
        ? String(chatIdRaw ?? fromId ?? '')
        : String(userId ?? '');
      const senderId = name === 'UpdateShortChatMessage'
        ? String(fromId ?? '')
        : String(userId ?? '');

      if (!chatId) return;

      // Только чаты, которые пользователь выбрал при синхронизации (bd_account_sync_chats). Не авто-добавляем при приходе сообщения.
      const allowed = await this.isChatAllowedForAccount(accountId, chatId);
      if (!allowed) {
        this.log.info({ message: `Short: chat not in sync list (user did not select during sync), skipping, accountId=${accountId}, chatId=${chatId}` });
        return;
      }

      const contactTelegramId = senderId || chatId;
      const contactId = await this.ensureContactEnrichedFromTelegram(organizationId, accountId, contactTelegramId);
      const direction = isOut ? MessageDirection.OUTBOUND : MessageDirection.INBOUND;
      const telegramDate = date ? (typeof date === 'number' ? new Date(date * 1000) : new Date(date)) : null;
      const serialized: SerializedTelegramMessage = {
        telegram_message_id: String(msgId),
        telegram_date: telegramDate,
        content: text.trim(),
        telegram_entities: null,
        telegram_media: null,
        reply_to_telegram_id: null,
        telegram_extra: {},
      };

      const savedMessage = await this.saveMessageToDb({
        organizationId,
        bdAccountId: accountId,
        contactId,
        channel: MessageChannel.TELEGRAM,
        channelId: chatId,
        direction,
        status: MessageStatus.DELIVERED,
        unread: !isOut,
        serialized,
        metadata: { senderId, short: true },
      });

      const clientInfo = this.clients.get(accountId);
      if (clientInfo) {
        clientInfo.lastActivity = new Date();
        await this.pool.query('UPDATE bd_accounts SET last_activity = NOW() WHERE id = $1', [accountId]);
      }

      // Всегда публикуем MESSAGE_RECEIVED, чтобы campaign-service и др. могли обработать ответ (в т.ч. для чатов только в «Все чаты»).
      const event: MessageReceivedEvent = {
        id: randomUUID(),
        type: EventType.MESSAGE_RECEIVED,
        timestamp: new Date(),
        organizationId,
        data: {
          messageId: savedMessage.id,
          channel: MessageChannel.TELEGRAM,
          channelId: chatId,
          contactId: contactId || undefined,
          bdAccountId: accountId,
          content: serialized.content,
          direction: isOut ? 'outbound' : 'inbound',
          telegramMessageId: serialized.telegram_message_id || undefined,
          replyToTelegramId: serialized.reply_to_telegram_id || undefined,
          createdAt: new Date().toISOString(),
        },
      };
      await this.rabbitmq.publishEvent(event);
      this.log.info({ message: `Short message saved and event published, messageId=${savedMessage.id}, channelId=${chatId}` });
    } catch (error) {
      this.log.error({ message: `Error handling short message`, error: error?.message || String(error) });
    }
  }

  /**
   * Handle new message (incoming or outgoing from another device). Only for chats in bd_account_sync_chats
   * (chats the user selected during sync). No auto-add on message — save + emit event only for sync_chats.
   */
  private async handleNewMessage(
    message: Api.Message,
    accountId: string,
    organizationId: string
  ): Promise<void> {
    try {
      const isOut = (message as any).out === true;
      let chatId = '';
      if (message.peerId) {
        if (message.peerId instanceof Api.PeerUser) chatId = String(message.peerId.userId);
        else if (message.peerId instanceof Api.PeerChat) chatId = String(message.peerId.chatId);
        else if (message.peerId instanceof Api.PeerChannel) chatId = String(message.peerId.channelId);
        else chatId = String(message.peerId);
      }
      this.log.info({ message: `New message ${isOut ? 'outgoing' : 'incoming'}`, error: { accountId, chatId } });
      const text = getMessageText(message);
      if (!text.trim() && !message.media) {
        return; // Skip empty messages
      }

      let senderId = '';
      if (message.fromId) {
        if (message.fromId instanceof Api.PeerUser) {
          senderId = String(message.fromId.userId);
        } else {
          senderId = String(message.fromId);
        }
      }

      // Только чаты, которые пользователь выбрал при синхронизации (bd_account_sync_chats). Не авто-добавляем чаты при приходе сообщения — иначе прилетали бы уведомления по всем чатам.
      const allowed = await this.isChatAllowedForAccount(accountId, chatId);
      if (!allowed) {
        this.log.info({ message: `Chat not in sync list (user did not select this chat during sync), skipping message, accountId=${accountId}, chatId=${chatId}` });
        return;
      }

      let contactId: string | null = null;
      const tid = senderId || chatId;
      if (message.fromId && message.fromId instanceof Api.PeerUser) {
        const clientInfo = this.clients.get(accountId);
        if (clientInfo?.client) {
          try {
            const peer = await clientInfo.client.getInputEntity(parseInt(tid, 10));
            const entity = await clientInfo.client.getEntity(peer);
            if (entity && (entity as any).className === 'User') {
              const u = entity as Api.User;
              contactId = await this.upsertContactFromTelegramUser(organizationId, tid, {
                firstName: (u.firstName ?? '').trim(),
                lastName: (u.lastName ?? '').trim() || null,
                username: (u.username ?? '').trim() || null,
              });
            }
          } catch (e: any) {
            if (e?.message !== 'TIMEOUT' && !e?.message?.includes('Could not find')) {
              this.log.warn({ message: "getEntity for contact enrichment", error: e?.message });
            }
          }
        }
      }
      if (contactId == null) {
        contactId = await this.upsertContactFromTelegramUser(organizationId, tid);
      }
      const direction = isOut ? MessageDirection.OUTBOUND : MessageDirection.INBOUND;

      const serialized = serializeMessage(message);
      const savedMessage = await this.saveMessageToDb({
        organizationId,
        bdAccountId: accountId,
        contactId,
        channel: MessageChannel.TELEGRAM,
        channelId: chatId,
        direction,
        status: MessageStatus.DELIVERED,
        unread: !isOut,
        serialized,
        metadata: { senderId, hasMedia: !!message.media },
      });

      // Update last activity
      const clientInfo = this.clients.get(accountId);
      if (clientInfo) {
        clientInfo.lastActivity = new Date();
        await this.pool.query(
          'UPDATE bd_accounts SET last_activity = NOW() WHERE id = $1',
          [accountId]
        );
      }

      // Всегда публикуем MESSAGE_RECEIVED, чтобы campaign-service мог пометить «ответил» и создать лида при ответе (в т.ч. для чатов только в «Все чаты»).
      const event: MessageReceivedEvent = {
        id: randomUUID(),
        type: EventType.MESSAGE_RECEIVED,
        timestamp: new Date(),
        organizationId,
        data: {
          messageId: savedMessage.id,
          channel: MessageChannel.TELEGRAM,
          channelId: chatId,
          contactId: contactId || undefined,
          bdAccountId: accountId,
          content: serialized.content,
          direction: isOut ? 'outbound' : 'inbound',
          telegramMessageId: serialized.telegram_message_id || undefined,
          replyToTelegramId: serialized.reply_to_telegram_id || undefined,
          telegramMedia: serialized.telegram_media || undefined,
          telegramEntities: serialized.telegram_entities || undefined,
          createdAt: new Date().toISOString(),
        },
      };
      await this.rabbitmq.publishEvent(event);
      this.log.info({ message: `MessageReceivedEvent published, messageId=${savedMessage.id}, channelId=${chatId}` });
    } catch (error) {
      this.log.error({ message: `Error handling new message`, error: error?.message || String(error) });
    }
  }

  /** Delay between Telegram API calls to respect rate limits (ms) */
  private readonly SYNC_DELAY_MS = 1100;
  /** Initial sync: only this many messages per chat (one page); older messages load on scroll via load-older-history. */
  private readonly SYNC_INITIAL_MESSAGES_PER_CHAT = parseInt(process.env.SYNC_INITIAL_MESSAGES_PER_CHAT || '100', 10) || 100;
  /** Legacy: depth in days for syncHistoryForChat / other paths; initial sync uses SYNC_INITIAL_MESSAGES_PER_CHAT only. */
  private readonly SYNC_MESSAGES_MAX_AGE_DAYS = parseInt(process.env.SYNC_MESSAGES_MAX_AGE_DAYS || '365', 10) || 365;
  /** Safety cap: max messages per chat when loading older on demand (load-older-history). */
  private readonly SYNC_MESSAGES_PER_CHAT_CAP = parseInt(process.env.SYNC_MESSAGES_PER_CHAT_CAP || '50000', 10) || 50000;

  /**
   * Run initial history sync for selected chats: one page of messages per chat (SYNC_INITIAL_MESSAGES_PER_CHAT).
   * Older history loads on demand when user scrolls up (load-older-history). Fast sync, then lazy load per chat.
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
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    for (let i = 0; i < chats.length; i++) {
      const { telegram_chat_id: telegramChatId, title, peer_type: peerType } = chats[i];
      const isUserChat = (peerType || 'user').toLowerCase() === 'user';
      let fetched = 0;
      const chatNum = i + 1;
      this.log.info({ message: `Processing chat ${chatNum}/${totalChats}: ${title} (id=${telegramChatId})` });

      try {
        // GramJS getInputEntity: numeric IDs (incl. -100xxx for channels) must be number; usernames stay string
        const peerIdNum = Number(telegramChatId);
        const peerInput = Number.isNaN(peerIdNum) ? telegramChatId : peerIdNum;
        const peer = await client.getInputEntity(peerInput);
        let offsetId = 0;
        const cap = this.SYNC_INITIAL_MESSAGES_PER_CHAT;
        const batchSize = Math.min(100, cap);

        // For user (1-1) chats, pre-enrich contact so first_name/last_name/username are in DB even before first message
        if (isUserChat && Number(telegramChatId) > 0) {
          await this.ensureContactEnrichedFromTelegram(organizationId, accountId, telegramChatId);
        }

        while (fetched < cap) {
          try {
            const result = await client.invoke(
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

              // For 1-1 chats the contact is the other party (chatId); for groups use message author (senderId)
              const contactTelegramId = isUserChat ? chatId : (senderId || chatId);
              const contactId = await this.ensureContactEnrichedFromTelegram(organizationId, accountId, contactTelegramId);

              const direction = (msg as any).out === true ? MessageDirection.OUTBOUND : MessageDirection.INBOUND;
              const serialized = serializeMessage(msg);
              await this.saveMessageToDb({
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
        // Не прерываем весь sync: обновляем прогресс и продолжаем со следующим чатом
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

  private static mapDialogToItem(dialog: any): any {
    const pinned = !!(dialog.pinned ?? dialog.dialog?.pinned);
    const entity = dialog.entity;
    const isUser = dialog.isUser ?? (entity && (entity.className === 'User' || entity.constructor?.className === 'User'));
    let first_name: string | undefined;
    let last_name: string | null | undefined;
    let username: string | null | undefined;
    if (entity && isUser) {
      first_name = (entity.firstName ?? entity.first_name ?? '').trim() || undefined;
      last_name = (entity.lastName ?? entity.last_name ?? '').trim() || null;
      username = (entity.username ?? '').trim() || null;
    }
    return {
      id: String(dialog.id),
      name: dialog.name || dialog.title || 'Unknown',
      unreadCount: dialog.unreadCount || 0,
      lastMessage: dialog.message?.text || '',
      lastMessageDate: dialog.message?.date,
      isUser: dialog.isUser ?? !!isUser,
      isGroup: dialog.isGroup,
      isChannel: dialog.isChannel,
      pinned,
      ...(isUser && { first_name, last_name, username }),
    };
  }

  /**
   * Fetch all dialogs for a folder using iterDialogs (paginated by GramJS) with delay between batches to reduce flood wait.
   * Returns only users and groups (no channels) — for client communication (DMs and group chats), channels don't affect deals.
   */
  async getDialogsAll(
    accountId: string,
    folderId: number,
    options?: { maxDialogs?: number; delayEveryN?: number; delayMs?: number }
  ): Promise<any[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const maxDialogs = options?.maxDialogs ?? 3000;
    const delayEveryN = options?.delayEveryN ?? 100;
    const delayMs = options?.delayMs ?? 600;
    const result: any[] = [];
    let count = 0;
    const client = clientInfo.client as any;
    if (typeof client.iterDialogs !== 'function') {
      return this.getDialogs(accountId, folderId);
    }
    try {
      const iter = client.iterDialogs({ folder: folderId, limit: maxDialogs });
      for await (const dialog of iter) {
        if (dialog.isUser || dialog.isGroup) {
          result.push(TelegramManager.mapDialogToItem(dialog));
          count++;
          if (count % delayEveryN === 0 && count < maxDialogs) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
        }
        if (count >= maxDialogs) break;
      }
      this.log.info({ message: `getDialogsAll folder=${folderId} fetched ${result.length} dialogs` });
      return result;
    } catch (error: any) {
      if (error?.message === 'TIMEOUT' || error?.message?.includes('TIMEOUT')) throw error;
      this.log.error({ message: `Error getDialogsAll for ${accountId} folder ${folderId}`, error: error?.message || String(error) });
      throw error;
    }
  }

  /**
   * Get dialogs for an account (optionally filtered by folder). Single batch, max 100 — for lightweight calls.
   * For full list use getDialogsAll.
   */
  async getDialogs(accountId: string, folderId?: number): Promise<any[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }

    try {
      const opts: { limit: number; folderId?: number } = { limit: 100 };
      if (folderId !== undefined && folderId !== null) {
        opts.folderId = folderId;
      }
      const dialogs = await clientInfo.client.getDialogs(opts);
      const mapped = dialogs.map((dialog: any) => TelegramManager.mapDialogToItem(dialog));
      return mapped.filter((d: any) => d.isUser || d.isGroup);
    } catch (error) {
      this.log.error({ message: `Error getting dialogs for ${accountId}`, error: error?.message || String(error) });
      throw error;
    }
  }

  /**
   * Search groups/channels by keyword (messages.SearchGlobal). Returns unique chats from global message search.
   * Uses pagination (next_rate, offsetPeer, offsetId) to fetch more results; handles search_flood with backoff.
   * @param type - 'groups' | 'channels' | 'all' (default 'all')
   * @param maxPages - max pagination iterations (default 10) to avoid excessive requests
   */
  async searchGroupsByKeyword(
    accountId: string,
    query: string,
    limit: number = 50,
    type: 'groups' | 'channels' | 'all' = 'all',
    maxPages: number = 10
  ): Promise<{ chatId: string; title: string; peerType: string; membersCount?: number; username?: string }[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const q = (query || '').trim();
    if (q.length < 2) {
      const err = new Error('Query too short');
      (err as any).code = 'QUERY_TOO_SHORT';
      throw err;
    }
    const groupsOnly = type === 'groups';
    const broadcastOnly = type === 'channels';
    const requestLimit = Math.min(100, Math.max(1, limit));
    const seen = new Set<string>();
    const out: { chatId: string; title: string; peerType: string; membersCount?: number; username?: string }[] = [];
    let offsetRate = 0;
    let offsetPeer: InstanceType<typeof Api.InputPeerEmpty> = new Api.InputPeerEmpty();
    let offsetId = 0;
    let page = 0;
    const SEARCH_FLOOD_BACKOFF_MS = 8000;
    const PAGINATION_DELAY_MS = 1500;

    // Collect chat/channel IDs the user is already in — filter them out so we return only "new" groups (global search)
    const myChatIds = new Set<string>();
    try {
      const dialogs = await clientInfo.client.getDialogs({ limit: 150, folderId: 0 });
      for (const d of dialogs) {
        const ent = (d as any).entity;
        if (!ent) continue;
        const cls = String(ent.className ?? ent.constructor?.className ?? '').toLowerCase();
        if (cls.includes('channel') || cls.includes('chat')) {
          const id = ent.id ?? ent.channelId ?? ent.chatId;
          if (id != null) myChatIds.add(String(id));
        }
      }
    } catch (e: any) {
      this.log.warn({ message: 'Could not load dialogs for search filter', accountId, error: e?.message });
    }

    function extractChatsFromResult(
      result: { messages?: any[]; chats?: any[] },
      chatsAcc: typeof out,
      seenIds: Set<string>,
      excludeChatIds: Set<string>
    ): void {
      const chats = result?.chats ?? [];
      const messages = result?.messages ?? [];
      for (const msg of messages) {
        const peer = msg?.peer ?? msg?.peerId ?? msg?.peer_id;
        if (!peer) continue;
        const p = peer as any;
        let cid: string | null = null;
        const cn = String(peer.className ?? peer.constructor?.className ?? '').toLowerCase();
        if (cn.includes('peerchannel')) {
          const id = p.channelId ?? p.channel_id;
          if (id != null) cid = String(id);
        } else if (cn.includes('peerchat')) {
          const id = p.chatId ?? p.chat_id;
          if (id != null) cid = String(id);
        }
        if (cid && !seenIds.has(cid) && !excludeChatIds.has(cid)) {
          seenIds.add(cid);
          const chat = chats.find((c: any) => {
            const id = c.id ?? c.channelId ?? c.chat_id ?? c.chatId;
            return id != null && String(id) === cid;
          });
          const title = (chat?.title ?? chat?.name ?? '').trim() || cid;
          const peerType = (chat as any)?.broadcast ? 'channel' : (chat as any)?.megagroup ? 'group' : 'chat';
          const membersCount = chat?.participantsCount ?? chat?.participants_count ?? undefined;
          const username = (chat?.username ?? '').trim() || undefined;
          chatsAcc.push({ chatId: cid, title, peerType, membersCount, username });
        }
      }
      // Fallback: add channels/groups from result.chats (in case message peer parsing missed them)
      for (const c of chats) {
        const id = c.id ?? c.channelId ?? c.chat_id ?? c.chatId;
        if (id == null) continue;
        const cid = String(id);
        const cn = String(c.className ?? c.constructor?.className ?? '').toLowerCase();
        const isChannel = cn.includes('channel');
        const isChat = cn.includes('chat') && !cn.includes('peer');
        if (!isChannel && !isChat) continue;
        if (seenIds.has(cid) || excludeChatIds.has(cid)) continue;
        seenIds.add(cid);
        const title = (c.title ?? c.name ?? '').trim() || cid;
        const peerType = (c as any)?.broadcast ? 'channel' : (c as any)?.megagroup ? 'group' : 'chat';
        const membersCount = c?.participantsCount ?? c?.participants_count ?? undefined;
        const username = (c?.username ?? '').trim() || undefined;
        chatsAcc.push({ chatId: cid, title, peerType, membersCount, username });
      }
    }

    try {
      const client = clientInfo.client;

      while (page < maxPages) {
        let result: any;
        try {
          result = await client.invoke(
            new Api.messages.SearchGlobal({
              q,
              filter: new Api.InputMessagesFilterEmpty(),
              minDate: 0,
              maxDate: 0,
              offsetRate,
              offsetPeer,
              offsetId,
              limit: requestLimit,
              folderId: 0,
              broadcastOnly,
              groupsOnly,
              samePeer: false,
            })
          );
        } catch (e: any) {
          if (e?.message?.includes('QUERY_TOO_SHORT') || (e as any)?.code === 'QUERY_TOO_SHORT') {
            const err = new Error('Query too short');
            (err as any).code = 'QUERY_TOO_SHORT';
            throw err;
          }
          throw e;
        }

        const messages = result?.messages ?? [];
        const isSlice = result?.className === 'messages.messagesSlice' || (result?.constructor?.className === 'messages.messagesSlice');
        const searchFlood = !!(result?.searchFlood ?? result?.search_flood);

        if (searchFlood) {
          this.log.warn({ message: 'SearchGlobal search_flood, backing off', accountId, query: q, page });
          await new Promise((r) => setTimeout(r, SEARCH_FLOOD_BACKOFF_MS));
          const retryResult = await client.invoke(
            new Api.messages.SearchGlobal({
              q,
              filter: new Api.InputMessagesFilterEmpty(),
              minDate: 0,
              maxDate: 0,
              offsetRate,
              offsetPeer,
              offsetId,
              limit: requestLimit,
              folderId: 0,
              broadcastOnly,
              groupsOnly,
              samePeer: false,
            })
          ) as any;
          if (retryResult?.searchFlood ?? retryResult?.search_flood) {
            this.log.warn({ message: 'SearchGlobal search_flood on retry, returning collected results', accountId, query: q });
            return out;
          }
          result = retryResult;
        }

        if (page === 0) {
          const msgCount = result?.messages?.length ?? 0;
          const chatCount = result?.chats?.length ?? 0;
          const firstMsgKeys = result?.messages?.[0] ? Object.keys(result.messages[0]).filter((k) => ['peer', 'peerId', 'peer_id'].includes(k)) : [];
          this.log.info({
            message: 'SearchGlobal first response',
            accountId,
            query: q,
            messagesCount: msgCount,
            chatsCount: chatCount,
            firstMessagePeerKeys: firstMsgKeys,
          });
        }

        extractChatsFromResult(result, out, seen, myChatIds);

        if (out.length >= limit) break;
        if (!isSlice || messages.length === 0) break;

        const nextRate = result?.nextRate ?? result?.next_rate;
        if (nextRate == null) break;

        const lastMsg = messages[messages.length - 1];
        offsetRate = typeof nextRate === 'number' ? nextRate : Number(nextRate) || 0;
        offsetId = lastMsg?.id ?? offsetId;
        try {
          const lastPeer = lastMsg?.peer ?? lastMsg?.peerId ?? lastMsg?.peer_id;
          if (lastPeer) {
            offsetPeer = await client.getInputEntity(lastPeer) as any;
          }
        } catch (_) {
          break;
        }

        page++;
        await new Promise((r) => setTimeout(r, PAGINATION_DELAY_MS));
      }

      return out;
    } catch (e: any) {
      if (e?.message?.includes('QUERY_TOO_SHORT') || (e as any)?.code === 'QUERY_TOO_SHORT') {
        const err = new Error('Query too short');
        (err as any).code = 'QUERY_TOO_SHORT';
        throw err;
      }
      this.log.error({ message: 'searchGroupsByKeyword failed', accountId, query: q, error: e?.message || String(e) });
      throw e;
    }
  }

  /**
   * Search public channels by keyword (channels.SearchPosts). Returns channels/groups from public posts
   * including those the user is not a member of. Use for type=channels or type=all in Contact Discovery.
   */
  async searchPublicChannelsByKeyword(
    accountId: string,
    query: string,
    limit: number = 50,
    maxPages: number = 10,
    searchMode: 'query' | 'hashtag' = 'query'
  ): Promise<{ chatId: string; title: string; peerType: string; membersCount?: number; username?: string }[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const q = (query || '').trim();
    if (q.length < 2) {
      const err = new Error('Query too short');
      (err as any).code = 'QUERY_TOO_SHORT';
      throw err;
    }
    const requestLimit = Math.min(100, Math.max(1, limit));
    const seen = new Set<string>();
    const out: { chatId: string; title: string; peerType: string; membersCount?: number; username?: string }[] = [];
    let offsetRate = 0;
    let offsetPeer: InstanceType<typeof Api.InputPeerEmpty> = new Api.InputPeerEmpty();
    let offsetId = 0;
    let page = 0;
    const SEARCH_FLOOD_BACKOFF_MS = 8000;
    const PAGINATION_DELAY_MS = 1500;
    const emptyExclude = new Set<string>();

    function extract(result: { messages?: any[]; chats?: any[] }, chatsAcc: typeof out, seenIds: Set<string>, excludeChatIds: Set<string>) {
      const chats = result?.chats ?? [];
      const messages = result?.messages ?? [];
      for (const msg of messages) {
        const peer = msg?.peer ?? msg?.peerId ?? msg?.peer_id;
        if (!peer) continue;
        const p = peer as any;
        let cid: string | null = null;
        const cn = String(peer.className ?? peer.constructor?.className ?? '').toLowerCase();
        if (cn.includes('peerchannel')) {
          const id = p.channelId ?? p.channel_id;
          if (id != null) cid = String(id);
        } else if (cn.includes('peerchat')) {
          const id = p.chatId ?? p.chat_id;
          if (id != null) cid = String(id);
        }
        if (cid && !seenIds.has(cid) && !excludeChatIds.has(cid)) {
          seenIds.add(cid);
          const chat = chats.find((c: any) => {
            const id = c.id ?? c.channelId ?? c.chat_id ?? c.chatId;
            return id != null && String(id) === cid;
          });
          const title = (chat?.title ?? chat?.name ?? '').trim() || cid;
          const peerType = (chat as any)?.broadcast ? 'channel' : (chat as any)?.megagroup ? 'group' : 'chat';
          const membersCount = chat?.participantsCount ?? chat?.participants_count ?? undefined;
          const username = (chat?.username ?? '').trim() || undefined;
          chatsAcc.push({ chatId: cid, title, peerType, membersCount, username });
        }
      }
      for (const c of chats) {
        const id = c.id ?? c.channelId ?? c.chat_id ?? c.chatId;
        if (id == null) continue;
        const cid = String(id);
        const cn = String(c.className ?? c.constructor?.className ?? '').toLowerCase();
        const isChannel = cn.includes('channel');
        const isChat = cn.includes('chat') && !cn.includes('peer');
        if (!isChannel && !isChat) continue;
        if (seenIds.has(cid) || excludeChatIds.has(cid)) continue;
        seenIds.add(cid);
        const title = (c.title ?? c.name ?? '').trim() || cid;
        const peerType = (c as any)?.broadcast ? 'channel' : (c as any)?.megagroup ? 'group' : 'chat';
        const membersCount = c?.participantsCount ?? c?.participants_count ?? undefined;
        const username = (c?.username ?? '').trim() || undefined;
        chatsAcc.push({ chatId: cid, title, peerType, membersCount, username });
      }
    }

    try {
      const client = clientInfo.client;

      const safeOffsetPeer = () => offsetPeer ?? new Api.InputPeerEmpty();

      while (page < maxPages) {
        let result: any;
        try {
          if (searchMode === 'hashtag') {
            const hashtagVal = (q.startsWith('#') ? q.slice(1) : q).trim() || ' ';
            result = await client.invoke(new Api.channels.SearchPosts({
              hashtag: hashtagVal,
              offsetRate,
              offsetPeer: safeOffsetPeer(),
              offsetId,
              limit: requestLimit,
            }));
          } else {
            // Вариант B: вместе с query передаём пустой hashtag, чтобы обойти строгую
            // проверку типов в пакете telegram (GramJS), которая ожидает строку.
            result = await client.invoke(new Api.channels.SearchPosts({
              query: q,
              hashtag: '',
              offsetRate,
              offsetPeer: safeOffsetPeer(),
              offsetId,
              limit: requestLimit,
            }));
          }
        } catch (e: any) {
          if (e?.message?.includes('QUERY_TOO_SHORT') || (e as any)?.code === 'QUERY_TOO_SHORT') {
            const err = new Error('Query too short');
            (err as any).code = 'QUERY_TOO_SHORT';
            throw err;
          }
          throw e;
        }

        const messages = result?.messages ?? [];
        const isSlice = result?.className === 'messages.messagesSlice' || (result?.constructor?.className === 'messages.messagesSlice');
        const searchFlood = !!(result?.searchFlood ?? result?.search_flood);

        if (searchFlood) {
          this.log.warn({ message: 'SearchPosts search_flood, backing off', accountId, query: q, page });
          await new Promise((r) => setTimeout(r, SEARCH_FLOOD_BACKOFF_MS));
          if (searchMode === 'hashtag') {
            const hashtagVal = (q.startsWith('#') ? q.slice(1) : q).trim() || ' ';
            result = await client.invoke(new Api.channels.SearchPosts({
              hashtag: hashtagVal,
              offsetRate,
              offsetPeer: safeOffsetPeer(),
              offsetId,
              limit: requestLimit,
            })) as any;
          } else {
            result = await client.invoke(new Api.channels.SearchPosts({
              query: q,
              hashtag: '',
              offsetRate,
              offsetPeer: safeOffsetPeer(),
              offsetId,
              limit: requestLimit,
            })) as any;
          }
          if (result?.searchFlood ?? result?.search_flood) {
            this.log.warn({ message: 'SearchPosts search_flood on retry, returning collected results', accountId, query: q });
            return out;
          }
        }

        extract(result, out, seen, emptyExclude);

        if (out.length >= limit) break;
        if (!isSlice || messages.length === 0) break;

        const nextRate = result?.nextRate ?? result?.next_rate;
        if (nextRate == null) break;

        const lastMsg = messages[messages.length - 1];
        offsetRate = typeof nextRate === 'number' ? nextRate : Number(nextRate) || 0;
        offsetId = lastMsg?.id ?? offsetId;
        try {
          const lastPeer = lastMsg?.peer ?? lastMsg?.peerId ?? lastMsg?.peer_id;
          if (lastPeer) {
            offsetPeer = await client.getInputEntity(lastPeer) as any;
          }
        } catch (_) {
          break;
        }

        page++;
        await new Promise((r) => setTimeout(r, PAGINATION_DELAY_MS));
      }

      return out;
    } catch (e: any) {
      if (e?.message?.includes('QUERY_TOO_SHORT') || (e as any)?.code === 'QUERY_TOO_SHORT') {
        const err = new Error('Query too short');
        (err as any).code = 'QUERY_TOO_SHORT';
        throw err;
      }
      this.log.error({ message: 'searchPublicChannelsByKeyword failed', accountId, query: q, error: e?.message || String(e) });
      throw e;
    }
  }

  /**
   * Search by contacts.search (Telegram API). Returns only groups and channels from the result;
   * personal chats (PeerUser) are excluded. Use to enrich type=all search.
   */
  async searchByContacts(
    accountId: string,
    query: string,
    limit: number = 50
  ): Promise<{ chatId: string; title: string; peerType: string; membersCount?: number; username?: string }[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const q = (query || '').trim();
    if (q.length < 2) {
      const err = new Error('Query too short');
      (err as any).code = 'QUERY_TOO_SHORT';
      throw err;
    }
    const requestLimit = Math.min(100, Math.max(1, limit));
    const seen = new Set<string>();
    const out: { chatId: string; title: string; peerType: string; membersCount?: number; username?: string }[] = [];

    try {
      const result = await clientInfo.client.invoke(
        new Api.contacts.Search({ q, limit: requestLimit })
      ) as { my_results?: any[]; results?: any[]; chats?: any[]; users?: any[] };

      const allPeers = [
        ...(result?.my_results ?? []),
        ...(result?.results ?? []),
      ];
      const chats = result?.chats ?? [];

      for (const peer of allPeers) {
        const cn = String(peer?.className ?? peer?.constructor?.className ?? '').toLowerCase();
        if (cn.includes('peeruser')) continue;
        let cid: string | null = null;
        if (cn.includes('peerchannel')) {
          const id = (peer as any).channelId ?? (peer as any).channel_id;
          if (id != null) cid = String(id);
        } else if (cn.includes('peerchat')) {
          const id = (peer as any).chatId ?? (peer as any).chat_id;
          if (id != null) cid = String(id);
        }
        if (!cid || seen.has(cid)) continue;
        seen.add(cid);
        const chat = chats.find((c: any) => {
          const id = c.id ?? c.channelId ?? c.chat_id ?? c.chatId;
          return id != null && String(id) === cid;
        });
        const title = (chat?.title ?? chat?.name ?? '').trim() || cid;
        const peerType = (chat as any)?.broadcast ? 'channel' : (chat as any)?.megagroup ? 'group' : 'chat';
        const membersCount = chat?.participantsCount ?? chat?.participants_count ?? undefined;
        const username = (chat?.username ?? '').trim() || undefined;
        out.push({ chatId: cid, title, peerType, membersCount, username });
      }

      return out;
    } catch (e: any) {
      if (e?.message?.includes('QUERY_TOO_SHORT') || e?.message?.includes('SEARCH_QUERY_EMPTY') || (e as any)?.code === 'QUERY_TOO_SHORT') {
        const err = new Error('Query too short');
        (err as any).code = 'QUERY_TOO_SHORT';
        throw err;
      }
      this.log.error({ message: 'searchByContacts failed', accountId, query: q, error: e?.message || String(e) });
      throw e;
    }
  }

  /**
   * Get channels and supergroups that the user administers (channels.GetAdminedPublicChannels).
   * Same response shape as search for consistency (chatId, title, peerType, membersCount?, username?).
   */
  async getAdminedPublicChannels(
    accountId: string
  ): Promise<{ chatId: string; title: string; peerType: string; membersCount?: number; username?: string }[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    try {
      const result = await clientInfo.client.invoke(new Api.channels.GetAdminedPublicChannels({})) as { chats?: any[] };
      const chats = result?.chats ?? [];
      return chats.map((c: any) => {
        const id = c.id ?? c.channelId ?? c.chat_id ?? c.chatId;
        const chatId = id != null ? String(id) : '';
        const title = (c.title ?? c.name ?? '').trim() || chatId;
        const peerType = (c as any)?.broadcast ? 'channel' : (c as any)?.megagroup ? 'group' : 'chat';
        const membersCount = c?.participantsCount ?? c?.participants_count ?? undefined;
        const username = (c?.username ?? '').trim() || undefined;
        return { chatId, title, peerType, membersCount, username };
      });
    } catch (e: any) {
      this.log.error({ message: 'getAdminedPublicChannels failed', accountId, error: e?.message || String(e) });
      throw e;
    }
  }

  /**
   * Get basic group participants via messages.GetFullChat (for Api.Chat).
   */
  private async getBasicGroupParticipants(
    client: any,
    chatEntity: any,
    excludeAdmins: boolean
  ): Promise<{ users: Array<{ telegram_id: string; username?: string; first_name?: string; last_name?: string }>; nextOffset: number | null }> {
    const chatId = chatEntity.id ?? chatEntity.chatId;
    const full = await client.invoke(new Api.messages.GetFullChat({ chatId })) as any;
    const fullChat = full?.fullChat ?? full?.full_chat;
    const participants = fullChat?.participants?.participants ?? fullChat?.participants ?? [];
    const users = full?.users ?? [];
    const userMap = new Map<number, any>();
    for (const u of users) {
      const id = (u as any).id ?? (u as any).userId;
      if (id != null) userMap.set(Number(id), u);
    }
    const out: Array<{ telegram_id: string; username?: string; first_name?: string; last_name?: string }> = [];
    for (const p of participants) {
      const uid = (p as any).userId ?? (p as any).user_id;
      if (uid == null) continue;
      if (excludeAdmins) {
        const cn = String((p as any).className ?? (p as any).constructor?.className ?? '').toLowerCase();
        if (cn.includes('chatparticipantadmin') || cn.includes('chatparticipantcreator')) continue;
      }
      const u = userMap.get(Number(uid));
      if ((u as any)?.deleted || (u as any)?.bot) continue;
      out.push({
        telegram_id: String(uid),
        username: (u?.username ?? '').trim() || undefined,
        first_name: (u?.firstName ?? u?.first_name ?? '').trim() || undefined,
        last_name: (u?.lastName ?? u?.last_name ?? '').trim() || undefined,
      });
    }
    return { users: out, nextOffset: null };
  }

  /**
   * Get channel/supergroup participants (channels.GetParticipants). Paginated; returns users and nextOffset.
   * For basic groups (Api.Chat) uses GetFullChat. ExcludeAdmins - if true, omit admins/creator.
   */
  async getChannelParticipants(
    accountId: string,
    channelId: string,
    offset: number,
    limit: number,
    excludeAdmins: boolean = false
  ): Promise<{ users: Array<{ telegram_id: string; username?: string; first_name?: string; last_name?: string }>; nextOffset: number | null }> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const client = clientInfo.client;
    let entity: any;

    try {
      const peerId = Number(channelId);
      const isNumericId = !Number.isNaN(peerId) && !channelId.startsWith('@') && !channelId.includes('://');
      // For channels from SearchGlobal we get raw channelId (e.g. 1619174067). gram.js needs -100xxxxxxxxxx for channel, -id for basic group.
      if (isNumericId && peerId > 0) {
        try {
          entity = await client.getEntity(`-100${channelId}`);
        } catch {
          try {
            entity = await client.getEntity(`-${channelId}`);
          } catch {
            try {
              entity = await client.getEntity(channelId);
            } catch (err2) {
              throw err2;
            }
          }
        }
      } else {
        entity = await client.getEntity(channelId);
      }

      if (!(entity instanceof Api.Chat || entity instanceof Api.Channel)) {
        throw new Error('Not a group or channel');
      }
      if (entity instanceof Api.Chat) {
        return this.getBasicGroupParticipants(client, entity, excludeAdmins);
      }
    } catch (e: any) {
      if (e?.message?.includes('CHAT_ADMIN_REQUIRED') || (e as any)?.code === 'CHAT_ADMIN_REQUIRED') {
        const err = new Error('No permission to get participants');
        (err as any).code = 'CHAT_ADMIN_REQUIRED';
        throw err;
      }
      if (e?.message?.includes('CHANNEL_PRIVATE') || (e as any)?.code === 'CHANNEL_PRIVATE') {
        const err = new Error('Channel is private');
        (err as any).code = 'CHANNEL_PRIVATE';
        throw err;
      }
      throw e;
    }

    try {
      const result = await client.invoke(
        new Api.channels.GetParticipants({
          channel: entity,
          filter: new Api.ChannelParticipantsRecent(),
          offset,
          limit: Math.min(limit, 200),
          hash: BigInt(0),
        })
      ) as { participants?: any[]; users?: any[]; count?: number };
      const participants = result?.participants ?? [];
      const users = result?.users ?? [];
      const userMap = new Map<number, any>();
      for (const u of users) {
        const id = (u as any).id ?? (u as any).userId;
        if (id != null) userMap.set(Number(id), u);
      }
      const out: Array<{ telegram_id: string; username?: string; first_name?: string; last_name?: string }> = [];
      for (const p of participants) {
        if (excludeAdmins) {
          const cn = String((p as any).className ?? (p as any).constructor?.className ?? '').toLowerCase();
          if (cn.includes('channelparticipantadmin') || cn.includes('channelparticipantcreator')) continue;
        }
        const uid = (p as any).userId;
        if (uid == null) continue;
        const u = userMap.get(Number(uid));
        out.push({
          telegram_id: String(uid),
          username: (u?.username ?? '').trim() || undefined,
          first_name: (u?.firstName ?? u?.first_name ?? '').trim() || undefined,
          last_name: (u?.lastName ?? u?.last_name ?? '').trim() || undefined,
        });
      }
      const count = result?.count ?? 0;
      const nextOffset = offset + participants.length < count && participants.length >= Math.min(limit, 200)
        ? offset + participants.length
        : null;
      return { users: out, nextOffset };
    } catch (e: any) {
      if (e?.message?.includes('CHAT_ADMIN_REQUIRED') || (e as any)?.code === 'CHAT_ADMIN_REQUIRED') {
        const err = new Error('No permission to get participants');
        (err as any).code = 'CHAT_ADMIN_REQUIRED';
        throw err;
      }
      if (e?.message?.includes('CHANNEL_PRIVATE') || (e as any)?.code === 'CHANNEL_PRIVATE') {
        const err = new Error('Channel is private');
        (err as any).code = 'CHANNEL_PRIVATE';
        throw err;
      }
      this.log.error({ message: 'getChannelParticipants failed', accountId, channelId, error: e?.message || String(e) });
      throw e;
    }
  }

  /**
   * Get active participants (users who sent messages) from a chat history.
   */
  async getActiveParticipants(
    accountId: string,
    chatId: string,
    depth: number,
    excludeAdmins: boolean = false
  ): Promise<{ users: Array<{ telegram_id: string; username?: string; first_name?: string; last_name?: string }> }> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const client = clientInfo.client;
    let entity: any;

    try {
      const peerId = Number(chatId);
      const isNumericId = !Number.isNaN(peerId) && !chatId.startsWith('@') && !chatId.includes('://');
      if (isNumericId && peerId > 0) {
        try {
          entity = await client.getEntity(`-100${chatId}`);
        } catch {
          try {
            entity = await client.getEntity(`-${chatId}`);
          } catch {
            try {
              entity = await client.getEntity(chatId);
            } catch (err2) {
              throw err2;
            }
          }
        }
      } else {
        entity = await client.getEntity(chatId);
      }
    } catch (e: any) {
      this.log.error({ message: 'Failed to resolve entity for getActiveParticipants', accountId, chatId, error: e?.message || String(e) });
      throw e;
    }

    const uniqueUsers = new Map<string, any>();
    let offsetId = 0;
    const limit = 100;
    let fetched = 0;

    try {
      while (fetched < depth) {
        const fetchLimit = Math.min(limit, depth - fetched);
        const result = await client.invoke(
          new Api.messages.GetHistory({
            peer: entity,
            offsetId,
            offsetDate: 0,
            addOffset: 0,
            limit: fetchLimit,
            maxId: 0,
            minId: 0,
            hash: BigInt(0),
          })
        ) as any;

        const messages = result.messages || [];
        const users = result.users || [];
        
        if (messages.length === 0) break; // no more messages

        // Map users from this batch
        const usersMap = new Map();
        for (const u of users) {
           usersMap.set(String(u.id), u);
        }

        for (const msg of messages) {
          const fromId = msg.fromId;
          if (fromId && fromId.className === 'PeerUser') {
             const uid = String(fromId.userId);
             if (!uniqueUsers.has(uid) && usersMap.has(uid)) {
               uniqueUsers.set(uid, usersMap.get(uid));
             }
          }
        }
        
        fetched += messages.length;
        offsetId = messages[messages.length - 1].id;
      }

      // Filter and map users
      let usersResult = Array.from(uniqueUsers.values())
        .filter((u: any) => !u.deleted && !u.bot)
        .map((u: any) => ({
          telegram_id: String(u.id),
          username: u.username,
          first_name: u.firstName,
          last_name: u.lastName,
        }));

      if (excludeAdmins) {
         try {
           if (entity instanceof Api.Channel) {
             const adminResult = await client.invoke(new Api.channels.GetParticipants({
               channel: entity,
               filter: new Api.ChannelParticipantsAdmins(),
               offset: 0,
               limit: 100,
               hash: BigInt(0),
             })) as { participants?: any[]; users?: any[] };
             const adminIds = new Set(
               (adminResult.participants || [])
               .filter(p => p instanceof Api.ChannelParticipantAdmin || p instanceof Api.ChannelParticipantCreator)
               .map(p => String(p.userId))
             );
             usersResult = usersResult.filter(u => !adminIds.has(u.telegram_id));
           }
         } catch(err) {
           this.log.warn({ message: 'Failed to fetch admins for exclusion in getActiveParticipants', error: String(err) });
         }
      }

      return { users: usersResult };
    } catch (e: any) {
      this.log.error({ message: 'getActiveParticipants failed', accountId, chatId, error: e?.message || String(e) });
      throw e;
    }
  }

  /**
   * Leave a channel/supergroup (channels.LeaveChannel). No-op if already left.
   */
  async leaveChat(accountId: string, chatId: string): Promise<void> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const client = clientInfo.client;
    let inputChannel: Api.TypeInputChannel;
    try {
      const peerId = Number(chatId);
      const fullId = Number.isNaN(peerId) ? chatId : (peerId < 0 ? peerId : -1000000000 - Math.abs(peerId));
      const peer = await client.getInputEntity(fullId);
      if (peer instanceof Api.InputChannel) {
        inputChannel = peer;
      } else if (peer && typeof (peer as any).channelId !== 'undefined') {
        inputChannel = new Api.InputChannel({
          channelId: (peer as any).channelId,
          accessHash: (peer as any).accessHash ?? BigInt(0),
        });
      } else {
        throw new Error('Not a channel or supergroup');
      }
    } catch (e: any) {
      if (e?.message?.includes('CHANNEL_PRIVATE') || (e as any)?.code === 'CHANNEL_PRIVATE') {
        const err = new Error('Channel is private or already left');
        (err as any).code = 'CHANNEL_PRIVATE';
        throw err;
      }
      throw e;
    }
    try {
      await client.invoke(new Api.channels.LeaveChannel({ channel: inputChannel }));
    } catch (e: any) {
      if (e?.message?.includes('USER_NOT_PARTICIPANT') || (e as any).code === 'USER_NOT_PARTICIPANT') {
        return;
      }
      this.log.error({ message: 'leaveChat failed', accountId, chatId, error: e?.message || String(e) });
      throw e;
    }
  }

  /**
   * Resolve one input (link, username, invite) to chatId + title + peerType.
   * For invite links the account will join the chat (ImportChatInvite).
   */
  async resolveChatFromInput(
    accountId: string,
    input: string
  ): Promise<{ chatId: string; title: string; peerType: string }> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const client = clientInfo.client;
    const raw = (input || '').trim();
    if (!raw) {
      const err = new Error('Empty input');
      (err as any).code = 'VALIDATION';
      throw err;
    }
    const lower = raw.toLowerCase();
    const isInvite = lower.includes('/joinchat/') || lower.startsWith('+') || lower.includes('t.me/+');
    if (isInvite) {
      let hash = '';
      const joinchatMatch = raw.match(/joinchat\/([a-zA-Z0-9_-]+)/i) || raw.match(/t\.me\/\+?([a-zA-Z0-9_-]+)/i);
      if (joinchatMatch) hash = joinchatMatch[1];
      else if (raw.startsWith('+')) hash = raw.slice(1).trim();
      if (!hash) {
        const err = new Error('Invalid invite link');
        (err as any).code = 'INVALID_INVITE';
        throw err;
      }
      try {
        const updates = await client.invoke(new Api.messages.ImportChatInvite({ hash })) as any;
        const chats = updates?.chats ?? [];
        const c = Array.isArray(chats) ? chats[0] : chats;
        if (!c) {
          const err = new Error('No chat in invite response');
          (err as any).code = 'INVALID_INVITE';
          throw err;
        }
        const id = c.id ?? c.channelId ?? c.chatId;
        const title = (c.title ?? c.name ?? '').trim() || String(id);
        const peerType = (c as any).broadcast ? 'channel' : (c as any).megagroup ? 'group' : 'chat';
        return { chatId: String(id), title, peerType };
      } catch (e: any) {
        if (e?.message?.includes('INVITE_HASH_EXPIRED') || (e as any).code === 'INVITE_HASH_EXPIRED') {
          const err = new Error('Invite link expired');
          (err as any).code = 'INVITE_EXPIRED';
          throw err;
        }
        if (e?.message?.includes('INVITE_HASH_INVALID') || (e as any).code === 'INVITE_HASH_INVALID') {
          const err = new Error('Invalid invite link');
          (err as any).code = 'INVALID_INVITE';
          throw err;
        }
        throw e;
      }
    }
    let username = raw
      .replace(/^@/, '')
      .replace(/^https?:\/\/t\.me\//i, '')
      .replace(/^t\.me\//i, '')
      .trim();
    if (!username) {
      const err = new Error('Invalid username or link');
      (err as any).code = 'VALIDATION';
      throw err;
    }
    try {
      const resolved = await client.invoke(new Api.contacts.ResolveUsername({ username })) as any;
      const peer = resolved?.peer;
      const chats = resolved?.chats ?? [];
      if (!peer) {
        const err = new Error('Chat not found');
        (err as any).code = 'CHAT_NOT_FOUND';
        throw err;
      }
      let cid: string | null = null;
      const pn = String(peer.className ?? peer.constructor?.className ?? '').toLowerCase();
      if (pn.includes('peerchannel') && (peer as any).channelId != null) {
        cid = String((peer as any).channelId);
      } else if (pn.includes('peerchat') && (peer as any).chatId != null) {
        cid = String((peer as any).chatId);
      }
      if (!cid) {
        const err = new Error('Not a group or channel');
        (err as any).code = 'CHAT_NOT_FOUND';
        throw err;
      }
      const chat = (Array.isArray(chats) ? chats : [chats]).find((ch: any) => {
        const id = ch?.id ?? ch?.channelId ?? ch?.chatId;
        return id != null && String(id) === cid;
      });
      const title = (chat?.title ?? chat?.name ?? '').trim() || cid;
      const peerType = (chat as any)?.broadcast ? 'channel' : (chat as any)?.megagroup ? 'group' : 'chat';
      return { chatId: cid, title, peerType };
    } catch (e: any) {
      if (e?.message?.includes('USERNAME_NOT_OCCUPIED') || (e as any).code === 'USERNAME_NOT_OCCUPIED') {
        const err = new Error('Chat not found');
        (err as any).code = 'CHAT_NOT_FOUND';
        throw err;
      }
      this.log.error({ message: 'resolveChatFromInput failed', accountId, input: raw, error: e?.message || String(e) });
      throw e;
    }
  }

  /**
   * Resolve one input to ResolvedSource (type, linkedChatId, canGetMembers, canGetMessages).
   * Uses GetFullChannel/GetFullChat to get full info for smart parse strategy.
   */
  async resolveSourceFromInput(
    accountId: string,
    input: string
  ): Promise<ResolvedSource> {
    const basic = await this.resolveChatFromInput(accountId, input);
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo?.isConnected) {
      return this.basicToResolvedSource(basic, input);
    }
    const client = clientInfo.client;
    const chatId = basic.chatId;
    const raw = (input || '').trim();

    const peerId = Number(chatId);
    const isNumericId = !Number.isNaN(peerId) && !chatId.startsWith('@') && !chatId.includes('://');
    let entity: any;
    try {
      if (isNumericId && peerId > 0) {
        try {
          entity = await client.getEntity(`-100${chatId}`);
        } catch {
          entity = await client.getEntity(chatId);
        }
      } else {
        entity = await client.getEntity(chatId);
      }
    } catch (e: any) {
      this.log.warn({ message: 'resolveSourceFromInput getEntity failed, using basic', accountId, input: raw, error: e?.message });
      return this.basicToResolvedSource(basic, input);
    }

    let type: TelegramSourceType = 'unknown';
    let membersCount: number | undefined;
    let linkedChatId: number | undefined;
    let canGetMembers = false;
    let canGetMessages = true;
    const username = (entity as any)?.username ? String((entity as any).username) : undefined;

    if (entity instanceof Api.Channel) {
      const ch = entity as any;
      if (ch.broadcast) {
        canGetMembers = false;
        try {
          const inputChannel = await client.getInputEntity(entity) as any;
          const full = await client.invoke(new Api.channels.GetFullChannel({ channel: inputChannel })) as any;
          const fullChat = full?.fullChat ?? full?.full_chat;
          if (fullChat?.linkedChatId) {
            linkedChatId = Number(fullChat.linkedChatId);
            type = 'comment_group';
          } else {
            type = 'channel';
          }
          if (fullChat?.participantsCount != null) membersCount = Number(fullChat.participantsCount);
        } catch (e: any) {
          this.log.warn({ message: 'GetFullChannel failed in resolveSource', accountId, chatId, error: e?.message });
          type = 'channel';
        }
      } else {
        type = ch.username ? 'public_group' : 'private_group';
        canGetMembers = !!ch.username;
        try {
          const inputChannel = await client.getInputEntity(entity) as any;
          const full = await client.invoke(new Api.channels.GetFullChannel({ channel: inputChannel })) as any;
          const fullChat = full?.fullChat ?? full?.full_chat;
          if (fullChat?.participantsCount != null) membersCount = Number(fullChat.participantsCount);
        } catch (e: any) {
          this.log.warn({ message: 'GetFullChannel failed in resolveSource', accountId, chatId, error: e?.message });
        }
      }
    } else if (entity instanceof Api.Chat) {
      type = 'public_group';
      canGetMembers = true;
      try {
        const chatIdNum = (entity as any).id ?? (entity as any).chatId;
        const full = await client.invoke(new Api.messages.GetFullChat({ chatId: chatIdNum })) as any;
        const fullChat = full?.fullChat ?? full?.full_chat;
        if (fullChat?.participantsCount != null) membersCount = Number(fullChat.participantsCount);
      } catch (e: any) {
        this.log.warn({ message: 'GetFullChat failed in resolveSource', accountId, chatId, error: e?.message });
      }
    } else {
      type = basic.peerType === 'channel' ? 'public_group' : 'unknown';
      canGetMembers = type === 'public_group';
    }

    return {
      input: raw,
      type,
      title: basic.title,
      username,
      chatId: basic.chatId,
      membersCount,
      linkedChatId,
      canGetMembers,
      canGetMessages,
    };
  }

  private basicToResolvedSource(
    basic: { chatId: string; title: string; peerType: string },
    input: string
  ): ResolvedSource {
    const type: TelegramSourceType =
      basic.peerType === 'channel' ? 'public_group' : basic.peerType === 'chat' ? 'public_group' : 'unknown';
    return {
      input: (input || '').trim(),
      type,
      title: basic.title,
      chatId: basic.chatId,
      canGetMembers: type === 'public_group',
      canGetMessages: true,
    };
  }

  /**
   * Добавляет в Set все возможные строковые представления peer id для сопоставления с dialog.id из getDialogs.
   * GramJS может использовать entity.id (положительные) или getPeerId (user: +, chat: -id, channel: -1000000000-id).
   */
  private static inputPeerToDialogIds(peer: any, out: Set<string>): void {
    if (!peer) return;
    const c = String(peer.className ?? peer.constructor?.className ?? '').toLowerCase();
    const userId = peer.userId ?? peer.user_id;
    const chatId = peer.chatId ?? peer.chat_id;
    const channelId = peer.channelId ?? peer.channel_id;
    if ((c === 'inputpeeruser') && userId != null) {
      out.add(String(userId));
      return;
    }
    if ((c === 'inputpeerchat') && chatId != null) {
      const n = Number(chatId);
      out.add(String(n));
      out.add(String(-n));
      return;
    }
    if ((c === 'inputpeerchannel') && channelId != null) {
      const n = Number(channelId);
      out.add(String(n));
      out.add(String(-n));
      out.add(String(-1000000000 - n));
      out.add(String(-1000000000000 - n)); // альтернативный префикс (12 нулей)
      return;
    }
  }

  /**
   * Возвращает множество строковых id диалогов (peer id), входящих в кастомный фильтр по include_peers и pinned_peers.
   * Для folder_id 0/1 не используется. Для фильтра без include_peers/pinned_peers (только по критериям) вернёт пустой Set.
   */
  /**
   * Сырой ответ GetDialogFilters с кэшем (TTL 90s). Один запрос к Telegram на несколько вызовов getDialogFilters / getDialogFilterRaw / getDialogFilterPeerIds.
   */
  private async getDialogFiltersRaw(accountId: string): Promise<any[]> {
    const now = Date.now();
    const cached = this.dialogFiltersCache.get(accountId);
    if (cached && now - cached.ts < this.DIALOG_FILTERS_CACHE_TTL_MS) {
      return cached.filters;
    }
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const result = await clientInfo.client.invoke(new Api.messages.GetDialogFilters({}));
    const filters = (result as any).filters ?? [];
    this.dialogFiltersCache.set(accountId, { ts: now, filters });
    return filters;
  }

  async getDialogFilterPeerIds(accountId: string, filterId: number): Promise<Set<string>> {
    const filters = await this.getDialogFiltersRaw(accountId);
    const f = filters.find((x: any) => (x.id ?? -1) === filterId);
    if (!f) return new Set();
    const ids = new Set<string>();
    const pinned = f.pinned_peers ?? f.pinnedPeers ?? [];
    const included = f.include_peers ?? f.includePeers ?? [];
    const peers = [...pinned, ...included];
    for (const p of peers) {
      TelegramManager.inputPeerToDialogIds(p, ids);
    }
    return ids;
  }

  /**
   * Возвращает сырой объект DialogFilter для папки (id >= 2). Нужен для фильтрации по критериям (contacts, groups и т.д.). Использует кэш GetDialogFilters.
   */
  async getDialogFilterRaw(accountId: string, filterId: number): Promise<any | null> {
    const filters = await this.getDialogFiltersRaw(accountId);
    return filters.find((x: any) => (x.id ?? -1) === filterId) ?? null;
  }

  /**
   * Все строковые варианты peer id для диалога (dialog.id из GramJS может быть в разных форматах).
   * Учитывает user (положительный), chat (-id), channel/supergroup (-1000000000 - channel_id).
   * inputPeerToDialogIds в фильтрах отдаёт channel_id числом — добавляем его для совпадения с dialog.id.
   */
  private static dialogIdToVariants(dialogId: string | number): Set<string> {
    const s = String(dialogId).trim();
    const n = Number(s);
    const out = new Set<string>([s]);
    if (!Number.isNaN(n)) {
      out.add(String(n));
      out.add(String(-n));
      if (n > 0 && n < 1000000000) {
        out.add(String(-1000000000 - n));
        out.add(String(-1000000000000 - n));
      }
      // channel/supergroup: dialog.id = -1000000000 - channel_id; include_peers содержит channel_id
      if (n < -1000000000) {
        const channelId = -(n + 1000000000);
        if (Number.isInteger(channelId)) out.add(String(channelId));
        const channelIdAlt = -(n + 1000000000000);
        if (Number.isInteger(channelIdAlt)) out.add(String(channelIdAlt));
      }
    }
    return out;
  }

  /**
   * Проверяет, входит ли диалог в кастомную папку по правилам Telegram (include_peers, pinned_peers, критерии, exclude_peers).
   * См. https://core.telegram.org/constructor/dialogFilter
   */
  static dialogMatchesFilter(
    dialog: { id: string; isUser?: boolean; isGroup?: boolean; isChannel?: boolean },
    filterRaw: any,
    includePeerIds: Set<string>,
    excludePeerIds: Set<string>
  ): boolean {
    if (!filterRaw) return false;
    const variants = TelegramManager.dialogIdToVariants(dialog.id);
    for (const v of variants) {
      if (excludePeerIds.has(v)) return false;
    }
    for (const v of variants) {
      if (includePeerIds.has(v)) return true;
    }
    const contacts = !!(filterRaw.contacts === true);
    const non_contacts = !!(filterRaw.non_contacts === true);
    const groups = !!(filterRaw.groups === true);
    const broadcasts = !!(filterRaw.broadcasts === true);
    const bots = !!(filterRaw.bots === true);
    const isUser = !!dialog.isUser;
    const isGroup = !!dialog.isGroup;
    const isChannel = !!dialog.isChannel;
    if ((contacts || non_contacts || bots) && isUser) return true;
    if (groups && isGroup) return true;
    if (broadcasts && isChannel) return true;
    return false;
  }

  /**
   * Строит множества include и exclude из сырого фильтра (для передачи в dialogMatchesFilter).
   */
  static getFilterIncludeExcludePeerIds(filterRaw: any): { include: Set<string>; exclude: Set<string> } {
    const include = new Set<string>();
    const exclude = new Set<string>();
    if (!filterRaw) return { include, exclude };
    const pinned = filterRaw.pinned_peers ?? filterRaw.pinnedPeers ?? [];
    const included = filterRaw.include_peers ?? filterRaw.includePeers ?? [];
    const excluded = filterRaw.exclude_peers ?? filterRaw.excludePeers ?? [];
    for (const p of [...pinned, ...included]) {
      TelegramManager.inputPeerToDialogIds(p, include);
    }
    for (const p of excluded) {
      TelegramManager.inputPeerToDialogIds(p, exclude);
    }
    return { include, exclude };
  }

  /**
   * Get dialog filters (folders) from Telegram — кастомные папки пользователя. Использует кэш GetDialogFilters (TTL 90s).
   * Папку «Все чаты» (id 0) для списка диалогов вызывающая сторона добавляет сама через getDialogsByFolder(accountId, 0).
   * emoticon — иконка папки из Telegram (эмодзи, например 📁).
   */
  async getDialogFilters(accountId: string): Promise<{ id: number; title: string; isCustom: boolean; emoticon?: string }[]> {
    try {
      const filters = await this.getDialogFiltersRaw(accountId);
      const list: { id: number; title: string; isCustom: boolean; emoticon?: string }[] = [];
      for (let i = 0; i < filters.length; i++) {
        const f = filters[i];
        const id = f.id ?? i;
        const rawTitle = typeof f.title === 'string' ? f.title : (f.title?.text ?? '');
        const title = (typeof rawTitle === 'string' ? rawTitle : String(rawTitle)).trim() || (id === 0 ? 'Все чаты' : id === 1 ? 'Архив' : `Папка ${id}`);
        const emoticon = typeof f.emoticon === 'string' && f.emoticon.trim() ? f.emoticon.trim() : undefined;
        list.push({ id, title, isCustom: id >= 2, emoticon });
      }
      return list;
    } catch (error: any) {
      this.log.error({ message: `Error getting dialog filters for ${accountId}`, error: error?.message || String(error) });
      throw error;
    }
  }

  /**
   * Обратная синхронизация: отправить папки из CRM в Telegram (обновить фильтры по названию и списку чатов).
   * Папки 0 и 1 не трогаем (системные в Telegram). Берём только folder_id >= 2 из bd_account_sync_folders.
   * Для каждой папки — чаты из sync_chats с этим folder_id; UpdateDialogFilter создаёт фильтр в TG, если его ещё нет (id 2, 3, …).
   */
  async pushFoldersToTelegram(accountId: string): Promise<{ updated: number; errors: string[] }> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const client = clientInfo.client;
    const errors: string[] = [];
    let updated = 0;

    const foldersRows = await this.pool.query(
      'SELECT id, folder_id, folder_title, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 AND folder_id >= 2 ORDER BY order_index',
      [accountId]
    );
    if (foldersRows.rows.length === 0) {
      return { updated: 0, errors: [] };
    }

    for (const row of foldersRows.rows) {
      const folderId = Number(row.folder_id);
      const title = String(row.folder_title || '').trim() || `Folder ${folderId}`;
      const emoticon = row.icon && String(row.icon).trim() ? String(row.icon).trim().slice(0, 4) : undefined;

      const chatsRows = await this.pool.query(
        'SELECT telegram_chat_id FROM bd_account_sync_chat_folders WHERE bd_account_id = $1 AND folder_id = $2',
        [accountId, folderId]
      );
      const includePeers: any[] = [];
      for (const c of chatsRows.rows) {
        const tid = String(c.telegram_chat_id || '').trim();
        if (!tid) continue;
        try {
          const peerIdNum = Number(tid);
          const peerInput = Number.isNaN(peerIdNum) ? tid : peerIdNum;
          const peer = await client.getInputEntity(peerInput);
          includePeers.push(new Api.InputDialogPeer({ peer }));
        } catch (e: any) {
          errors.push(`Chat ${tid}: ${e?.message || 'Failed to resolve'}`);
        }
      }

      try {
        const filter = new Api.DialogFilter({
          id: folderId,
          title,
          emoticon: emoticon || '',
          pinnedPeers: [],
          includePeers: includePeers,
          excludePeers: [],
          contacts: false,
          nonContacts: false,
          groups: false,
          broadcasts: false,
          bots: false,
        });
        await client.invoke(new Api.messages.UpdateDialogFilter({ id: folderId, filter }));
        updated += 1;
      } catch (e: any) {
        // GramJS may use snake_case in TL types
        if (e?.message?.includes('includePeers') || e?.message?.includes('include_peers')) {
          try {
            const filterAlt = new (Api as any).DialogFilter({
              id: folderId,
              title,
              emoticon: emoticon || '',
              pinned_peers: [],
              include_peers: includePeers,
              exclude_peers: [],
              contacts: false,
              non_contacts: false,
              groups: false,
              broadcasts: false,
              bots: false,
            });
            await client.invoke(new Api.messages.UpdateDialogFilter({ id: folderId, filter: filterAlt }));
            updated += 1;
          } catch (e2: any) {
            errors.push(`Folder "${title}" (id=${folderId}): ${e2?.message || String(e2)}`);
          }
        } else {
          const msg = e?.message || String(e);
          errors.push(`Folder "${title}" (id=${folderId}): ${msg}`);
        }
      }
    }
    return { updated, errors };
  }

  /**
   * Get dialogs for a specific folder (for populating sync_chats from selected folders).
   * Папки 0 и 1: через getDialogsAll (полный список). Кастомные (id >= 2): все диалоги 0+1 и фильтр по DialogFilter (include_peers + критерии).
   */
  async getDialogsByFolder(accountId: string, folderId: number): Promise<any[]> {
    if (folderId === 0) {
      return this.getDialogsAll(accountId, 0, { maxDialogs: 3000, delayEveryN: 100, delayMs: 600 });
    }
    if (folderId === 1) {
      return this.getDialogsAll(accountId, 1, { maxDialogs: 2000, delayEveryN: 100, delayMs: 600 }).catch(() => []);
    }
    const [all0, all1] = await Promise.all([
      this.getDialogsAll(accountId, 0, { maxDialogs: 3000, delayEveryN: 100, delayMs: 600 }),
      this.getDialogsAll(accountId, 1, { maxDialogs: 2000, delayEveryN: 100, delayMs: 600 }).catch(() => []),
    ]);
    const mergedById = new Map<string, any>();
    for (const d of [...all0, ...all1]) {
      if (!mergedById.has(String(d.id))) mergedById.set(String(d.id), d);
    }
    const merged = Array.from(mergedById.values());
    const filterRaw = await this.getDialogFilterRaw(accountId, folderId);
    const { include: includePeerIds, exclude: excludePeerIds } = TelegramManager.getFilterIncludeExcludePeerIds(filterRaw);
    return merged.filter((d: any) =>
      TelegramManager.dialogMatchesFilter(d, filterRaw, includePeerIds, excludePeerIds)
    );
  }

  /**
   * Если чат не в sync_chats, но есть выбранные папки — добавить чат в БД по getEntity (без GetDialogs, без flood wait).
   * Чат добавляется в папку 0 «Все чаты»; пользователь может перенести в другую папку из UI.
   */
  async tryAddChatFromSelectedFolders(accountId: string, chatId: string): Promise<boolean> {
    const foldersRows = await this.pool.query(
      'SELECT folder_id FROM bd_account_sync_folders WHERE bd_account_id = $1 LIMIT 1',
      [accountId]
    );
    if (foldersRows.rows.length === 0) return false;

    const clientInfo = this.clients.get(accountId);
    if (!clientInfo?.isConnected) return false;

    const accRow = await this.pool.query(
      'SELECT organization_id, display_name, username, first_name FROM bd_accounts WHERE id = $1 LIMIT 1',
      [accountId]
    );
    const row = accRow.rows[0] as { organization_id?: string; display_name?: string | null; username?: string | null; first_name?: string | null } | undefined;
    const organizationId = row?.organization_id;
    const account = row;

    let title = chatId;
    let peerType = 'user';
    const isAccountName = (t: string) => {
      const s = (t || '').trim();
      if (!s) return false;
      const d = (account?.display_name || '').trim();
      const u = (account?.username || '').trim();
      const f = (account?.first_name || '').trim();
      return (d && d === s) || (u && u === s) || (f && f === s);
    };
    try {
      const peerIdNum = Number(chatId);
      const peerInput = Number.isNaN(peerIdNum) ? chatId : peerIdNum;
      const peer = await clientInfo.client.getInputEntity(peerInput);
      const entity = await clientInfo.client.getEntity(peer);
      if (entity) {
        const c = (entity as any).className;
        if (c === 'User') {
          const u = entity as any;
          title = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || title;
          if (account && isAccountName(title)) title = chatId;
          peerType = 'user';
          if (organizationId) {
            await this.upsertContactFromTelegramUser(organizationId, chatId, {
              firstName: (u.firstName ?? '').trim(),
              lastName: (u.lastName ?? '').trim() || null,
              username: (u.username ?? '').trim() || null,
            });
          }
        } else if (c === 'Chat') {
          title = (entity as any).title?.trim() || title;
          if (account && isAccountName(title)) title = chatId;
          peerType = 'chat';
        } else if (c === 'Channel') {
          title = (entity as any).title?.trim() || title;
          if (account && isAccountName(title)) title = chatId;
          peerType = 'channel';
        }
      }
    } catch (err: any) {
      if (err?.message !== 'TIMEOUT' && !err?.message?.includes('builder.resolve')) {
        this.log.warn({ message: `tryAddChatFromSelectedFolders getEntity ${chatId}`, error: err?.message });
      }
      return false;
    }

    const folderId = 0;
    await this.pool.query(
      `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id)
       VALUES ($1, $2, $3, $4, false, $5)
       ON CONFLICT (bd_account_id, telegram_chat_id) DO UPDATE SET
         title = CASE WHEN EXISTS (
           SELECT 1 FROM bd_accounts a WHERE a.id = EXCLUDED.bd_account_id
             AND (NULLIF(TRIM(COALESCE(a.display_name, '')), '') = TRIM(EXCLUDED.title)
               OR a.username = TRIM(EXCLUDED.title)
               OR NULLIF(TRIM(COALESCE(a.first_name, '')), '') = TRIM(EXCLUDED.title))
         ) THEN bd_account_sync_chats.telegram_chat_id::text ELSE EXCLUDED.title END,
         peer_type = EXCLUDED.peer_type,
         folder_id = COALESCE(bd_account_sync_chats.folder_id, EXCLUDED.folder_id)`,
      [accountId, chatId, title, peerType, folderId]
    );
    await this.pool.query(
      `INSERT INTO bd_account_sync_chat_folders (bd_account_id, telegram_chat_id, folder_id)
       VALUES ($1, $2, $3) ON CONFLICT (bd_account_id, telegram_chat_id, folder_id) DO NOTHING`,
      [accountId, chatId, folderId]
    );
    this.log.info({ message: `Auto-added chat ${chatId} (${title}) for account ${accountId} via getEntity` });
    return true;
  }

  /**
   * Shared chat creation: use ChatSync.createSharedChat via `telegram/index` TelegramManager (not this legacy file).
   */

  /**
   * Синхронизировать историю переписки для одного чата (после авто-добавления контакта из папки).
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
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
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
          const result = await client.invoke(
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

            const contactId = await this.ensureContactEnrichedFromTelegram(organizationId, accountId, senderId || cid);
            const direction = (msg as any).out === true ? MessageDirection.OUTBOUND : MessageDirection.INBOUND;
            const serialized = serializeMessage(msg);
            await this.saveMessageToDb({
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
   * Догрузить одну страницу более старых сообщений из Telegram для чата (при скролле вверх).
   * Возвращает { added, exhausted }. Если exhausted — в Telegram больше нет сообщений для этого чата.
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
    let peer: any;
    const accessHashRaw = syncRow.access_hash;
    if (accessHashRaw != null && accessHashRaw !== '') {
      const storedFull = Number(storedChatId);
      const rawChannelId = Number.isNaN(storedFull) ? 0 : -1000000000 - storedFull;
      peer = new Api.InputPeerChannel({ channelId: rawChannelId, accessHash: BigInt(accessHashRaw) });
    } else {
      const peerInput = Number.isNaN(fullIdNum) ? chatId : fullIdNum;
      peer = await client.getInputEntity(peerInput);
    }

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

    const doGetHistory = async (p: any) =>
      client.invoke(
        new Api.messages.GetHistory({
          peer: p,
          limit,
          offsetId,
          offsetDate,
          maxId: 0,
          minId: 0,
          addOffset: 0,
          hash: BigInt(0),
        })
      );

    let result: any;
    try {
      result = await doGetHistory(peer);
    } catch (firstErr: any) {
      const msg = firstErr?.message ?? '';
      if (msg.includes('PEER_ID_INVALID')) {
        try {
          await client.getDialogs({ limit: 100 });
          if (accessHashRaw != null && accessHashRaw !== '') {
            const storedFull = Number(storedChatId);
            const rawChannelId = Number.isNaN(storedFull) ? 0 : -1000000000 - storedFull;
            peer = new Api.InputPeerChannel({ channelId: rawChannelId, accessHash: BigInt(accessHashRaw) });
          } else {
            peer = await client.getInputEntity(Number.isNaN(fullIdNum) ? chatId : fullIdNum);
          }
          result = await doGetHistory(peer);
        } catch (retryErr: any) {
          this.log.warn({ message: `fetchOlderMessagesFromTelegram failed for ${accountId}/${chatId}`, error: retryErr?.message });
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
        // Используем chatId из запроса, чтобы channel_id в БД совпадал с тем, что шлёт фронт (иначе запрос сообщений возвращает 0)
        const contactId = await this.ensureContactEnrichedFromTelegram(organizationId, accountId, senderId || chatId);
        const direction = (msg as any).out === true ? MessageDirection.OUTBOUND : MessageDirection.INBOUND;
        const serialized = serializeMessage(msg);
        await this.saveMessageToDb({
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
      this.log.warn({ message: `fetchOlderMessagesFromTelegram failed for ${accountId}/${chatId}`, error: err?.message });
      throw err;
    }
  }

  /**
   * Download media from a Telegram message (photo, video, voice, document).
   * Used to proxy media to the frontend without storing files — fetch from Telegram on demand.
   */
  async downloadMessageMedia(
    accountId: string,
    channelId: string,
    messageId: string
  ): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }

    const client = clientInfo.client;
    const peerIdNum = Number(channelId);
    const peerInput = Number.isNaN(peerIdNum) ? channelId : peerIdNum;
    const peer = await client.getInputEntity(peerInput);
    const msgId = parseInt(messageId, 10);
    if (Number.isNaN(msgId)) return null;

    const messages = await client.getMessages(peer, { ids: [msgId] });
    const message = messages?.[0];
    if (!message || !(message as any).media) return null;

    const buffer = await client.downloadMedia(message as any, {});
    if (!buffer || !(buffer instanceof Buffer)) return null;

    const media = (message as any).media;
    let mimeType = 'application/octet-stream';
    if (media instanceof Api.MessageMediaPhoto || media?.className === 'MessageMediaPhoto') {
      mimeType = 'image/jpeg';
    } else if (media?.document) {
      mimeType = media.document.mimeType || 'application/octet-stream';
    }

    return { buffer, mimeType };
  }

  /**
   * Send message via Telegram (optional reply to message by Telegram message id).
   */
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

    try {
      const message = await clientInfo.client.sendMessage(chatId, {
        message: text,
        ...(opts.replyTo != null ? { replyTo: opts.replyTo } : {}),
      });
      
      // Update last activity
      clientInfo.lastActivity = new Date();
      await this.pool.query(
        'UPDATE bd_accounts SET last_activity = NOW() WHERE id = $1',
        [accountId]
      );

      return message;
    } catch (error) {
      this.log.error({ message: `Error sending message`, error: error?.message || String(error) });
      throw error;
    }
  }

  /**
   * Send typing indicator (messages.SetTyping) to simulate human behavior.
   */
  async setTyping(accountId: string, chatId: string): Promise<void> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    try {
      const peer = await clientInfo.client.getInputEntity(chatId);
      await clientInfo.client.invoke(
        new Api.messages.SetTyping({ peer, action: new Api.SendMessageTypingAction() })
      );
    } catch (error: any) {
      this.log.warn({ message: 'setTyping failed', accountId, chatId, error: error?.message || String(error) });
    }
  }

  /**
   * Mark messages as read in a chat (messages.ReadHistory / channels.ReadHistory).
   */
  async markAsRead(accountId: string, chatId: string): Promise<void> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    try {
      const entity = await clientInfo.client.getInputEntity(chatId);
      if ((entity as any).className === 'InputPeerChannel') {
        await clientInfo.client.invoke(
          new Api.channels.ReadHistory({ channel: entity as any, maxId: 0 })
        );
      } else {
        await clientInfo.client.invoke(
          new Api.messages.ReadHistory({ peer: entity, maxId: 0 })
        );
      }
    } catch (error: any) {
      this.log.warn({ message: 'markAsRead failed', accountId, chatId, error: error?.message || String(error) });
    }
  }

  /**
   * Save draft in Telegram (messages.SaveDraft). Empty text clears the draft.
   */
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
    const peer = await client.getInputEntity(chatId);
    const replyTo = opts.replyToMsgId != null ? { replyToMsgId: opts.replyToMsgId } : undefined;
    await client.invoke(
      new ApiAny.messages.SaveDraft({
        peer,
        message: text || '',
        ...(replyTo ? { replyTo } : {}),
      })
    );
    clientInfo.lastActivity = new Date();
  }

  /**
   * Send file (photo, document, etc.) via Telegram. Uses GramJS sendFile.
   * @param fileBuffer - file contents (Buffer)
   * @param opts.caption - optional caption
   * @param opts.filename - optional filename (for documents)
   */
  async sendFile(
    accountId: string,
    chatId: string,
    fileBuffer: Buffer,
    opts: { caption?: string; filename?: string; replyTo?: number } = {}
  ): Promise<Api.Message> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    try {
      const file = Object.assign(Buffer.from(fileBuffer), {
        name: opts.filename || 'file',
      });
      const client = clientInfo.client as any;
      const message = await client.sendFile(chatId, {
        file,
        caption: opts.caption || '',
        ...(opts.replyTo != null ? { replyTo: opts.replyTo } : {}),
      });
      clientInfo.lastActivity = new Date();
      await this.pool.query(
        'UPDATE bd_accounts SET last_activity = NOW() WHERE id = $1',
        [accountId]
      );
      return message;
    } catch (error) {
      this.log.error({ message: `Error sending file`, error: error?.message || String(error) });
      throw error;
    }
  }

  /**
   * Forward a message from one chat to another (Telegram ForwardMessages).
   */
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
    const fromPeer = await client.getInputEntity(fromChatId);
    const toPeer = await client.getInputEntity(toChatId);
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

  /**
   * Эмодзи, которые Telegram принимает как ReactionEmoji (стандартный набор).
   * Храним в NFC, чтобы сравнивать после normalise — иначе возможен REACTION_INVALID.
   */
  private static readonly REACTION_EMOJI_ALLOWED_NFC = new Set(
    ['👍', '👎', '❤️', '🔥', '👏', '😄', '😮', '😢', '🙏'].map((e) => e.normalize('NFC'))
  );

  /**
   * Нормализует строку эмодзи в NFC и проверяет, что она в разрешённом списке.
   * Возвращает нормализованную строку для отправки или null, если не разрешена.
   */
  private static normalizeReactionEmoji(emoji: string): string | null {
    if (typeof emoji !== 'string' || !emoji.trim()) return null;
    const normalized = emoji.trim().normalize('NFC');
    return TelegramManager.REACTION_EMOJI_ALLOWED_NFC.has(normalized) ? normalized : null;
  }

  /**
   * Установить реакции на сообщение в Telegram (messages.SendReaction).
   * Передаётся полный список реакций пользователя (до 3), не одна — Telegram так требует.
   * Эмодзи нормализуются (NFC) и фильтруются по разрешённому списку, чтобы избежать REACTION_INVALID.
   */
  async sendReaction(
    accountId: string,
    chatId: string,
    telegramMessageId: number,
    reactionEmojis: string[]
  ): Promise<void> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const client = clientInfo.client;
    const peer = await client.getInputEntity(chatId);
    const reaction = (reactionEmojis || [])
      .map((e) => TelegramManager.normalizeReactionEmoji(e))
      .filter((e): e is string => e != null)
      .filter((e, i, a) => a.indexOf(e) === i)
      .slice(0, 3)
      .map((emoticon) => new Api.ReactionEmoji({ emoticon }));
    await client.invoke(
      new Api.messages.SendReaction({
        peer,
        msgId: telegramMessageId,
        reaction,
      })
    );
    clientInfo.lastActivity = new Date();
    await this.pool.query(
      'UPDATE bd_accounts SET last_activity = NOW() WHERE id = $1',
      [accountId]
    );
  }

  /**
   * Disconnect an account
   */
  async disconnectAccount(accountId: string): Promise<void> {
    this.stopUpdateKeepalive(accountId);
    this.stopLockHeartbeat(accountId);
    const clientInfo = this.clients.get(accountId);
    if (clientInfo) {
      try {
        await clientInfo.client.disconnect();
      } catch (error) {
        this.log.error({ message: `Error disconnecting account ${accountId}`, error: error?.message || String(error) });
      }
      this.clients.delete(accountId);
      this.dialogFiltersCache.delete(accountId);

      const interval = this.reconnectIntervals.get(accountId);
      if (interval) {
        clearInterval(interval);
        this.reconnectIntervals.delete(accountId);
      }
    }
    try {
      await this.releaseLock(accountId);
    } catch (error: unknown) {
      this.log.warn({ message: `Failed to release lock for account ${accountId} (proceeding)`, error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(accountId: string): void {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo) return;

    if (clientInfo.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      this.log.error({ message: `Max reconnect attempts reached for ${accountId}` });
      this.updateAccountStatus(accountId, 'error', 'Max reconnect attempts reached');
      return;
    }

    // Clear existing interval
    const existing = this.reconnectIntervals.get(accountId);
    if (existing) {
      clearInterval(existing);
    }

    // Schedule reconnect
    const interval = setTimeout(async () => {
      try {
        clientInfo.reconnectAttempts++;
        this.log.info({ message: `Attempting to reconnect account ${accountId} (attempt ${clientInfo.reconnectAttempts})` });
        
        // Get account details from DB
        const result = await this.pool.query(
          'SELECT api_id, api_hash, session_string, phone_number, session_encrypted FROM bd_accounts WHERE id = $1',
          [accountId]
        );

        if (result.rows.length === 0) {
          throw new Error('Account not found');
        }

        const account = result.rows[0];
        const decryptedApiHash = decryptIfNeeded(account.api_hash, account.session_encrypted) || account.api_hash;
        const decryptedSession = decryptIfNeeded(account.session_string, account.session_encrypted) || account.session_string;
        await this.connectAccount(
          accountId,
          account.organization_id || clientInfo.organizationId,
          clientInfo.userId,
          account.phone_number || clientInfo.phoneNumber,
          parseInt(account.api_id),
          decryptedApiHash,
          decryptedSession
        );

        // Reset reconnect attempts on success
        clientInfo.reconnectAttempts = 0;
        this.reconnectIntervals.delete(accountId);
      } catch (error) {
        this.log.error({ message: `Reconnection failed for ${accountId}`, error: error?.message || String(error) });
        // Schedule next attempt
        this.scheduleReconnect(accountId);
      }
    }, this.RECONNECT_DELAY);

    this.reconnectIntervals.set(accountId, interval);
  }

  /**
   * Update account status in database
   */
  private async updateAccountStatus(
    accountId: string,
    status: string,
    message?: string
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO bd_account_status (account_id, status, message)
         VALUES ($1, $2, $3)`,
        [accountId, status, message || '']
      );
    } catch (error) {
      this.log.error({ message: `Error updating account status`, error: error?.message || String(error) });
    }
  }

  /**
   * Get client info
   */
  getClientInfo(accountId: string): TelegramClientInfo | undefined {
    return this.clients.get(accountId);
  }

  /**
   * Check if account is connected
   */
  isConnected(accountId: string): boolean {
    const clientInfo = this.clients.get(accountId);
    return clientInfo?.isConnected || false;
  }

  /**
   * Schedule reconnect of only the account that hit TIMEOUT (debounced).
   * Prevents one account's update-loop TIMEOUT from disconnecting others (e.g. during long GetDialogs).
   */
  scheduleReconnectOneAfterTimeout(accountId: string): void {
    const existing = this.reconnectOneAfterTimeoutTimeouts.get(accountId);
    if (existing != null) {
      clearTimeout(existing);
    }
    const timeout = setTimeout(() => {
      this.reconnectOneAfterTimeoutTimeouts.delete(accountId);
      this.reconnectOneClientAfterTimeout(accountId).catch((err) => {
        this.log.error({ message: 'reconnectOneClientAfterTimeout failed', accountId, error: String(err) });
      });
    }, this.RECONNECT_ONE_DEBOUNCE_MS);
    this.reconnectOneAfterTimeoutTimeouts.set(accountId, timeout);
    this.log.info({ message: 'TIMEOUT from update loop — scheduled reconnect of account in N s', accountId, debounceSec: this.RECONNECT_ONE_DEBOUNCE_MS / 1000 });
  }

  private async reconnectOneClientAfterTimeout(accountId: string): Promise<void> {
    const info = this.clients.get(accountId);
    if (!info) return;
    try {
      const row = await this.pool.query(
        `SELECT id, organization_id, phone_number, api_id, api_hash, session_string, session_encrypted FROM bd_accounts WHERE id = $1 AND is_active = true`,
        [accountId]
      ).then((r: any) => r.rows[0]);
      if (!row) return;
      await this.disconnectAccount(accountId);
      const apiHash = decryptIfNeeded(row.api_hash, row.session_encrypted) || row.api_hash;
      const sessionStr = decryptIfNeeded(row.session_string, row.session_encrypted) || row.session_string;
      await this.connectAccount(
        row.id,
        row.organization_id,
        row.organization_id,
        row.phone_number,
        parseInt(row.api_id),
        apiHash,
        sessionStr
      );
      this.log.info({ message: 'Reconnected account after TIMEOUT', accountId });
    } catch (err) {
      this.log.error({ message: 'Failed to reconnect account after TIMEOUT', accountId, error: String(err) });
    }
  }

  /**
   * Schedule reconnect of all clients after TIMEOUT from update loop (debounced).
   * Call from process unhandledRejection when reason.message === 'TIMEOUT'.
   */
  scheduleReconnectAllAfterTimeout(): void {
    if (this.reconnectAllTimeout != null) return;
    this.reconnectAllTimeout = setTimeout(() => {
      this.reconnectAllTimeout = null;
      this.reconnectAllClientsAfterTimeout().catch((err) => {
        this.log.error({ message: "reconnectAllClientsAfterTimeout failed", error: String(err) });
      });
    }, this.RECONNECT_ALL_DEBOUNCE_MS);
    this.log.info('[TelegramManager] TIMEOUT from update loop — scheduled reconnect of all clients in', this.RECONNECT_ALL_DEBOUNCE_MS / 1000, 's');
  }

  /**
   * Reconnect all active Telegram clients to restart update loops after TIMEOUT.
   */
  private async reconnectAllClientsAfterTimeout(): Promise<void> {
    const accountIds = Array.from(this.clients.keys());
    if (accountIds.length === 0) return;
    this.log.info('[TelegramManager] Reconnecting', accountIds.length, 'client(s) to restart update loops');
    for (const accountId of accountIds) {
      const info = this.clients.get(accountId);
      if (!info) continue;
      try {
        const row = await this.pool.query(
          'SELECT organization_id, phone_number, api_id, api_hash, session_string, session_encrypted FROM bd_accounts WHERE id = $1',
          [accountId]
        );
        if (row.rows.length === 0 || !row.rows[0].session_string) continue;
        const acc = row.rows[0];
        const decApiHash = decryptIfNeeded(acc.api_hash, acc.session_encrypted) || acc.api_hash;
        const decSession = decryptIfNeeded(acc.session_string, acc.session_encrypted) || acc.session_string;
        await this.disconnectAccount(accountId);
        await this.connectAccount(
          accountId,
          acc.organization_id || info.organizationId,
          info.userId,
          acc.phone_number || info.phoneNumber,
          parseInt(acc.api_id, 10),
          decApiHash,
          decSession
        );
      } catch (err: any) {
        this.log.error('[TelegramManager] Reconnect failed for account', accountId, err?.message || err);
      }
    }
  }

  /**
   * Initialize all active accounts on startup
   */
  async initializeActiveAccounts(): Promise<void> {
    try {
      const result = await this.pool.query(
        `SELECT id, organization_id, phone_number, api_id, api_hash, session_string, session_encrypted
         FROM bd_accounts
         WHERE is_active = true AND (is_demo IS NOT TRUE) AND session_string IS NOT NULL AND session_string != ''`
      );

      for (const account of result.rows) {
        try {
          // Use organization_id as userId fallback (will be replaced when user connects)
          const userId = account.organization_id;
          const apiHash = decryptIfNeeded(account.api_hash, account.session_encrypted) || account.api_hash;
          const sessionStr = decryptIfNeeded(account.session_string, account.session_encrypted) || account.session_string;

          await this.connectAccount(
            account.id,
            account.organization_id,
            userId,
            account.phone_number,
            parseInt(account.api_id),
            apiHash,
            sessionStr
          );
        } catch (error) {
          this.log.error({ message: `Failed to initialize account ${account.id}`, error: error?.message || String(error) });
        }
      }
    } catch (error) {
      this.log.error({ message: "Error initializing active accounts", error: String(error) });
    }
  }

  /**
   * Start periodic cleanup of inactive clients
   */
  private startCleanupInterval(): void {
    this.cleanupInterval = setInterval(async () => {
      try {
        await this.cleanupInactiveClients();
      } catch (error) {
        this.log.error({ message: "Error during cleanup", error: String(error) });
      }
    }, this.CLEANUP_INTERVAL);
  }

  /**
   * Clean up clients for accounts that no longer exist or are inactive
   */
  private async cleanupInactiveClients(): Promise<void> {
    const accountIds = Array.from(this.clients.keys());
    
    if (accountIds.length === 0) {
      return;
    }

    try {
      const result = await this.pool.query(
        `SELECT id FROM bd_accounts 
         WHERE id = ANY($1::uuid[]) AND is_active = true`,
        [accountIds]
      );

      const activeAccountIds = new Set(result.rows.map((row: any) => row.id));

      // Disconnect clients for accounts that are no longer active
      for (const accountId of accountIds) {
        if (!activeAccountIds.has(accountId)) {
          this.log.info({ message: `Cleaning up inactive client for account ${accountId}` });
          await this.disconnectAccount(accountId);
        }
      }
    } catch (error) {
      this.log.error({ message: "Error checking active accounts", error: String(error) });
    }
  }

  /**
   * Save session to database
   */
  private async saveSession(accountId: string, client: TelegramClient): Promise<void> {
    try {
      const sessionString = client.session.save() as string;
      await this.pool.query(
        'UPDATE bd_accounts SET session_string = $1, session_encrypted = true, last_activity = NOW() WHERE id = $2',
        [encryptSession(sessionString), accountId]
      );
    } catch (error) {
      this.log.error({ message: `Error saving session for account ${accountId}`, error: error?.message || String(error) });
    }
  }

  /**
   * Fetch full profile from Telegram (getMe + GetFullUser + profile photo) and save to bd_accounts.
   * Does not overwrite display_name (custom name).
   */
  async saveAccountProfile(accountId: string, client: TelegramClient): Promise<void> {
    try {
      const me = (await client.getMe()) as Api.User;
      const telegramId = String(me?.id ?? '');
      const firstName = (me?.firstName ?? '').trim() || null;
      const lastName = (me?.lastName ?? '').trim() || null;
      const username = (me?.username ?? '').trim() || null;
      const phoneNumber = (me?.phone ?? '').trim() || null;

      let bio: string | null = null;
      let photoFileId: string | null = null;

      try {
        const inputMe = await client.getInputEntity('me');
        const fullUserResult = await client.invoke(
          new Api.users.GetFullUser({ id: inputMe })
        ) as Api.users.UserFull;
        if (fullUserResult?.fullUser?.about) {
          bio = String(fullUserResult.fullUser.about).trim() || null;
        }
        const profilePhoto = fullUserResult?.fullUser?.profile_photo;
        if (profilePhoto && typeof (profilePhoto as any).id === 'number') {
          photoFileId = String((profilePhoto as any).id);
        }
      } catch (e: any) {
        this.log.warn({ message: `GetFullUser for ${accountId} failed (non-fatal)`, error: e?.message });
      }

      if (!photoFileId) {
        try {
          const inputMe = await client.getInputEntity('me');
          const photos = await client.invoke(
            new Api.photos.GetUserPhotos({
              userId: inputMe,
              offset: 0,
              maxId: BigInt(0),
              limit: 1,
            })
          ) as Api.photos.Photos;
          const photo = (photos as any).photos?.[0];
          if (photo && typeof (photo as any).id === 'number') {
            photoFileId = String((photo as any).id);
          }
        } catch (e: any) {
          this.log.warn({ message: `GetUserPhotos for ${accountId} failed (non-fatal)`, error: e?.message });
        }
      }

      await this.pool.query(
        `UPDATE bd_accounts SET
          telegram_id = $1, phone_number = COALESCE($2, phone_number),
          first_name = $3, last_name = $4, username = $5, bio = $6, photo_file_id = $7,
          last_activity = NOW()
         WHERE id = $8`,
        [telegramId, phoneNumber, firstName, lastName, username, bio, photoFileId, accountId]
      );
      this.log.info({ message: `Profile saved for account ${accountId}` });
    } catch (error: any) {
      this.log.error({ message: `Error saving profile for account ${accountId}`, error: error?.message || String(error) });
    }
  }

  /**
   * Download current profile photo for an account (for avatar display).
   */
  async downloadAccountProfilePhoto(accountId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      return null;
    }
    try {
      const buffer = await clientInfo.client.downloadProfilePhoto('me', { isBig: false });
      if (!buffer || !(buffer instanceof Buffer)) return null;
      return { buffer, mimeType: 'image/jpeg' };
    } catch (e: any) {
      this.log.warn({ message: `downloadProfilePhoto for ${accountId}`, error: e?.message });
      return null;
    }
  }

  /**
   * Download profile/chat photo for a peer (user or group) — for avatars in chat list.
   */
  async downloadChatProfilePhoto(accountId: string, chatId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      return null;
    }
    try {
      const peerIdNum = Number(chatId);
      const peerInput = Number.isNaN(peerIdNum) ? chatId : peerIdNum;
      const peer = await clientInfo.client.getInputEntity(peerInput);
      const buffer = await clientInfo.client.downloadProfilePhoto(peer as any, { isBig: false });
      if (!buffer || !(buffer instanceof Buffer)) return null;
      return { buffer, mimeType: 'image/jpeg' };
    } catch (e: any) {
      const msg = e?.message ?? '';
      const isEntityMissing =
        typeof msg === 'string' &&
        (msg.includes('Could not find the input entity') || msg.includes('PeerUser'));
      if (isEntityMissing) {
        this.log.info({ message: `downloadChatProfilePhoto ${accountId}/${chatId}`, error: msg });
      } else {
        this.log.warn({ message: `downloadChatProfilePhoto ${accountId}/${chatId}`, error: msg });
      }
      return null;
    }
  }

  /**
   * Start periodic session saving to keep sessions alive
   */
  private startSessionSaveInterval(): void {
    this.sessionSaveInterval = setInterval(async () => {
      try {
        await this.saveAllSessions();
      } catch (error) {
        this.log.error({ message: "Error during session save", error: String(error) });
      }
    }, this.SESSION_SAVE_INTERVAL);
  }

  /**
   * Save all active sessions to database
   */
  private async saveAllSessions(): Promise<void> {
    for (const [accountId, clientInfo] of this.clients) {
      if (clientInfo.isConnected && clientInfo.client.connected) {
        try {
          await this.saveSession(accountId, clientInfo.client);
          // Update last activity
          clientInfo.lastActivity = new Date();
        } catch (error) {
          this.log.error({ message: `Error saving session for account ${accountId}`, error: error?.message || String(error) });
        }
      }
    }
  }

  /**
   * Cleanup on shutdown
   */
  async shutdown(): Promise<void> {
    if (this.reconnectAllTimeout != null) {
      clearTimeout(this.reconnectAllTimeout);
      this.reconnectAllTimeout = null;
    }
    for (const t of this.reconnectOneAfterTimeoutTimeouts.values()) clearTimeout(t);
    this.reconnectOneAfterTimeoutTimeouts.clear();
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    if (this.sessionSaveInterval) {
      clearInterval(this.sessionSaveInterval);
      this.sessionSaveInterval = null;
    }
    for (const aid of Array.from(this.updateKeepaliveIntervals.keys())) {
      this.stopUpdateKeepalive(aid);
    }
    await this.saveAllSessions();
    for (const [accountId] of this.clients) {
      await this.disconnectAccount(accountId);
    }
  }
}

