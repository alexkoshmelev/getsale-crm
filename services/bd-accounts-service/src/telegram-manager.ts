// @ts-nocheck — telegram (GramJS) types are incomplete; remove when @types/telegram or package types are used
import { TelegramClient, Api } from 'telegram';
import { NewMessage, Raw } from 'telegram/events';
import { StringSession } from 'telegram/sessions';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { RabbitMQClient, RedisClient } from '@getsale/utils';
import {
  EventType,
  Event,
  MessageReceivedEvent,
  BDAccountSyncStartedEvent,
  BDAccountSyncProgressEvent,
  BDAccountSyncCompletedEvent,
  BDAccountSyncFailedEvent,
} from '@getsale/events';
import { MessageChannel, MessageDirection, MessageStatus } from '@getsale/types';
import { serializeMessage, getMessageText, SerializedTelegramMessage } from './telegram-serialize';

interface TelegramClientInfo {
  client: TelegramClient;
  accountId: string;
  organizationId: string;
  userId: string;
  phoneNumber: string;
  isConnected: boolean;
  lastActivity: Date;
  reconnectAttempts: number;
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
  private reconnectIntervals: Map<string, NodeJS.Timeout> = new Map();
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_DELAY = 5000; // 5 seconds
  /** Debounce: reconnect all clients after TIMEOUT from update loop (restart loops) */
  private reconnectAllTimeout: NodeJS.Timeout | null = null;
  private readonly RECONNECT_ALL_DEBOUNCE_MS = 12000; // 12 sec — не чаще раза в 12 сек

  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly CLEANUP_INTERVAL = 60000; // 1 minute

  private sessionSaveInterval: NodeJS.Timeout | null = null;
  private readonly SESSION_SAVE_INTERVAL = 300000; // 5 minutes - save sessions periodically

  /** Интервалы вызова updates.GetState() для поддержания потока апдейтов (Telegram перестаёт слать, если нет активности). */
  private updateKeepaliveIntervals: Map<string, NodeJS.Timeout> = new Map();
  private readonly UPDATE_KEEPALIVE_MS = 10 * 60 * 1000; // 10 минут

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

  constructor(pool: Pool, rabbitmq: RabbitMQClient, redis?: RedisClient | null) {
    this.pool = pool;
    this.rabbitmq = rabbitmq;
    this.redis = redis ?? null;
    this.startCleanupInterval();
    this.startSessionSaveInterval();
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
    apiHash: string
  ): Promise<{ phoneCodeHash: string }> {
    try {
      // Check if client already exists for this account
      if (this.clients.has(accountId)) {
        await this.disconnectAccount(accountId);
      }

      const session = new StringSession('');
      const client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
        retryDelay: 1000,
        timeout: 30000, // Increased timeout to handle datacenter migration
        // Don't disable updates, but we won't set up handlers until after auth
      });

      // Connect client with proper error handling for datacenter migration
      try {
        await client.connect();
        console.log(`[TelegramManager] Connected client for sending code to ${phoneNumber}`);
        
        // Wait a bit for connection to stabilize and avoid builder.resolve errors
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error: any) {
        // If connection fails, clean up and rethrow
        console.error(`[TelegramManager] Connection error for ${phoneNumber}:`, error.message);
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
      console.error(`[TelegramManager] Error sending code for account ${accountId}:`, error);
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

      await this.updateAccountStatus(accountId, 'connected', 'Successfully signed in');

      return { requiresPassword: false };
    } catch (error: any) {
      console.error(`[TelegramManager] Error signing in account ${accountId}:`, error);
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

      await this.updateAccountStatus(accountId, 'connected', 'Successfully signed in with password');
    } catch (error: any) {
      console.error(`[TelegramManager] Error signing in with password for account ${accountId}:`, error);
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
    apiHash: string
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

    const session = new StringSession('');
    const client = new TelegramClient(session, apiId, apiHash, {
      connectionRetries: 5,
      retryDelay: 1000,
      timeout: 30000,
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
              console.error('[TelegramManager] QR login onError:', msg, err);
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
            `UPDATE bd_accounts SET telegram_id = $1, phone_number = $2, api_id = $3, api_hash = $4, session_string = $5, is_active = true, created_by_user_id = COALESCE(created_by_user_id, $6) WHERE id = $7`,
            [telegramId, phoneNumber, String(apiId), apiHash, sessionString, userId, accountId]
          );
        } else {
          const insertResult = await this.pool.query(
            `INSERT INTO bd_accounts (organization_id, telegram_id, phone_number, api_id, api_hash, session_string, is_active, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, true, $7) RETURNING id`,
            [organizationId, telegramId, phoneNumber, String(apiId), apiHash, sessionString, userId]
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
        console.error('[TelegramManager] QR login failed:', msg, err?.stack);
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
        } catch (_) {}
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
      console.error('[TelegramManager] Failed to persist QR state to Redis:', err);
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
        // Disconnect old client
        await this.disconnectAccount(accountId);
      }

      if (!sessionString) {
        throw new Error('Session string is required for existing accounts');
      }

      const session = new StringSession(sessionString);
      const client = new TelegramClient(session, apiId, apiHash, {
        connectionRetries: 5,
        retryDelay: 1000,
        timeout: 30000, // Increased timeout to 30 seconds to reduce TIMEOUT errors
      });

      // Connect client first
      await client.connect();
      console.log(`[TelegramManager] Connected account ${accountId} (${phoneNumber})`);

      // Wait for connection to stabilize before setting up handlers
      // This helps avoid builder.resolve errors during initialization
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Verify session is valid by checking if we're authorized
      try {
        await client.getMe();
        console.log(`[TelegramManager] Session verified for account ${accountId}`);
      } catch (error: any) {
        console.error(`[TelegramManager] Session invalid for account ${accountId}:`, error.message);
        await client.disconnect();
        throw new Error('Invalid session. Please reconnect the account.');
      }

      // Set up event handlers AFTER verifying session is valid and connection is stable
      this.setupEventHandlers(client, accountId, organizationId);
      console.log(`[TelegramManager] Event handlers registered for account ${accountId}`);

      // Best practice: high-level request after handlers so Telegram pushes updates to this client
      try {
        await client.getMe();
        console.log(`[TelegramManager] getMe() after handlers — update stream active for account ${accountId}`);
      } catch (e: any) {
        console.warn(`[TelegramManager] getMe() after handlers failed (non-fatal):`, e?.message);
      }

      // Save session immediately after connection
      await this.saveSession(accountId, client);

      // Store client info
      const clientInfo: TelegramClientInfo = {
        client,
        accountId,
        organizationId,
        userId,
        phoneNumber,
        isConnected: true,
        lastActivity: new Date(),
        reconnectAttempts: 0,
      };

      this.clients.set(accountId, clientInfo);

      // Поддержание потока апдейтов: Telegram перестаёт слать updates, если долго нет запросов (см. gramjs client/updates.ts).
      this.startUpdateKeepalive(accountId, client);

      // Update status
      await this.updateAccountStatus(accountId, 'connected', 'Successfully connected');

      return client;
    } catch (error: any) {
      console.error(`[TelegramManager] Error connecting account ${accountId}:`, error);
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
        await info.client.invoke(new Api.updates.GetState());
        console.log(`[TelegramManager] GetState keepalive OK for account ${accountId}`);
      } catch (e: any) {
        if (e?.message !== 'TIMEOUT' && !e?.message?.includes('builder.resolve')) {
          console.warn(`[TelegramManager] GetState keepalive failed for ${accountId}:`, e?.message);
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
        console.warn(`[TelegramManager] Client not connected for account ${accountId}, skipping event handlers`);
        return;
      }

      // Лог сырых апдейтов (для отладки). Важно: второй аргумент должен быть EventBuilder (Raw), иначе gram.js ломает цикл обработки.
      try {
        client.addEventHandler(
          (update: any) => {
            const name = update?.className ?? update?.constructor?.name ?? (update && typeof update === 'object' ? 'Object' : String(update));
            const hasMessage = update?.message != null;
            console.log(`[TelegramManager] Raw update: ${name}, accountId=${accountId}, hasMessage=${hasMessage}`);
          },
          new Raw({ func: () => true })
        );
      } catch (_) {}

      // UpdateShortMessage / UpdateShortChatMessage — личные и групповые сообщения в «коротком» формате (часто приходят первыми).
      try {
        client.addEventHandler(
          async (update: any) => {
            try {
              if (!client.connected) return;
              const out = (update as any).out === true;
              if (out) return; // только входящие
              await this.handleShortMessageUpdate(update, accountId, organizationId);
            } catch (err: any) {
              if (err?.message === 'TIMEOUT' || err?.message?.includes('TIMEOUT')) return;
              if (err?.message?.includes('builder.resolve')) return;
              console.error(`[TelegramManager] Short message handler error for ${accountId}:`, err?.message || err);
            }
          },
          new Raw({
            func: (update: any) => {
              try {
                if (!update) return false;
                const name = update.className ?? update.constructor?.name ?? '';
                if (name === 'UpdateShortMessage' || name === 'UpdateShortChatMessage') {
                  const out = (update as any).out === true;
                  const text = (update as any).message;
                  return !out && typeof text === 'string' && text.length > 0;
                }
                return false;
              } catch (_) {
                return false;
              }
            },
          })
        );
      } catch (_) {}

      // UpdateNewMessage / UpdateNewChannelMessage — полный объект Message (личные чаты и группы/каналы).
      try {
        client.addEventHandler(
          async (event: any) => {
            try {
              console.log(`[TelegramManager] Raw UpdateNewMessage/UpdateNewChannelMessage, accountId=${accountId}, hasMessage=${!!event?.message}`);
              if (!client.connected) return;

              const accountCheck = await this.pool.query(
                'SELECT id, is_active FROM bd_accounts WHERE id = $1',
                [accountId]
              );
              if (accountCheck.rows.length === 0 || !accountCheck.rows[0].is_active) {
                console.log(`[TelegramManager] Account ${accountId} no longer exists or is inactive, disconnecting...`);
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
                console.warn(`[TelegramManager] Timeout error for account ${accountId}, will retry:`, error.message);
                return;
              }
              if (error.message?.includes('builder.resolve') || error.stack?.includes('builder.resolve')) return;
              console.error(`[TelegramManager] Error handling new message for account ${accountId}:`, error);
            }
          },
          new Raw({
            types: [Api.UpdateNewMessage, Api.UpdateNewChannelMessage],
            func: (update: any) => update != null && update.message != null,
          })
        );
      } catch (error: any) {
        if (error.message?.includes('builder.resolve') || error.stack?.includes('builder.resolve')) {
          console.warn(`[TelegramManager] Could not set up UpdateNewMessage handler for ${accountId}, will rely on Short/NewMessage`);
        } else {
          throw error;
        }
      }

      // Дублируем подписку через NewMessage (incoming) — надёжнее ловит входящие от сторонних аккаунтов
      try {
        client.addEventHandler(
          async (event: any) => {
            try {
              console.log(`[TelegramManager] NewMessage(incoming) handler fired, accountId=${accountId}, hasMessage=${!!event?.message}`);
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
              console.error(`[TelegramManager] NewMessage handler error for ${accountId}:`, err?.message || err);
            }
          },
          new NewMessage({ incoming: true })
        );
        console.log(`[TelegramManager] NewMessage(incoming) handler registered for account ${accountId}`);
      } catch (err: any) {
        if (err?.message?.includes('builder.resolve') || err?.stack?.includes('builder.resolve')) {
          console.warn(`[TelegramManager] Could not set up NewMessage handler for ${accountId}`);
        }
      }

      // Reconnection and account cleanup are handled in scheduleReconnect, cleanupInactiveClients, and on TIMEOUT.
    } catch (error: any) {
      console.error(`[TelegramManager] Error setting up event handlers:`, error.message);
      // Don't throw - allow client to continue without event handlers
    }
  }

  /**
   * Check if chat is in allowed sync list for this account
   */
  private async isChatAllowedForAccount(accountId: string, telegramChatId: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
      [accountId, telegramChatId]
    );
    return result.rows.length > 0;
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
    const {
      telegram_message_id,
      telegram_date,
      content,
      telegram_entities,
      telegram_media,
      reply_to_telegram_id,
      telegram_extra,
    } = serialized;

    const result = await this.pool.query(
      `INSERT INTO messages (
        organization_id, bd_account_id, contact_id, channel, channel_id, direction, content, status, unread,
        metadata, telegram_message_id, telegram_date, loaded_at, reply_to_telegram_id, telegram_entities, telegram_media, telegram_extra
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13, $14, $15, $16)
      ON CONFLICT (bd_account_id, channel_id, telegram_message_id) WHERE (telegram_message_id IS NOT NULL)
      DO UPDATE SET
        content = EXCLUDED.content,
        telegram_entities = EXCLUDED.telegram_entities,
        telegram_media = EXCLUDED.telegram_media,
        telegram_extra = EXCLUDED.telegram_extra,
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
      ]
    );
    return result.rows[0];
  }

  /**
   * Найти или создать контакт по telegram_id (для отображения имени в чатах).
   */
  private async ensureContactForTelegramId(organizationId: string, telegramId: string): Promise<string | null> {
    if (!telegramId?.trim()) return null;
    const existing = await this.pool.query(
      'SELECT id FROM contacts WHERE telegram_id = $1 AND organization_id = $2 LIMIT 1',
      [telegramId, organizationId]
    );
    if (existing.rows.length > 0) return existing.rows[0].id;
    try {
      const insert = await this.pool.query(
        `INSERT INTO contacts (organization_id, telegram_id, first_name, last_name)
         VALUES ($1, $2, $3, NULL)
         RETURNING id`,
        [organizationId, telegramId, `Telegram ${telegramId}`]
      );
      if (insert.rows.length > 0) return insert.rows[0].id;
    } catch (_) {}
    const again = await this.pool.query(
      'SELECT id FROM contacts WHERE telegram_id = $1 AND organization_id = $2 LIMIT 1',
      [telegramId, organizationId]
    );
    return again.rows.length > 0 ? again.rows[0].id : null;
  }

  /**
   * Handle incoming short update (UpdateShortMessage / UpdateShortChatMessage).
   * Личные и групповые сообщения часто приходят в этом формате.
   */
  private async handleShortMessageUpdate(
    update: any,
    accountId: string,
    organizationId: string
  ): Promise<void> {
    try {
      const name = update?.className ?? update?.constructor?.name ?? '';
      const userId = (update as any).userId ?? (update as any).user_id;
      const fromId = (update as any).fromId ?? (update as any).from_id;
      const chatIdRaw = (update as any).chatId ?? (update as any).chat_id;
      const msgId = (update as any).id;
      const text = (update as any).message;
      const date = (update as any).date;
      console.log(`[TelegramManager] Short message received: ${name}, accountId=${accountId}, chatId=${chatIdRaw ?? userId}`);
      if (typeof text !== 'string' || !text.trim()) return;

      const chatId = name === 'UpdateShortChatMessage'
        ? String(chatIdRaw ?? fromId ?? '')
        : String(userId ?? '');
      const senderId = name === 'UpdateShortChatMessage'
        ? String(fromId ?? '')
        : String(userId ?? '');

      if (!chatId) return;

      let allowed = await this.isChatAllowedForAccount(accountId, chatId);
      if (!allowed) {
        const added = await this.tryAddChatFromSelectedFolders(accountId, chatId);
        if (added) {
          allowed = true;
          this.syncHistoryForChat(accountId, organizationId, chatId).catch((e) =>
            console.warn('[TelegramManager] Background syncHistoryForChat failed:', e?.message)
          );
        } else {
          console.log(`[TelegramManager] Short: chat not in sync list, skipping, accountId=${accountId}, chatId=${chatId}`);
          return;
        }
      }

      const contactId = await this.ensureContactForTelegramId(organizationId, senderId || chatId);
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
        direction: MessageDirection.INBOUND,
        status: MessageStatus.DELIVERED,
        unread: true,
        serialized,
        metadata: { senderId, short: true },
      });

      const clientInfo = this.clients.get(accountId);
      if (clientInfo) {
        clientInfo.lastActivity = new Date();
        await this.pool.query('UPDATE bd_accounts SET last_activity = NOW() WHERE id = $1', [accountId]);
      }

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
        },
      };
      await this.rabbitmq.publishEvent(event);
      console.log(`[TelegramManager] Short message saved and event published, messageId=${savedMessage.id}, channelId=${chatId}`);
    } catch (error) {
      console.error(`[TelegramManager] Error handling short message:`, error);
    }
  }

  /**
   * Handle new incoming message (only for allowed chats; save to DB + emit event for WS)
   */
  private async handleNewMessage(
    message: Api.Message,
    accountId: string,
    organizationId: string
  ): Promise<void> {
    try {
      let chatId = '';
      if (message.peerId) {
        if (message.peerId instanceof Api.PeerUser) chatId = String(message.peerId.userId);
        else if (message.peerId instanceof Api.PeerChat) chatId = String(message.peerId.chatId);
        else if (message.peerId instanceof Api.PeerChannel) chatId = String(message.peerId.channelId);
        else chatId = String(message.peerId);
      }
      console.log('[TelegramManager] New message received', { accountId, chatId });
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

      // Только чаты из bd_account_sync_chats; если чат в выбранной папке — авто-добавляем и подгружаем историю.
      let allowed = await this.isChatAllowedForAccount(accountId, chatId);
      if (!allowed) {
        const added = await this.tryAddChatFromSelectedFolders(accountId, chatId);
        if (added) {
          allowed = true;
          this.syncHistoryForChat(accountId, organizationId, chatId).catch((e) =>
            console.warn('[TelegramManager] Background syncHistoryForChat failed:', e?.message)
          );
        } else {
          console.log(`[TelegramManager] Chat not in sync list (add chat to sync in UI), skipping message, accountId=${accountId}, chatId=${chatId}`);
          return;
        }
      }

      const contactId = await this.ensureContactForTelegramId(organizationId, senderId || chatId);

      const serialized = serializeMessage(message);
      const savedMessage = await this.saveMessageToDb({
        organizationId,
        bdAccountId: accountId,
        contactId,
        channel: MessageChannel.TELEGRAM,
        channelId: chatId,
        direction: MessageDirection.INBOUND,
        status: MessageStatus.DELIVERED,
        unread: true,
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

      // Publish event (channelId for WebSocket room targeting)
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
        },
      };

      await this.rabbitmq.publishEvent(event);
      console.log(`[TelegramManager] MessageReceivedEvent published, messageId=${savedMessage.id}, channelId=${chatId}`);
    } catch (error) {
      console.error(`[TelegramManager] Error handling new message:`, error);
    }
  }

  /** Delay between Telegram API calls to respect rate limits (ms) */
  private readonly SYNC_DELAY_MS = 1100;
  /** Initial sync: depth in days (hybrid: 1 month; older messages load on scroll via load-older-history). */
  private readonly SYNC_MESSAGES_MAX_AGE_DAYS = parseInt(process.env.SYNC_MESSAGES_MAX_AGE_DAYS || '30', 10) || 30;
  /** Safety cap: max messages per chat in one sync run (to avoid runaway in huge groups). */
  private readonly SYNC_MESSAGES_PER_CHAT_CAP = parseInt(process.env.SYNC_MESSAGES_PER_CHAT_CAP || '50000', 10) || 50000;

  /**
   * Run initial history sync for selected chats: fetch messages from Telegram, save to DB, emit progress.
   * Respects rate limits (delay + FLOOD_WAIT handling).
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
    const rows = await this.pool.query(
      'SELECT telegram_chat_id, title FROM bd_account_sync_chats WHERE bd_account_id = $1 ORDER BY created_at',
      [accountId]
    );
    const chats = rows.rows as { telegram_chat_id: string; title: string }[];
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
    console.log(`[TelegramManager] Sync started for account ${accountId}, ${totalChats} chats`);

    let totalMessages = 0;
    let failedChatsCount = 0;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

    for (let i = 0; i < chats.length; i++) {
      const { telegram_chat_id: telegramChatId, title } = chats[i];
      let fetched = 0;
      const chatNum = i + 1;
      console.log(`[TelegramManager] Processing chat ${chatNum}/${totalChats}: ${title} (id=${telegramChatId})`);

      try {
        // GramJS getInputEntity: numeric IDs (incl. -100xxx for channels) must be number; usernames stay string
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
            if (!Array.isArray(rawMessages)) {
              hasMore = false;
              break;
            }

            const list: Api.Message[] = rawMessages.filter((m: any) => m && typeof m === 'object' && (m.className === 'Message' || m instanceof Api.Message));
            for (const msg of list) {
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

              const contactId = await this.ensureContactForTelegramId(organizationId, senderId || chatId);

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

            if (list.length === 0) hasMore = false;
            else {
              offsetId = Number((list[list.length - 1] as any).id) || 0;
              const oldestMsgDate = (list[list.length - 1] as any).date;
              if (typeof oldestMsgDate === 'number' && oldestMsgDate < cutoffDate) hasMore = false;
            }
            if (fetched >= this.SYNC_MESSAGES_PER_CHAT_CAP) hasMore = false;
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
        console.error(`[TelegramManager] Sync error for chat ${chatNum}/${totalChats} (${title}, id=${telegramChatId}):`, err?.message || err);
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
      onProgress?.(done, totalChats, telegramChatId, title);
      console.log(`[TelegramManager] Chat ${done}/${totalChats} done: ${title}, messages: ${fetched}`);
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
    console.log(`[TelegramManager] Sync completed for account ${accountId}: ${totalChats} chats, ${totalMessages} messages, ${failedChatsCount} chats failed`);
    return { totalChats, totalMessages };
  }

  /**
   * Get all dialogs for an account (optionally filtered by folder).
   * @param folderId - Telegram folder id (0 = main list, 1 = archive, 2+ = custom filter id). Omit for all.
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
      const mapped = dialogs.map((dialog: any) => ({
        id: String(dialog.id),
        name: dialog.name || dialog.title || 'Unknown',
        unreadCount: dialog.unreadCount || 0,
        lastMessage: dialog.message?.text || '',
        lastMessageDate: dialog.message?.date,
        isUser: dialog.isUser,
        isGroup: dialog.isGroup,
        isChannel: dialog.isChannel,
      }));
      // Показываем только личные переписки и групповые чаты (где пользователь может писать); каналы исключаем
      return mapped.filter((d: any) => d.isUser || d.isGroup);
    } catch (error) {
      console.error(`[TelegramManager] Error getting dialogs for ${accountId}:`, error);
      throw error;
    }
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
  async getDialogFilterPeerIds(accountId: string, filterId: number): Promise<Set<string>> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const result = await clientInfo.client.invoke(new Api.messages.GetDialogFilters({}));
    const filters = (result as any).filters ?? [];
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
   * Get dialog filters (folders) from Telegram — кастомные папки пользователя.
   * Если у пользователя нет папок, API вернёт пустой массив или один элемент (дефолт «Все чаты», id 0).
   * Папку «Все чаты» (id 0) для списка диалогов вызывающая сторона добавляет сама через getDialogsByFolder(accountId, 0).
   * emoticon — иконка папки из Telegram (эмодзи, например 📁).
   */
  async getDialogFilters(accountId: string): Promise<{ id: number; title: string; isCustom: boolean; emoticon?: string }[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }

    try {
      const result = await clientInfo.client.invoke(new Api.messages.GetDialogFilters({}));
      const filters = (result as any).filters ?? [];
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
      console.error(`[TelegramManager] Error getting dialog filters for ${accountId}:`, error?.message || error);
      throw error;
    }
  }

  /**
   * Get dialogs for a specific folder (for populating sync_chats from selected folders).
   * В Telegram API folder_id в getDialogs поддерживает только 0 (основной список) и 1 (архив).
   * Кастомные папки (id >= 2) — это Dialog Filter с include_peers/pinned_peers: берём все диалоги из 0 и фильтруем по списку пиров фильтра.
   */
  async getDialogsByFolder(accountId: string, folderId: number): Promise<any[]> {
    if (folderId === 0 || folderId === 1) {
      return this.getDialogs(accountId, folderId);
    }
    const allDialogs = await this.getDialogs(accountId, 0);
    const peerIds = await this.getDialogFilterPeerIds(accountId, folderId);
    if (peerIds.size === 0) return [];
    return allDialogs.filter((d: any) => peerIds.has(String(d.id)));
  }

  /**
   * Если чат не в sync_chats, но есть выбранные папки — проверить, входит ли чат в одну из папок.
   * Если да: добавить чат в bd_account_sync_chats и вернуть true (далее сообщение обработается и можно подгрузить историю).
   */
  async tryAddChatFromSelectedFolders(accountId: string, chatId: string): Promise<boolean> {
    const foldersRows = await this.pool.query(
      'SELECT folder_id, folder_title FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index',
      [accountId]
    );
    if (foldersRows.rows.length === 0) return false;

    for (const row of foldersRows.rows) {
      const folderId = Number(row.folder_id);
      try {
        const dialogs = await this.getDialogsByFolder(accountId, folderId);
        const found = dialogs.find((d: any) => String(d.id ?? '').trim() === chatId);
        if (found) {
          let peerType = 'user';
          if (found.isChannel) peerType = 'channel';
          else if (found.isGroup) peerType = 'chat';
          const title = (found.name ?? '').trim() || chatId;
          await this.pool.query(
            `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id)
             VALUES ($1, $2, $3, $4, false, $5)
             ON CONFLICT (bd_account_id, telegram_chat_id) DO UPDATE SET
               title = EXCLUDED.title,
               peer_type = EXCLUDED.peer_type,
               folder_id = EXCLUDED.folder_id`,
            [accountId, chatId, title, peerType, folderId]
          );
          console.log(`[TelegramManager] Auto-added chat ${chatId} from folder ${folderId} for account ${accountId}`);
          return true;
        }
      } catch (err: any) {
        if (err?.message !== 'TIMEOUT' && !err?.message?.includes('builder.resolve')) {
          console.warn(`[TelegramManager] tryAddChatFromSelectedFolders folder ${folderId} failed:`, err?.message);
        }
      }
    }
    return false;
  }

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

            const contactId = await this.ensureContactForTelegramId(organizationId, senderId || cid);
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
        console.log(`[TelegramManager] syncHistoryForChat: ${fetched} messages for chat ${chatId}, account ${accountId}`);
      }
    } catch (err: any) {
      console.warn(`[TelegramManager] syncHistoryForChat failed for ${accountId}/${chatId}:`, err?.message);
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

    const exhaustedRow = await this.pool.query(
      'SELECT history_exhausted FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
      [accountId, chatId]
    );
    if (exhaustedRow.rows.length === 0) {
      return { added: 0, exhausted: true };
    }
    if ((exhaustedRow.rows[0] as any).history_exhausted === true) {
      return { added: 0, exhausted: true };
    }

    const oldestRow = await this.pool.query(
      `SELECT telegram_message_id, telegram_date, created_at FROM messages
       WHERE bd_account_id = $1 AND channel_id = $2
       ORDER BY COALESCE(telegram_date, created_at) ASC NULLS LAST
       LIMIT 1`,
      [accountId, chatId]
    );

    if (oldestRow.rows.length === 0) {
      return { added: 0, exhausted: true };
    }

    const client = clientInfo.client;
    const peerIdNum = Number(chatId);
    const peerInput = Number.isNaN(peerIdNum) ? chatId : peerIdNum;
    const peer = await client.getInputEntity(peerInput);

    const row = oldestRow.rows[0] as any;
    let offsetId = 0;
    let offsetDate = 0;
    if (row.telegram_message_id != null) offsetId = parseInt(String(row.telegram_message_id), 10) || 0;
    if (row.telegram_date) offsetDate = row.telegram_date;
    else if (row.created_at) offsetDate = Math.floor(new Date(row.created_at).getTime() / 1000);

    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const limit = 100;

    try {
      const result = await client.invoke(
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
      );

      const rawMessages = (result as any).messages;
      if (!Array.isArray(rawMessages)) {
        await this.pool.query(
          'UPDATE bd_account_sync_chats SET history_exhausted = true WHERE bd_account_id = $1 AND telegram_chat_id = $2',
          [accountId, chatId]
        );
        return { added: 0, exhausted: true };
      }

      const list: Api.Message[] = rawMessages.filter((m: any) => m && typeof m === 'object' && (m.className === 'Message' || m instanceof Api.Message));
      let added = 0;

      for (const msg of list) {
        const hasText = !!getMessageText(msg).trim();
        if (!hasText && !msg.media) continue;
        let cid = chatId;
        let senderId = '';
        if (msg.peerId) {
          if (msg.peerId instanceof Api.PeerUser) cid = String(msg.peerId.userId);
          else if (msg.peerId instanceof Api.PeerChat) cid = String(msg.peerId.chatId);
          else if (msg.peerId instanceof Api.PeerChannel) cid = String(msg.peerId.channelId);
        }
        if (msg.fromId instanceof Api.PeerUser) senderId = String(msg.fromId.userId);

        const contactId = await this.ensureContactForTelegramId(organizationId, senderId || cid);
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
        added++;
      }

      const exhausted = list.length === 0 || list.length < limit;
      if (exhausted) {
        await this.pool.query(
          'UPDATE bd_account_sync_chats SET history_exhausted = true WHERE bd_account_id = $1 AND telegram_chat_id = $2',
          [accountId, chatId]
        );
      }

      if (added > 0) {
        console.log(`[TelegramManager] fetchOlderMessagesFromTelegram: +${added} for chat ${chatId}, account ${accountId}, exhausted=${exhausted}`);
      }
      return { added, exhausted };
    } catch (err: any) {
      console.warn(`[TelegramManager] fetchOlderMessagesFromTelegram failed for ${accountId}/${chatId}:`, err?.message);
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
   * Send message via Telegram
   */
  async sendMessage(
    accountId: string,
    chatId: string,
    text: string
  ): Promise<Api.Message> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }

    try {
      const message = await clientInfo.client.sendMessage(chatId, { message: text });
      
      // Update last activity
      clientInfo.lastActivity = new Date();
      await this.pool.query(
        'UPDATE bd_accounts SET last_activity = NOW() WHERE id = $1',
        [accountId]
      );

      return message;
    } catch (error) {
      console.error(`[TelegramManager] Error sending message:`, error);
      throw error;
    }
  }

  /**
   * Disconnect an account
   */
  async disconnectAccount(accountId: string): Promise<void> {
    this.stopUpdateKeepalive(accountId);
    const clientInfo = this.clients.get(accountId);
    if (clientInfo) {
      try {
        await clientInfo.client.disconnect();
      } catch (error) {
        console.error(`[TelegramManager] Error disconnecting account ${accountId}:`, error);
      }
      this.clients.delete(accountId);
      
      const interval = this.reconnectIntervals.get(accountId);
      if (interval) {
        clearInterval(interval);
        this.reconnectIntervals.delete(accountId);
      }
    }
  }

  /**
   * Schedule reconnection attempt
   */
  private scheduleReconnect(accountId: string): void {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo) return;

    if (clientInfo.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error(`[TelegramManager] Max reconnect attempts reached for ${accountId}`);
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
        console.log(`[TelegramManager] Attempting to reconnect account ${accountId} (attempt ${clientInfo.reconnectAttempts})`);
        
        // Get account details from DB
        const result = await this.pool.query(
          'SELECT api_id, api_hash, session_string, phone_number FROM bd_accounts WHERE id = $1',
          [accountId]
        );

        if (result.rows.length === 0) {
          throw new Error('Account not found');
        }

        const account = result.rows[0];
        await this.connectAccount(
          accountId,
          account.organization_id || clientInfo.organizationId,
          clientInfo.userId,
          account.phone_number || clientInfo.phoneNumber,
          parseInt(account.api_id),
          account.api_hash,
          account.session_string
        );

        // Reset reconnect attempts on success
        clientInfo.reconnectAttempts = 0;
        this.reconnectIntervals.delete(accountId);
      } catch (error) {
        console.error(`[TelegramManager] Reconnection failed for ${accountId}:`, error);
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
      console.error(`[TelegramManager] Error updating account status:`, error);
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
   * Schedule reconnect of all clients after TIMEOUT from update loop (debounced).
   * Call from process unhandledRejection when reason.message === 'TIMEOUT'.
   */
  scheduleReconnectAllAfterTimeout(): void {
    if (this.reconnectAllTimeout != null) return;
    this.reconnectAllTimeout = setTimeout(() => {
      this.reconnectAllTimeout = null;
      this.reconnectAllClientsAfterTimeout().catch((err) => {
        console.error('[TelegramManager] reconnectAllClientsAfterTimeout failed:', err);
      });
    }, this.RECONNECT_ALL_DEBOUNCE_MS);
    console.log('[TelegramManager] TIMEOUT from update loop — scheduled reconnect of all clients in', this.RECONNECT_ALL_DEBOUNCE_MS / 1000, 's');
  }

  /**
   * Reconnect all active Telegram clients to restart update loops after TIMEOUT.
   */
  private async reconnectAllClientsAfterTimeout(): Promise<void> {
    const accountIds = Array.from(this.clients.keys());
    if (accountIds.length === 0) return;
    console.log('[TelegramManager] Reconnecting', accountIds.length, 'client(s) to restart update loops');
    for (const accountId of accountIds) {
      const info = this.clients.get(accountId);
      if (!info) continue;
      try {
        const row = await this.pool.query(
          'SELECT organization_id, phone_number, api_id, api_hash, session_string FROM bd_accounts WHERE id = $1',
          [accountId]
        );
        if (row.rows.length === 0 || !row.rows[0].session_string) continue;
        const acc = row.rows[0];
        await this.disconnectAccount(accountId);
        await this.connectAccount(
          accountId,
          acc.organization_id || info.organizationId,
          info.userId,
          acc.phone_number || info.phoneNumber,
          parseInt(acc.api_id, 10),
          acc.api_hash,
          acc.session_string
        );
      } catch (err: any) {
        console.error('[TelegramManager] Reconnect failed for account', accountId, err?.message || err);
      }
    }
  }

  /**
   * Initialize all active accounts on startup
   */
  async initializeActiveAccounts(): Promise<void> {
    try {
      const result = await this.pool.query(
        `SELECT id, organization_id, phone_number, api_id, api_hash, session_string
         FROM bd_accounts
         WHERE is_active = true AND session_string IS NOT NULL AND session_string != ''`
      );

      for (const account of result.rows) {
        try {
          // Use organization_id as userId fallback (will be replaced when user connects)
          const userId = account.organization_id;
          
          await this.connectAccount(
            account.id,
            account.organization_id,
            userId,
            account.phone_number,
            parseInt(account.api_id),
            account.api_hash,
            account.session_string
          );
        } catch (error) {
          console.error(`[TelegramManager] Failed to initialize account ${account.id}:`, error);
        }
      }
    } catch (error) {
      console.error('[TelegramManager] Error initializing active accounts:', error);
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
        console.error('[TelegramManager] Error during cleanup:', error);
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
          console.log(`[TelegramManager] Cleaning up inactive client for account ${accountId}`);
          await this.disconnectAccount(accountId);
        }
      }
    } catch (error) {
      console.error('[TelegramManager] Error checking active accounts:', error);
    }
  }

  /**
   * Save session to database
   */
  private async saveSession(accountId: string, client: TelegramClient): Promise<void> {
    try {
      const sessionString = client.session.save() as string;
      await this.pool.query(
        'UPDATE bd_accounts SET session_string = $1, last_activity = NOW() WHERE id = $2',
        [sessionString, accountId]
      );
    } catch (error) {
      console.error(`[TelegramManager] Error saving session for account ${accountId}:`, error);
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
        console.error('[TelegramManager] Error during session save:', error);
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
          console.error(`[TelegramManager] Error saving session for account ${accountId}:`, error);
        }
      }
    }
  }

  /**
   * Cleanup on shutdown
   */
  async shutdown(): Promise<void> {
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

