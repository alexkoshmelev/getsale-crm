import { Router } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { RabbitMQClient } from '@getsale/utils';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, canPermission, validate, withOrgContext, ServiceHttpClient } from '@getsale/service-core';
import { TelegramManager } from '../telegram';
import { requireAccountOwner, requireBidiOwnAccount, getAccountOr404 } from '../helpers';
import { decryptIfNeeded } from '../crypto';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  telegramManager: TelegramManager;
  messagingClient: ServiceHttpClient;
}

export function accountsRouter({ pool, rabbitmq, log, telegramManager, messagingClient }: Deps): Router {
  const router = Router();
  const checkPermission = canPermission(pool);

  const PurchaseSchema = z.object({
    platform: z.string().min(1).max(64),
    durationDays: z.number().int().min(1).max(3650),
  });
  const EnrichContactsSchema = z.object({
    contactIds: z.array(z.string()).optional(),
    bdAccountId: z.string().uuid().optional().nullable(),
  });
  const AccountPatchSchema = z.object({
    display_name: z.string().max(500).trim().optional().nullable(),
    proxy_config: z.object({
      type: z.enum(['http', 'socks5']).optional(),
      host: z.string().min(1).max(256),
      port: z.number().int().min(1).max(65535),
      username: z.string().max(256).optional(),
      password: z.string().max(512).optional(),
    }).nullable().optional(),
  }).optional();
  const AccountConfigSchema = z.object({
    limits: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
  }).optional();

  // POST routes with literal paths must be registered before /:id patterns
  router.post('/purchase', validate(PurchaseSchema), asyncHandler(async (req, res) => {
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

  router.post('/enrich-contacts', validate(EnrichContactsSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { contactIds = [], bdAccountId } = req.body;
    const ids = contactIds;
    const result = await telegramManager.enrichContactsFromTelegram(organizationId, ids, bdAccountId);
    res.json(result);
  }));

  // GET / — list BD accounts with unread counts
  router.get('/', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;

    if (!organizationId) {
      throw new AppError(401, 'Unauthorized', ErrorCodes.UNAUTHORIZED);
    }

    const result = await pool.query(
      `SELECT id, organization_id, telegram_id, phone_number, is_active, is_demo, connected_at, last_activity,
              created_at, sync_status, sync_progress_done, sync_progress_total, sync_error,
              created_by_user_id AS owner_id,
              first_name, last_name, username, bio, photo_file_id, display_name
       FROM bd_accounts WHERE organization_id = $1 ORDER BY created_at DESC`,
      [organizationId]
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
    const rows = result.rows.map((r: ListRow) => ({
      ...r,
      is_owner: r.owner_id != null && r.owner_id === userId,
      unread_count: unreadByAccount[r.id] ?? 0,
    }));
    res.json(rows);
  }));

  // GET /:id — single account
  router.get('/:id', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { id } = req.params;

    const row = await getAccountOr404<Record<string, unknown> & { owner_id?: string }>(
      pool,
      id,
      organizationId,
      'id, organization_id, telegram_id, phone_number, is_active, is_demo, connected_at, last_activity, created_at, sync_status, sync_progress_done, sync_progress_total, sync_error, created_by_user_id AS owner_id, first_name, last_name, username, bio, photo_file_id, display_name, proxy_config'
    );
    res.json({
      ...row,
      is_owner: row.owner_id != null && row.owner_id === userId,
    });
  }));

  // PATCH /:id — update display_name and/or proxy_config
  router.patch('/:id', validate(AccountPatchSchema), asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;
    const body = req.body ?? {};
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
    const params: (string | null)[] = [];
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
      } else if (typeof proxyConfig === 'object' && proxyConfig.host && proxyConfig.port) {
        sets.push(`proxy_config = $${idx++}`);
        params.push(JSON.stringify({
          type: proxyConfig.type === 'http' ? 'http' : 'socks5',
          host: String(proxyConfig.host).trim(),
          port: Number(proxyConfig.port),
          ...(proxyConfig.username ? { username: String(proxyConfig.username) } : {}),
          ...(proxyConfig.password ? { password: String(proxyConfig.password) } : {}),
        }));
      }
    }

    if (sets.length === 0) {
      return res.json({ success: true });
    }

    sets.push('updated_at = NOW()');
    params.push(id);
    await withOrgContext(pool, user.organizationId, (client) =>
      client.query(
        `UPDATE bd_accounts SET ${sets.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1}`,
        [...params, user.organizationId]
      )
    );
    res.json({ success: true });
  }));

  // GET /:id/status
  router.get('/:id/status', asyncHandler(async (req, res) => {
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
  router.put('/:id/config', validate(AccountConfigSchema), asyncHandler(async (req, res) => {
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
    const { id } = req.params;

    const accountResult = await pool.query(
      `SELECT id, organization_id, created_by_user_id, phone_number, api_id, api_hash, session_string, session_encrypted
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
    if (!row.session_string) {
      throw new AppError(400, 'Account has no session; reconnect via QR or phone', ErrorCodes.BAD_REQUEST);
    }

    const isEncrypted = Boolean(row.session_encrypted);
    const apiHash = decryptIfNeeded(String(row.api_hash ?? ''), isEncrypted) || (row.api_hash as string);
    const sessionString = decryptIfNeeded(String(row.session_string ?? ''), isEncrypted) || (row.session_string as string);

    await withOrgContext(pool, user.organizationId, (client) =>
      client.query(
        'UPDATE bd_accounts SET is_active = true WHERE id = $1 AND organization_id = $2',
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

    // S2/A1: messaging-service owns messages; orphan via internal API instead of direct UPDATE
    await messagingClient.post(
      '/internal/messages/orphan-by-bd-account',
      { bdAccountId: id },
      undefined,
      { organizationId: user.organizationId }
    ).catch((err: unknown) => {
      log.warn({ message: 'Messaging orphan-by-bd-account failed (proceeding with account delete)', bdAccountId: id, error: String(err) });
      // Proceed: account and sync tables will be removed; messages remain linked to deleted account until cleaned up
    });

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
