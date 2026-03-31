import { Router } from 'express';
import { Pool } from 'pg';
import { Counter } from 'prom-client';
import { RabbitMQClient } from '@getsale/utils';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, canPermission, validate, withOrgContext, ServiceHttpClient } from '@getsale/service-core';
import { TelegramManager } from '../telegram';
import {
  requireAccountOwner,
  requireBidiOwnAccount,
  getAccountOr404,
  bdAccountsListScope,
  assertBdAccountsNotViewer,
} from '../helpers';
import { decryptIfNeeded } from '../crypto';
import {
  BdAccountPurchaseSchema,
  BdAccountEnrichContactsSchema,
  BdAccountPatchSchema,
  BdAccountConfigSchema,
} from '../validation';

/** Columns returned by GET /:id and PATCH /:id (keep in sync with list when adding fields). */
const BD_ACCOUNT_DETAIL_SELECT =
  'id, organization_id, telegram_id, phone_number, is_active, is_demo, connected_at, last_activity, created_at, sync_status, sync_progress_done, sync_progress_total, sync_error, created_by_user_id AS owner_id, first_name, last_name, username, bio, photo_file_id, display_name, proxy_config, connection_state, disconnect_reason, last_error_code, last_error_at, flood_wait_until, flood_wait_seconds, flood_reason, flood_last_at, timezone, working_hours_start, working_hours_end, working_days, auto_responder_enabled, auto_responder_system_prompt, auto_responder_history_count';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  telegramManager: TelegramManager;
  messagingClient: ServiceHttpClient;
  messagingOrphanFallbackTotal: Counter;
}

export function accountsRouter({
  pool,
  rabbitmq,
  log,
  telegramManager,
  messagingClient,
  messagingOrphanFallbackTotal,
}: Deps): Router {
  const router = Router();
  const checkPermission = canPermission(pool);
  const withProxyStatus = (
    row: Record<string, unknown>,
    isConnected: boolean
  ): Record<string, unknown> => {
    const cfg = row.proxy_config;
    const hasProxy = cfg != null && typeof cfg === 'object';
    const lastStatus = typeof row.last_status === 'string' ? row.last_status.toLowerCase() : '';
    const lastMessage = typeof row.last_status_message === 'string' ? row.last_status_message : '';
    const proxyError = hasProxy && (lastStatus === 'error') && /proxy|socks|http proxy|connection refused|timed out/i.test(lastMessage);
    return {
      ...row,
      proxy_status: !hasProxy ? 'none' : proxyError ? 'error' : isConnected ? 'ok' : 'configured',
      last_proxy_check_at: row.last_status_at ?? null,
      last_proxy_error: proxyError ? lastMessage : null,
    };
  };

  // POST routes with literal paths must be registered before /:id patterns
  router.post('/purchase', validate(BdAccountPurchaseSchema), asyncHandler(async (req, res) => {
    assertBdAccountsNotViewer(req.user);
    const { id: userId, organizationId } = req.user;
    const { platform, durationDays } = req.body;

    const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);

    const row = await withOrgContext(pool, organizationId, async (client) => {
      const result = await client.query(
        `INSERT INTO bd_accounts (organization_id, user_id, platform, account_type, status, purchased_at, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
        [organizationId, userId, platform, 'rented', 'pending', new Date(), expiresAt]
      );
      return result.rows[0];
    });

    res.json(row);
  }));

  router.post('/enrich-contacts', validate(BdAccountEnrichContactsSchema), asyncHandler(async (req, res) => {
    assertBdAccountsNotViewer(req.user);
    const { organizationId } = req.user;
    const { contactIds = [], bdAccountId } = req.body;
    const ids = contactIds;
    const result = await telegramManager.enrichContactsFromTelegram(organizationId, ids, bdAccountId);
    res.json(result);
  }));

  // GET / — list BD accounts with unread counts
  router.get('/', asyncHandler(async (req, res) => {
    const { id: userId, organizationId, role } = req.user;

    if (!organizationId) {
      throw new AppError(401, 'Unauthorized', ErrorCodes.UNAUTHORIZED);
    }

    const scope = bdAccountsListScope(role);
    if (scope === 'none') {
      return res.json([]);
    }

    const listParams: unknown[] = [organizationId];
    let ownerFilter = '';
    if (scope === 'own_only') {
      listParams.push(userId);
      ownerFilter = ` AND a.created_by_user_id = $${listParams.length}`;
    }

    const result = await pool.query(
      `SELECT a.id, a.organization_id, a.telegram_id, a.phone_number, a.is_active, a.is_demo, a.connected_at, a.last_activity,
              a.created_at, a.sync_status, a.sync_progress_done, a.sync_progress_total, a.sync_error,
              a.created_by_user_id AS owner_id,
              a.first_name, a.last_name, a.username, a.bio, a.photo_file_id, a.display_name, a.proxy_config,
              a.connection_state, a.disconnect_reason, a.last_error_code, a.last_error_at,
              a.flood_wait_until, a.flood_wait_seconds, a.flood_reason, a.flood_last_at, a.timezone, a.working_hours_start, a.working_hours_end, a.working_days,
              a.auto_responder_enabled, a.auto_responder_system_prompt, a.auto_responder_history_count,
              s.status AS last_status, s.message AS last_status_message, s.recorded_at AS last_status_at
       FROM bd_accounts a
       LEFT JOIN LATERAL (
         SELECT status, message, recorded_at
         FROM bd_account_status
         WHERE account_id = a.id
         ORDER BY recorded_at DESC
         LIMIT 1
       ) s ON true
       WHERE a.organization_id = $1${ownerFilter} ORDER BY a.created_at DESC`,
      listParams
    );

    const unreadResult = await pool.query(
      `SELECT s.bd_account_id, COALESCE(SUM(sub.cnt), 0)::int AS unread_count
       FROM bd_account_sync_chats s
       JOIN bd_accounts a ON a.id = s.bd_account_id AND a.organization_id = $1
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS cnt
         FROM messages m
         WHERE m.organization_id = a.organization_id AND m.channel = 'telegram' AND m.unread = true
           AND m.bd_account_id = s.bd_account_id AND m.channel_id = s.telegram_chat_id
       ) sub ON true
       WHERE s.peer_type IN ('user', 'chat')
       GROUP BY s.bd_account_id`,
      [organizationId]
    );
    const unreadByAccount: Record<string, number> = {};
    for (const row of unreadResult.rows as { bd_account_id: string; unread_count: number }[]) {
      unreadByAccount[row.bd_account_id] = Number(row.unread_count) || 0;
    }

    interface ListRow { id: string; owner_id?: string | null; [k: string]: unknown }
    const rows = result.rows.map((r: ListRow) => {
      const isConnected = telegramManager.isConnected(r.id);
      const withProxy = withProxyStatus(r as Record<string, unknown>, isConnected);
      return {
        ...withProxy,
        is_owner: r.owner_id != null && r.owner_id === userId,
        unread_count: unreadByAccount[r.id] ?? 0,
      };
    });
    res.json(rows);
  }));

  /** Aggregated BD health for dashboard (campaign counts from same DB). */
  router.get('/health-summary', asyncHandler(async (req, res) => {
    const { organizationId, role } = req.user;
    if (!organizationId) {
      throw new AppError(401, 'Unauthorized', ErrorCodes.UNAUTHORIZED);
    }

    if (bdAccountsListScope(role) === 'none') {
      res.json({
        generatedAt: new Date().toISOString(),
        floodActiveCount: 0,
        limitsConfiguredCount: 0,
        warmingRunningGroups: 0,
        campaigns: { active: 0, paused: 0, draft: 0, completed: 0 },
        riskAccounts: [],
      });
      return;
    }

    const [floodR, limitsR, campR, riskR] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS c FROM bd_accounts
         WHERE organization_id = $1 AND flood_wait_until IS NOT NULL AND flood_wait_until > NOW()`,
        [organizationId]
      ),
      pool.query(
        `SELECT COUNT(*)::int AS c FROM bd_accounts
         WHERE organization_id = $1 AND max_dm_per_day IS NOT NULL AND max_dm_per_day > 0`,
        [organizationId]
      ),
      pool.query(
        `SELECT status, COUNT(*)::int AS c FROM campaigns WHERE organization_id = $1 GROUP BY status`,
        [organizationId]
      ),
      pool.query(
        `SELECT a.id, a.telegram_id, a.display_name, a.first_name, a.last_name, a.username,
                a.flood_wait_until, a.connection_state, a.sync_error,
                s.message AS last_status_message, s.status AS last_status
         FROM bd_accounts a
         LEFT JOIN LATERAL (
           SELECT status, message FROM bd_account_status WHERE account_id = a.id ORDER BY recorded_at DESC LIMIT 1
         ) s ON true
         WHERE a.organization_id = $1
           AND (
             (a.flood_wait_until IS NOT NULL AND a.flood_wait_until > NOW())
             OR (a.connection_state IS NOT NULL AND a.connection_state <> 'connected')
             OR (a.sync_error IS NOT NULL AND TRIM(COALESCE(a.sync_error, '')) <> '')
             OR EXISTS (
               SELECT 1 FROM bd_account_status st
               WHERE st.account_id = a.id
                 AND st.status = 'error'
                 AND (st.message ILIKE '%proxy%' OR st.message ILIKE '%socks%' OR st.message ILIKE '%connection refused%')
             )
           )
         ORDER BY a.created_at DESC
         LIMIT 50`,
        [organizationId]
      ),
    ]);

    let warmingRunningGroups = 0;
    try {
      const warmR = await pool.query(
        `SELECT COUNT(*)::int AS c FROM warming_groups WHERE organization_id = $1 AND status = 'running'`,
        [organizationId]
      );
      warmingRunningGroups = Number((warmR.rows[0] as { c?: number })?.c ?? 0);
    } catch {
      /* table may not exist */
    }

    const campaignCounts: Record<string, number> = {};
    for (const row of campR.rows as { status: string; c: number }[]) {
      campaignCounts[row.status] = row.c;
    }

    res.json({
      generatedAt: new Date().toISOString(),
      floodActiveCount: Number((floodR.rows[0] as { c?: number })?.c ?? 0),
      limitsConfiguredCount: Number((limitsR.rows[0] as { c?: number })?.c ?? 0),
      warmingRunningGroups,
      campaigns: {
        active: campaignCounts.active ?? 0,
        paused: campaignCounts.paused ?? 0,
        draft: campaignCounts.draft ?? 0,
        completed: campaignCounts.completed ?? 0,
      },
      riskAccounts: riskR.rows,
    });
  }));

  // GET /:id — single account
  router.get('/:id', asyncHandler(async (req, res) => {
    const user = req.user;
    assertBdAccountsNotViewer(user);
    const { id: userId, organizationId } = user;
    const { id } = req.params;

    const row = await getAccountOr404<Record<string, unknown> & { owner_id?: string }>(
      pool,
      id,
      organizationId,
      BD_ACCOUNT_DETAIL_SELECT
    );
    await requireBidiOwnAccount(pool, id, user);
    const isConnected = telegramManager.isConnected(id);
    res.json({
      ...withProxyStatus(row as Record<string, unknown>, isConnected),
      is_owner: row.owner_id != null && row.owner_id === userId,
    });
  }));

  // PATCH /:id — update display_name and/or proxy_config
  router.patch('/:id', validate(BdAccountPatchSchema), asyncHandler(async (req, res) => {
    const user = req.user;
    assertBdAccountsNotViewer(user);
    const { id: userId } = req.user;
    const { id } = req.params;
    const body = (req.body ?? {}) as Record<string, unknown>;
    const displayName = body.display_name;
    const proxyConfig = body.proxy_config;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiOwnAccount(pool, id, user);
    const isOwner = await requireAccountOwner(pool, id, user);
    if (!isOwner) {
      throw new AppError(403, 'Only the account owner can update', ErrorCodes.FORBIDDEN);
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (displayName !== undefined) {
      const value = typeof displayName === 'string' ? displayName.trim() || null : null;
      sets.push(`display_name = $${idx++}`);
      params.push(value);
    }

    if (proxyConfig !== undefined) {
      if (proxyConfig === null) {
        sets.push(`proxy_config = $${idx++}`);
        params.push(null);
      } else if (typeof proxyConfig === 'object' && proxyConfig !== null) {
        const pc = proxyConfig as { type?: string; host?: string; port?: number; username?: string; password?: string };
        if (pc.host && pc.port) {
          if (pc.type === 'http') {
            throw new AppError(
              400,
              'HTTP/HTTPS proxy is not supported by current Telegram client. Please use SOCKS5 proxy.',
              ErrorCodes.VALIDATION
            );
          }
          sets.push(`proxy_config = $${idx++}`);
          params.push(JSON.stringify({
            type: 'socks5',
            host: String(pc.host).trim(),
            port: Number(pc.port),
            ...(pc.username ? { username: String(pc.username) } : {}),
            ...(pc.password ? { password: String(pc.password) } : {}),
          }));
        }
      }
    }

    if (body.timezone !== undefined) {
      const v = body.timezone;
      sets.push(`timezone = $${idx++}`);
      params.push(v === null || v === '' ? null : String(v).trim());
    }
    if (body.working_hours_start !== undefined) {
      sets.push(`working_hours_start = $${idx++}`);
      params.push(body.working_hours_start === null || body.working_hours_start === '' ? null : String(body.working_hours_start));
    }
    if (body.working_hours_end !== undefined) {
      sets.push(`working_hours_end = $${idx++}`);
      params.push(body.working_hours_end === null || body.working_hours_end === '' ? null : String(body.working_hours_end));
    }
    if (body.working_days !== undefined) {
      sets.push(`working_days = $${idx++}`);
      params.push(body.working_days === null ? null : body.working_days);
    }
    if (body.auto_responder_enabled !== undefined) {
      sets.push(`auto_responder_enabled = $${idx++}`);
      params.push(Boolean(body.auto_responder_enabled));
    }
    if (body.auto_responder_system_prompt !== undefined) {
      sets.push(`auto_responder_system_prompt = $${idx++}`);
      const p = body.auto_responder_system_prompt;
      params.push(p === null || p === '' ? null : String(p));
    }
    if (body.auto_responder_history_count !== undefined) {
      sets.push(`auto_responder_history_count = $${idx++}`);
      params.push(Number(body.auto_responder_history_count));
    }

    if (sets.length === 0) {
      const row = await getAccountOr404<Record<string, unknown> & { owner_id?: string }>(
        pool, id, user.organizationId, BD_ACCOUNT_DETAIL_SELECT
      );
      const isConnected = telegramManager.isConnected(id);
      return res.json({
        ...withProxyStatus(row as Record<string, unknown>, isConnected),
        is_owner: row.owner_id != null && row.owner_id === userId,
      });
    }

    sets.push('updated_at = NOW()');
    params.push(id, user.organizationId);
    await withOrgContext(pool, user.organizationId, (client) =>
      client.query(
        `UPDATE bd_accounts SET ${sets.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1}`,
        params
      )
    );
    const row = await getAccountOr404<Record<string, unknown> & { owner_id?: string }>(
      pool, id, user.organizationId, BD_ACCOUNT_DETAIL_SELECT
    );
    const isConnected = telegramManager.isConnected(id);
    res.json({
      ...withProxyStatus(row as Record<string, unknown>, isConnected),
      is_owner: row.owner_id != null && row.owner_id === userId,
    });
  }));

  // GET /:id/status
  router.get('/:id/status', asyncHandler(async (req, res) => {
    assertBdAccountsNotViewer(req.user);
    const { organizationId } = req.user;
    const { id } = req.params;

    const result = await pool.query(
      `SELECT a.*, s.status as last_status, s.message, s.recorded_at as checked_at
       FROM bd_accounts a
       LEFT JOIN LATERAL (
         SELECT status, message, recorded_at
         FROM bd_account_status
         WHERE account_id = a.id
         ORDER BY recorded_at DESC
         LIMIT 1
       ) s ON true
       WHERE a.id = $1 AND a.organization_id = $2`,
      [id, organizationId]
    );

    if (result.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    const account = result.rows[0];
    const isConnected = telegramManager.isConnected(id);
    const clientInfo = telegramManager.getClientInfo(id);

    res.json({
      ...account,
      isConnected,
      lastActivity: clientInfo?.lastActivity,
      reconnectAttempts: clientInfo?.reconnectAttempts || 0,
    });
  }));

  // PUT /:id/config
  router.put('/:id/config', validate(BdAccountConfigSchema), asyncHandler(async (req, res) => {
    assertBdAccountsNotViewer(req.user);
    const { organizationId } = req.user;
    const { id } = req.params;
    const { limits, metadata } = req.body;

    const result = await withOrgContext(pool, organizationId, (client) =>
      client.query(
        `UPDATE bd_accounts
         SET limits = $1, metadata = $2, updated_at = NOW()
         WHERE id = $3 AND organization_id = $4
         RETURNING *`,
        [JSON.stringify(limits || {}), JSON.stringify(metadata || {}), id, organizationId]
      )
    );

    if (result.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    res.json(result.rows[0]);
  }));

  // POST /:id/enable — reconnect after disconnect
  router.post('/:id/enable', asyncHandler(async (req, res) => {
    const user = req.user;
    assertBdAccountsNotViewer(user);
    const { id } = req.params;

    const accountResult = await pool.query(
      `SELECT id, organization_id, created_by_user_id, phone_number, api_id, api_hash, session_string, session_encrypted, connection_state
       FROM bd_accounts WHERE id = $1 AND organization_id = $2`,
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiOwnAccount(pool, id, user);
    const isOwner = await requireAccountOwner(pool, id, user);
    const canSettings = await checkPermission(user.role, 'bd_accounts', 'settings');
    if (!isOwner && !canSettings) {
      throw new AppError(403, 'No permission to enable account', ErrorCodes.FORBIDDEN);
    }

    const row = accountResult.rows[0] as Record<string, unknown> & { session_string?: string; api_hash?: string; session_encrypted?: unknown; organization_id?: string; created_by_user_id?: string; phone_number?: string; api_id?: string };
    if (row.connection_state === 'reauth_required') {
      throw new AppError(409, 'Session expired. Please reconnect account via QR or phone login.', ErrorCodes.BAD_REQUEST);
    }
    if (!row.session_string) {
      throw new AppError(400, 'Account has no session; reconnect via QR or phone', ErrorCodes.BAD_REQUEST);
    }

    const isEncrypted = Boolean(row.session_encrypted);
    const apiHash = decryptIfNeeded(String(row.api_hash ?? ''), isEncrypted) || (row.api_hash as string);
    const sessionString = decryptIfNeeded(String(row.session_string ?? ''), isEncrypted) || (row.session_string as string);

    await withOrgContext(pool, user.organizationId, (client) =>
      client.query(
        "UPDATE bd_accounts SET is_active = true, connection_state = 'reconnecting', updated_at = NOW() WHERE id = $1 AND organization_id = $2",
        [id, user.organizationId]
      )
    );

    const orgId = String(row.organization_id ?? user.organizationId ?? '');
    const createdBy = String(row.created_by_user_id ?? user.id ?? '');
    await telegramManager.connectAccount(
      id,
      orgId,
      createdBy,
      row.phone_number ?? '',
      Number(row.api_id) || 0,
      apiHash,
      sessionString
    );

    res.json({ success: true });
  }));

  // DELETE /:id — permanent delete
  router.delete('/:id', asyncHandler(async (req, res) => {
    const user = req.user;
    assertBdAccountsNotViewer(user);
    const { id } = req.params;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiOwnAccount(pool, id, user);
    const isOwner = await requireAccountOwner(pool, id, user);
    const canSettings = await checkPermission(user.role, 'bd_accounts', 'settings');
    if (!isOwner && !canSettings) {
      throw new AppError(403, 'No permission to delete account', ErrorCodes.FORBIDDEN);
    }

    // Mark inactive before disconnect so reconnect logic (TIMEOUT → scheduleReconnectAll) does not re-add this account
    await pool.query(
      'UPDATE bd_accounts SET is_active = false WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    await telegramManager.disconnectAccount(id);

    // S2/A1: orphan messages so FK allows deleting bd_accounts. Prefer messaging-service API; fallback to direct UPDATE when messaging is down (e.g. circuit breaker).
    const orphanOk = await messagingClient.post(
      '/internal/messages/orphan-by-bd-account',
      { bdAccountId: id },
      undefined,
      { organizationId: user.organizationId }
    ).then(() => true).catch((err: unknown) => {
      log.warn({ message: 'Messaging orphan-by-bd-account failed, orphaning messages locally', bdAccountId: id, error: String(err) });
      return false;
    });
    if (!orphanOk) {
      messagingOrphanFallbackTotal.inc();
      await pool.query(
        'UPDATE messages SET bd_account_id = NULL WHERE bd_account_id = $1 AND organization_id = $2',
        [id, user.organizationId]
      );
    }

    await withOrgContext(pool, user.organizationId, async (client) => {
      await client.query('DELETE FROM bd_account_sync_chat_folders WHERE bd_account_id = $1', [id]);
      await client.query('DELETE FROM bd_account_sync_chats WHERE bd_account_id = $1', [id]);
      await client.query('DELETE FROM bd_account_sync_folders WHERE bd_account_id = $1', [id]);
      await client.query('DELETE FROM bd_accounts WHERE id = $1 AND organization_id = $2', [id, user.organizationId]);
    });

    res.json({ success: true });
  }));

  return router;
}
