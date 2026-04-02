import { Pool } from 'pg';
import type { ServiceHttpClient } from '@getsale/service-core';
import type { Logger } from '@getsale/logger';
import type { MessageRow } from './types';

export interface MessagesListFilters {
  organizationId: string;
  contactId?: string | null;
  channel?: string | null;
  channelId?: string | null;
  bdAccountId?: string | null;
}

export interface MessagesListWhere {
  whereClause: string;
  params: unknown[];
}

/** Build WHERE clause and params for messages list query (without LIMIT/OFFSET). */
export function buildMessagesListWhere(filters: MessagesListFilters): MessagesListWhere {
  let whereClause = 'organization_id = $1';
  const params: unknown[] = [filters.organizationId];

  const telegramWithContact =
    filters.channel === 'telegram' &&
    filters.bdAccountId &&
    filters.channelId &&
    filters.contactId;

  if (telegramWithContact) {
    params.push(String(filters.channel), String(filters.channelId), String(filters.contactId), filters.bdAccountId);
    const ch = params.length - 3;
    const cid = params.length - 2;
    const cidContact = params.length - 1;
    const bd = params.length;
    whereClause += ` AND channel = $${ch} AND bd_account_id = $${bd} AND (channel_id = $${cid} OR contact_id = $${cidContact})`;
  } else {
    if (filters.contactId) {
      params.push(String(filters.contactId));
      whereClause += ` AND contact_id = $${params.length}`;
    }
    if (filters.channel && filters.channelId) {
      params.push(String(filters.channel), String(filters.channelId));
      whereClause += ` AND channel = $${params.length - 1} AND channel_id = $${params.length}`;
    }
    if (filters.bdAccountId) {
      params.push(filters.bdAccountId);
      whereClause += ` AND bd_account_id = $${params.length}`;
    }
  }
  return { whereClause, params };
}

/** Run count query for messages list. */
export async function runMessagesCount(
  pool: Pool,
  where: MessagesListWhere
): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*) AS count FROM messages WHERE ${where.whereClause}`,
    where.params
  );
  return parseInt(String(result.rows[0]?.count ?? 0), 10);
}

/** Fetch messages with ORDER BY and LIMIT/OFFSET. Returns rows in chronological order (oldest first) for display. */
export async function runMessagesListQuery(
  pool: Pool,
  where: MessagesListWhere,
  limit: number,
  offset: number
): Promise<MessageRow[]> {
  const params = [...where.params, limit, offset];
  const limitIdx = params.length - 1;
  const offsetIdx = params.length;
  const result = await pool.query(
    `SELECT * FROM messages WHERE ${where.whereClause}
     ORDER BY COALESCE(telegram_date, created_at) DESC NULLS LAST
     LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params
  );
  return (result.rows as MessageRow[]).slice().reverse();
}

/** Options to resolve sync-chat data via bd-accounts internal API (A1 ownership). */
export interface SyncChatApiOptions {
  bdAccountsClient: ServiceHttpClient;
  organizationId: string;
}

/** Get history_exhausted flag for a Telegram chat. Uses bd-accounts internal API when options provided. */
export async function getHistoryExhausted(
  pool: Pool,
  bdAccountId: string,
  telegramChatId: string,
  apiOptions?: SyncChatApiOptions
): Promise<boolean> {
  if (!apiOptions) {
    return false;
  }
  const data = await apiOptions.bdAccountsClient.get<{ chats: Array<{ telegram_chat_id: string; history_exhausted: boolean }> }>(
    `/internal/sync-chats?bdAccountId=${encodeURIComponent(bdAccountId)}`,
    undefined,
    { organizationId: apiOptions.organizationId }
  );
  const chat = data.chats?.find((c) => c.telegram_chat_id === telegramChatId);
  return Boolean(chat?.history_exhausted);
}

/** Trigger load-older-history for first page when total is 0. No return. */
export async function maybeLoadInitialHistory(
  bdAccountsClient: ServiceHttpClient,
  bdAccountId: string,
  channelId: string,
  userId: string,
  organizationId: string,
  log: Logger
): Promise<void> {
  try {
    await bdAccountsClient.post(
      `/api/bd-accounts/${bdAccountId}/chats/${channelId}/load-older-history`,
      {},
      { 'x-user-id': userId || '', 'x-organization-id': organizationId || '' }
    );
  } catch (err) {
    log.warn({ message: 'Load initial history (0 messages) request failed', error: String(err) });
  }
}

/** Trigger load-older-history when needOffset >= total. Returns new total if load added messages, else total. */
export async function maybeLoadOlderHistoryAndGetTotal(
  pool: Pool,
  bdAccountsClient: ServiceHttpClient,
  where: MessagesListWhere,
  bdAccountId: string,
  channelId: string,
  channel: string,
  userId: string,
  organizationId: string,
  currentTotal: number,
  needOffset: number,
  log: Logger
): Promise<number> {
  if (needOffset < currentTotal) return currentTotal;
  const exhausted = await getHistoryExhausted(pool, bdAccountId, channelId, {
    bdAccountsClient,
    organizationId,
  });
  if (exhausted) return currentTotal;
  try {
    const data = await bdAccountsClient.post<{ added?: number }>(
      `/api/bd-accounts/${bdAccountId}/chats/${channelId}/load-older-history`,
      {},
      { 'x-user-id': userId || '', 'x-organization-id': organizationId || '' }
    );
    if ((data.added ?? 0) > 0) {
      return runMessagesCount(pool, where);
    }
  } catch (err) {
    log.warn({ message: 'Load older history request failed', error: String(err) });
  }
  return currentTotal;
}

/** Enrich message rows with sender_name for chat/channel peer types (inbound messages from contacts). Uses bd-accounts API when apiOptions provided. */
export async function enrichMessagesWithSenderNames(
  pool: Pool,
  rows: MessageRow[],
  bdAccountId: string,
  channelId: string,
  apiOptions?: SyncChatApiOptions
): Promise<MessageRow[]> {
  let peerType: string | undefined;
  if (apiOptions) {
    const data = await apiOptions.bdAccountsClient.get<{ chats: Array<{ telegram_chat_id: string; peer_type: string }> }>(
      `/internal/sync-chats?bdAccountId=${encodeURIComponent(bdAccountId)}`,
      undefined,
      { organizationId: apiOptions.organizationId }
    );
    const chat = data.chats?.find((c) => c.telegram_chat_id === channelId);
    peerType = chat?.peer_type;
  }
  if (!peerType || (peerType !== 'chat' && peerType !== 'channel')) {
    return rows;
  }
  const inboundContactIds = [...new Set(
    rows.filter((r) => r.direction === 'inbound' && r.contact_id).map((r) => r.contact_id as string)
  )];
  if (inboundContactIds.length === 0) return rows;
  const contactsRes = await pool.query(
    `SELECT id, COALESCE(NULLIF(TRIM(display_name), ''), NULLIF(TRIM(CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,''))), ''), username, telegram_id::text) AS display_name
     FROM contacts WHERE id = ANY($1::uuid[])`,
    [inboundContactIds]
  );
  const senderNames: Record<string, string> = {};
  for (const c of contactsRes.rows as { id: string; display_name: string | null }[]) {
    senderNames[c.id] = (c.display_name && c.display_name.trim()) ? c.display_name.trim() : c.id.slice(0, 8);
  }
  return rows.map((r) =>
    r.direction === 'inbound' && r.contact_id
      ? { ...r, sender_name: senderNames[r.contact_id] ?? null }
      : r
  );
}
