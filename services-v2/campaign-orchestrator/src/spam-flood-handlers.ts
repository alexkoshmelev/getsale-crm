import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { EventType } from '@getsale/events';
import { Logger } from '@getsale/logger';
import { type RabbitMQClient } from '@getsale/queue';
import { RedisClient } from '@getsale/cache';
import { JobQueue } from '@getsale/queue';
import { type CampaignJobData } from './scheduler';

interface SpamFloodDeps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  redis: RedisClient;
  jobQueue: JobQueue<CampaignJobData>;
}

export async function subscribeToSpamFloodEvents(deps: SpamFloodDeps): Promise<void> {
  const { pool, rabbitmq, log, redis, jobQueue } = deps;

  await rabbitmq.subscribeToEvents(
    [
      EventType.BD_ACCOUNT_SPAM_RESTRICTED,
      EventType.BD_ACCOUNT_SPAM_CLEARED,
      EventType.BD_ACCOUNT_FLOOD_CLEARED,
    ],
    async (event: any) => {
      const bdAccountId = event.data?.bdAccountId ?? null;
      if (!bdAccountId) return;
      const orgId = event.organizationId ?? '';

      try {
        switch (event.type) {
          case EventType.BD_ACCOUNT_SPAM_RESTRICTED:
            await handleBdAccountSpamRestricted(pool, rabbitmq, log, redis, bdAccountId, orgId);
            break;
          case EventType.BD_ACCOUNT_SPAM_CLEARED:
          case EventType.BD_ACCOUNT_FLOOD_CLEARED:
            await recalculatePendingForCampaignsUsingBdAccount(pool, log, redis, jobQueue, bdAccountId);
            break;
        }
      } catch (err) {
        log.warn({ message: 'Spam/flood event handler error', eventType: event.type, error: String(err) });
      }
    },
    'events',
    'campaign-spam-flood-v2',
  );

  log.info({ message: 'Spam/flood event subscriptions active' });
}

async function handleBdAccountSpamRestricted(
  pool: Pool,
  rabbitmq: RabbitMQClient,
  log: Logger,
  redis: RedisClient,
  bdAccountId: string,
  organizationId: string,
): Promise<void> {
  const campaignsRes = await pool.query(
    `SELECT DISTINCT c.id FROM campaigns c
     JOIN campaign_participants cp ON cp.campaign_id = c.id
     WHERE c.status = 'active'
       AND cp.bd_account_id = $1
       AND cp.status IN ('pending','sent','in_progress','awaiting_reply')`,
    [bdAccountId],
  );

  for (const row of campaignsRes.rows as { id: string }[]) {
    const campaignId = row.id;

    const participants = await pool.query(
      `SELECT cp.id FROM campaign_participants cp
       WHERE cp.campaign_id = $1 AND cp.bd_account_id = $2
         AND cp.status IN ('pending','sent','in_progress')`,
      [campaignId, bdAccountId],
    );

    for (const p of participants.rows as { id: string }[]) {
      await pool.query(
        `INSERT INTO campaign_sends (campaign_participant_id, sequence_step, sent_at, status, metadata)
         VALUES ($1, 0, NOW(), 'deferred', $2)`,
        [p.id, JSON.stringify({ event: 'account_spam_restricted', bdAccountId })],
      );
    }

    await pool.query(
      `UPDATE campaign_participants
       SET next_send_at = NOW() + INTERVAL '24 hours', updated_at = NOW()
       WHERE campaign_id = $1 AND bd_account_id = $2 AND status IN ('pending','in_progress')`,
      [campaignId, bdAccountId],
    );

    const accountCount = await pool.query(
      `SELECT COUNT(DISTINCT bd_account_id)::int AS c FROM campaign_participants
       WHERE campaign_id = $1 AND status IN ('pending','sent','in_progress','awaiting_reply')`,
      [campaignId],
    );
    const distinctAccounts = Number(accountCount.rows[0]?.c ?? 0);

    if (distinctAccounts <= 1) {
      await pool.query("UPDATE campaigns SET status = 'paused', updated_at = NOW() WHERE id = $1 AND status = 'active'", [campaignId]);
      rabbitmq.publishEvent({
        id: randomUUID(),
        type: EventType.CAMPAIGN_PAUSED,
        timestamp: new Date(),
        organizationId,
        userId: '',
        data: { campaignId },
      } as any).catch(() => {});
      log.info({ message: `Campaign ${campaignId} paused (single-account spam restricted)`, bdAccountId });
    }

    await redis.del(`campaign:stats:${campaignId}`);
  }

  log.info({ message: `Spam restricted handler processed for ${bdAccountId}`, campaigns: campaignsRes.rows.length });
}

export async function recalculatePendingForCampaignsUsingBdAccount(
  pool: Pool,
  log: Logger,
  redis: RedisClient,
  jobQueue: JobQueue<CampaignJobData>,
  bdAccountId: string,
): Promise<void> {
  const campaignsRes = await pool.query(
    `SELECT DISTINCT c.id, c.target_audience FROM campaigns c
     JOIN campaign_participants cp ON cp.campaign_id = c.id
     WHERE c.status = 'active'
       AND cp.bd_account_id = $1
       AND cp.status = 'pending'
       AND cp.next_send_at IS NOT NULL`,
    [bdAccountId],
  );

  for (const row of campaignsRes.rows as { id: string; target_audience: any }[]) {
    const campaignId = row.id;
    const audience = (row.target_audience ?? {}) as { sendDelayMinSeconds?: number; sendDelayMaxSeconds?: number };
    const minDelay = audience.sendDelayMinSeconds ?? 68;
    const maxDelay = audience.sendDelayMaxSeconds ?? 84;

    const participants = await pool.query(
      `SELECT cp.id, cp.contact_id, cp.channel_id FROM campaign_participants cp
       WHERE cp.campaign_id = $1 AND cp.bd_account_id = $2
         AND cp.status = 'pending' AND cp.current_step = 0 AND cp.next_send_at IS NOT NULL
       ORDER BY cp.next_send_at`,
      [campaignId, bdAccountId],
    );

    const now = Date.now();
    let cumulativeDelay = 5000;

    for (const p of participants.rows as { id: string; contact_id: string; channel_id: string }[]) {
      const delay = (minDelay + Math.random() * (maxDelay - minDelay)) * 1000;
      cumulativeDelay += delay;
      const nextSendAt = new Date(now + cumulativeDelay);

      await pool.query(
        'UPDATE campaign_participants SET next_send_at = $1, updated_at = NOW() WHERE id = $2',
        [nextSendAt, p.id],
      );

      await jobQueue.add({
        name: `send:${campaignId}:${p.id}:step0`,
        data: {
          participantId: p.id,
          campaignId,
          stepIndex: 0,
          bdAccountId,
          contactId: p.contact_id,
          channelId: p.channel_id,
          organizationId: '',
          scheduledAt: now + cumulativeDelay,
        },
        opts: {
          delay: cumulativeDelay,
          jobId: `campaign-${campaignId}-${p.id}-step0-reschedule-${Date.now()}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      });
    }

    await redis.del(`campaign:stats:${campaignId}`);
    log.info({ message: `Rescheduled ${participants.rows.length} pending participants for campaign ${campaignId}`, bdAccountId });
  }
}
