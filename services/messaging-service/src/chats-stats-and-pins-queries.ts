import { Pool } from 'pg';
import type { PinnedChatRow, QueryParam } from './types';

export async function queryMessagingStats(
  pool: Pool,
  organizationId: string | number,
  filters: { startDate?: string; endDate?: string }
): Promise<{ stats: unknown[]; unreadCount: number }> {
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

  if (filters.startDate) {
    query += ` AND created_at >= $${params.length + 1}`;
    params.push(String(filters.startDate));
  }
  if (filters.endDate) {
    query += ` AND created_at <= $${params.length + 1}`;
    params.push(String(filters.endDate));
  }

  query += ` GROUP BY channel, direction, status`;

  const result = await pool.query(query, params);
  const unreadResult = await pool.query(
    'SELECT COUNT(*) as count FROM messages WHERE organization_id = $1 AND unread = true',
    [organizationId]
  );

  return {
    stats: result.rows,
    unreadCount: parseInt(String(unreadResult.rows[0].count), 10),
  };
}

export async function listPinnedChatsForAccount(
  pool: Pool,
  userId: string | number,
  organizationId: string | number,
  bdAccountId: string
): Promise<Array<{ channel_id: string; order_index: number }>> {
  const result = await pool.query(
    `SELECT channel_id, order_index FROM user_chat_pins
     WHERE user_id = $1 AND organization_id = $2 AND bd_account_id = $3
     ORDER BY order_index ASC, created_at ASC`,
    [userId, organizationId, bdAccountId]
  );
  return result.rows.map((r: unknown) => {
    const row = r as PinnedChatRow;
    return { channel_id: row.channel_id, order_index: row.order_index };
  });
}

export async function appendPinnedChatForUser(
  pool: Pool,
  userId: string | number,
  organizationId: string | number,
  bdAccountId: string,
  channelId: string
): Promise<{ channel_id: string; order_index: number }> {
  const maxResult = await pool.query(
    `SELECT COALESCE(MAX(order_index), -1) + 1 AS next_index FROM user_chat_pins
     WHERE user_id = $1 AND organization_id = $2 AND bd_account_id = $3`,
    [userId, organizationId, bdAccountId]
  );
  const nextIndex = maxResult.rows[0]?.next_index ?? 0;
  await pool.query(
    `INSERT INTO user_chat_pins (user_id, organization_id, bd_account_id, channel_id, order_index)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, organization_id, bd_account_id, channel_id) DO UPDATE SET order_index = EXCLUDED.order_index`,
    [userId, organizationId, bdAccountId, channelId, nextIndex]
  );
  return { channel_id: channelId, order_index: nextIndex };
}

export async function deletePinnedChatForUser(
  pool: Pool,
  userId: string | number,
  organizationId: string | number,
  bdAccountId: string,
  channelId: string
): Promise<void> {
  await pool.query(
    `DELETE FROM user_chat_pins
     WHERE user_id = $1 AND organization_id = $2 AND bd_account_id = $3 AND channel_id = $4`,
    [userId, organizationId, bdAccountId, channelId]
  );
}

/** Replaces all pins for (user, org, bd account) with ordered channel ids (same semantics as previous route loop). */
export async function replacePinnedChatsOrdered(
  pool: Pool,
  userId: string | number,
  organizationId: string | number,
  bdAccountId: string,
  channelIds: string[]
): Promise<number> {
  await pool.query(
    `DELETE FROM user_chat_pins
     WHERE user_id = $1 AND organization_id = $2 AND bd_account_id = $3`,
    [userId, organizationId, bdAccountId]
  );
  for (let i = 0; i < channelIds.length; i++) {
    await pool.query(
      `INSERT INTO user_chat_pins (user_id, organization_id, bd_account_id, channel_id, order_index)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, organization_id, bd_account_id, channel_id) DO UPDATE SET order_index = EXCLUDED.order_index`,
      [userId, organizationId, bdAccountId, channelIds[i], i]
    );
  }
  return channelIds.length;
}
