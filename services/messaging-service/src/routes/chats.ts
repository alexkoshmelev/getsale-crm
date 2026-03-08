import { Router } from 'express';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, canPermission } from '@getsale/service-core';

interface Deps {
  pool: Pool;
  log: Logger;
}

export function chatsRouter({ pool, log }: Deps): Router {
  const router = Router();
  const checkPermission = canPermission(pool);

  // GET /chats — all chats (optionally filtered by bd_account_id)
  router.get('/chats', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { channel, bdAccountId } = req.query;

    const orgId = organizationId;
    const params: any[] = [orgId];

    if (bdAccountId && String(bdAccountId).trim()) {
      if (channel && String(channel) !== 'telegram') {
        return res.json([]);
      }
      params.push(String(bdAccountId).trim());

      const query = `
        SELECT
          'telegram' AS channel,
          s.telegram_chat_id::text AS channel_id,
          s.bd_account_id,
          s.folder_id,
          (SELECT COALESCE(array_agg(j.folder_id ORDER BY j.folder_id), ARRAY[]::integer[]) FROM bd_account_sync_chat_folders j WHERE j.bd_account_id = s.bd_account_id AND j.telegram_chat_id = s.telegram_chat_id) AS folder_ids,
          msg.contact_id,
          s.peer_type,
          c.first_name,
          c.last_name,
          c.email,
          c.telegram_id,
          c.display_name,
          c.username,
          COALESCE(
            CASE WHEN s.peer_type IN ('chat','channel') AND NULLIF(TRIM(COALESCE(s.title,'')),'') IS NOT NULL THEN NULLIF(TRIM(s.title),'') ELSE NULL END,
            CASE WHEN s.peer_type IN ('chat','channel') AND NULLIF(TRIM(COALESCE(s.title,'')),'') IS NULL THEN 'Chat ' || s.telegram_chat_id::text ELSE NULL END,
            CASE WHEN c.telegram_id IS DISTINCT FROM a.telegram_id THEN c.display_name ELSE NULL END,
            CASE WHEN c.telegram_id IS DISTINCT FROM a.telegram_id
                 AND NULLIF(TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))), '') IS NOT NULL
                 AND TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))) NOT LIKE 'Telegram %'
                 THEN TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))) ELSE NULL END,
            CASE WHEN c.telegram_id IS DISTINCT FROM a.telegram_id THEN c.username ELSE NULL END,
            CASE WHEN NULLIF(TRIM(COALESCE(s.title, '')), '') IS NOT NULL
                 AND (TRIM(COALESCE(s.title, '')) = NULLIF(TRIM(COALESCE(a.display_name, '')), '')
                      OR TRIM(COALESCE(s.title, '')) = COALESCE(a.username, '')
                      OR TRIM(COALESCE(s.title, '')) = NULLIF(TRIM(COALESCE(a.first_name, '')), ''))
                 THEN NULL ELSE NULLIF(TRIM(COALESCE(s.title, '')), '') END,
            c.telegram_id::text,
            s.telegram_chat_id::text
          ) AS name,
          COALESCE(msg.unread_count, 0)::int AS unread_count,
          msg.last_message_at,
          msg.last_message,
          conv.id AS conversation_id,
          COALESCE(conv.lead_id, l.id) AS lead_id,
          conv.campaign_id,
          conv.became_lead_at,
          conv.last_viewed_at,
          st.name AS lead_stage_name,
          p.name AS lead_pipeline_name,
          COALESCE(NULLIF(TRIM(a.display_name), ''), a.username, a.phone_number, a.telegram_id::text) AS account_name,
          s.title AS chat_title
        FROM bd_account_sync_chats s
        JOIN bd_accounts a ON a.id = s.bd_account_id AND a.organization_id = $1
        LEFT JOIN LATERAL (
          SELECT
            (SELECT m0.contact_id FROM messages m0 WHERE m0.organization_id = a.organization_id AND m0.channel = 'telegram' AND m0.channel_id = s.telegram_chat_id::text AND m0.bd_account_id = s.bd_account_id ORDER BY COALESCE(m0.telegram_date, m0.created_at) DESC NULLS LAST LIMIT 1) AS contact_id,
            (SELECT COUNT(*)::int FROM messages m WHERE m.organization_id = a.organization_id AND m.channel = 'telegram' AND m.channel_id = s.telegram_chat_id::text AND m.bd_account_id = s.bd_account_id AND m.unread = true) AS unread_count,
            (SELECT MAX(COALESCE(m.telegram_date, m.created_at)) FROM messages m WHERE m.organization_id = a.organization_id AND m.channel = 'telegram' AND m.channel_id = s.telegram_chat_id::text AND m.bd_account_id = s.bd_account_id) AS last_message_at,
            (SELECT COALESCE(NULLIF(TRIM(m2.content), ''), '[Media]') FROM messages m2 WHERE m2.organization_id = a.organization_id AND m2.channel = 'telegram' AND m2.channel_id = s.telegram_chat_id::text AND m2.bd_account_id = s.bd_account_id ORDER BY COALESCE(m2.telegram_date, m2.created_at) DESC LIMIT 1) AS last_message
        ) msg ON true
        LEFT JOIN contacts c ON c.id = msg.contact_id
        LEFT JOIN conversations conv ON conv.organization_id = a.organization_id AND conv.bd_account_id = s.bd_account_id AND conv.channel = 'telegram' AND conv.channel_id = s.telegram_chat_id::text
        LEFT JOIN LATERAL (
          SELECT l0.id, l0.stage_id, l0.pipeline_id
          FROM leads l0
          WHERE l0.organization_id = a.organization_id
            AND (l0.id = conv.lead_id OR (conv.lead_id IS NULL AND l0.contact_id = msg.contact_id))
          ORDER BY CASE WHEN l0.id = conv.lead_id THEN 0 ELSE 1 END, l0.created_at DESC
          LIMIT 1
        ) l ON true
        LEFT JOIN stages st ON st.id = l.stage_id
        LEFT JOIN pipelines p ON p.id = l.pipeline_id
        WHERE s.bd_account_id = $2 AND s.peer_type IN ('user', 'chat')
        ORDER BY msg.last_message_at DESC NULLS LAST, s.telegram_chat_id
      `;
      const result = await pool.query(query, params);
      const rows = result.rows as { name?: string; channel_id?: string; peer_type?: string; account_name?: string }[];
      for (const r of rows) {
        if (r.peer_type === 'user' && r.account_name && typeof r.name === 'string' && r.name.trim() === String(r.account_name).trim()) {
          r.name = r.channel_id ?? r.name;
        }
      }
      return res.json(rows);
    }

    if (channel) params.push(channel);
    const channelParam = channel ? ` AND m.channel = $${params.length}` : '';
    let query = `
      WITH latest_per_chat AS (
        SELECT DISTINCT ON (m.organization_id, m.channel, m.channel_id, m.bd_account_id)
          m.organization_id, m.channel, m.channel_id, m.bd_account_id, m.contact_id
        FROM messages m
        WHERE m.organization_id = $1${channelParam}
        ORDER BY m.organization_id, m.channel, m.channel_id, m.bd_account_id, COALESCE(m.telegram_date, m.created_at) DESC NULLS LAST
      ),
      unread_per_chat AS (
        SELECT m.organization_id, m.channel, m.channel_id, m.bd_account_id,
               COUNT(*) FILTER (WHERE m.unread = true) AS unread_count
        FROM messages m
        WHERE m.organization_id = $1${channelParam}
        GROUP BY m.organization_id, m.channel, m.channel_id, m.bd_account_id
      )
      SELECT
        m.channel,
        m.channel_id,
        m.bd_account_id,
        m.contact_id,
        s.peer_type,
        c.first_name,
        c.last_name,
        c.email,
        c.telegram_id,
        c.display_name,
        c.username,
        COALESCE(
          CASE WHEN s.peer_type IN ('chat','channel') AND NULLIF(TRIM(COALESCE(s.title,'')),'') IS NOT NULL THEN NULLIF(TRIM(s.title),'') ELSE NULL END,
          CASE WHEN s.peer_type IN ('chat','channel') AND NULLIF(TRIM(COALESCE(s.title,'')),'') IS NULL THEN 'Chat ' || m.channel_id ELSE NULL END,
          CASE WHEN c.telegram_id IS DISTINCT FROM ba.telegram_id THEN c.display_name ELSE NULL END,
          CASE WHEN c.telegram_id IS DISTINCT FROM ba.telegram_id
               AND NULLIF(TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))), '') IS NOT NULL
               AND TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))) NOT LIKE 'Telegram %'
               THEN TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))) ELSE NULL END,
          CASE WHEN c.telegram_id IS DISTINCT FROM ba.telegram_id THEN c.username ELSE NULL END,
          CASE WHEN NULLIF(TRIM(COALESCE(s.title, '')), '') IS NOT NULL
               AND (TRIM(COALESCE(s.title, '')) = NULLIF(TRIM(COALESCE(ba.display_name, '')), '')
                    OR TRIM(COALESCE(s.title, '')) = COALESCE(ba.username, '')
                    OR TRIM(COALESCE(s.title, '')) = NULLIF(TRIM(COALESCE(ba.first_name, '')), ''))
               THEN NULL ELSE NULLIF(TRIM(COALESCE(s.title, '')), '') END,
          c.telegram_id::text,
          m.channel_id
        ) AS name,
        COALESCE(u.unread_count, 0)::int AS unread_count,
        (SELECT COALESCE(m2.telegram_date, m2.created_at) FROM messages m2 WHERE m2.organization_id = m.organization_id AND m2.channel = m.channel AND m2.channel_id = m.channel_id AND (m2.bd_account_id IS NOT DISTINCT FROM m.bd_account_id) ORDER BY COALESCE(m2.telegram_date, m2.created_at) DESC LIMIT 1) as last_message_at,
        (SELECT COALESCE(NULLIF(TRIM(m2.content), ''), '[Media]') FROM messages m2 WHERE m2.organization_id = m.organization_id AND m2.channel = m.channel AND m2.channel_id = m.channel_id AND (m2.bd_account_id IS NOT DISTINCT FROM m.bd_account_id) ORDER BY COALESCE(m2.telegram_date, m2.created_at) DESC LIMIT 1) as last_message,
        conv.id AS conversation_id,
        COALESCE(conv.lead_id, l.id) AS lead_id,
        conv.campaign_id,
        conv.became_lead_at,
        conv.last_viewed_at,
        st.name AS lead_stage_name,
        p.name AS lead_pipeline_name,
        COALESCE(NULLIF(TRIM(ba.display_name), ''), ba.username, ba.phone_number, ba.telegram_id::text) AS account_name,
        s.title AS chat_title
      FROM latest_per_chat m
      LEFT JOIN contacts c ON c.id = m.contact_id
      LEFT JOIN unread_per_chat u ON u.organization_id = m.organization_id AND u.channel = m.channel AND u.channel_id = m.channel_id AND u.bd_account_id = m.bd_account_id
      LEFT JOIN bd_account_sync_chats s ON s.bd_account_id = m.bd_account_id AND s.telegram_chat_id = m.channel_id
      LEFT JOIN bd_accounts ba ON ba.id = m.bd_account_id
      LEFT JOIN conversations conv ON conv.organization_id = m.organization_id AND conv.bd_account_id IS NOT DISTINCT FROM m.bd_account_id AND conv.channel = m.channel AND conv.channel_id = m.channel_id
      LEFT JOIN LATERAL (
        SELECT l0.id, l0.stage_id, l0.pipeline_id
        FROM leads l0
        WHERE l0.organization_id = m.organization_id
          AND (l0.id = conv.lead_id OR (conv.lead_id IS NULL AND l0.contact_id = m.contact_id))
        ORDER BY CASE WHEN l0.id = conv.lead_id THEN 0 ELSE 1 END, l0.created_at DESC
        LIMIT 1
      ) l ON true
      LEFT JOIN stages st ON st.id = l.stage_id
      LEFT JOIN pipelines p ON p.id = l.pipeline_id
      WHERE m.organization_id = $1${channelParam}
      ORDER BY last_message_at DESC NULLS LAST
    `;

    const result = await pool.query(query, params);
    const rows = result.rows as { name?: string; channel_id?: string; peer_type?: string; account_name?: string }[];
    for (const r of rows) {
      if (r.peer_type === 'user' && r.account_name && typeof r.name === 'string' && r.name.trim() === String(r.account_name).trim()) {
        r.name = r.channel_id ?? r.name;
      }
    }
    res.json(rows);
  }));

  // GET /search — search chats by name
  router.get('/search', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '5'), 10) || 5, 1), 20);
    if (!q || q.length < 2) {
      return res.json({ items: [] });
    }
    const searchPattern = `%${q.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    const result = await pool.query(
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
    res.json({ items: result.rows });
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
    const params: any[] = [organizationId];

    if (startDate) {
      query += ` AND created_at >= $${params.length + 1}`;
      params.push(startDate);
    }
    if (endDate) {
      query += ` AND created_at <= $${params.length + 1}`;
      params.push(endDate);
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
    res.json(result.rows.map((r: any) => ({ channel_id: r.channel_id, order_index: r.order_index })));
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
    const ids = Array.isArray(pinnedChatIds) ? pinnedChatIds.map((x: any) => String(x)).filter(Boolean) : [];
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
