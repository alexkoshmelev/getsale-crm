// @ts-nocheck — GramJS types are incomplete
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { buildTelegramProxy, buildGramJsClientOptions } from './helpers';
import type { TelegramManagerDeps, TelegramClientInfo, ProxyConfig, StructuredLog } from './types';
import type { ConnectionManager } from './connection-manager';
import type { SessionManager } from './session-manager';
import type { EventHandlerSetup } from './event-handlers';
import type { Pool } from 'pg';

/**
 * Handles phone-code-based authentication (sendCode, signIn, signInWithPassword).
 */
export class AuthHandler {
  private readonly pool: Pool;
  private readonly log: StructuredLog;
  private readonly clients: Map<string, TelegramClientInfo>;
  private connectionManager!: ConnectionManager;
  private sessionManager!: SessionManager;
  private eventHandlerSetup!: EventHandlerSetup;

  constructor(private readonly deps: TelegramManagerDeps) {
    this.pool = deps.pool;
    this.log = deps.log;
    this.clients = deps.clients;
  }

  setConnectionManager(cm: ConnectionManager): void { this.connectionManager = cm; }
  setSessionManager(sm: SessionManager): void { this.sessionManager = sm; }
  setEventHandlerSetup(ehs: EventHandlerSetup): void { this.eventHandlerSetup = ehs; }

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
        await this.connectionManager.disconnectAccount(accountId);
      }

      const proxy = buildTelegramProxy(proxyConfigRaw);
      this.log.info({
        message: `Connecting client for sending code to ${phoneNumber}`,
        hasProxy: !!proxy,
        proxyHost: proxy?.ip as string | undefined,
        proxyPort: proxy?.port as number | undefined,
      });
      const session = new StringSession('');
      const client = new TelegramClient(session, apiId, apiHash, buildGramJsClientOptions(proxy));

      try {
        await client.connect();
        this.log.info({ message: `Connected client for sending code to ${phoneNumber}` });
      } catch (error: any) {
        this.log.error({ message: `Connection error for ${phoneNumber}`, error: error.message });
        throw error;
      }

      const result = await client.invoke(
        new Api.auth.SendCode({
          phoneNumber,
          apiId,
          apiHash,
          settings: new Api.CodeSettings({}),
        })
      );

      const phoneCodeHash = (result as Api.auth.SentCode).phoneCodeHash;

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
      await this.connectionManager.updateAccountStatus(accountId, 'error', error.message || 'Failed to send code');
      throw error;
    }
  }

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
        if (error.errorMessage === 'PHONE_CODE_INVALID') {
          throw new Error('Неверный код подтверждения. Пожалуйста, запросите новый код.');
        }
        if (error.errorMessage === 'PHONE_CODE_EXPIRED') {
          throw new Error('Код подтверждения истек. Пожалуйста, запросите новый код.');
        }
        if (error.errorMessage === 'PHONE_NUMBER_INVALID') {
          throw new Error('Неверный номер телефона.');
        }
        if (error.errorMessage === 'SESSION_PASSWORD_NEEDED' || error.code === 401) {
          return { requiresPassword: true };
        }
        throw error;
      }

      if (result instanceof Api.auth.AuthorizationSignUpRequired) {
        throw new Error('Account not found. Please sign up first.');
      }

      const auth = result as Api.auth.Authorization;
      const user = auth.user as Api.User;

      clientInfo.isConnected = true;
      clientInfo.phoneNumber = phoneNumber;

      this.eventHandlerSetup.setupEventHandlers(client, accountId, clientInfo.organizationId);

      await this.sessionManager.saveSession(accountId, client);

      await this.pool.query(
        'UPDATE bd_accounts SET telegram_id = $1, connected_at = NOW(), last_activity = NOW(), is_active = true WHERE id = $2',
        [String(user.id), accountId]
      );

      await this.sessionManager.saveAccountProfile(accountId, client);
      await this.connectionManager.updateAccountStatus(accountId, 'connected', 'Successfully signed in');

      return { requiresPassword: false };
    } catch (error: any) {
      this.log.error({ message: `Error signing in account ${accountId}`, error: error?.message || String(error) });
      await this.connectionManager.updateAccountStatus(accountId, 'error', error.message || 'Sign in failed');
      throw error;
    }
  }

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

      const passwordResult = await client.invoke(new Api.account.GetPassword());

      const { computeCheck } = await import('telegram/Password');
      const passwordCheck = await computeCheck(passwordResult, password);

      const result = await client.invoke(
        new Api.auth.CheckPassword({
          password: passwordCheck,
        })
      );

      const auth = result as Api.auth.Authorization;
      const user = auth.user as Api.User;

      clientInfo.isConnected = true;

      this.eventHandlerSetup.setupEventHandlers(client, accountId, clientInfo.organizationId);

      await this.sessionManager.saveSession(accountId, client);

      await this.pool.query(
        'UPDATE bd_accounts SET telegram_id = $1, connected_at = NOW(), last_activity = NOW(), is_active = true WHERE id = $2',
        [String(user.id), accountId]
      );

      await this.sessionManager.saveAccountProfile(accountId, client);
      await this.connectionManager.updateAccountStatus(accountId, 'connected', 'Successfully signed in with password');
    } catch (error: any) {
      this.log.error({ message: `Error signing in with password for account ${accountId}`, error: error?.message || String(error) });
      await this.connectionManager.updateAccountStatus(accountId, 'error', error.message || 'Password sign in failed');
      throw error;
    }
  }
}
