// @ts-nocheck — GramJS types are incomplete
import { TelegramClient, Api } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { decryptIfNeeded } from '../crypto';
import { getErrorMessage } from '../helpers';
import { buildTelegramProxy, buildGramJsClientOptions, killTelegramClient } from './helpers';
import type { TelegramManagerDeps, TelegramClientInfo, ProxyConfig, StructuredLog } from './types';
import type { SessionManager } from './session-manager';
import type { EventHandlerSetup } from './event-handlers';
import type { Pool } from 'pg';
import type { RedisClient } from '@getsale/utils';

/** Distributed lock constants */
const LOCK_KEY_PREFIX = 'bd-account-lock:';
const LOCK_TTL_SEC = 45;
const LOCK_HEARTBEAT_SEC = 20;

export class ConnectionManager {
  private readonly pool: Pool;
  private readonly log: StructuredLog;
  private readonly redis: RedisClient | null;
  private readonly clients: Map<string, TelegramClientInfo>;
  private readonly instanceId: string;
  private readonly reconnectIntervals: Map<string, NodeJS.Timeout>;
  private readonly updateKeepaliveIntervals: Map<string, NodeJS.Timeout>;
  private readonly lockHeartbeatIntervals: Map<string, NodeJS.Timeout>;
  private readonly dialogFiltersCache: Map<string, { ts: number; filters: unknown[] }>;
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly CLEANUP_INTERVAL = 60000;
  private readonly MAX_RECONNECT_ATTEMPTS = 5;
  private readonly RECONNECT_DELAY = 5000;
  /** How often to invoke updates.GetState to beat SOCKS5/firewall idle timeouts (default 15s). */
  private readonly UPDATE_KEEPALIVE_MS =
    parseInt(String(process.env.TELEGRAM_KEEPALIVE_INTERVAL_MS || '').trim(), 10) || 15_000;
  private reconnectAllTimeout: NodeJS.Timeout | null = null;
  private readonly RECONNECT_ALL_DEBOUNCE_MS = 12000;
  private readonly reconnectAfterTimeoutTimeouts = new Map<string, NodeJS.Timeout>();
  private readonly RECONNECT_AFTER_TIMEOUT_DEBOUNCE_MS = 8000;
  /** Coalesce concurrent connectAccount calls per account in-process. */
  private readonly connectingNow = new Map<string, Promise<TelegramClient>>();
  /** Keepalive GetState failures before app-level reconnect (lets GramJS autoReconnect handle blips). */
  private readonly keepaliveFailureCount = new Map<string, number>();
  private readonly KEEPALIVE_FAILURES_BEFORE_ESCALATE = 3;

  private sessionManager!: SessionManager;
  private eventHandlerSetup!: EventHandlerSetup;

  constructor(private readonly deps: TelegramManagerDeps) {
    this.pool = deps.pool;
    this.log = deps.log;
    this.redis = deps.redis;
    this.clients = deps.clients;
    this.instanceId = deps.instanceId;
    this.reconnectIntervals = deps.reconnectIntervals;
    this.updateKeepaliveIntervals = deps.updateKeepaliveIntervals;
    this.lockHeartbeatIntervals = deps.lockHeartbeatIntervals;
    this.dialogFiltersCache = deps.dialogFiltersCache;
  }

  private getFatalAuthCode(message: string): string | null {
    const msg = String(message || '').toUpperCase();
    const fatalCodes = [
      'AUTH_KEY_UNREGISTERED',
      'AUTH_KEY_DUPLICATED',
      'SESSION_REVOKED',
      'AUTH_KEY_INVALID',
      'USER_DEACTIVATED',
      'PHONE_NUMBER_BANNED',
    ];
    for (const code of fatalCodes) {
      if (msg.includes(code)) return code;
    }
    return null;
  }

  private async markReauthRequired(accountId: string, errorMessage: string): Promise<void> {
    const code = this.getFatalAuthCode(errorMessage) ?? 'AUTH_SESSION_INVALID';
    await this.pool.query(
      `UPDATE bd_accounts
       SET connection_state = 'reauth_required',
           disconnect_reason = $2,
           last_error_code = $3,
           last_error_at = NOW(),
           is_active = false,
           updated_at = NOW()
       WHERE id = $1`,
      [accountId, errorMessage.slice(0, 2000), code]
    );
    await this.updateAccountStatus(accountId, 'error', `${code}: ${errorMessage}`);
    await this.disconnectAccount(accountId);
  }

  private async setConnectionState(
    accountId: string,
    state: 'connected' | 'reconnecting' | 'disconnected'
  ): Promise<void> {
    await this.pool.query(
      `UPDATE bd_accounts
       SET connection_state = $2::varchar,
           disconnect_reason = CASE WHEN $2::text = 'connected' THEN NULL ELSE disconnect_reason END,
           last_error_code = CASE WHEN $2::text = 'connected' THEN NULL ELSE last_error_code END,
           updated_at = NOW()
       WHERE id = $1`,
      [accountId, state]
    );
  }

  setSessionManager(sm: SessionManager): void { this.sessionManager = sm; }
  setEventHandlerSetup(ehs: EventHandlerSetup): void { this.eventHandlerSetup = ehs; }

  private async handleClientRuntimeError(accountId: string, err: unknown): Promise<void> {
    const msg = getErrorMessage(err);
    const fatalCode = this.getFatalAuthCode(msg);
    if (fatalCode) {
      this.log.error({ message: 'Fatal Telegram auth error, reauth required', accountId, fatalCode, error: msg });
      await this.markReauthRequired(accountId, msg);
      return;
    }
    if (msg === 'TIMEOUT' || msg.includes('TIMEOUT')) {
      this.log.warn({ message: 'Telegram client runtime TIMEOUT, scheduling reconnect', accountId });
      this.scheduleReconnectAfterTimeout(accountId);
      return;
    }
    this.log.warn({ message: 'Telegram runtime warning (scheduling debounced reconnect)', accountId, error: msg });
    this.scheduleReconnectAfterTimeout(accountId);
  }

  // --- Distributed locking ---
  private lockKey(accountId: string): string {
    return LOCK_KEY_PREFIX + accountId;
  }

  private get redisHasLockSupport(): boolean {
    return !!(
      this.redis &&
      typeof (this.redis as { tryLock?: unknown }).tryLock === 'function' &&
      typeof (this.redis as { refreshLock?: unknown }).refreshLock === 'function'
    );
  }

  async acquireLock(accountId: string): Promise<boolean> {
    if (!this.redisHasLockSupport) return true;
    const key = this.lockKey(accountId);
    const ok = await this.redis!.tryLock(key, this.instanceId, LOCK_TTL_SEC);
    if (!ok) this.log.warn({ message: `Could not acquire lock for account ${accountId} (owned by another instance)` });
    return ok;
  }

  async releaseLock(accountId: string): Promise<void> {
    if (!this.redis || !this.redisHasLockSupport) return;
    await this.redis.del(this.lockKey(accountId));
  }

  startLockHeartbeat(accountId: string, lockValue: string): void {
    this.stopLockHeartbeat(accountId);
    if (!this.redisHasLockSupport) return;
    const key = this.lockKey(accountId);
    const interval = setInterval(async () => {
      if (!this.redis) return;
      const refreshed = await this.redis.refreshLock(key, lockValue, LOCK_TTL_SEC);
      if (!refreshed) {
        this.log.warn({ message: `Lock lost for account ${accountId}, stopping heartbeat` });
        this.stopLockHeartbeat(accountId);
      }
    }, LOCK_HEARTBEAT_SEC * 1000);
    this.lockHeartbeatIntervals.set(accountId, interval);
  }

  stopLockHeartbeat(accountId: string): void {
    const interval = this.lockHeartbeatIntervals.get(accountId);
    if (interval) {
      clearInterval(interval);
      this.lockHeartbeatIntervals.delete(accountId);
    }
  }

  // --- Keepalive ---
  startUpdateKeepalive(accountId: string, client: TelegramClient): void {
    this.stopUpdateKeepalive(accountId);
    this.keepaliveFailureCount.delete(accountId);
    const interval = setInterval(async () => {
      const info = this.clients.get(accountId);
      if (!info?.client?.connected) return;
      try {
        await client.invoke(new Api.updates.GetState());
        this.keepaliveFailureCount.delete(accountId);
      } catch (e: unknown) {
        const msg = getErrorMessage(e);
        const fatalCode = this.getFatalAuthCode(msg);
        if (fatalCode) {
          this.log.error({ message: 'Fatal Telegram auth error during keepalive', accountId, fatalCode, error: msg });
          await this.markReauthRequired(accountId, msg);
          return;
        }
        const n = (this.keepaliveFailureCount.get(accountId) ?? 0) + 1;
        this.keepaliveFailureCount.set(accountId, n);
        if (n >= this.KEEPALIVE_FAILURES_BEFORE_ESCALATE) {
          this.keepaliveFailureCount.delete(accountId);
          await this.handleClientRuntimeError(accountId, e);
        } else {
          this.log.warn({
            message: 'Keepalive failed; deferring app-level reconnect for GramJS autoReconnect',
            accountId,
            attempt: n,
            error: msg,
          });
        }
      }
    }, this.UPDATE_KEEPALIVE_MS);
    this.updateKeepaliveIntervals.set(accountId, interval);
  }

  stopUpdateKeepalive(accountId: string): void {
    const interval = this.updateKeepaliveIntervals.get(accountId);
    if (interval) {
      clearInterval(interval);
      this.updateKeepaliveIntervals.delete(accountId);
    }
    this.keepaliveFailureCount.delete(accountId);
  }

  // --- Connect / Disconnect ---
  async connectAccount(
    accountId: string,
    organizationId: string,
    userId: string,
    phoneNumber: string,
    apiId: number,
    apiHash: string,
    sessionString?: string
  ): Promise<TelegramClient> {
    if (this.clients.has(accountId)) {
      const existing = this.clients.get(accountId)!;
      if (existing.isConnected) {
        return existing.client;
      }
    }

    const inflight = this.connectingNow.get(accountId);
    if (inflight) return inflight;

    const promise = this.runConnectAccount(
      accountId,
      organizationId,
      userId,
      phoneNumber,
      apiId,
      apiHash,
      sessionString
    );
    this.connectingNow.set(accountId, promise);
    try {
      return await promise;
    } finally {
      this.connectingNow.delete(accountId);
    }
  }

  private async runConnectAccount(
    accountId: string,
    organizationId: string,
    userId: string,
    phoneNumber: string,
    apiId: number,
    apiHash: string,
    sessionString?: string
  ): Promise<TelegramClient> {
    try {
      this.stopUpdateKeepalive(accountId);
      this.keepaliveFailureCount.delete(accountId);
      if (this.clients.has(accountId)) {
        const existing = this.clients.get(accountId)!;
        if (existing.isConnected) {
          return existing.client;
        }
        await this.disconnectAccount(accountId);
      }

      const activeCheck = await this.pool.query('SELECT is_active FROM bd_accounts WHERE id = $1', [accountId]);
      if (activeCheck.rows.length === 0 || !activeCheck.rows[0].is_active) {
        throw new Error('Account is not active');
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
      this.log.info({
        message: `Connecting account ${accountId}`,
        hasProxy: !!proxy,
        proxyHost: proxy?.ip as string | undefined,
        proxyPort: proxy?.port as number | undefined,
      });
      const client = new TelegramClient(session, apiId, apiHash, buildGramJsClientOptions(proxy));

      await client.connect();
      this.log.info({ message: `Connected account ${accountId} (${phoneNumber})` });

      try {
        await client.getMe();
        this.log.info({ message: `Session verified for account ${accountId}` });
      } catch (error: unknown) {
        this.log.error({ message: `Session invalid for account ${accountId}`, error: getErrorMessage(error) });
        killTelegramClient(client);
        await client.destroy().catch(() => {});
        throw new Error('Invalid session. Please reconnect the account.');
      }

      this.eventHandlerSetup.setupEventHandlers(client, accountId, organizationId);
      this.log.info({ message: `Event handlers registered for account ${accountId}` });

      await this.sessionManager.saveSession(accountId, client);
      await this.sessionManager.saveAccountProfile(accountId, client);

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
      this.startUpdateKeepalive(accountId, client);
      await this.setConnectionState(accountId, 'connected');
      await this.updateAccountStatus(accountId, 'connected', 'Successfully connected');

      return client;
    } catch (error: unknown) {
      if (!this.clients.has(accountId)) await this.releaseLock(accountId);
      const msg = getErrorMessage(error);
      this.log.error({ message: `Error connecting account ${accountId}`, error: msg });
      const fatalCode = this.getFatalAuthCode(msg);
      if (fatalCode) {
        await this.markReauthRequired(accountId, msg);
      } else {
        await this.updateAccountStatus(accountId, 'error', msg || 'Connection failed');
      }
      throw error;
    }
  }

  async disconnectAccount(accountId: string): Promise<void> {
    const pendingReconnect = this.reconnectAfterTimeoutTimeouts.get(accountId);
    if (pendingReconnect) {
      clearTimeout(pendingReconnect);
      this.reconnectAfterTimeoutTimeouts.delete(accountId);
    }
    this.stopUpdateKeepalive(accountId);
    this.stopLockHeartbeat(accountId);
    const clientInfo = this.clients.get(accountId);
    if (clientInfo) {
      const client = clientInfo.client;
      killTelegramClient(client);
      try {
        await client.destroy();
      } catch (error: unknown) {
        this.log.error({ message: `Error destroying Telegram client for account ${accountId}`, error: getErrorMessage(error) });
      }
      setTimeout(() => {
        killTelegramClient(client);
      }, 3000);
      this.clients.delete(accountId);
      this.dialogFiltersCache.delete(accountId);

      const interval = this.reconnectIntervals.get(accountId);
      if (interval) {
        clearTimeout(interval);
        this.reconnectIntervals.delete(accountId);
      }
    }
    try {
      await this.releaseLock(accountId);
    } catch (error: unknown) {
      this.log.warn({ message: `Failed to release lock for account ${accountId} (proceeding)`, error: getErrorMessage(error) });
    }
    await this.setConnectionState(accountId, 'disconnected');
  }

  async updateAccountStatus(accountId: string, status: string, message?: string): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO bd_account_status (account_id, status, message) VALUES ($1, $2, $3)`,
        [accountId, status, message || '']
      );
    } catch (error: unknown) {
      this.log.error({ message: `Error updating account status`, error: getErrorMessage(error) });
    }
  }

  getClientInfo(accountId: string): TelegramClientInfo | undefined {
    return this.clients.get(accountId);
  }

  isConnected(accountId: string): boolean {
    const clientInfo = this.clients.get(accountId);
    return clientInfo?.isConnected || false;
  }

  // --- Reconnect ---
  scheduleReconnectAfterTimeout(accountId: string): void {
    this.pool.query('SELECT connection_state, is_active FROM bd_accounts WHERE id = $1', [accountId]).then((r) => {
      const s = r.rows[0] as { connection_state?: string; is_active?: boolean } | undefined;
      if (!s || s.connection_state === 'reauth_required' || s.is_active === false) return;
      const existing = this.reconnectAfterTimeoutTimeouts.get(accountId);
      if (existing) {
        clearTimeout(existing);
        this.reconnectAfterTimeoutTimeouts.delete(accountId);
      }
      const timeout = setTimeout(() => {
        this.reconnectAfterTimeoutTimeouts.delete(accountId);
        if (!this.clients.has(accountId)) return;
        this.reconnectOneAccountAfterTimeout(accountId).catch((err) => {
          this.log.error({ message: 'reconnectOneAccountAfterTimeout failed', accountId, error: String(err) });
        });
      }, this.RECONNECT_AFTER_TIMEOUT_DEBOUNCE_MS);
      this.reconnectAfterTimeoutTimeouts.set(accountId, timeout);
      this.log.info({ message: 'TIMEOUT from update loop — scheduled reconnect of account in N s', accountId, debounceSec: this.RECONNECT_AFTER_TIMEOUT_DEBOUNCE_MS / 1000 });
    }).catch(() => {});
  }

  private async reconnectOneAccountAfterTimeout(accountId: string): Promise<void> {
    const info = this.clients.get(accountId);
    if (!info) return;
    try {
      const row = await this.pool.query(
        'SELECT organization_id, phone_number, api_id, api_hash, session_string, session_encrypted FROM bd_accounts WHERE id = $1',
        [accountId]
      );
      if (row.rows.length === 0 || !row.rows[0].session_string) return;
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
    } catch (err: unknown) {
      this.log.error({ message: '[TelegramManager] Reconnect after TIMEOUT failed for account', accountId, error: getErrorMessage(err) });
    }
  }

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
      } catch (err: unknown) {
        this.log.error('[TelegramManager] Reconnect failed for account', accountId, getErrorMessage(err));
      }
    }
  }

  scheduleReconnect(accountId: string): void {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo) return;
    this.pool.query('SELECT connection_state, is_active FROM bd_accounts WHERE id = $1', [accountId]).then((r) => {
      const s = r.rows[0] as { connection_state?: string; is_active?: boolean } | undefined;
      if (!s || s.connection_state === 'reauth_required' || s.is_active === false) return;
      this.setConnectionState(accountId, 'reconnecting').catch(() => {});

      if (clientInfo.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
        this.log.error({ message: `Max reconnect attempts reached for ${accountId}` });
        this.updateAccountStatus(accountId, 'error', 'Max reconnect attempts reached');
        return;
      }

      const existing = this.reconnectIntervals.get(accountId);
      if (existing) {
        clearTimeout(existing);
      }

      const interval = setTimeout(async () => {
      if (!this.clients.has(accountId)) return;
      try {
        clientInfo.reconnectAttempts++;
        this.log.info({ message: `Attempting to reconnect account ${accountId} (attempt ${clientInfo.reconnectAttempts})` });

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

        clientInfo.reconnectAttempts = 0;
        this.reconnectIntervals.delete(accountId);
        } catch (error: unknown) {
          const msg = getErrorMessage(error);
          const fatalCode = this.getFatalAuthCode(msg);
          if (fatalCode) {
            await this.markReauthRequired(accountId, msg);
            return;
          }
          this.log.error({ message: `Reconnection failed for ${accountId}`, error: msg });
          this.scheduleReconnect(accountId);
        }
      }, this.RECONNECT_DELAY);

      this.reconnectIntervals.set(accountId, interval);
    }).catch(() => {});
  }

  // --- Lifecycle ---
  async initializeActiveAccounts(): Promise<void> {
    try {
      const result = await this.pool.query(
        `SELECT id, organization_id, phone_number, api_id, api_hash, session_string, session_encrypted
         FROM bd_accounts
         WHERE is_active = true AND (is_demo IS NOT TRUE) AND session_string IS NOT NULL AND session_string != '' AND COALESCE(connection_state, '') != 'reauth_required'`
      );

      for (const account of result.rows) {
        try {
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
        } catch (error: unknown) {
          this.log.error({ message: `Failed to initialize account ${account.id}`, error: getErrorMessage(error) });
        }
      }
    } catch (error) {
      this.log.error({ message: "Error initializing active accounts", error: String(error) });
    }
  }

  startCleanupInterval(): void {
    this.cleanupInterval = setInterval(async () => {
      try {
        await this.cleanupInactiveClients();
      } catch (error) {
        this.log.error({ message: "Error during cleanup", error: String(error) });
      }
    }, this.CLEANUP_INTERVAL);
  }

  private async cleanupInactiveClients(): Promise<void> {
    const accountIds = Array.from(this.clients.keys());
    if (accountIds.length === 0) return;

    try {
      const result = await this.pool.query(
        `SELECT id FROM bd_accounts WHERE id = ANY($1::uuid[]) AND is_active = true`,
        [accountIds]
      );

      const activeAccountIds = new Set(result.rows.map((row: { id: string }) => row.id));

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

  stopCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }
}
