import { Pool } from 'pg';
import {
  resolveCampaignChannelId,
  scheduleFromBdAccountRow,
  getEffectiveSchedule,
  resolveDelayRange,
  spreadOffsetSecondsForSlot,
  staggeredFirstSendAtByOffset,
  type Schedule,
  DEFAULT_DAILY_SEND_CAP,
} from './helpers';

export type TargetAudienceShape = {
  bdAccountId?: string;
  bdAccountIds?: string[];
  sendDelaySeconds?: number;
  sendDelayMinSeconds?: number;
  sendDelayMaxSeconds?: number;
  dailySendTarget?: number;
};

export type ContactRow = {
  contact_id: string;
  telegram_id: string | null;
  username: string | null;
};

/**
 * Inserts campaign participants for the given contacts. Returns how many rows were actually inserted.
 */
export async function bulkInsertCampaignParticipants(
  pool: Pool,
  opts: {
    campaignId: string;
    organizationId: string;
    contacts: ContactRow[];
    audience: TargetAudienceShape;
    campaignSchedule: Schedule;
    /** First enqueue_order index to use for spread (e.g. max existing + 1). */
    enqueueOrderBase: number;
  }
): Promise<{ inserted: number }> {
  const { campaignId, organizationId, contacts, audience, campaignSchedule, enqueueOrderBase } = opts;

  const bdAccountIdsRaw = audience.bdAccountIds ?? (audience.bdAccountId ? [audience.bdAccountId] : []);
  const bdAccountIdsFiltered = bdAccountIdsRaw.filter((id): id is string => typeof id === 'string');
  let accountIds: string[] = [];
  if (bdAccountIdsFiltered.length > 0) {
    const check = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = ANY($1::uuid[]) AND organization_id = $2 AND is_active = true',
      [bdAccountIdsFiltered, organizationId]
    );
    const order = new Map(bdAccountIdsFiltered.map((id, i) => [id, i]));
    accountIds = (check.rows as { id: string }[])
      .map((r) => r.id)
      .sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
  }
  if (accountIds.length === 0) {
    const fallback = await pool.query(
      'SELECT id FROM bd_accounts WHERE organization_id = $1 AND is_active = true LIMIT 1',
      [organizationId]
    );
    accountIds = fallback.rows.length > 0 ? [fallback.rows[0].id] : [];
  }

  let accScheduleFallback: Schedule = null;
  if (accountIds.length > 0) {
    const accSch = await pool.query(
      `SELECT timezone, working_hours_start, working_hours_end, working_days FROM bd_accounts WHERE id = $1`,
      [accountIds[0]]
    );
    accScheduleFallback = scheduleFromBdAccountRow(accSch.rows[0]);
  }
  const effectiveSchedule = getEffectiveSchedule(campaignSchedule, accScheduleFallback);
  const delayRange = resolveDelayRange(audience);

  const now = new Date();
  let insertedCount = 0;
  let contactIndex = 0;

  for (const row of contacts) {
    let bdAccountId = accountIds.length > 0 ? accountIds[contactIndex % accountIds.length]! : null;
    contactIndex++;
    let channelId: string | null = resolveCampaignChannelId(row.telegram_id, row.username);
    if (channelId && bdAccountId) {
      const chatRes = await pool.query(
        `SELECT bd_account_id, telegram_chat_id FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1`,
        [bdAccountId, channelId]
      );
      if (chatRes.rows.length > 0) {
        bdAccountId = chatRes.rows[0].bd_account_id;
        channelId = String(chatRes.rows[0].telegram_chat_id);
      }
    }
    if (!channelId || !bdAccountId) continue;

    const capRow = await pool.query('SELECT COALESCE(max_dm_per_day, -1) AS m FROM bd_accounts WHERE id = $1', [bdAccountId]);
    const dm = Number((capRow.rows[0] as { m?: number })?.m);
    const audienceDaily =
      typeof audience.dailySendTarget === 'number'
        ? Math.min(500, Math.max(1, Math.floor(audience.dailySendTarget)))
        : null;
    const dailyCap = audienceDaily ?? (Number.isFinite(dm) && dm >= 0 ? dm : DEFAULT_DAILY_SEND_CAP);

    const slotIndex = enqueueOrderBase + insertedCount;
    const spreadSec = spreadOffsetSecondsForSlot(slotIndex, dailyCap, effectiveSchedule, delayRange);
    const nextSendAt = staggeredFirstSendAtByOffset(now, spreadSec, effectiveSchedule);

    const ins = await pool.query(
      `INSERT INTO campaign_participants (campaign_id, contact_id, bd_account_id, channel_id, status, current_step, next_send_at, enqueue_order)
       VALUES ($1, $2, $3, $4, 'pending', 0, $5, $6)
       ON CONFLICT (campaign_id, contact_id) DO NOTHING
       RETURNING id`,
      [campaignId, row.contact_id, bdAccountId, channelId, nextSendAt, slotIndex]
    );
    if (ins.rowCount && ins.rows.length > 0) {
      insertedCount++;
    }
  }

  return { inserted: insertedCount };
}
