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
      step_index: data.stepIndex,
    });

    const validStatuses = data.stepIndex === 0
      ? ['pending']
      : ['pending', 'in_progress', 'awaiting_reply'];

    const [participant, campaign] = await Promise.all([
      pool.query('SELECT status, current_step FROM campaign_participants WHERE id = $1', [data.participantId]),
      pool.query('SELECT status FROM campaigns WHERE id = $1', [data.campaignId]),
    ]);

    if (!participant.rows.length || !validStatuses.includes(participant.rows[0].status)) {
      log.info({ message: `Participant ${data.participantId} status=${participant.rows[0]?.status}, skipping` });
      return;
    }
    if (!campaign.rows.length || campaign.rows[0].status !== 'active') {
      log.info({ message: `Campaign ${data.campaignId} no longer active, skipping` });
      return;
    }

    // Check send_blocked_until for this BD account (spam/flood block)
    const accountCheck = await pool.query(
      'SELECT send_blocked_until FROM bd_accounts WHERE id = $1',
      [data.bdAccountId],
    );
    const blockedUntil = accountCheck.rows[0]?.send_blocked_until;
    if (blockedUntil && new Date(blockedUntil) > new Date()) {
      const delayMs = new Date(blockedUntil).getTime() - Date.now() + 5000;
      log.warn({
        message: `Account ${data.bdAccountId} blocked until ${blockedUntil}, re-enqueueing with delay`,
        delay_ms: delayMs,
      });
      await jobQueue.add({
        name: `send:${data.campaignId}:${data.participantId}:step${data.stepIndex}`,
        data,
        opts: {
          delay: Math.max(delayMs, 10_000),
          jobId: `campaign:${data.campaignId}:${data.participantId}:step${data.stepIndex}:retry-${Date.now()}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      });
      return;
    }

    // Check daily cap
    const dailyKey = `campaign_daily:${data.bdAccountId}:${new Date().toISOString().slice(0, 10)}`;
    const dailyCount = await redis.incr(dailyKey, 86400);
    const audienceRow = await pool.query('SELECT target_audience FROM campaigns WHERE id = $1', [data.campaignId]);
    const audience = (audienceRow.rows[0]?.target_audience || {}) as { dailySendTarget?: number; randomizeWithAI?: boolean };
    const dailyLimit = audience.dailySendTarget ?? 50;
    if (dailyCount > dailyLimit) {
      const now = new Date();
      const tomorrow9am = new Date(now);
      tomorrow9am.setDate(tomorrow9am.getDate() + 1);
      tomorrow9am.setHours(9, 0, 0, 0);
      const delayMs = tomorrow9am.getTime() - now.getTime();

      log.warn({ message: `Daily cap reached for account ${data.bdAccountId}, re-enqueueing for tomorrow`, count: dailyCount });
      await jobQueue.add({
        name: `send:${data.campaignId}:${data.participantId}:step${data.stepIndex}`,
        data,
        opts: {
          delay: delayMs,
          jobId: `campaign:${data.campaignId}:${data.participantId}:step${data.stepIndex}:dailycap-${Date.now()}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 1000,
          removeOnFail: 5000,
        },
      });
      return;
    }

    try {
      // Load all sequence steps
      const seqRes = await pool.query(
        `SELECT cs.id, cs.order_index, ct.content, cs.trigger_type, cs.delay_hours, cs.delay_minutes, cs.is_hidden
         FROM campaign_sequences cs
         JOIN campaign_templates ct ON ct.id = cs.template_id
         WHERE cs.campaign_id = $1
         ORDER BY cs.order_index`,
        [data.campaignId],
      );
      const steps = seqRes.rows as {
        id: string;
        order_index: number;
        content: string;
        trigger_type: string;
        delay_hours: number;
        delay_minutes: number;
        is_hidden: boolean;
      }[];
      const step = steps[data.stepIndex];
      if (!step) {
        log.warn({ message: `Step ${data.stepIndex} not found for campaign ${data.campaignId}`, totalSteps: steps.length });
        return;
      }

      if (step.is_hidden) {
        log.info({ message: `Step ${data.stepIndex} is hidden, skipping to next`, campaignId: data.campaignId });
        await scheduleNextStep(jobQueue, pool, data, steps, data.stepIndex);
        return;
      }

      // Prepare message
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
        await pool.query(
          "UPDATE campaign_participants SET status = 'skipped', last_error = 'Empty message content', updated_at = NOW() WHERE id = $1",
          [data.participantId],
        );
        return;
      }

      if (audience.randomizeWithAI) {
        messageText = await aiRephrase(messageText, data.organizationId, data.campaignId, data.participantId);
      }

      // Publish commands to TSM queue
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

      // Record campaign send as 'queued' — TSM will update to 'sent' after actual delivery
      await pool.query(
        `INSERT INTO campaign_sends (campaign_participant_id, sequence_step, sent_at, status)
         VALUES ($1, $2, NOW(), 'queued')`,
        [data.participantId, data.stepIndex],
      );

      // Schedule next step or finalize participant status
      await scheduleNextStep(jobQueue, pool, data, steps, data.stepIndex);

      log.info({
        message: `Campaign job completed`,
        campaign_id: data.campaignId,
        participant_id: data.participantId,
        step_index: data.stepIndex,
      });
    } catch (err) {
      const isLastAttempt = (job.attemptsMade ?? 0) >= ((job.opts?.attempts ?? 3) - 1);
      log.error({
        message: `Campaign job error`,
        campaign_id: data.campaignId,
        participant_id: data.participantId,
        step_index: data.stepIndex,
        attempt: job.attemptsMade,
        is_last_attempt: isLastAttempt,
        error: String(err),
      });

      if (isLastAttempt) {
        await pool.query(
          "UPDATE campaign_participants SET status = 'failed', failed_at = NOW(), last_error = $2, updated_at = NOW() WHERE id = $1",
          [data.participantId, String(err).slice(0, 500)],
        ).catch(() => {});
      }

      throw err;
    }
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

async function scheduleNextStep(
  jobQueue: JobQueue<CampaignJobData>,
  dbPool: Pool,
  data: CampaignJobData,
  steps: { order_index: number; trigger_type: string; delay_hours: number; delay_minutes: number; is_hidden: boolean }[],
  currentStepIndex: number,
): Promise<void> {
  const nextStepIndex = currentStepIndex + 1;
  const nextStep = steps[nextStepIndex];

  if (!nextStep) {
    // No more steps -- mark participant as 'sent' (all steps done)
    await dbPool.query(
      "UPDATE campaign_participants SET status = 'sent', current_step = $2, next_send_at = NULL, updated_at = NOW() WHERE id = $1",
      [data.participantId, currentStepIndex],
    );
    return;
  }

  if (nextStep.trigger_type === 'after_reply') {
    // Wait for contact's reply before sending next step
    await dbPool.query(
      "UPDATE campaign_participants SET status = 'awaiting_reply', current_step = $2, next_send_at = NULL, updated_at = NOW() WHERE id = $1",
      [data.participantId, nextStepIndex],
    );
    return;
  }

  // Delay-based trigger: enqueue next step with calculated delay
  const delayMs = (nextStep.delay_hours * 3600000) + ((nextStep.delay_minutes || 0) * 60000);
  const effectiveDelay = Math.max(delayMs, 60000); // minimum 1 minute

  await dbPool.query(
    "UPDATE campaign_participants SET status = 'in_progress', current_step = $2, next_send_at = $3, updated_at = NOW() WHERE id = $1",
    [data.participantId, nextStepIndex, new Date(Date.now() + effectiveDelay)],
  );

  await jobQueue.add({
    name: `send:${data.campaignId}:${data.participantId}:step${nextStepIndex}`,
    data: { ...data, stepIndex: nextStepIndex, scheduledAt: Date.now() + effectiveDelay },
    opts: {
      delay: effectiveDelay,
      jobId: `campaign:${data.campaignId}:${data.participantId}:step${nextStepIndex}`,
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });
}

main().catch((err) => {
  log.error({ message: 'Campaign worker failed to start', error: String(err) });
  process.exit(1);
});
