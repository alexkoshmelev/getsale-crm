import type { Pool } from 'pg';
import type { Logger } from '@getsale/logger';
import { CampaignStatus } from '@getsale/types';
import {
  type Schedule,
  getEffectiveSchedule,
  resolveDelayRange,
  scheduleFromBdAccountRow,
  spreadOffsetSecondsForSlot,
  staggeredFirstSendAtByOffset,
  DEFAULT_DAILY_SEND_CAP,
} from './helpers';

export type TargetAudienceForReschedule = {
  bdAccountId?: string;
  bdAccountIds?: string[];
  sendDelaySeconds?: number;
  sendDelayMinSeconds?: number;
  sendDelayMaxSeconds?: number;
  dailySendTarget?: number;
};

/**
 * Recalculate next_send_at from now for pending participants (first send not done yet).
 * Used on resume-from-pause and when a BD account exits FLOOD_WAIT.
 *
 * @param onlyBdAccountId — if set, only participants assigned to this BD account are updated (multi-account campaigns).
 */
export async function recalculatePendingNextSendAtForCampaign(
  pool: Pool,
  opts: {
    campaignId: string;
    organizationId: string;
    audience: TargetAudienceForReschedule;
    campaignSchedule: Schedule;
    /** Restrict reschedule to participants on this BD account (e.g. after flood cleared on that account). */
    onlyBdAccountId?: string | null;
  }
): Promise<void> {
  const { campaignId, organizationId, audience, campaignSchedule, onlyBdAccountId } = opts;

  /** First-send queue only: status stays `pending` until the first message is delivered. */
  const pendingRes = await pool.query(
    `SELECT id, enqueue_order, bd_account_id,
            (ROW_NUMBER() OVER (PARTITION BY bd_account_id ORDER BY enqueue_order) - 1)::int AS slot_index
     FROM campaign_participants
     WHERE campaign_id = $1
       AND status = 'pending'
       AND current_step = 0
       AND next_send_at IS NOT NULL
       AND ($2::uuid IS NULL OR bd_account_id = $2)
     ORDER BY bd_account_id, enqueue_order`,
    [campaignId, onlyBdAccountId ?? null]
  );
  const rows = pendingRes.rows as {
    id: string;
    enqueue_order: number | string;
    bd_account_id: string;
    slot_index: number;
  }[];
  if (rows.length === 0) return;

  const bdAccountIdsRaw = audience.bdAccountIds ?? (audience.bdAccountId ? [audience.bdAccountId] : []);
  let accSchedule: Schedule = null;
  if (bdAccountIdsRaw.length > 0) {
    const schRow = await pool.query(
      'SELECT timezone, working_hours_start, working_hours_end, working_days FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [bdAccountIdsRaw[0], organizationId]
    );
    if (schRow.rows.length > 0) {
      accSchedule = scheduleFromBdAccountRow(schRow.rows[0]);
    }
  }
  const effectiveSch = getEffectiveSchedule(campaignSchedule, accSchedule);
  const delayRange = resolveDelayRange(audience);
  const now = new Date();

  const audienceDaily =
    typeof audience.dailySendTarget === 'number'
      ? Math.min(500, Math.max(1, Math.floor(audience.dailySendTarget)))
      : null;

  for (const row of rows) {
    const capRow = await pool.query('SELECT COALESCE(max_dm_per_day, -1) AS m FROM bd_accounts WHERE id = $1', [row.bd_account_id]);
    const dm = Number((capRow.rows[0] as { m?: number })?.m);
    const dailyCap = audienceDaily ?? (Number.isFinite(dm) && dm >= 0 ? dm : DEFAULT_DAILY_SEND_CAP);
    /** Dense index among remaining first-send pendings per BD account — not global enqueue_order (avoids multi-day gap after resume when many rows already sent/failed). */
    const slotOrder = Math.max(0, Number(row.slot_index) || 0);
    const spreadSec = spreadOffsetSecondsForSlot(slotOrder, dailyCap, effectiveSch, delayRange);
    const nextSendAt = staggeredFirstSendAtByOffset(now, spreadSec, effectiveSch);
    await pool.query(
      'UPDATE campaign_participants SET next_send_at = $1, updated_at = NOW() WHERE id = $2',
      [nextSendAt, row.id]
    );
  }
}

/**
 * After FLOOD_WAIT clears on a BD account, stagger next_send_at from now for pending participants
 * still waiting for their first message on that account across active campaigns.
 */
export async function recalculatePendingForCampaignsUsingBdAccount(
  pool: Pool,
  bdAccountId: string,
  log: Logger
): Promise<void> {
  const cr = await pool.query(
    `SELECT DISTINCT cp.campaign_id, c.organization_id
     FROM campaign_participants cp
     JOIN campaigns c ON c.id = cp.campaign_id
     WHERE cp.bd_account_id = $1::uuid
       AND c.status = $2
       AND cp.status = 'pending'
       AND cp.next_send_at IS NOT NULL`,
    [bdAccountId, CampaignStatus.ACTIVE]
  );
  if (cr.rows.length === 0) return;
  let ok = 0;
  for (const row of cr.rows) {
    const campaignId = row.campaign_id as string;
    const orgId = row.organization_id as string;
    const campRes = await pool.query(
      'SELECT target_audience, schedule FROM campaigns WHERE id = $1 AND organization_id = $2',
      [campaignId, orgId]
    );
    if (campRes.rows.length === 0) continue;
    const campaign = campRes.rows[0];
    const audience = (campaign.target_audience || {}) as TargetAudienceForReschedule;
    const campaignSchedule = (campaign.schedule as Schedule) ?? null;
    try {
      await recalculatePendingNextSendAtForCampaign(pool, {
        campaignId,
        organizationId: orgId,
        audience,
        campaignSchedule,
        onlyBdAccountId: bdAccountId,
      });
      ok++;
    } catch (err) {
      log.warn({
        message: 'Campaign reschedule after flood failed',
        bdAccountId,
        campaignId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  log.info({
    message: 'Pending campaign sends rescheduled after BD FLOOD_WAIT cleared',
    bdAccountId,
    campaignsAffected: ok,
    campaignsConsidered: cr.rows.length,
  });
}
