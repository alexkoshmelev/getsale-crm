import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { JobQueue } from '@getsale/queue';
import { type CampaignJobData } from './scheduler';

const SWEEP_INTERVAL_MS = 5 * 60_000;
const STALE_QUEUED_THRESHOLD_MINUTES = 10;
const STALE_IN_PROGRESS_THRESHOLD_MINUTES = 30;

interface StaleJobDeps {
  pool: Pool;
  log: Logger;
  jobQueue: JobQueue<CampaignJobData>;
}

export function startStaleJobSweeper(deps: StaleJobDeps): NodeJS.Timeout {
  const { pool, log, jobQueue } = deps;

  const sweep = async () => {
    try {
      const staleQueued = await pool.query(
        `UPDATE campaign_sends
         SET status = 'failed', metadata = jsonb_set(COALESCE(metadata, '{}'), '{stale_reason}', '"queued_timeout"')
         WHERE status = 'queued' AND sent_at < NOW() - INTERVAL '${STALE_QUEUED_THRESHOLD_MINUTES} minutes'
         RETURNING campaign_participant_id`,
      );

      if (staleQueued.rowCount && staleQueued.rowCount > 0) {
        log.info({ message: `Stale sweeper: marked ${staleQueued.rowCount} queued sends as failed` });
      }

      const staleParticipants = await pool.query(
        `SELECT cp.id, cp.campaign_id, cp.bd_account_id, cp.contact_id, cp.channel_id,
                cp.current_step, c.organization_id
         FROM campaign_participants cp
         JOIN campaigns c ON c.id = cp.campaign_id
         WHERE cp.status = 'in_progress'
           AND cp.next_send_at < NOW() - INTERVAL '${STALE_IN_PROGRESS_THRESHOLD_MINUTES} minutes'
           AND c.status = 'active'`,
      );

      for (const p of staleParticipants.rows as {
        id: string; campaign_id: string; bd_account_id: string;
        contact_id: string; channel_id: string; current_step: number; organization_id: string;
      }[]) {
        await jobQueue.add({
          name: `send:${p.campaign_id}:${p.id}:step${p.current_step}:resweep`,
          data: {
            participantId: p.id,
            campaignId: p.campaign_id,
            stepIndex: p.current_step,
            bdAccountId: p.bd_account_id,
            contactId: p.contact_id,
            channelId: p.channel_id,
            organizationId: p.organization_id,
            scheduledAt: Date.now() + 5000,
          },
          opts: {
            delay: 5000,
            jobId: `campaign-${p.campaign_id}-${p.id}-step${p.current_step}-resweep-${Date.now()}`,
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: 1000,
            removeOnFail: 5000,
          },
        });
      }

      if (staleParticipants.rowCount && staleParticipants.rowCount > 0) {
        log.info({ message: `Stale sweeper: re-enqueued ${staleParticipants.rowCount} stale in_progress participants` });
      }
    } catch (err) {
      log.warn({ message: 'Stale job sweeper error', error: String(err) });
    }
  };

  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  sweep();
  return timer;
}
