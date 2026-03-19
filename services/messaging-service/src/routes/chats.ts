import { Router } from 'express';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, canPermission, ServiceHttpClient, ServiceCallError, withOrgContext } from '@getsale/service-core';
import type { PinnedChatRow, QueryParam } from '../types';
import { runSyncListQuery, runDefaultChatsQuery } from '../chats-list-helpers';

interface Deps {
  pool: Pool;
  log: Logger;
  bdAccountsClient: ServiceHttpClient;
}

export function chatsRouter({ pool, log, bdAccountsClient }: Deps): Router {
  const router = Router();
  const checkPermission = canPermission(pool);

  // GET /chats — all chats (optionally filtered by bd_account_id). A1: when bdAccountId set, sync-chat list from bd-accounts internal API. A4: withOrgContext.
  router.get('/chats', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    let { channel, bdAccountId } = req.query;
    // Normalize so both "tg" and "telegram" work (frontend/URLs may send either).
    const channelNorm = channel != null ? String(channel).trim().toLowerCase() : '';
    if (channelNorm === 'tg') (channel as string) = 'telegram';

    const orgId = organizationId != null ? String(organizationId).trim() : '';
    if (!orgId) {
      throw new AppError(400, 'Organization context required', ErrorCodes.VALIDATION);
    }
    const params: QueryParam[] = [orgId];

    const rows = await withOrgContext(pool, orgId, async (client) => {
    if (bdAccountId && String(bdAccountId).trim()) {
      if (channel && String(channel) !== 'telegram') {
        return [] as { name?: string; channel_id?: string; peer_type?: string; account_name?: string }[];
      }
      const bdId = String(bdAccountId).trim();

      let chats: Array<{ telegram_chat_id: string; title: string | null; peer_type: string; folder_id: number | null; folder_ids: number[] }>;
      try {
        const data = await bdAccountsClient.get<{ chats: Array<{ telegram_chat_id: string; title: string | null; peer_type: string; folder_id: number | null; folder_ids: number[] }> }>(
          `/internal/sync-chats?bdAccountId=${encodeURIComponent(bdId)}`,
          undefined,
          { organizationId: orgId }
        );
        chats = data?.chats ?? [];
      } catch (err) {
        if (err instanceof ServiceCallError) {
          const msg = typeof err.body === 'object' && err.body != null && 'error' in err.body && typeof (err.body as { error: unknown }).error === 'string'
            ? (err.body as { error: string }).error
            : err.message;
          throw new AppError(err.statusCode, msg, err.statusCode >= 500 ? ErrorCodes.INTERNAL_ERROR : ErrorCodes.BAD_REQUEST);
        }
        throw err;
      }
      if (!chats?.length) {
        return [] as { name?: string; channel_id?: string; peer_type?: string; account_name?: string }[];
      }
      const syncListJson = JSON.stringify(chats);
      return runSyncListQuery(client, orgId, bdId, syncListJson);
    }

    if (channel) params.push(String(channel));
    const channelParam = channel ? ` AND m.channel = $${params.length}` : '';
    return runDefaultChatsQuery(client, params as (string | number)[], channelParam);
    });
    res.json(rows);
  }));

  // GET /search — search chats by name. A4: withOrgContext.
  router.get('/search', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '5'), 10) || 5, 1), 20);
    if (!q || q.length < 2) {
      return res.json({ items: [] });
    }
    const searchPattern = `%${q.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    const items = await withOrgContext(pool, organizationId, async (client) => {
    const result = await client.query(
      `SELECT
        'telegram' AS channel,
        s.telegram_chat_id::text AS channel_id,
        s.bd_account_id,
        COALESCE(
          c.display_name,
          CASE WHEN NULLIF(TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))), '') IS NOT NULL
               AND TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))) NOT LIKE 'Telegram %%'
               THEN TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))) ELSE NULL END,
          c.username,
          NULLIF(TRIM(COALESCE(s.title, '')), ''),
          c.telegram_id::text,
          s.telegram_chat_id::text
        ) AS name
       FROM bd_account_sync_chats s
       JOIN bd_accounts a ON a.id = s.bd_account_id AND a.organization_id = $1
       LEFT JOIN LATERAL (
         SELECT m0.contact_id FROM messages m0
         WHERE m0.organization_id = a.organization_id AND m0.channel = 'telegram'
           AND m0.channel_id = s.telegram_chat_id::text AND m0.bd_account_id = s.bd_account_id
         LIMIT 1
       ) mid ON true
       LEFT JOIN contacts c ON c.id = mid.contact_id
       WHERE s.peer_type IN ('user', 'chat')
         AND (
           s.title ILIKE $2
           OR c.display_name ILIKE $2
           OR CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,'')) ILIKE $2
           OR c.username ILIKE $2
           OR c.telegram_id::text ILIKE $2
         )
       ORDER BY s.title, c.display_name NULLS LAST
       LIMIT $3`,
      [organizationId, searchPattern, limit]
    );
    return result.rows;
    });
    res.json({ items });
  }));

  // GET /stats — messaging statistics
  router.get('/stats', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { startDate, endDate } = req.query;

    let query = `
      SELECT
        channel,
        direction,
        status,
        COUNT(*) as count
      FROM messages
      WHERE organization_id = $1
    `;
    const params: QueryParam[] = [organizationId];

    if (startDate) {
      query += ` AND created_at >= $${params.length + 1}`;
      params.push(String(startDate));
    }
    if (endDate) {
      query += ` AND created_at <= $${params.length + 1}`;
      params.push(String(endDate));
    }

    query += ` GROUP BY channel, direction, status`;

    const result = await pool.query(query, params);

    const unreadResult = await pool.query(
      'SELECT COUNT(*) as count FROM messages WHERE organization_id = $1 AND unread = true',
      [organizationId]
    );

    res.json({
      stats: result.rows,
      unreadCount: parseInt(unreadResult.rows[0].count),
    });
  }));

  // GET /pinned-chats
  router.get('/pinned-chats', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { bdAccountId } = req.query;
    if (!bdAccountId || String(bdAccountId).trim() === '') {
      throw new AppError(400, 'bdAccountId is required', ErrorCodes.VALIDATION);
    }
    const result = await pool.query(
      `SELECT channel_id, order_index FROM user_chat_pins
       WHERE user_id = $1 AND organization_id = $2 AND bd_account_id = $3
       ORDER BY order_index ASC, created_at ASC`,
      [userId, organizationId, String(bdAccountId).trim()]
    );
    res.json(result.rows.map((r: unknown) => {
      const row = r as PinnedChatRow;
      return { channel_id: row.channel_id, order_index: row.order_index };
    }));
  }));

  // POST /pinned-chats
  router.post('/pinned-chats', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { bdAccountId, channelId } = req.body;
    if (!bdAccountId || !channelId) {
      throw new AppError(400, 'bdAccountId and channelId are required', ErrorCodes.VALIDATION);
    }
    const bdId = String(bdAccountId).trim();
    const chId = String(channelId).trim();
    const maxResult = await pool.query(
      `SELECT COALESCE(MAX(order_index), -1) + 1 AS next_index FROM user_chat_pins
       WHERE user_id = $1 AND organization_id = $2 AND bd_account_id = $3`,
      [userId, organizationId, bdId]
    );
    const nextIndex = maxResult.rows[0]?.next_index ?? 0;
    await pool.query(
      `INSERT INTO user_chat_pins (user_id, organization_id, bd_account_id, channel_id, order_index)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, organization_id, bd_account_id, channel_id) DO UPDATE SET order_index = EXCLUDED.order_index`,
      [userId, organizationId, bdId, chId, nextIndex]
    );
    res.json({ success: true, channel_id: chId, order_index: nextIndex });
  }));

  // DELETE /pinned-chats/:channelId
  router.delete('/pinned-chats/:channelId', asyncHandler(async (req, res) => {
    const { id: userId, organizationId, role } = req.user;
    const allowed = await checkPermission(role, 'messaging', 'chat.delete');
    if (!allowed) {
      throw new AppError(403, 'Forbidden: no permission to unpin chats', ErrorCodes.FORBIDDEN);
    }
    const { channelId } = req.params;
    const { bdAccountId } = req.query;
    if (!bdAccountId || String(bdAccountId).trim() === '') {
      throw new AppError(400, 'bdAccountId query is required', ErrorCodes.VALIDATION);
    }
    await pool.query(
      `DELETE FROM user_chat_pins
       WHERE user_id = $1 AND organization_id = $2 AND bd_account_id = $3 AND channel_id = $4`,
      [userId, organizationId, String(bdAccountId).trim(), String(channelId)]
    );
    res.json({ success: true });
  }));

  // POST /pinned-chats/sync — replace current user's pins with ordered list from Telegram
  router.post('/pinned-chats/sync', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { bdAccountId, pinned_chat_ids: pinnedChatIds } = req.body;
    if (!bdAccountId || String(bdAccountId).trim() === '') {
      throw new AppError(400, 'bdAccountId is required', ErrorCodes.VALIDATION);
    }
    const bdId = String(bdAccountId).trim();
    const ids = Array.isArray(pinnedChatIds) ? pinnedChatIds.map((x: unknown) => String(x)).filter(Boolean) : [];
    await pool.query(
      `DELETE FROM user_chat_pins
       WHERE user_id = $1 AND organization_id = $2 AND bd_account_id = $3`,
      [userId, organizationId, bdId]
    );
    for (let i = 0; i < ids.length; i++) {
      await pool.query(
        `INSERT INTO user_chat_pins (user_id, organization_id, bd_account_id, channel_id, order_index)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, organization_id, bd_account_id, channel_id) DO UPDATE SET order_index = EXCLUDED.order_index`,
        [userId, organizationId, bdId, ids[i], i]
      );
    }
    res.json({ success: true, count: ids.length });
  }));

  return router;
}
