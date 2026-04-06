import { Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { createLogger } from '@getsale/logger';
import { RedisClient } from '@getsale/cache';
import { JobQueue, RabbitMQClient } from '@getsale/queue';
import { CommandType } from './command-types';

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://ai-service:4010';

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

function expandSpintax(text: string): string {
  return text.replace(/\{([^{}|]+(?:\|[^{}|]+)*)\}/g, (_match, options: string) => {
    const parts = options.split('|').map((s) => s.trim());
    return parts[Math.floor(Math.random() * parts.length)] ?? '';
  });
}

function substituteVariables(
  content: string,
  contact: { first_name?: string | null; last_name?: string | null; company_name?: string | null },
): string {
  const first = (contact?.first_name ?? '').trim();
  const last = (contact?.last_name ?? '').trim();
  const company = (contact?.company_name ?? '').trim();
  return content
    .replace(/\{\{contact\.first_name\}\}/g, first)
    .replace(/\{\{contact\.last_name\}\}/g, last)
    .replace(/\{\{company\.name\}\}/g, company)
    .replace(/[ \t]+/g, ' ')
    .replace(/\n +/g, '\n')
    .replace(/ +\n/g, '\n')
    .trim();
}

async function aiRephrase(text: string, organizationId: string, campaignId: string, participantId: string): Promise<string> {
  try {
    const userRes = await pool.query('SELECT id FROM users WHERE organization_id = $1 LIMIT 1', [organizationId]);
    const userId = userRes.rows[0]?.id || '';

    const resp = await fetch(`${AI_SERVICE_URL}/api/ai/campaigns/rephrase`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-internal-auth': process.env.INTERNAL_AUTH_SECRET || 'dev_internal_auth_secret',
        'x-user-id': userId,
        'x-organization-id': organizationId,
        'x-user-role': 'owner',
      },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(30_000),
    });

    if (!resp.ok) {
      log.warn({ message: 'AI rephrase failed, using original text', campaignId, participantId, httpStatus: String(resp.status) });
      return text;
    }

    const result = (await resp.json()) as { content?: string };
    if (result.content && typeof result.content === 'string' && result.content.trim()) {
      log.info({ message: 'Using AI rephrased content', campaignId, participantId });
      return result.content;
    }
  } catch (err) {
    log.warn({ message: 'AI rephrase error, using original text', campaignId, participantId, error: String(err) });
  }
  return text;
}

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
    const audienceRow = await pool.query('SELECT target_audience FROM campaigns WHERE id = $1', [data.campaignId]);
    const audience = (audienceRow.rows[0]?.target_audience || {}) as { dailySendTarget?: number; randomizeWithAI?: boolean };
    const dailyLimit = audience.dailySendTarget ?? 50;
    if (dailyCount > dailyLimit) {
      log.warn({ message: `Daily cap reached for account ${data.bdAccountId}`, count: dailyCount });
      throw new Error('Daily cap reached');
    }

    // 3. Load campaign step from sequences + templates
    const seqRes = await pool.query(
      `SELECT cs.id, cs.order_index, ct.content
       FROM campaign_sequences cs
       JOIN campaign_templates ct ON ct.id = cs.template_id
       WHERE cs.campaign_id = $1
       ORDER BY cs.order_index`,
      [data.campaignId],
    );
    const steps = seqRes.rows as { id: string; order_index: number; content: string }[];
    const step = steps[data.stepIndex];
    if (!step) {
      log.warn({ message: `Step ${data.stepIndex} not found for campaign ${data.campaignId}`, totalSteps: steps.length });
      return;
    }

    // 4. Prepare message: variable substitution → spintax → AI rephrase
    const contactRes = await pool.query(
      `SELECT c.first_name, c.last_name, co.name AS company_name
       FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
       WHERE c.id = $1`,
      [data.contactId],
    );
    const contact = contactRes.rows[0] ?? {};

    let messageText = substituteVariables(step.content || '', contact);
    messageText = expandSpintax(messageText);

    if (!messageText.trim()) {
      log.warn({ message: 'Empty message content, skipping', campaignId: data.campaignId, stepIndex: data.stepIndex });
      return;
    }

    if (audience.randomizeWithAI) {
      messageText = await aiRephrase(messageText, data.organizationId, data.campaignId, data.participantId);
    }

    // 5. Publish commands to TSM queue
    const commandQueue = `telegram:commands:${data.bdAccountId}`;

    const typingDuration = 3000 + Math.random() * 5000;
    await rabbitmq.publishCommand(commandQueue, {
      id: randomUUID(),
      type: CommandType.TYPING,
      priority: 5,
      payload: { channelId: data.channelId, duration: typingDuration },
    });

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

    // 6. Update participant status + clear next_send_at (already sent)
    await pool.query(
      "UPDATE campaign_participants SET status = 'sent', current_step = $2, next_send_at = NULL, updated_at = NOW() WHERE id = $1",
      [data.participantId, data.stepIndex],
    );

    // 7. Record campaign send
    await pool.query(
      `INSERT INTO campaign_sends (campaign_participant_id, sequence_step, sent_at, status)
       VALUES ($1, $2, NOW(), 'sent')`,
      [data.participantId, data.stepIndex],
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
