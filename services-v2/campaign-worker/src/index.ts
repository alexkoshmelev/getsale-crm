import { Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { createLogger } from '@getsale/logger';
import { RedisClient } from '@getsale/cache';
import { JobQueue, RabbitMQClient } from '@getsale/queue';
import { CommandType } from './command-types';

interface CampaignJobData {
  participantId: string;
  campaignId: string;
  stepIndex: number;
  bdAccountId: string;
  contactId: string;
  channelId?: string;
  organizationId: string;
  scheduledAt: number;
}

const log = createLogger('campaign-worker-v2');
const redis = new RedisClient({ url: process.env.REDIS_URL || 'redis://localhost:6380' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres_dev@localhost:5433/postgres',
  max: 5,
});

async function main() {
  const rabbitmq = new RabbitMQClient({
    url: process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672',
    log,
  });
  await rabbitmq.connect();

  const jobQueue = new JobQueue<CampaignJobData>('campaign-jobs', {
    redis: process.env.REDIS_URL || 'redis://localhost:6380',
  });

  const concurrency = parseInt(process.env.WORKER_CONCURRENCY || '1', 10);

  jobQueue.process(async (job: Job<CampaignJobData>) => {
    const data = job.data;

    log.info({
      message: `Processing campaign job`,
      campaign_id: data.campaignId,
      participant_id: data.participantId,
      bd_account_id: data.bdAccountId,
    });

    // 1. Check participant still active, campaign still running
    const [participant, campaign] = await Promise.all([
      pool.query('SELECT status FROM campaign_participants WHERE id = $1', [data.participantId]),
      pool.query('SELECT status FROM campaigns WHERE id = $1', [data.campaignId]),
    ]);

    if (!participant.rows.length || participant.rows[0].status !== 'pending') {
      log.info({ message: `Participant ${data.participantId} no longer pending, skipping` });
      return;
    }
    if (!campaign.rows.length || campaign.rows[0].status !== 'active') {
      log.info({ message: `Campaign ${data.campaignId} no longer active, skipping` });
      return;
    }

    // 2. Check daily cap
    const dailyKey = `campaign_daily:${data.bdAccountId}:${new Date().toISOString().slice(0, 10)}`;
    const dailyCount = await redis.incr(dailyKey, 86400);
    const dailyLimit = 50; // TODO: load from campaign settings
    if (dailyCount > dailyLimit) {
      log.warn({ message: `Daily cap reached for account ${data.bdAccountId}`, count: dailyCount });
      // Re-queue with delay (tomorrow)
      throw new Error('Daily cap reached');
    }

    // 3. Load campaign step
    const campaignData = await pool.query('SELECT steps FROM campaigns WHERE id = $1', [data.campaignId]);
    const steps = JSON.parse(campaignData.rows[0]?.steps || '[]');
    const step = steps[data.stepIndex];
    if (!step) {
      log.warn({ message: `Step ${data.stepIndex} not found for campaign ${data.campaignId}` });
      return;
    }

    // 4. Prepare message
    const messageText = step.content || '';

    // 5. Publish commands to TSM queue
    const commandQueue = `telegram:commands:${data.bdAccountId}`;

    // Send TYPING command first (human simulation)
    const typingDuration = 3000 + Math.random() * 5000;
    await rabbitmq.publishCommand(commandQueue, {
      id: randomUUID(),
      type: CommandType.TYPING,
      priority: 5,
      payload: { channelId: data.channelId, duration: typingDuration },
    });

    // Then SEND_MESSAGE
    await rabbitmq.publishCommand(commandQueue, {
      id: randomUUID(),
      type: CommandType.SEND_MESSAGE,
      priority: 7,
      payload: {
        conversationId: null,
        text: messageText,
        channelId: data.channelId,
        organizationId: data.organizationId,
        userId: '',
        contactId: data.contactId,
        campaignId: data.campaignId,
        participantId: data.participantId,
      },
    });

    // 6. Update participant status
    await pool.query(
      "UPDATE campaign_participants SET status = 'sent', sent_at = NOW(), updated_at = NOW() WHERE id = $1",
      [data.participantId],
    );

    // 7. Record campaign send
    await pool.query(
      'INSERT INTO campaign_sends (campaign_id, participant_id, bd_account_id, step_index, sent_at) VALUES ($1, $2, $3, $4, NOW())',
      [data.campaignId, data.participantId, data.bdAccountId, data.stepIndex],
    );

    log.info({
      message: `Campaign job completed`,
      campaign_id: data.campaignId,
      participant_id: data.participantId,
    });
  }, concurrency);

  log.info({ message: `Campaign worker started (concurrency: ${concurrency})` });

  const shutdown = async () => {
    log.info({ message: 'Campaign worker shutting down' });
    await jobQueue.close();
    await rabbitmq.close();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.error({ message: 'Campaign worker failed to start', error: String(err) });
  process.exit(1);
});
