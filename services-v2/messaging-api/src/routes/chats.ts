import { FastifyInstance } from 'fastify';
import { AppError, ErrorCodes, requireUser } from '@getsale/service-framework';
import type { MessagingDeps } from '../types';

interface ChatListRow {
  name?: string;
  channel_id?: string;
  peer_type?: string;
  account_name?: string;
  [key: string]: unknown;
}

function inferPeerType(peerType: string | null | undefined, channelId: string | null | undefined): string {
  const cid = channelId != null ? String(channelId).trim() : '';
  if (!cid) return peerType ?? 'user';
  const isNegativeNumeric = /^-?\d+$/.test(cid) && parseInt(cid, 10) < 0;
  if (peerType === 'chat' && !isNegativeNumeric) return 'user';
  return peerType ?? 'user';
}

function normalizeChatRows(rows: ChatListRow[]): ChatListRow[] {
  for (const r of rows) {
    r.peer_type = inferPeerType(r.peer_type, r.channel_id);
    if (r.peer_type === 'user' && r.account_name && typeof r.name === 'string' && r.name.trim() === String(r.account_name).trim()) {
      r.name = r.channel_id ?? r.name;
    }
  }
  return rows;
}

function parseLastMessageAtMs(r: ChatListRow): number {
  const t = r.last_message_at;
  if (t == null || String(t).trim() === '') return 0;
  const ms = new Date(String(t)).getTime();
  return Number.isNaN(ms) ? 0 : ms;
}

function shouldDedupeTelegramDmRow(r: ChatListRow): boolean {
  if (r.peer_type !== 'user') return false;
  const cid = r.channel_id != null ? String(r.channel_id).trim() : '';
  if (!cid) return false;
  if (/^-?\d+$/.test(cid) && parseInt(cid, 10) < 0) return false;
  return true;
}

function dedupeIdentityKey(r: ChatListRow): string | null {
  const tg = r.telegram_id != null ? String(r.telegram_id).trim() : '';
  if (tg !== '') return `tg:${tg}`;
  const contactId = r.contact_id != null ? String(r.contact_id).trim() : '';
  if (contactId !== '') return `c:${contactId}`;
  return null;
}

function dedupeTelegramUserChats(rows: ChatListRow[]): ChatListRow[] {
  const passthrough: ChatListRow[] = [];
  const groups = new Map<string, ChatListRow[]>();

  for (const r of rows) {
    if (!shouldDedupeTelegramDmRow(r)) { passthrough.push(r); continue; }
    const key = dedupeIdentityKey(r);
    if (!key) { passthrough.push(r); continue; }
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const merged: ChatListRow[] = [];
  for (const [, group] of groups) {
    if (group.length === 1) { merged.push(group[0]!); continue; }
    let winner = group[0]!;
    let winnerMs = parseLastMessageAtMs(winner);
    for (let i = 1; i < group.length; i++) {
      const g = group[i]!;
      const ms = parseLastMessageAtMs(g);
      if (ms > winnerMs) { winner = g; winnerMs = ms; }
      else if (ms === winnerMs) {
        const wNum = /^\d+$/.test(String(winner.channel_id ?? '').trim());
        const gNum = /^\d+$/.test(String(g.channel_id ?? '').trim());
        if (gNum && !wNum) winner = g;
      }
    }
    const sumUnread = group.reduce((acc, x) => acc + (Number(x.unread_count) || 0), 0);
    merged.push({ ...winner, unread_count: sumUnread });
  }

  return [...passthrough, ...merged];
}

function sortAndDedupe(rows: ChatListRow[]): ChatListRow[] {
  const normalized = normalizeChatRows(rows);
  const deduped = dedupeTelegramUserChats(normalized);
  return [...deduped].sort((a, b) => parseLastMessageAtMs(b) - parseLastMessageAtMs(a));
}

const SYNC_LIST_QUERY = `
  WITH sync_list AS (
    SELECT sc.telegram_chat_id, sc.title, sc.peer_type
    FROM bd_account_sync_chats sc
    WHERE sc.bd_account_id = $2::uuid
  )
  SELECT
    'telegram' AS channel,
    s.telegram_chat_id AS channel_id,
    $2::uuid AS bd_account_id,
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
      CASE WHEN s.peer_type IN ('chat','channel') AND NULLIF(TRIM(COALESCE(s.title,'')),'') IS NULL THEN 'Chat ' || s.telegram_chat_id ELSE NULL END,
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
      s.telegram_chat_id
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
    s.title AS chat_title,
    s_folder.folder_id,
    s_folders.folder_ids
  FROM sync_list s
  CROSS JOIN (SELECT $1::uuid AS organization_id, $2::uuid AS id) ctx
  JOIN bd_accounts a ON a.id = ctx.id AND a.organization_id = ctx.organization_id
  LEFT JOIN LATERAL (
    SELECT
      (SELECT m0.contact_id FROM messages m0 WHERE m0.organization_id = ctx.organization_id AND m0.channel = 'telegram' AND m0.channel_id = s.telegram_chat_id AND m0.bd_account_id = $2::uuid ORDER BY COALESCE(m0.telegram_date, m0.created_at) DESC NULLS LAST LIMIT 1) AS contact_id,
      (SELECT COUNT(*)::int FROM messages m WHERE m.organization_id = ctx.organization_id AND m.channel = 'telegram' AND m.channel_id = s.telegram_chat_id AND m.bd_account_id = $2::uuid AND m.unread = true) AS unread_count,
      (SELECT MAX(COALESCE(m.telegram_date, m.created_at)) FROM messages m WHERE m.organization_id = ctx.organization_id AND m.channel = 'telegram' AND m.channel_id = s.telegram_chat_id AND m.bd_account_id = $2::uuid) AS last_message_at,
      (SELECT COALESCE(NULLIF(TRIM(m2.content), ''), '[Media]') FROM messages m2 WHERE m2.organization_id = ctx.organization_id AND m2.channel = 'telegram' AND m2.channel_id = s.telegram_chat_id AND m2.bd_account_id = $2::uuid ORDER BY COALESCE(m2.telegram_date, m2.created_at) DESC LIMIT 1) AS last_message
  ) msg ON true
  LEFT JOIN contacts c ON c.id = msg.contact_id
  LEFT JOIN conversations conv ON conv.organization_id = ctx.organization_id AND conv.bd_account_id = $2::uuid AND conv.channel = 'telegram' AND conv.channel_id = s.telegram_chat_id
  LEFT JOIN LATERAL (
    SELECT l0.id, l0.stage_id, l0.pipeline_id
    FROM leads l0
    WHERE l0.organization_id = ctx.organization_id
      AND (l0.id = conv.lead_id OR (conv.lead_id IS NULL AND l0.contact_id = msg.contact_id))
    ORDER BY CASE WHEN l0.id = conv.lead_id THEN 0 ELSE 1 END, l0.created_at DESC
    LIMIT 1
  ) l ON true
  LEFT JOIN stages st ON st.id = l.stage_id
  LEFT JOIN pipelines p ON p.id = l.pipeline_id
  LEFT JOIN LATERAL (
    SELECT sc2.folder_id FROM bd_account_sync_chats sc2
    WHERE sc2.bd_account_id = $2::uuid AND sc2.telegram_chat_id = s.telegram_chat_id
    LIMIT 1
  ) s_folder ON true
  LEFT JOIN LATERAL (
    SELECT COALESCE(array_agg(DISTINCT scf.folder_id ORDER BY scf.folder_id), ARRAY[]::int[]) AS folder_ids
    FROM bd_account_sync_chat_folders scf
    WHERE scf.bd_account_id = $2::uuid AND scf.telegram_chat_id = s.telegram_chat_id
  ) s_folders ON true
  WHERE s.peer_type IN ('user', 'chat')
  ORDER BY msg.last_message_at DESC NULLS LAST, s.telegram_chat_id
`;

export function registerChatRoutes(app: FastifyInstance, deps: MessagingDeps): void {
  const { db, log } = deps;

  app.get('/api/messaging/chats', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    let { channel, bdAccountId } = request.query as { channel?: string; bdAccountId?: string };

    const channelNorm = channel != null ? String(channel).trim().toLowerCase() : '';
    if (channelNorm === 'tg') channel = 'telegram';

    if (bdAccountId && String(bdAccountId).trim()) {
      if (channel && String(channel) !== 'telegram') return [];
      const bdId = String(bdAccountId).trim();
      try {
        const result = await db.read.query(SYNC_LIST_QUERY, [user.organizationId, bdId]);
        return sortAndDedupe(result.rows);
      } catch (err) {
        log.error({ message: 'chats sync-list query failed', error: String(err), bdAccountId: bdId });
        return [];
      }
    }

    const hasChannel = Boolean(channel && String(channel).trim());
    const chVal = hasChannel ? String(channel).trim() : '';

    const accParams: unknown[] = [user.organizationId];
    let accQuery = `SELECT DISTINCT m.bd_account_id::text AS bd_account_id FROM messages m
                    WHERE m.organization_id = $1 AND m.bd_account_id IS NOT NULL`;
    if (hasChannel) {
      accQuery += ' AND m.channel = $2';
      accParams.push(chVal);
    }

    const accRes = await db.read.query<{ bd_account_id: string }>(accQuery, accParams);
    const accountIds = accRes.rows.map((r) => r.bd_account_id);

    if (accountIds.length === 0) return [];

    const allRows: ChatListRow[] = [];
    await Promise.all(accountIds.map(async (bdId) => {
      try {
        const result = await db.read.query(SYNC_LIST_QUERY, [user.organizationId, bdId]);
        allRows.push(...result.rows);
      } catch (err) {
        log.warn({ message: 'chats query failed for account', bdAccountId: bdId, error: String(err) });
      }
    }));

    return sortAndDedupe(allRows);
  });

  app.get('/api/messaging/search', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { q, limit = 5 } = request.query as { q?: string; limit?: number };
    const safeLimit = Math.min(Number(limit) || 5, 50);

    if (!q || q.trim().length < 2) return { items: [] };

    const result = await db.read.query(
      `SELECT sc.telegram_chat_id AS channel_id, sc.title AS name, sc.peer_type,
              'telegram' AS channel,
              ba.id AS bd_account_id,
              COALESCE(NULLIF(TRIM(ba.display_name), ''), ba.username, ba.phone_number) AS account_name
       FROM bd_account_sync_chats sc
       JOIN bd_accounts ba ON ba.id = sc.bd_account_id
       WHERE ba.organization_id = $1
         AND (sc.title ILIKE $2 OR sc.telegram_chat_id ILIKE $2)
       ORDER BY sc.title ASC
       LIMIT $3`,
      [user.organizationId, `%${q.trim()}%`, safeLimit],
    );

    return { items: result.rows };
  });

  app.get('/api/messaging/pinned-chats', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { bdAccountId } = request.query as { bdAccountId?: string };

    if (!bdAccountId?.trim()) {
      throw new AppError(400, 'bdAccountId is required', ErrorCodes.VALIDATION);
    }

    const result = await db.read.query(
      `SELECT pc.channel_id, pc.order_index, pc.created_at,
              ct.first_name AS contact_first_name, ct.last_name AS contact_last_name
       FROM user_chat_pins pc
       LEFT JOIN conversations conv
         ON conv.channel_id = pc.channel_id
         AND conv.bd_account_id = pc.bd_account_id
         AND conv.organization_id = pc.organization_id
       LEFT JOIN contacts ct ON conv.contact_id = ct.id
       WHERE pc.user_id = $1 AND pc.organization_id = $2 AND pc.bd_account_id = $3
       ORDER BY pc.order_index ASC`,
      [user.id, user.organizationId, bdAccountId.trim()],
    );

    return result.rows;
  });

  app.post('/api/messaging/pinned-chats', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { bdAccountId, channelId } = request.body as { bdAccountId?: string; channelId?: string };

    if (!bdAccountId?.trim() || !channelId?.trim()) {
      throw new AppError(400, 'bdAccountId and channelId are required', ErrorCodes.VALIDATION);
    }

    const result = await db.write.query(
      `INSERT INTO user_chat_pins (user_id, organization_id, bd_account_id, channel_id, order_index)
       SELECT $1, $2, $3, $4, COALESCE(MAX(order_index), -1) + 1
       FROM user_chat_pins
       WHERE user_id = $1 AND organization_id = $2 AND bd_account_id = $3
       ON CONFLICT (user_id, organization_id, bd_account_id, channel_id) DO UPDATE SET order_index = EXCLUDED.order_index
       RETURNING channel_id, order_index`,
      [user.id, user.organizationId, bdAccountId.trim(), channelId.trim()],
    );

    return { success: true, channel_id: result.rows[0]?.channel_id ?? channelId.trim(), order_index: result.rows[0]?.order_index ?? 0 };
  });

  app.delete('/api/messaging/pinned-chats/:channelId', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { channelId } = request.params as { channelId: string };
    const { bdAccountId } = request.query as { bdAccountId?: string };

    if (!bdAccountId?.trim()) {
      throw new AppError(400, 'bdAccountId query is required', ErrorCodes.VALIDATION);
    }

    await db.write.query(
      `DELETE FROM user_chat_pins
       WHERE user_id = $1 AND organization_id = $2 AND bd_account_id = $3 AND channel_id = $4`,
      [user.id, user.organizationId, bdAccountId.trim(), channelId],
    );

    return { success: true };
  });

  app.post('/api/messaging/pinned-chats/sync', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { bdAccountId, pinned_chat_ids: pinnedChatIds } = request.body as { bdAccountId?: string; pinned_chat_ids?: string[] };

    if (!bdAccountId?.trim()) {
      throw new AppError(400, 'bdAccountId is required', ErrorCodes.VALIDATION);
    }
    const bdId = bdAccountId.trim();
    const ids = Array.isArray(pinnedChatIds) ? pinnedChatIds.map((x) => String(x)).filter(Boolean) : [];

    await db.write.query(
      'DELETE FROM user_chat_pins WHERE user_id = $1 AND organization_id = $2 AND bd_account_id = $3',
      [user.id, user.organizationId, bdId],
    );

    let count = 0;
    for (let i = 0; i < ids.length; i++) {
      await db.write.query(
        `INSERT INTO user_chat_pins (user_id, organization_id, bd_account_id, channel_id, order_index)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, organization_id, bd_account_id, channel_id) DO UPDATE SET order_index = $5`,
        [user.id, user.organizationId, bdId, ids[i], i],
      );
      count++;
    }

    return { success: true, count };
  });

  app.get('/api/messaging/stats', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { startDate, endDate } = request.query as { startDate?: string; endDate?: string };

    const params: unknown[] = [user.organizationId];
    let dateFilter = '';
    let idx = 2;

    if (startDate) {
      dateFilter += ` AND m.created_at >= $${idx}`;
      params.push(startDate);
      idx++;
    }
    if (endDate) {
      dateFilter += ` AND m.created_at <= $${idx}`;
      params.push(endDate);
      idx++;
    }

    const statsResult = await db.read.query(
      `SELECT
         COUNT(*)::int AS total_messages,
         COUNT(*) FILTER (WHERE m.direction = 'inbound')::int AS inbound,
         COUNT(*) FILTER (WHERE m.direction = 'outbound')::int AS outbound,
         COUNT(DISTINCT m.channel_id)::int AS unique_chats
       FROM messages m
       WHERE m.organization_id = $1${dateFilter}`,
      params,
    );

    const unreadResult = await db.read.query(
      `SELECT COUNT(*)::int AS unread_count
       FROM messages
       WHERE organization_id = $1 AND unread = true AND direction = 'inbound'`,
      [user.organizationId],
    );

    const byResult = await db.read.query(
      `SELECT m.channel, m.direction, m.status, COUNT(*)::int AS count
       FROM messages m
       WHERE m.organization_id = $1${dateFilter}
       GROUP BY m.channel, m.direction, m.status
       ORDER BY m.channel, m.direction`,
      params,
    );

    return {
      stats: statsResult.rows[0] || { total_messages: 0, inbound: 0, outbound: 0, unique_chats: 0 },
      byChannelDirection: byResult.rows,
      unreadCount: unreadResult.rows[0]?.unread_count ?? 0,
    };
  });
}
