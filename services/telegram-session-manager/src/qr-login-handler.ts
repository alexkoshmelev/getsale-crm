// @ts-nocheck
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { RedisClient } from '@getsale/cache';
import { RabbitMQClient } from '@getsale/queue';
import { EventType, type Event } from '@getsale/events';
import {
  encryptSession,
  buildTelegramProxy,
  buildGramJsClientOptions,
  destroyTelegramClient,
  type ProxyConfig,
  type QrLoginState,
} from '@getsale/telegram';

interface QrSessionInternal extends QrLoginState {
  organizationId: string;
  userId: string;
  apiId: number;
  apiHash: string;
  proxyConfigRaw?: ProxyConfig | null;
  passwordResolve?: (password: string) => void;
}

const QR_REDIS_PREFIX = 'qr:';
const QR_REDIS_TTL = 300;
const QR_PASSWORD_TTL = 120;
const PASSWORD_POLL_INTERVAL_MS = 200;
const PASSWORD_POLL_MAX_ITERATIONS = 600;

export class QrLoginHandler {
  private qrSessions = new Map<string, QrSessionInternal>();

  constructor(
    private pool: Pool,
    private rabbitmq: RabbitMQClient,
    private redis: RedisClient,
    private log: Logger,
    private apiId: number,
    private apiHash: string,
    private onAccountCreated?: (accountId: string, organizationId: string, userId: string) => Promise<void>,
  ) {}

  async startQrLogin(
    organizationId: string,
    userId: string,
    proxyConfigRaw?: ProxyConfig | null,
  ): Promise<{ sessionId: string }> {
    const sessionId = randomUUID();
    this.qrSessions.set(sessionId, {
      status: 'pending',
      organizationId,
      userId,
      apiId: this.apiId,
      apiHash: this.apiHash,
      proxyConfigRaw: proxyConfigRaw ?? null,
    });
    this.persistQrState(sessionId);

    const proxy = buildTelegramProxy(proxyConfigRaw);
    this.log.info({
      message: 'QR login: creating TelegramClient',
      sessionId,
      hasProxy: !!proxy,
    });

    const session = new StringSession('');
    const client = new TelegramClient(session, this.apiId, this.apiHash, buildGramJsClientOptions(proxy));

    this.runQrLoginFlow(sessionId, organizationId, userId, client, proxyConfigRaw);

    return { sessionId };
  }

  async getQrLoginStatus(sessionId: string): Promise<QrLoginState | null> {
    const full = this.qrSessions.get(sessionId);
    if (full) {
      const displayStatus =
        full.status === 'qr' && full.expiresAt && Date.now() > full.expiresAt
          ? 'expired'
          : full.status;
      return {
        status: displayStatus,
        loginTokenUrl: full.loginTokenUrl,
        expiresAt: full.expiresAt,
        accountId: full.accountId,
        error: full.error,
        passwordHint: full.passwordHint,
      };
    }

    const stored = await this.redis.get<QrLoginState>(QR_REDIS_PREFIX + sessionId);
    if (stored && typeof stored === 'object' && stored.status) {
      const displayStatus =
        stored.status === 'qr' && stored.expiresAt && Date.now() > stored.expiresAt
          ? 'expired'
          : stored.status;
      return { ...stored, status: displayStatus };
    }
    return null;
  }

  async submitQrLoginPassword(sessionId: string, password: string): Promise<boolean> {
    const full = this.qrSessions.get(sessionId);
    if (full?.passwordResolve) {
      full.passwordResolve(password);
      delete full.passwordResolve;
      return true;
    }
    await this.redis.set(QR_REDIS_PREFIX + sessionId + ':password', password, QR_PASSWORD_TTL);
    return true;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private runQrLoginFlow(
    sessionId: string,
    organizationId: string,
    userId: string,
    client: TelegramClient,
    proxyConfigRaw?: ProxyConfig | null,
  ): void {
    (async () => {
      try {
        await client.connect();

        await client.signInUserWithQrCode(
          { apiId: this.apiId, apiHash: this.apiHash },
          {
            qrCode: async (code: { token: Buffer; expires?: number }) => {
              this.handleQrCode(sessionId, code);
            },
            password: async (hint?: string) => {
              return this.handlePasswordPrompt(sessionId, hint);
            },
            onError: async (err: Error) => {
              return this.handleSignInError(sessionId, err);
            },
          },
        );

        await this.handleLoginSuccess(sessionId, organizationId, userId, client, proxyConfigRaw);
      } catch (err: any) {
        this.handleLoginFailure(sessionId, err);
        try { await destroyTelegramClient(client); } catch {}
      }
    })();
  }

  private handleQrCode(sessionId: string, code: { token: Buffer; expires?: number }): void {
    const tokenB64 = code.token.toString('base64url');
    const loginTokenUrl = `tg://login?token=${tokenB64}`;
    const state = this.qrSessions.get(sessionId);
    if (!state) return;

    state.status = 'qr';
    state.loginTokenUrl = loginTokenUrl;
    state.expiresAt =
      code.expires != null
        ? code.expires < 1e10 ? code.expires * 1000 : code.expires
        : Date.now() + 30_000;
    this.persistQrState(sessionId);
  }

  private async handlePasswordPrompt(sessionId: string, hint?: string): Promise<string> {
    const state = this.qrSessions.get(sessionId);
    if (state) {
      state.status = 'need_password';
      state.passwordHint = hint || undefined;
      this.persistQrState(sessionId);
    }

    for (let i = 0; i < PASSWORD_POLL_MAX_ITERATIONS; i++) {
      const p = await this.redis.get<string>(QR_REDIS_PREFIX + sessionId + ':password');
      if (p != null && typeof p === 'string') {
        await this.redis.del(QR_REDIS_PREFIX + sessionId + ':password');
        return p;
      }
      await new Promise((r) => setTimeout(r, PASSWORD_POLL_INTERVAL_MS));
    }
    return '';
  }

  private handleSignInError(sessionId: string, err: Error): boolean {
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
      this.persistQrState(sessionId);
    }
    return true;
  }

  private async handleLoginSuccess(
    sessionId: string,
    organizationId: string,
    userId: string,
    client: TelegramClient,
    proxyConfigRaw?: ProxyConfig | null,
  ): Promise<void> {
    const state = this.qrSessions.get(sessionId);
    if (!state) return;

    const me = await client.getMe();
    const telegramId = String((me as any).id ?? '');
    const phoneNumber = (me as any).phone ?? `qr-${telegramId}`;
    const sessionString = client.session.save() as string;

    const otherOrg = await this.pool.query(
      `SELECT id FROM bd_accounts WHERE organization_id != $1 AND is_active = true AND (telegram_id = $2 OR phone_number = $3)`,
      [organizationId, telegramId, phoneNumber],
    );
    if (otherOrg.rows.length > 0) {
      await destroyTelegramClient(client);
      state.status = 'error';
      state.error = 'Этот аккаунт уже подключён в другой организации. Один Telegram-аккаунт можно использовать только в одной организации.';
      this.persistQrState(sessionId);
      return;
    }

    const existing = await this.pool.query(
      `SELECT id, is_active FROM bd_accounts WHERE organization_id = $1 AND (telegram_id = $2 OR phone_number = $3)`,
      [organizationId, telegramId, phoneNumber],
    );

    let accountId: string;
    if (existing.rows.length > 0) {
      const row = existing.rows[0];
      accountId = row.id;
      if (row.is_active) {
        await destroyTelegramClient(client);
        state.status = 'error';
        state.error = 'Этот аккаунт уже подключён в вашей организации. Выберите его в списке или отключите перед повторным подключением.';
        this.persistQrState(sessionId);
        return;
      }
      await this.pool.query(
        `UPDATE bd_accounts SET telegram_id = $1, phone_number = $2, api_id = $3, api_hash = $4,
         session_string = $5, is_active = true, session_encrypted = true,
         created_by_user_id = COALESCE(created_by_user_id, $6),
         proxy_config = COALESCE($8::jsonb, proxy_config),
         connection_state = 'connected'
         WHERE id = $7`,
        [
          telegramId, phoneNumber, String(this.apiId), encryptSession(this.apiHash),
          encryptSession(sessionString), userId, accountId,
          proxyConfigRaw ? JSON.stringify(proxyConfigRaw) : null,
        ],
      );
    } else {
      const insertResult = await this.pool.query(
        `INSERT INTO bd_accounts (organization_id, telegram_id, phone_number, api_id, api_hash,
         session_string, is_active, session_encrypted, created_by_user_id, proxy_config, connection_state)
         VALUES ($1, $2, $3, $4, $5, $6, true, true, $7, $8, 'connected') RETURNING id`,
        [
          organizationId, telegramId, phoneNumber, String(this.apiId), encryptSession(this.apiHash),
          encryptSession(sessionString), userId,
          proxyConfigRaw ? JSON.stringify(proxyConfigRaw) : null,
        ],
      );
      accountId = insertResult.rows[0].id;
    }

    await destroyTelegramClient(client);

    if (this.onAccountCreated) {
      await this.onAccountCreated(accountId, organizationId, userId);
    }

    state.status = 'success';
    state.accountId = accountId;
    delete state.error;
    this.persistQrState(sessionId);

    await this.rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.BD_ACCOUNT_CONNECTED,
      timestamp: new Date(),
      organizationId,
      userId,
      data: { bdAccountId: accountId, platform: 'telegram', userId },
    } as Event);
  }

  private handleLoginFailure(sessionId: string, err: any): void {
    const msg = err?.message || String(err);
    this.log.error({ message: 'QR login failed', error: msg, stack: err?.stack });

    const state = this.qrSessions.get(sessionId);
    if (!state) return;

    state.status = 'error';
    if (msg.includes('AUTH_USER_CANCEL') || msg.includes('USER_CANCEL')) {
      state.error = 'Вход отменён на устройстве. Отсканируйте QR-код снова и нажмите «Войти» (не «Отмена»).';
    } else if (msg.toLowerCase().includes('password') || msg.includes('2FA')) {
      state.error = 'Для этого аккаунта включена 2FA. Войдите по номеру телефона или отключите пароль в Telegram.';
    } else {
      state.error = msg;
    }
    this.persistQrState(sessionId);
  }

  private persistQrState(sessionId: string): void {
    const full = this.qrSessions.get(sessionId);
    if (!full) return;
    const payload: QrLoginState = {
      status: full.status,
      loginTokenUrl: full.loginTokenUrl,
      expiresAt: full.expiresAt,
      accountId: full.accountId,
      error: full.error,
      passwordHint: full.passwordHint,
    };
    this.redis.set(QR_REDIS_PREFIX + sessionId, payload, QR_REDIS_TTL).catch((err) => {
      this.log.error({ message: 'Failed to persist QR state to Redis', error: String(err) });
    });
  }
}
