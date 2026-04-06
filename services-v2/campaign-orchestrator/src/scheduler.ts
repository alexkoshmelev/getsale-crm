import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { JobQueue } from '@getsale/queue';
import { RedisClient } from '@getsale/cache';

export interface CampaignJobData {
  participantId: string;
  campaignId: string;
  stepIndex: number;
  bdAccountId: string;
  contactId: string;
  channelId?: string;
  organizationId: string;
  scheduledAt: number;
}

/**
 * Schedules campaign send jobs using BullMQ delayed jobs.
 * Replaces the old setInterval-based campaign loop.
 */
export class CampaignScheduler {
  private pool: Pool;
  private log: Logger;
  private jobQueue: JobQueue<CampaignJobData>;
  private redis: RedisClient;

  constructor(config: {
    pool: Pool;
    log: Logger;
    jobQueue: JobQueue<CampaignJobData>;
    redis: RedisClient;
  }) {
    this.pool = config.pool;
    this.log = config.log;
    this.jobQueue = config.jobQueue;
    this.redis = config.redis;
  }

  /**
   * Schedule all participants for a campaign.
   * Spreads sends across working hours using slot-based scheduling.
   */
  async scheduleCampaign(campaignId: string): Promise<number> {
    const campaign = await this.pool.query(
      `SELECT c.*, cs.daily_limit, cs.working_hours_start, cs.working_hours_end
       FROM campaigns c LEFT JOIN campaign_settings cs ON cs.campaign_id = c.id
       WHERE c.id = $1`,
      [campaignId],
    );

    if (!campaign.rows.length) {
      this.log.warn({ message: `Campaign ${campaignId} not found` });
      return 0;
    }

    const camp = campaign.rows[0];
    const participants = await this.pool.query(
      `SELECT cp.id, cp.contact_id, cp.bd_account_id, cp.channel_id
       FROM campaign_participants cp
       WHERE cp.campaign_id = $1 AND cp.status = 'pending'
       ORDER BY cp.created_at`,
      [campaignId],
    );

    if (!participants.rows.length) {
      this.log.info({ message: `No pending participants for campaign ${campaignId}` });
      return 0;
    }

    const now = Date.now();
    const workStart = camp.working_hours_start ?? 9;
    const workEnd = camp.working_hours_end ?? 18;
    const dailyLimit = camp.daily_limit ?? 50;
    const slotDurationMs = ((workEnd - workStart) * 3600 * 1000) / Math.min(participants.rows.length, dailyLimit);

    const jobs = participants.rows.map((p: Record<string, string>, idx: number) => {
      const delay = Math.max(0, Math.floor(idx * slotDurationMs + Math.random() * slotDurationMs * 0.3));
      const scheduledAt = now + delay;

      return {
        name: `send:${campaignId}:${p.id}`,
        data: {
          participantId: p.id,
          campaignId,
          stepIndex: 0,
          bdAccountId: p.bd_account_id,
          contactId: p.contact_id,
          channelId: p.channel_id,
          organizationId: camp.organization_id,
          scheduledAt,
        },
        opts: {
          delay,
          jobId: `campaign:${campaignId}:${p.id}`,
          attempts: 3,
          backoff: { type: 'exponential' as const, delay: 5000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      };
    });

    await this.jobQueue.addBulk(jobs);

    await this.pool.query(
      "UPDATE campaigns SET status = 'active', started_at = NOW(), updated_at = NOW() WHERE id = $1",
      [campaignId],
    );

    this.log.info({ message: `Scheduled ${jobs.length} jobs for campaign ${campaignId}` });
    return jobs.length;
  }

  /**
   * Cancel all pending jobs for a campaign.
   */
  async cancelCampaign(campaignId: string): Promise<number> {
    const removed = await this.jobQueue.removeByPattern(`campaign:${campaignId}`);

    await this.pool.query(
      "UPDATE campaigns SET status = 'paused', updated_at = NOW() WHERE id = $1",
      [campaignId],
    );

    this.log.info({ message: `Cancelled ${removed} jobs for campaign ${campaignId}` });
    return removed;
  }

  async getCampaignStats(campaignId: string): Promise<Record<string, unknown>> {
    const cacheKey = `campaign:stats:${campaignId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached as Record<string, unknown>;

    const result = await this.pool.query(
      `SELECT status, COUNT(*)::int as count FROM campaign_participants WHERE campaign_id = $1 GROUP BY status`,
      [campaignId],
    );

    const stats: Record<string, number> = {};
    for (const row of result.rows) {
      stats[row.status] = row.count;
    }

    await this.redis.set(cacheKey, stats, 30);
    return stats;
  }
}
