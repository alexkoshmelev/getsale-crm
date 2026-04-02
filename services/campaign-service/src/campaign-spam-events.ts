import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import type { RabbitMQClient } from '@getsale/utils';
import type { Logger } from '@getsale/logger';
import { EventType } from '@getsale/events';
import { CampaignStatus } from '@getsale/types';

/**
 * When a BD account is marked spam-restricted: auto-pause single-account campaigns,
 * defer participants on multi-account campaigns, audit campaign_sends.
 */
export async function handleBdAccountSpamRestricted(
  pool: Pool,
  rabbitmq: RabbitMQClient,
  log: Logger,
  bdAccountId: string,
  organizationId: string
): Promise<void> {
  const camps = await pool.query(
    `SELECT DISTINCT c.id, c.organization_id, c.status
     FROM campaigns c
     INNER JOIN campaign_participants cp ON cp.campaign_id = c.id AND cp.bd_account_id = $1
     WHERE c.organization_id = $2 AND c.deleted_at IS NULL AND c.status = $3`,
    [bdAccountId, organizationId, CampaignStatus.ACTIVE]
  );

  for (const row of camps.rows as { id: string; organization_id: string; status: string }[]) {
    const campaignId = row.id;

    const distRes = await pool.query(
      `SELECT COUNT(DISTINCT bd_account_id)::int AS n
       FROM campaign_participants
       WHERE campaign_id = $1 AND status IN ('pending', 'sent')`,
      [campaignId]
    );
    const distinctAccounts = Number((distRes.rows[0] as { n?: number })?.n ?? 0);
    if (distinctAccounts === 0) continue;

    const deferAfter = new Date(Date.now() + 24 * 3600 * 1000);

    await pool.query(
      `INSERT INTO campaign_sends (campaign_participant_id, sequence_step, message_id, sent_at, status, metadata)
       SELECT id, current_step, NULL, NOW(), 'deferred',
              jsonb_build_object('event', 'account_spam_restricted', 'bdAccountId', $2::text)
       FROM campaign_participants
       WHERE campaign_id = $1 AND bd_account_id = $2 AND status IN ('pending', 'sent')`,
      [campaignId, bdAccountId]
    );

    await pool.query(
      `UPDATE campaign_participants
       SET next_send_at = $3, metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('deferredSpamRestriction', true),
           updated_at = NOW()
       WHERE campaign_id = $1 AND bd_account_id = $2 AND status IN ('pending', 'sent')`,
      [campaignId, bdAccountId, deferAfter.toISOString()]
    );

    if (distinctAccounts === 1) {
      const upd = await pool.query(
        `UPDATE campaigns SET status = $1, updated_at = NOW()
         WHERE id = $2 AND organization_id = $3 AND status = $4
         RETURNING id`,
        [CampaignStatus.PAUSED, campaignId, organizationId, CampaignStatus.ACTIVE]
      );
      if (upd.rows.length > 0) {
        log.warn({
          message: 'Campaign auto-paused due to BD account spam restriction',
          campaignId,
          bdAccountId,
        });
        try {
          await rabbitmq.publishEvent({
            id: randomUUID(),
            type: EventType.CAMPAIGN_PAUSED,
            timestamp: new Date(),
            organizationId,
            data: { campaignId },
          });
        } catch (e: unknown) {
          log.warn({ message: 'CAMPAIGN_PAUSED publish failed (spam)', campaignId, error: String(e) });
        }
      }
    }
  }
}
