/**
 * Helpers for GET /chats list queries (A5/Q1: extracted from chats.ts).
 * buildSyncListQuery / buildDefaultChatsQuery + run + normalizeChatRows.
 */
import type { PoolClient } from 'pg';

export interface ChatListRow {
  name?: string;
  channel_id?: string;
  peer_type?: string;
  account_name?: string;
  [key: string]: unknown;
}

/** SQL for chats list when bdAccountId is set (sync list from bd-accounts internal API). */
export function getSyncListQuery(): string {
  return `
    WITH sync_list AS (
      SELECT * FROM json_to_recordset($3::json) AS x(telegram_chat_id text, title text, peer_type text, folder_id int, folder_ids int[])
    )
    SELECT
      'telegram' AS channel,
      s.telegram_chat_id AS channel_id,
      $2::uuid AS bd_account_id,
      s.folder_id,
      COALESCE(s.folder_ids, ARRAY[]::integer[]) AS folder_ids,
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
      s.title AS chat_title
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
    WHERE s.peer_type IN ('user', 'chat')
    ORDER BY msg.last_message_at DESC NULLS LAST, s.telegram_chat_id
  `;
}

/**
 * Default chats list (no bdAccountId). Sync metadata comes from $2::json (bd-accounts internal API),
 * not from reading bd_account_sync_chats in messaging (A1).
 * $1 = organization_id, $2 = json array of { bd_account_id, telegram_chat_id, title, peer_type, folder_id }.
 * $3 = channel filter when hasChannelFilter.
 */
export function getDefaultChatsQuery(hasChannelFilter: boolean): string {
  const channelSql = hasChannelFilter ? ' AND m.channel = $3' : '';
  return `
    WITH latest_per_chat AS (
      SELECT DISTINCT ON (m.organization_id, m.channel, m.channel_id, m.bd_account_id)
        m.organization_id, m.channel, m.channel_id, m.bd_account_id, m.contact_id
      FROM messages m
      WHERE m.organization_id = $1${channelSql}
      ORDER BY m.organization_id, m.channel, m.channel_id, m.bd_account_id, COALESCE(m.telegram_date, m.created_at) DESC NULLS LAST
    ),
    unread_per_chat AS (
      SELECT m.organization_id, m.channel, m.channel_id, m.bd_account_id,
             COUNT(*) FILTER (WHERE m.unread = true) AS unread_count
      FROM messages m
      WHERE m.organization_id = $1${channelSql}
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
    LEFT JOIN json_to_recordset($2::json) AS s(
      bd_account_id uuid,
      telegram_chat_id text,
      title text,
      peer_type text,
      folder_id int
    ) ON s.bd_account_id = m.bd_account_id AND s.telegram_chat_id = m.channel_id
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
    WHERE m.organization_id = $1${channelSql}
    ORDER BY last_message_at DESC NULLS LAST
  `;
}

/**
 * Treat as personal (user) when peer_type is 'chat' but channel_id is username or positive id (not a group id).
 * Fixes campaign outreach chats that were stored with peer_type 'chat' when sending by username.
 */
function inferPeerType(peerType: string | null | undefined, channelId: string | null | undefined): string {
  const cid = channelId != null ? String(channelId).trim() : '';
  if (!cid) return peerType ?? 'user';
  const isNegativeNumeric = /^-?\d+$/.test(cid) && parseInt(cid, 10) < 0;
  if (peerType === 'chat' && !isNegativeNumeric) return 'user';
  return peerType ?? 'user';
}

/** Normalize chat row names for user peer_type when name equals account_name; fix peer_type for username-based chats. */
export function normalizeChatRows<T extends ChatListRow>(rows: T[]): T[] {
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

/**
 * True for DM user rows we can collapse by contacts.telegram_id / contact_id.
 * Excludes Telegram groups/channels (negative numeric peer ids).
 */
export function shouldDedupeTelegramDmRow(r: ChatListRow): boolean {
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

/**
 * Merge list rows that refer to the same Telegram user (username vs numeric id, sync duplicates).
 * Groups/channels (negative channel_id) are left untouched.
 */
export function dedupeTelegramUserChats<T extends ChatListRow>(rows: T[]): T[] {
  const passthrough: T[] = [];
  const groups = new Map<string, T[]>();

  for (const r of rows) {
    if (!shouldDedupeTelegramDmRow(r)) {
      passthrough.push(r);
      continue;
    }
    const key = dedupeIdentityKey(r);
    if (!key) {
      passthrough.push(r);
      continue;
    }
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const merged: T[] = [];
  for (const [, group] of groups) {
    if (group.length === 1) {
      merged.push(group[0]!);
      continue;
    }
    let winner = group[0]!;
    let winnerMs = parseLastMessageAtMs(winner);
    for (let i = 1; i < group.length; i++) {
      const g = group[i]!;
      const ms = parseLastMessageAtMs(g);
      if (ms > winnerMs) {
        winner = g;
        winnerMs = ms;
      } else if (ms === winnerMs) {
        const wNum = /^\d+$/.test(String(winner.channel_id ?? '').trim());
        const gNum = /^\d+$/.test(String(g.channel_id ?? '').trim());
        if (gNum && !wNum) winner = g;
      }
    }
    const sumUnread = group.reduce((acc, x) => acc + (Number(x.unread_count) || 0), 0);
    const out = { ...winner, unread_count: sumUnread } as T;
    merged.push(out);
  }

  return [...passthrough, ...merged];
}

function sortChatsByLastMessageAtDesc<T extends ChatListRow>(rows: T[]): T[] {
  return [...rows].sort((a, b) => parseLastMessageAtMs(b) - parseLastMessageAtMs(a));
}

/** Run sync-list query (bdAccountId branch) and return normalized rows. */
export async function runSyncListQuery(
  client: PoolClient,
  orgId: string,
  bdId: string,
  syncListJson: string
): Promise<ChatListRow[]> {
  const result = await client.query(getSyncListQuery(), [orgId, bdId, syncListJson]);
  const rows = result.rows as ChatListRow[];
  return sortChatsByLastMessageAtDesc(dedupeTelegramUserChats(normalizeChatRows(rows)));
}

/** Run default chats query and return normalized rows. */
export async function runDefaultChatsQuery(
  client: PoolClient,
  params: (string | number)[],
  hasChannelFilter: boolean
): Promise<ChatListRow[]> {
  const result = await client.query(getDefaultChatsQuery(hasChannelFilter), params);
  const rows = result.rows as ChatListRow[];
  return sortChatsByLastMessageAtDesc(dedupeTelegramUserChats(normalizeChatRows(rows)));
}
