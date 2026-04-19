// @ts-nocheck
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { RabbitMQClient } from '@getsale/queue';
import { EventType, type Event } from '@getsale/events';
import { encryptSession, buildTelegramProxy, buildGramJsClientOptions, destroyTelegramClient } from '@getsale/telegram';

const AUTH_TIMEOUT_MS = 300_000; // 5 minutes

interface PendingPhoneAuth {
  client: TelegramClient;
  organizationId: string;
  userId: string;
  phoneNumber: string;
  phoneCodeHash: string;
  accountId?: string;
}

export class PhoneLoginHandler {
  private pendingAuths = new Map<string, PendingPhoneAuth>();

  constructor(
    private pool: Pool,
    private rabbitmq: RabbitMQClient,
    private log: Logger,
    private apiId: number,
    private apiHash: string,
    private onAccountCreated?: (accountId: string, organizationId: string, userId: string) => Promise<void>,
  ) {}

  async sendCode(params: {
    phoneNumber: string;
    organizationId: string;
    userId: string;
    proxyConfig?: { host: string; port: number; username?: string; password?: string } | null;
    apiId?: number;
    apiHash?: string;
  }): Promise<{ phoneCodeHash: string; accountId: string }> {
    const { phoneNumber, organizationId, userId, proxyConfig } = params;
    const apiId = params.apiId || this.apiId;
    const apiHash = params.apiHash || this.apiHash;

    const accountId = await this.findOrCreateAccount(organizationId, phoneNumber, apiId, apiHash, userId);

    await this.cleanupPendingAuth(accountId);

    const proxy = buildTelegramProxy(proxyConfig as any);
    const session = new StringSession('');
    const client = new TelegramClient(session, apiId, apiHash, buildGramJsClientOptions(proxy));

    await client.connect();

    const result = await client.invoke(
      new Api.auth.SendCode({
        phoneNumber,
        apiId,
        apiHash,
        settings: new Api.CodeSettings({}),
      }),
    );

    const phoneCodeHash = (result as Api.auth.SentCode).phoneCodeHash;

    this.pendingAuths.set(accountId, {
      client,
      organizationId,
      userId,
      phoneNumber,
      phoneCodeHash,
      accountId,
    });

    this.scheduleAuthTimeout(accountId, phoneCodeHash);

    return { phoneCodeHash, accountId };
  }

  async verifyCode(params: {
    accountId: string;
    phoneNumber: string;
    phoneCode: string;
    phoneCodeHash: string;
    password?: string;
  }): Promise<{ success: boolean; requiresPassword?: boolean; accountId: string }> {
    const { accountId, phoneNumber, phoneCode, phoneCodeHash, password } = params;

    const pending = this.pendingAuths.get(accountId);
    if (!pending) {
      throw new Error('No pending authentication. Please send code first.');
    }

    const client = pending.client;

    try {
      if (password) {
        await this.authenticateWithPassword(client, password);
      } else {
        const needsPassword = await this.authenticateWithCode(client, phoneNumber, phoneCode, phoneCodeHash);
        if (needsPassword) {
          return { success: false, requiresPassword: true, accountId };
        }
      }

      await this.finalizeAuth(client, accountId, pending);
      return { success: true, accountId };
    } catch (error: any) {
      this.log.error({ message: 'Phone auth verify failed', error: error?.message });
      throw error;
    }
  }

  async cleanup(): Promise<void> {
    for (const [, pending] of this.pendingAuths) {
      try { await destroyTelegramClient(pending.client); } catch { /* best-effort */ }
    }
    this.pendingAuths.clear();
  }

  // --- private helpers ---

  private async findOrCreateAccount(
    organizationId: string,
    phoneNumber: string,
    apiId: number,
    apiHash: string,
    userId: string,
  ): Promise<string> {
    const existing = await this.pool.query(
      `SELECT id FROM bd_accounts WHERE organization_id = $1 AND phone_number = $2`,
      [organizationId, phoneNumber],
    );

    if (existing.rows.length > 0) {
      return existing.rows[0].id;
    }

    const ins = await this.pool.query(
      `INSERT INTO bd_accounts (organization_id, phone_number, api_id, api_hash, is_active, session_encrypted, created_by_user_id, connection_state)
       VALUES ($1, $2, $3, $4, false, true, $5, 'authenticating') RETURNING id`,
      [organizationId, phoneNumber, String(apiId), encryptSession(apiHash), userId],
    );
    return ins.rows[0].id;
  }

  private async cleanupPendingAuth(accountId: string): Promise<void> {
    const prev = this.pendingAuths.get(accountId);
    if (prev) {
      try { await destroyTelegramClient(prev.client); } catch { /* best-effort */ }
      this.pendingAuths.delete(accountId);
    }
  }

  private scheduleAuthTimeout(accountId: string, phoneCodeHash: string): void {
    setTimeout(() => {
      const pending = this.pendingAuths.get(accountId);
      if (pending && pending.phoneCodeHash === phoneCodeHash) {
        destroyTelegramClient(pending.client).catch(() => {});
        this.pendingAuths.delete(accountId);
      }
    }, AUTH_TIMEOUT_MS);
  }

  private async authenticateWithCode(
    client: TelegramClient,
    phoneNumber: string,
    phoneCode: string,
    phoneCodeHash: string,
  ): Promise<boolean> {
    try {
      await client.invoke(
        new Api.auth.SignIn({ phoneNumber, phoneCodeHash, phoneCode }),
      );
      return false;
    } catch (error: any) {
      if (error.errorMessage === 'PHONE_CODE_INVALID') {
        throw new Error('Invalid verification code.');
      }
      if (error.errorMessage === 'PHONE_CODE_EXPIRED') {
        throw new Error('Verification code expired. Please request a new one.');
      }
      if (error.errorMessage === 'SESSION_PASSWORD_NEEDED' || error.code === 401) {
        return true;
      }
      throw error;
    }
  }

  private async authenticateWithPassword(client: TelegramClient, password: string): Promise<void> {
    const passwordResult = await client.invoke(new Api.account.GetPassword());
    const { computeCheck } = await import('telegram/Password');
    const passwordCheck = await computeCheck(passwordResult, password);
    await client.invoke(new Api.auth.CheckPassword({ password: passwordCheck }));
  }

  private async finalizeAuth(client: TelegramClient, accountId: string, pending: PendingPhoneAuth): Promise<void> {
    const me = await client.getMe();
    const telegramId = String(me?.id ?? '');
    const sessionString = client.session.save() as string;

    await this.pool.query(
      `UPDATE bd_accounts SET
        telegram_id = $1, session_string = $2, session_encrypted = true,
        is_active = true, connection_state = 'connected',
        connected_at = NOW(), last_activity = NOW(),
        username = $3, first_name = $4, last_name = $5
      WHERE id = $6`,
      [
        telegramId,
        encryptSession(sessionString),
        (me as any)?.username || null,
        (me as any)?.firstName || null,
        (me as any)?.lastName || null,
        accountId,
      ],
    );

    await destroyTelegramClient(client);
    this.pendingAuths.delete(accountId);

    if (this.onAccountCreated) {
      await this.onAccountCreated(accountId, pending.organizationId, pending.userId);
    }

    await this.rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.BD_ACCOUNT_CONNECTED,
      timestamp: new Date(),
      organizationId: pending.organizationId,
      userId: pending.userId,
      data: { bdAccountId: accountId, platform: 'telegram' },
    } as unknown as Event);
  }
}
