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
      `SELECT c.* FROM campaigns c WHERE c.id = $1`,
      [campaignId],
    );

    if (!campaign.rows.length) {
      this.log.warn({ message: `Campaign ${campaignId} not found` });
      return 0;
    }

    const camp = campaign.rows[0];

    const audience = (camp.target_audience || {}) as {
      dailySendTarget?: number;
      sendDelayMinSeconds?: number;
      sendDelayMaxSeconds?: number;
      sendDelaySeconds?: number;
    };

    const delayMinMs = ((audience.sendDelayMinSeconds ?? audience.sendDelaySeconds ?? 68) * 1000);
    const delayMaxMs = ((audience.sendDelayMaxSeconds ?? audience.sendDelaySeconds ?? 84) * 1000);

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
    const FIRST_SEND_DELAY_MS = 5000;
    let cumulativeDelay = FIRST_SEND_DELAY_MS;

    const jobs = participants.rows.map((p: Record<string, string>, idx: number) => {
      if (idx > 0) {
        const randDelay = delayMinMs + Math.random() * (delayMaxMs - delayMinMs);
        cumulativeDelay += Math.floor(randDelay);
      }
      const delay = cumulativeDelay;
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
          jobId: `campaign-${campaignId}-${p.id}`,
          attempts: 3,
          backoff: { type: 'exponential' as const, delay: 5000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      };
    });

    await this.pool.query(
      "UPDATE campaigns SET status = 'active', updated_at = NOW() WHERE id = $1",
      [campaignId],
    );

    await this.jobQueue.addBulk(jobs);

    for (const job of jobs) {
      const nextSendAt = new Date(job.data.scheduledAt);
      await this.pool.query(
        'UPDATE campaign_participants SET next_send_at = $1 WHERE id = $2',
        [nextSendAt, job.data.participantId],
      );
    }

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
    const cached = await this.redis.get<Record<string, unknown>>(cacheKey);
    if (cached) return cached;

    const [
      totalRes, byStatusRes, totalSendsRes, contactsSentRes, dateRangeRes,
      totalReadRes, totalSharedRes, avgTimeToSharedRes,
      totalWonRes, totalLostRes, totalRevenueRes, avgTimeToWonRes,
    ] = await Promise.all([
      this.pool.query('SELECT COUNT(*)::int AS total FROM campaign_participants WHERE campaign_id = $1', [campaignId]),
      this.pool.query('SELECT status, COUNT(*)::int AS cnt FROM campaign_participants WHERE campaign_id = $1 GROUP BY status', [campaignId]),
      this.pool.query(
        `SELECT COUNT(*)::int AS cnt FROM campaign_sends cs JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id WHERE cp.campaign_id = $1 AND cs.status IN ('sent', 'queued')`,
        [campaignId],
      ),
      this.pool.query(
        `SELECT COUNT(DISTINCT cp.id)::int AS cnt FROM campaign_sends cs JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id WHERE cp.campaign_id = $1 AND cs.status IN ('sent', 'queued')`,
        [campaignId],
      ),
      this.pool.query(
        `SELECT MIN(cs.sent_at) AS first_send_at, MAX(cs.sent_at) AS last_send_at FROM campaign_sends cs JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id WHERE cp.campaign_id = $1 AND cs.status IN ('sent', 'queued')`,
        [campaignId],
      ),
      this.pool.query(
        `SELECT COUNT(DISTINCT cp.id)::int AS cnt FROM campaign_participants cp
         INNER JOIN campaign_sends cs ON cs.campaign_participant_id = cp.id
         WHERE cp.campaign_id = $1 AND cs.status = 'sent'
           AND (cs.read_at IS NOT NULL OR EXISTS (
             SELECT 1 FROM messages m WHERE m.id = cs.message_id AND m.status = 'read'
           ))`,
        [campaignId],
      ),
      this.pool.query(
        `SELECT COUNT(*)::int AS cnt FROM conversations WHERE campaign_id = $1 AND shared_chat_created_at IS NOT NULL`,
        [campaignId],
      ),
      this.pool.query(
        `SELECT AVG(EXTRACT(EPOCH FROM (c.shared_chat_created_at - fs.first_sent_at)) / 3600.0) AS avg_hours
         FROM conversations c JOIN LATERAL (
           SELECT MIN(cs.sent_at) AS first_sent_at FROM campaign_sends cs JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
           WHERE cp.campaign_id = c.campaign_id AND cp.bd_account_id = c.bd_account_id AND cp.channel_id = c.channel_id AND cs.status = 'sent'
         ) fs ON fs.first_sent_at IS NOT NULL WHERE c.campaign_id = $1 AND c.shared_chat_created_at IS NOT NULL`,
        [campaignId],
      ),
      this.pool.query(`SELECT COUNT(*)::int AS cnt FROM conversations WHERE campaign_id = $1 AND won_at IS NOT NULL`, [campaignId]),
      this.pool.query(`SELECT COUNT(*)::int AS cnt FROM conversations WHERE campaign_id = $1 AND lost_at IS NOT NULL`, [campaignId]),
      this.pool.query(`SELECT COALESCE(SUM(revenue_amount), 0)::numeric AS total FROM conversations WHERE campaign_id = $1 AND won_at IS NOT NULL`, [campaignId]),
      this.pool.query(
        `SELECT AVG(EXTRACT(EPOCH FROM (c.won_at - fs.first_sent_at)) / 3600.0) AS avg_hours
         FROM conversations c JOIN LATERAL (
           SELECT MIN(cs.sent_at) AS first_sent_at FROM campaign_sends cs JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
           WHERE cp.campaign_id = c.campaign_id AND cp.bd_account_id = c.bd_account_id AND cp.channel_id = c.channel_id AND cs.status = 'sent'
         ) fs ON fs.first_sent_at IS NOT NULL WHERE c.campaign_id = $1 AND c.won_at IS NOT NULL`,
        [campaignId],
      ),
    ]);

    const total = totalRes.rows[0]?.total ?? 0;
    const byStatus: Record<string, number> = {};
    for (const r of byStatusRes.rows as { status: string; cnt: number }[]) byStatus[r.status] = r.cnt;

    const totalSends = totalSendsRes.rows[0]?.cnt ?? 0;
    const contactsSent = contactsSentRes.rows[0]?.cnt ?? 0;
    const totalSent = contactsSent;
    const totalRead = totalReadRes.rows[0]?.cnt ?? 0;
    const replied = byStatus.replied ?? 0;
    const totalReplied = replied;
    const totalConvertedToSharedChat = totalSharedRes.rows[0]?.cnt ?? 0;
    const totalWon = totalWonRes.rows[0]?.cnt ?? 0;
    const totalLost = totalLostRes.rows[0]?.cnt ?? 0;
    const totalRevenue = Number(totalRevenueRes.rows[0]?.total ?? 0);

    const readRate = totalSent > 0 ? Math.round((totalRead / totalSent) * 1000) / 10 : 0;
    const replyRate = totalRead > 0 ? Math.round((totalReplied / totalRead) * 1000) / 10 : 0;
    const conversionRate = total > 0 ? Math.round((replied / total) * 100) : 0;
    const sharedConversionRate = totalReplied > 0 ? Math.round((totalConvertedToSharedChat / totalReplied) * 1000) / 10 : 0;
    const winRate = totalReplied > 0 ? Math.round((totalWon / totalReplied) * 1000) / 10 : 0;
    const revenuePerSent = totalSent > 0 ? Math.round((totalRevenue / totalSent) * 100) / 100 : 0;
    const revenuePerReply = totalReplied > 0 ? Math.round((totalRevenue / totalReplied) * 100) / 100 : 0;
    const avgRevenuePerWon = totalWon > 0 ? Math.round((totalRevenue / totalWon) * 100) / 100 : 0;

    const dr = dateRangeRes.rows[0] as { first_send_at: string | null; last_send_at: string | null } | undefined;
    const avgHoursRaw = avgTimeToSharedRes.rows[0]?.avg_hours;
    const avgTimeToSharedHours = avgHoursRaw != null ? Math.round(parseFloat(String(avgHoursRaw)) * 10) / 10 : null;
    const avgTimeToWonRaw = avgTimeToWonRes.rows[0]?.avg_hours;
    const avgTimeToWonHours = avgTimeToWonRaw != null ? Math.round(parseFloat(String(avgTimeToWonRaw)) * 10) / 10 : null;

    const failedCount = byStatus.failed ?? 0;
    let errorSample: string | undefined;
    if (failedCount > 0) {
      const sampleRes = await this.pool.query(
        `SELECT metadata->>'lastError' AS last_error FROM campaign_participants WHERE campaign_id = $1 AND status = 'failed' AND (metadata->>'lastError') IS NOT NULL ORDER BY updated_at DESC LIMIT 1`,
        [campaignId],
      );
      const val = sampleRes.rows[0]?.last_error;
      if (typeof val === 'string' && val.trim()) errorSample = val;
    }

    const byPhase = {
      waiting: (byStatus.pending ?? 0) + (byStatus.in_progress ?? 0) + (byStatus.awaiting_reply ?? 0),
      sent: byStatus.sent ?? 0,
      replied: byStatus.replied ?? 0,
      failed: (byStatus.failed ?? 0) + (byStatus.skipped ?? 0),
    };

    const stats: Record<string, unknown> = {
      total,
      byStatus,
      byPhase,
      ...(failedCount > 0 && { error_summary: { count: failedCount, sample: errorSample } }),
      totalSends,
      contactsSent,
      conversionRate,
      firstSendAt: dr?.first_send_at ?? null,
      lastSendAt: dr?.last_send_at ?? null,
      total_sent: totalSent,
      total_read: totalRead,
      total_replied: totalReplied,
      total_converted_to_shared_chat: totalConvertedToSharedChat,
      read_rate: readRate,
      reply_rate: replyRate,
      conversion_rate: sharedConversionRate,
      avg_time_to_shared_hours: avgTimeToSharedHours,
      total_won: totalWon,
      total_lost: totalLost,
      total_revenue: totalRevenue,
      win_rate: winRate,
      revenue_per_sent: revenuePerSent,
      revenue_per_reply: revenuePerReply,
      avg_revenue_per_won: avgRevenuePerWon,
      avg_time_to_won_hours: avgTimeToWonHours,
    };

    await this.redis.set(cacheKey, stats, 15);
    return stats;
  }
}
