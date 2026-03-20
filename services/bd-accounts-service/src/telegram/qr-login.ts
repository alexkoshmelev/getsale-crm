// @ts-nocheck — GramJS types are incomplete
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { randomUUID } from 'crypto';
import {
  EventType,
  type Event,
} from '@getsale/events';
import { encryptSession } from '../crypto';
import { getErrorMessage } from '../helpers';
import { buildTelegramProxy } from './helpers';
import type { TelegramManagerDeps, QrLoginState, QrSessionInternal, ProxyConfig, StructuredLog, TelegramClientInfo } from './types';
import type { ConnectionManager } from './connection-manager';
import type { Pool } from 'pg';
import type { RabbitMQClient, RedisClient } from '@getsale/utils';

const QR_REDIS_PREFIX = 'qr:';
const QR_REDIS_TTL = 300;
const QR_PASSWORD_TTL = 120;
const QR_SESSION_TTL_MS = 120000;

export class QrLogin {
  private readonly pool: Pool;
  private readonly rabbitmq: RabbitMQClient;
  private readonly redis: RedisClient | null;
  private readonly log: StructuredLog;
  private readonly qrSessions: Map<string, QrSessionInternal>;
  private connectionManager!: ConnectionManager;

  constructor(private readonly deps: TelegramManagerDeps) {
    this.pool = deps.pool;
    this.rabbitmq = deps.rabbitmq;
    this.redis = deps.redis;
    this.log = deps.log;
    this.qrSessions = deps.qrSessions;
  }

  setConnectionManager(cm: ConnectionManager): void { this.connectionManager = cm; }

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
      proxyConfigRaw: proxyConfigRaw ?? null,
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
                  const p = await this.redis.get<string>(QR_REDIS_PREFIX + sessionId + ':password');
                  if (p != null && typeof p === 'string') {
                    await this.redis.del(QR_REDIS_PREFIX + sessionId + ':password');
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
              return true;
            },
          }
        );

        const state = this.qrSessions.get(sessionId);
        if (!state) return;

        const me = await client.getMe();
        const telegramId = String((me as any).id ?? '');
        const phoneNumber = (me as any).phone ?? `qr-${telegramId}`;
        const sessionString = client.session.save() as string;

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
            `UPDATE bd_accounts SET telegram_id = $1, phone_number = $2, api_id = $3, api_hash = $4, session_string = $5, is_active = true, session_encrypted = true, created_by_user_id = COALESCE(created_by_user_id, $6), proxy_config = COALESCE($8::jsonb, proxy_config) WHERE id = $7`,
            [telegramId, phoneNumber, String(apiId), encryptSession(apiHash), encryptSession(sessionString), userId, accountId, state.proxyConfigRaw ? JSON.stringify(state.proxyConfigRaw) : null]
          );
        } else {
          const insertResult = await this.pool.query(
            `INSERT INTO bd_accounts (organization_id, telegram_id, phone_number, api_id, api_hash, session_string, is_active, session_encrypted, created_by_user_id, proxy_config)
             VALUES ($1, $2, $3, $4, $5, $6, true, true, $7, $8) RETURNING id`,
            [organizationId, telegramId, phoneNumber, String(apiId), encryptSession(apiHash), encryptSession(sessionString), userId, state.proxyConfigRaw ? JSON.stringify(state.proxyConfigRaw) : null]
          );
          accountId = insertResult.rows[0].id;
        }

        await client.disconnect();

        await this.connectionManager.connectAccount(accountId, organizationId, userId, phoneNumber, apiId, apiHash, sessionString);

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
        } catch (err) {
          this.log.debug({ message: 'disconnect after QR error', error: getErrorMessage(err) });
        }
      }
    })();

    return { sessionId };
  }

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
    this.redis.set(QR_REDIS_PREFIX + sessionId, payload, QR_REDIS_TTL).catch((err) => {
      this.log.error({ message: "Failed to persist QR state to Redis", error: String(err) });
    });
  }

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
      const stored = await this.redis.get<QrLoginState>(QR_REDIS_PREFIX + sessionId);
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

  async submitQrLoginPassword(sessionId: string, password: string): Promise<boolean> {
    const full = this.qrSessions.get(sessionId);
    if (full?.passwordResolve) {
      full.passwordResolve(password);
      delete full.passwordResolve;
      this.qrSessions.set(sessionId, full);
      return true;
    }
    if (this.redis) {
      await this.redis.set(QR_REDIS_PREFIX + sessionId + ':password', password, QR_PASSWORD_TTL);
      return true;
    }
    return false;
  }
}
