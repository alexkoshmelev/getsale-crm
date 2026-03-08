import { Router } from 'express';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, canPermission } from '@getsale/service-core';
import { TelegramManager } from '../telegram-manager';
import { requireAccountOwner, requireBidiOwnAccount } from '../helpers';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  telegramManager: TelegramManager;
}

export function accountsRouter({ pool, rabbitmq, log, telegramManager }: Deps): Router {
  const router = Router();
  const checkPermission = canPermission(pool);

  // POST routes with literal paths must be registered before /:id patterns
  router.post('/purchase', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { platform, durationDays } = req.body;

    const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);

    const result = await pool.query(
      `INSERT INTO bd_accounts (organization_id, user_id, platform, account_type, status, purchased_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [organizationId, userId, platform, 'rented', 'pending', new Date(), expiresAt]
    );

    res.json(result.rows[0]);
  }));

  router.post('/enrich-contacts', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { contactIds = [], bdAccountId } = req.body;
    const ids = Array.isArray(contactIds) ? contactIds.filter((x: unknown) => typeof x === 'string') : [];
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
    for (const row of unreadResult.rows as any[]) {
      unreadByAccount[row.bd_account_id] = Number(row.unread_count) || 0;
    }

    const rows = result.rows.map((r: any) => ({
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

    const result = await pool.query(
      `SELECT id, organization_id, telegram_id, phone_number, is_active, is_demo, connected_at, last_activity,
              created_at, sync_status, sync_progress_done, sync_progress_total, sync_error,
              created_by_user_id AS owner_id,
              first_name, last_name, username, bio, photo_file_id, display_name
       FROM bd_accounts WHERE id = $1 AND organization_id = $2`,
      [id, organizationId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    const row = result.rows[0] as any;
    res.json({
      ...row,
      is_owner: row.owner_id != null && row.owner_id === userId,
    });
  }));

  // PATCH /:id — update display_name
  router.patch('/:id', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;
    const { display_name: displayName } = req.body ?? {};

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

    const value = typeof displayName === 'string' ? displayName.trim() || null : null;
    await pool.query(
      'UPDATE bd_accounts SET display_name = $1, updated_at = NOW() WHERE id = $2',
      [value, id]
    );
    res.json({ success: true, display_name: value });
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
  router.put('/:id/config', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { limits, metadata } = req.body;

    const result = await pool.query(
      `UPDATE bd_accounts
       SET limits = $1, metadata = $2, updated_at = NOW()
       WHERE id = $3 AND organization_id = $4
       RETURNING *`,
      [JSON.stringify(limits || {}), JSON.stringify(metadata || {}), id, organizationId]
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
      `SELECT id, organization_id, created_by_user_id, phone_number, api_id, api_hash, session_string
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

    const row = accountResult.rows[0] as any;
    if (!row.session_string) {
      throw new AppError(400, 'Account has no session; reconnect via QR or phone', ErrorCodes.BAD_REQUEST);
    }

    await pool.query(
      'UPDATE bd_accounts SET is_active = true WHERE id = $1',
      [id]
    );

    await telegramManager.connectAccount(
      id,
      row.organization_id,
      row.created_by_user_id || user.id,
      row.phone_number || '',
      parseInt(row.api_id, 10),
      row.api_hash,
      row.session_string
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

    await telegramManager.disconnectAccount(id);

    await pool.query('UPDATE messages SET bd_account_id = NULL WHERE bd_account_id = $1', [id]);
    await pool.query('DELETE FROM bd_account_sync_chat_folders WHERE bd_account_id = $1', [id]);
    await pool.query('DELETE FROM bd_account_sync_chats WHERE bd_account_id = $1', [id]);
    await pool.query('DELETE FROM bd_account_sync_folders WHERE bd_account_id = $1', [id]);
    await pool.query('DELETE FROM bd_accounts WHERE id = $1', [id]);

    res.json({ success: true });
  }));

  return router;
}
