import { Job } from 'bullmq';
import { randomUUID } from 'crypto';
import { createServer } from 'http';
import { Pool } from 'pg';
import { createLogger } from '@getsale/logger';
import { RedisClient } from '@getsale/cache';
import { EventType, type Event } from '@getsale/events';
import { JobQueue, RabbitMQClient } from '@getsale/queue';
import { CommandType } from './command-types';

const AI_SERVICE_URL = process.env.AI_SERVICE_URL || 'http://ai-service:4010';
const DEFAULT_DAILY_CAP = parseInt(process.env.CAMPAIGN_MAX_SENDS_PER_ACCOUNT_PER_DAY || '20', 10);

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

type Schedule = {
  timezone?: string;
  workingHours?: { start?: string; end?: string };
  daysOfWeek?: number[];
} | null;

type StepConditions = {
  stopIfReplied?: boolean;
  contact?: Array<{
    field: 'first_name' | 'last_name' | 'email' | 'phone' | 'telegram_id' | 'company_name';
    op: 'equals' | 'not_equals' | 'contains' | 'empty' | 'not_empty';
    value?: string;
  }>;
  inPipelineStage?: { pipelineId: string; stageIds: string[] };
  notInPipelineStage?: { pipelineId: string; stageIds: string[] };
};

const NON_RETRYABLE_ERRORS = new Set([
  'PRIVACY_RESTRICTED', 'USER_PRIVACY_RESTRICTED', 'PEER_ID_INVALID',
  'USER_IS_BOT', 'USER_DEACTIVATED', 'USER_DEACTIVATED_BAN',
  'INPUT_USER_DEACTIVATED', 'CHAT_WRITE_FORBIDDEN', 'CHANNEL_PRIVATE',
  'YOU_BLOCKED_USER', 'CHAT_FORBIDDEN',
]);

const log = createLogger('campaign-worker-v2');
const redis = new RedisClient({ url: process.env.REDIS_URL || 'redis://localhost:6380' });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres_dev@localhost:5433/postgres',
  max: 5,
});

function dateInTz(d: Date, tz: string): { hour: number; minute: number; dayOfWeek: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz || 'UTC', hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short',
  });
  const parts = fmt.formatToParts(d);
  let hour = 0, minute = 0, dayOfWeek = 1;
  for (const p of parts) {
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    if (p.type === 'minute') minute = parseInt(p.value, 10);
    if (p.type === 'weekday')
      dayOfWeek = ({ sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 } as Record<string, number>)[p.value.toLowerCase().slice(0, 3)] ?? 1;
  }
  return { hour, minute, dayOfWeek };
}

function isWithinScheduleAt(d: Date, schedule: Schedule): boolean {
  if (!schedule?.workingHours?.start || !schedule?.workingHours?.end || !schedule.daysOfWeek?.length) return true;
  const tz = schedule.timezone || 'UTC';
  const { hour, minute, dayOfWeek } = dateInTz(d, tz);
  const [startH] = schedule.workingHours.start.split(':').map(Number);
  const [endH] = schedule.workingHours.end.split(':').map(Number);
  const inWindow = hour > startH! || (hour === startH && minute >= 0);
  const beforeEnd = hour < endH! || (hour === endH && minute === 0);
  return inWindow && beforeEnd && schedule.daysOfWeek.includes(dayOfWeek);
}

function nextScheduleSlot(from: Date, campaign: Schedule, account: Schedule): Date {
  let d = new Date(from.getTime());
  for (let i = 0; i < 672; i++) {
    if (isWithinScheduleAt(d, campaign) && isWithinScheduleAt(d, account)) return d;
    d = new Date(d.getTime() + 15 * 60 * 1000);
  }
  return new Date(from.getTime() + 15 * 60 * 1000);
}

function expandSpintax(text: string): string {
  return text.replace(/\{([^{}|]+(?:\|[^{}|]+)*)\}/g, (_match, options: string) => {
    const parts = options.split('|').map((s) => s.trim());
    return parts[Math.floor(Math.random() * parts.length)] ?? '';
  });
}

type TemplateVariantRow = {
  id: string;
  content: string;
  media_url: string | null;
  media_type: string | null;
  media_metadata: Record<string, any> | null;
  variant_weight: number;
};

function pickWeightedTemplateVariant(variants: TemplateVariantRow[]): TemplateVariantRow {
  if (variants.length === 1) return variants[0]!;
  const weights = variants.map((v) => Math.max(0, Number(v.variant_weight) || 0));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) {
    return variants[Math.floor(Math.random() * variants.length)]!;
  }
  let r = Math.random() * total;
  for (let i = 0; i < variants.length; i++) {
    r -= weights[i]!;
    if (r < 0) return variants[i]!;
  }
  return variants[variants.length - 1]!;
}

async function applyAbTemplateVariant(
  db: Pool,
  campaignId: string,
  step: {
    variant_group: string | null;
    content: string;
    media_url: string | null;
    media_type: string | null;
    media_metadata: Record<string, any> | null;
  },
): Promise<{
  content: string;
  media_url: string | null;
  media_type: string | null;
  media_metadata: Record<string, any> | null;
}> {
  if (!step.variant_group) {
    return {
      content: step.content,
      media_url: step.media_url,
      media_type: step.media_type,
      media_metadata: step.media_metadata,
    };
  }
  const v = await db.query(
    `SELECT id, content, media_url, media_type, media_metadata, variant_weight
     FROM campaign_templates
     WHERE campaign_id = $1 AND variant_group = $2`,
    [campaignId, step.variant_group],
  );
  const rows = v.rows as TemplateVariantRow[];
  if (rows.length === 0) {
    return {
      content: step.content,
      media_url: step.media_url,
      media_type: step.media_type,
      media_metadata: step.media_metadata,
    };
  }
  const picked = pickWeightedTemplateVariant(rows);
  return {
    content: picked.content,
    media_url: picked.media_url,
    media_type: picked.media_type,
    media_metadata: picked.media_metadata,
  };
}

function substituteVariables(
  content: string,
  contact: Record<string, any>,
): string {
  const get = (key: string) => (contact?.[key] ?? '').toString().trim();
  return content
    .replace(/\{\{contact\.first_name\}\}/g, get('first_name'))
    .replace(/\{\{contact\.last_name\}\}/g, get('last_name'))
    .replace(/\{\{contact\.email\}\}/g, get('email'))
    .replace(/\{\{contact\.phone\}\}/g, get('phone'))
    .replace(/\{\{contact\.telegram_id\}\}/g, get('telegram_id'))
    .replace(/\{\{contact\.username\}\}/g, get('username'))
    .replace(/\{\{company\.name\}\}/g, get('company_name'))
    .replace(/[ \t]+/g, ' ')
    .replace(/\n +/g, '\n')
    .replace(/ +\n/g, '\n')
    .trim();
}

function evalContactRule(contact: Record<string, unknown>, rule: NonNullable<StepConditions['contact']>[number]): boolean {
  const raw = String(contact[rule.field] ?? '').trim();
  const val = (rule.value ?? '').trim().toLowerCase();
  const rawLower = raw.toLowerCase();
  switch (rule.op) {
    case 'equals': return rawLower === val;
    case 'not_equals': return rawLower !== val;
    case 'contains': return val ? rawLower.includes(val) : true;
    case 'empty': return raw === '';
    case 'not_empty': return raw !== '';
    default: return true;
  }
}

async function evaluateStepConditions(
  conditions: StepConditions | undefined | null,
  contact: Record<string, unknown>,
  organizationId: string,
  contactId: string,
  participantStatus?: string,
): Promise<boolean> {
  if (!conditions || typeof conditions !== 'object') return true;
  if (conditions.stopIfReplied && participantStatus === 'replied') return false;
  if (conditions.contact?.length) {
    for (const rule of conditions.contact) {
      if (!evalContactRule(contact, rule)) return false;
    }
  }
  if (conditions.inPipelineStage?.pipelineId && conditions.inPipelineStage.stageIds?.length) {
    const lead = await pool.query(
      'SELECT stage_id FROM leads WHERE organization_id = $1 AND contact_id = $2 AND pipeline_id = $3',
      [organizationId, contactId, conditions.inPipelineStage.pipelineId],
    );
    const stageId = lead.rows[0]?.stage_id;
    if (!stageId || !conditions.inPipelineStage.stageIds.includes(stageId)) return false;
  }
  if (conditions.notInPipelineStage?.pipelineId && conditions.notInPipelineStage.stageIds?.length) {
    const lead = await pool.query(
      'SELECT stage_id FROM leads WHERE organization_id = $1 AND contact_id = $2 AND pipeline_id = $3',
      [organizationId, contactId, conditions.notInPipelineStage.pipelineId],
    );
    const stageId = lead.rows[0]?.stage_id;
    if (stageId && conditions.notInPipelineStage.stageIds.includes(stageId)) return false;
  }
  return true;
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
      return result.content;
    }
  } catch (err) {
    log.warn({ message: 'AI rephrase error, using original text', campaignId, participantId, error: String(err) });
  }
  return text;
}

async function tryCreateLeadOnFirstSend(data: CampaignJobData, rabbitmq: RabbitMQClient): Promise<void> {
  try {
    const sendCount = await pool.query(
      "SELECT COUNT(*)::int AS c FROM campaign_sends WHERE campaign_participant_id = $1 AND status IN ('sent','queued')",
      [data.participantId],
    );
    if (Number(sendCount.rows[0]?.c ?? 0) !== 1) return;

    const camp = await pool.query(
      'SELECT organization_id, pipeline_id, lead_creation_settings FROM campaigns WHERE id = $1',
      [data.campaignId],
    );
    const c = camp.rows[0] as { organization_id: string; pipeline_id: string | null; lead_creation_settings: any } | undefined;
    if (!c?.pipeline_id) return;

    const lcs = c.lead_creation_settings as { trigger?: string; default_stage_id?: string; default_responsible_id?: string } | null;
    const trigger = lcs?.trigger ?? (c.pipeline_id ? 'on_first_send' : undefined);
    if (trigger !== 'on_first_send') return;

    const existing = await pool.query(
      'SELECT id FROM leads WHERE contact_id = $1 AND pipeline_id = $2 AND organization_id = $3 LIMIT 1',
      [data.contactId, c.pipeline_id, c.organization_id],
    );
    if (existing.rows.length > 0) return;

    let stageId = lcs?.default_stage_id || null;
    if (!stageId) {
      const stageRow = await pool.query(
        'SELECT id FROM stages WHERE pipeline_id = $1 AND organization_id = $2 ORDER BY order_index ASC LIMIT 1',
        [c.pipeline_id, c.organization_id],
      );
      stageId = (stageRow.rows[0] as { id: string } | undefined)?.id ?? null;
    }
    if (!stageId) return;

    const userRow = await pool.query('SELECT id FROM users WHERE organization_id = $1 LIMIT 1', [c.organization_id]);
    const systemUserId = (userRow.rows[0] as { id: string } | undefined)?.id ?? '';
    const responsibleId = lcs?.default_responsible_id || systemUserId;

    const maxOrder = await pool.query('SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM leads WHERE stage_id = $1', [stageId]);
    const orderIndex = (maxOrder.rows[0] as { next: number })?.next ?? 0;

    const result = await pool.query(
      `INSERT INTO leads (organization_id, contact_id, pipeline_id, stage_id, order_index, responsible_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [c.organization_id, data.contactId, c.pipeline_id, stageId, orderIndex, responsibleId],
    );
    const leadId = (result.rows[0] as { id: string })?.id;
    if (!leadId) return;

    await pool.query(
      `INSERT INTO lead_activity_log (id, lead_id, type, metadata, created_at) VALUES (gen_random_uuid(), $1, 'lead_created', $2, NOW())`,
      [leadId, JSON.stringify({ source: 'campaign_first_send', campaign_id: data.campaignId })],
    ).catch(() => {});

    rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.LEAD_CREATED,
      timestamp: new Date(),
      organizationId: c.organization_id,
      userId: systemUserId,
      data: { contactId: data.contactId, pipelineId: c.pipeline_id, stageId, leadId: leadId },
    } as unknown as Event).catch(() => {});

    log.info({ message: 'Lead created on first send', leadId, campaignId: data.campaignId });
  } catch (err) {
    log.warn({ message: 'Lead creation on first send failed', error: String(err) });
  }
}

async function checkCampaignCompletion(campaignId: string): Promise<void> {
  try {
    const result = await pool.query(
      `SELECT c.id FROM campaigns c
       WHERE c.id = $1 AND c.status = 'active'
       AND NOT EXISTS (
         SELECT 1 FROM campaign_participants cp
         WHERE cp.campaign_id = c.id AND cp.status NOT IN ('sent','replied','failed','skipped','completed')
       )
       AND EXISTS (SELECT 1 FROM campaign_participants cp WHERE cp.campaign_id = c.id)`,
      [campaignId],
    );
    if (result.rows.length > 0) {
      await pool.query("UPDATE campaigns SET status = 'completed', updated_at = NOW() WHERE id = $1", [campaignId]);
      log.info({ message: `Campaign ${campaignId} auto-completed (all participants terminal)` });
    }
  } catch (err) {
    log.warn({ message: 'Campaign completion check failed', campaignId, error: String(err) });
  }
}

function isNonRetryableError(errorMsg: string): boolean {
  for (const code of NON_RETRYABLE_ERRORS) {
    if (errorMsg.includes(code)) return true;
  }
  return false;
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

    const accountCheck = await pool.query(
      'SELECT send_blocked_until, max_dm_per_day, timezone, working_hours_start, working_hours_end, working_days FROM bd_accounts WHERE id = $1',
      [data.bdAccountId],
    );
    const bdAccount = accountCheck.rows[0] ?? {};

    // Check send_blocked_until (spam/flood block)
    const blockedUntil = bdAccount.send_blocked_until;
    if (blockedUntil && new Date(blockedUntil) > new Date()) {
      const delayMs = new Date(blockedUntil).getTime() - Date.now() + 5000;
      log.warn({ message: `Account ${data.bdAccountId} blocked until ${blockedUntil}, re-enqueueing`, delay_ms: delayMs });
      await pool.query(
        'UPDATE campaign_participants SET next_send_at = $1, updated_at = NOW() WHERE id = $2',
        [new Date(Date.now() + delayMs), data.participantId],
      );
      await jobQueue.add({
        name: `send:${data.campaignId}:${data.participantId}:step${data.stepIndex}`,
        data,
        opts: {
          delay: Math.max(delayMs, 10_000),
          jobId: `campaign-${data.campaignId}-${data.participantId}-step${data.stepIndex}-retry-${Date.now()}`,
          attempts: 3, backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 1000, removeOnFail: 5000,
        },
      });
      return;
    }

    // Working hours check
    const audienceRow = await pool.query('SELECT target_audience, pipeline_id, lead_creation_settings FROM campaigns WHERE id = $1', [data.campaignId]);
    const audience = (audienceRow.rows[0]?.target_audience || {}) as {
      dailySendTarget?: number; randomizeWithAI?: boolean;
      schedule?: Schedule;
    };
    const campaignSchedule: Schedule = audience.schedule ?? null;
    const accountSchedule: Schedule = (bdAccount.working_hours_start && bdAccount.working_hours_end)
      ? { timezone: bdAccount.timezone, workingHours: { start: bdAccount.working_hours_start, end: bdAccount.working_hours_end }, daysOfWeek: bdAccount.working_days ?? [1,2,3,4,5] }
      : null;

    const now = new Date();
    if (!isWithinScheduleAt(now, campaignSchedule) || !isWithinScheduleAt(now, accountSchedule)) {
      const nextSlot = nextScheduleSlot(now, campaignSchedule, accountSchedule);
      const delayMs = nextSlot.getTime() - now.getTime();
      log.info({ message: `Outside schedule, deferring to ${nextSlot.toISOString()}`, campaignId: data.campaignId });

      await pool.query(
        `INSERT INTO campaign_sends (campaign_participant_id, sequence_step, sent_at, status, metadata)
         VALUES ($1, $2, NOW(), 'deferred', $3)`,
        [data.participantId, data.stepIndex, JSON.stringify({ event: 'outside_schedule', nextWindow: nextSlot.toISOString() })],
      );

      await pool.query(
        'UPDATE campaign_participants SET next_send_at = $1, updated_at = NOW() WHERE id = $2',
        [nextSlot, data.participantId],
      );

      await jobQueue.add({
        name: `send:${data.campaignId}:${data.participantId}:step${data.stepIndex}`,
        data,
        opts: {
          delay: Math.max(delayMs, 60_000),
          jobId: `campaign-${data.campaignId}-${data.participantId}-step${data.stepIndex}-sched-${Date.now()}`,
          attempts: 3, backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 1000, removeOnFail: 5000,
        },
      });
      return;
    }

    // Daily cap — DB-accurate count with per-account limit
    const accountTz = (bdAccount as any).schedule_timezone || (bdAccount as any).timezone || audience.schedule?.timezone || 'UTC';
    const dailyCountRes = await pool.query(
      `SELECT COUNT(*)::int AS c FROM campaign_sends cs
       JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
       WHERE cp.bd_account_id = $1 AND cs.status IN ('sent','queued')
         AND cs.sent_at >= (NOW() AT TIME ZONE $2)::date AT TIME ZONE $2`,
      [data.bdAccountId, accountTz],
    );
    const dailyCount = Number(dailyCountRes.rows[0]?.c ?? 0);
    const perAccountLimit = bdAccount.max_dm_per_day ?? DEFAULT_DAILY_CAP;
    const campaignLimit = audience.dailySendTarget ?? 50;
    const dailyLimit = Math.min(perAccountLimit, campaignLimit);

    if (dailyCount >= dailyLimit) {
      const nextSlot = nextScheduleSlot(new Date(now.getTime() + 24 * 3600000), campaignSchedule, accountSchedule);
      const delayMs = nextSlot.getTime() - now.getTime();
      log.warn({ message: `Daily cap reached for ${data.bdAccountId} (${dailyCount}/${dailyLimit})`, nextSlot: nextSlot.toISOString() });

      await pool.query(
        `INSERT INTO campaign_sends (campaign_participant_id, sequence_step, sent_at, status, metadata)
         VALUES ($1, $2, NOW(), 'deferred', $3)`,
        [data.participantId, data.stepIndex, JSON.stringify({ event: 'daily_cap', count: dailyCount, limit: dailyLimit })],
      );

      await pool.query(
        'UPDATE campaign_participants SET next_send_at = $1, updated_at = NOW() WHERE id = $2',
        [nextSlot, data.participantId],
      );

      await jobQueue.add({
        name: `send:${data.campaignId}:${data.participantId}:step${data.stepIndex}`,
        data,
        opts: {
          delay: delayMs,
          jobId: `campaign-${data.campaignId}-${data.participantId}-step${data.stepIndex}-dailycap-${Date.now()}`,
          attempts: 3, backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: 1000, removeOnFail: 5000,
        },
      });
      return;
    }

    try {
      const seqRes = await pool.query(
        `SELECT cs.id, cs.order_index, ct.content, ct.media_url, ct.media_type, ct.media_metadata,
                ct.variant_group, ct.variant_weight,
                cs.trigger_type, cs.delay_hours, cs.delay_minutes, cs.is_hidden, cs.conditions
         FROM campaign_sequences cs
         JOIN campaign_templates ct ON ct.id = cs.template_id
         WHERE cs.campaign_id = $1
         ORDER BY cs.order_index`,
        [data.campaignId],
      );
      const steps = seqRes.rows as {
        id: string; order_index: number; content: string; trigger_type: string;
        delay_hours: number; delay_minutes: number; is_hidden: boolean; conditions: any;
        media_url: string | null; media_type: string | null; media_metadata: Record<string, any> | null;
        variant_group: string | null; variant_weight: number;
      }[];
      const stepBase = steps[data.stepIndex];
      if (!stepBase) {
        log.warn({ message: `Step ${data.stepIndex} not found for campaign ${data.campaignId}`, totalSteps: steps.length });
        await pool.query(
          "UPDATE campaign_participants SET status = 'failed', failed_at = NOW(), last_error = 'Step not found', updated_at = NOW() WHERE id = $1",
          [data.participantId],
        );
        await checkCampaignCompletion(data.campaignId);
        return;
      }

      const variantResolved = await applyAbTemplateVariant(pool, data.campaignId, stepBase);
      const step = { ...stepBase, ...variantResolved };

      if (step.is_hidden) {
        log.info({ message: `Step ${data.stepIndex} is hidden, skipping to next`, campaignId: data.campaignId });
        await scheduleNextStep(jobQueue, pool, rabbitmq, data, steps, data.stepIndex);
        return;
      }

      // Step conditions evaluation
      const contactRes = await pool.query(
        `SELECT c.first_name, c.last_name, c.email, c.phone, c.telegram_id, c.username, co.name AS company_name
         FROM contacts c LEFT JOIN companies co ON co.id = c.company_id
         WHERE c.id = $1`,
        [data.contactId],
      );
      const contact = contactRes.rows[0] ?? {};

      const conditions = step.conditions as StepConditions | null;
      const shouldSend = await evaluateStepConditions(conditions, contact, data.organizationId, data.contactId, participant.rows[0].status);
      if (!shouldSend) {
        log.info({ message: `Step conditions not met, advancing`, campaignId: data.campaignId, stepIndex: data.stepIndex });
        await scheduleNextStep(jobQueue, pool, rabbitmq, data, steps, data.stepIndex);
        return;
      }

      let messageText = substituteVariables(step.content || '', contact);
      messageText = expandSpintax(messageText);

      if (!messageText.trim()) {
        log.warn({ message: 'Empty message content, skipping', campaignId: data.campaignId, stepIndex: data.stepIndex });
        await pool.query(
          "UPDATE campaign_participants SET status = 'skipped', last_error = 'Empty message content', updated_at = NOW() WHERE id = $1",
          [data.participantId],
        );
        await checkCampaignCompletion(data.campaignId);
        return;
      }

      if (audience.randomizeWithAI) {
        messageText = await aiRephrase(messageText, data.organizationId, data.campaignId, data.participantId);
      }

      const commandQueue = `telegram:commands:${data.bdAccountId}`;

      // Mark read before typing (human simulation)
      await rabbitmq.publishCommand(commandQueue, {
        id: randomUUID(),
        type: CommandType.MARK_READ,
        priority: 4,
        payload: { channelId: data.channelId },
      });

      const typingDuration = 5000 + Math.random() * 10000;
      await rabbitmq.publishCommand(commandQueue, {
        id: randomUUID(),
        type: CommandType.TYPING,
        priority: 5,
        payload: { channelId: data.channelId, duration: typingDuration },
      });

      const sendPayload: Record<string, unknown> = {
        conversationId: null,
        text: messageText,
        channelId: data.channelId,
        organizationId: data.organizationId,
        userId: '',
        contactId: data.contactId,
        campaignId: data.campaignId,
        participantId: data.participantId,
      };

      if (step.media_url && step.media_type) {
        try {
          const mediaResp = await fetch(step.media_url);
          if (mediaResp.ok) {
            const buf = Buffer.from(await mediaResp.arrayBuffer());
            sendPayload.fileBase64 = buf.toString('base64');
            sendPayload.mediaType = step.media_type;
            sendPayload.fileName = step.media_url.split('/').pop() || 'media';
            if (step.media_metadata) {
              if (step.media_metadata.duration) sendPayload.mediaDuration = step.media_metadata.duration;
              if (step.media_metadata.mimeType) sendPayload.mimeType = step.media_metadata.mimeType;
            }
          } else {
            log.warn({ message: 'Failed to fetch campaign media', url: step.media_url, httpStatus: String(mediaResp.status) });
          }
        } catch (mediaErr) {
          log.warn({ message: 'Error fetching campaign media', url: step.media_url, error: String(mediaErr) });
        }
      }

      await rabbitmq.publishCommand(commandQueue, {
        id: randomUUID(),
        type: CommandType.SEND_MESSAGE,
        priority: 7,
        payload: sendPayload,
      });

      await pool.query(
        `INSERT INTO campaign_sends (campaign_participant_id, sequence_step, sent_at, status)
         VALUES ($1, $2, NOW(), 'queued')`,
        [data.participantId, data.stepIndex],
      );

      await pool.query(
        `UPDATE campaign_participants SET status = 'in_progress', updated_at = NOW() WHERE id = $1 AND status = 'pending'`,
        [data.participantId],
      );

      // Lead creation on first send
      await tryCreateLeadOnFirstSend(data, rabbitmq);

      await scheduleNextStep(jobQueue, pool, rabbitmq, data, steps, data.stepIndex);

      log.info({ message: `Campaign job completed`, campaign_id: data.campaignId, participant_id: data.participantId, step_index: data.stepIndex });
    } catch (err) {
      const errorStr = String(err);
      const isLastAttempt = (job.attemptsMade ?? 0) >= ((job.opts?.attempts ?? 3) - 1);

      if (isNonRetryableError(errorStr) || isLastAttempt) {
        await pool.query(
          "UPDATE campaign_participants SET status = 'failed', failed_at = NOW(), last_error = $2, updated_at = NOW() WHERE id = $1",
          [data.participantId, errorStr.slice(0, 500)],
        ).catch(() => {});
        await checkCampaignCompletion(data.campaignId);
        if (isNonRetryableError(errorStr)) {
          log.warn({ message: 'Non-retryable error, participant failed', campaignId: data.campaignId, error: errorStr.slice(0, 200) });
          return;
        }
      }

      log.error({ message: `Campaign job error`, campaign_id: data.campaignId, participant_id: data.participantId, error: errorStr.slice(0, 300) });
      throw err;
    }
  }, concurrency);

  log.info({ message: `Campaign worker started (concurrency: ${concurrency})` });

  const healthPort = parseInt(process.env.HEALTH_PORT || '4016', 10);
  const healthServer = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  healthServer.listen(healthPort, () => {
    log.info({ message: `Health server listening on :${healthPort}` });
  });

  const shutdown = async () => {
    log.info({ message: 'Campaign worker shutting down' });
    healthServer.close();
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
  rabbitmq: RabbitMQClient,
  data: CampaignJobData,
  steps: { order_index: number; trigger_type: string; delay_hours: number; delay_minutes: number; is_hidden: boolean }[],
  currentStepIndex: number,
): Promise<void> {
  const nextStepIndex = currentStepIndex + 1;
  const nextStep = steps[nextStepIndex];

  if (!nextStep) {
    await dbPool.query(
      "UPDATE campaign_participants SET status = 'sent', current_step = $2, next_send_at = NULL, updated_at = NOW() WHERE id = $1",
      [data.participantId, currentStepIndex],
    );
    await checkCampaignCompletion(data.campaignId);
    return;
  }

  if (nextStep.trigger_type === 'after_reply') {
    await dbPool.query(
      "UPDATE campaign_participants SET status = 'awaiting_reply', current_step = $2, next_send_at = NULL, updated_at = NOW() WHERE id = $1",
      [data.participantId, nextStepIndex],
    );
    return;
  }

  const delayMs = (nextStep.delay_hours * 3600000) + ((nextStep.delay_minutes || 0) * 60000);
  const effectiveDelay = Math.max(delayMs, 60000);

  await dbPool.query(
    "UPDATE campaign_participants SET status = 'in_progress', current_step = $2, next_send_at = $3, updated_at = NOW() WHERE id = $1",
    [data.participantId, nextStepIndex, new Date(Date.now() + effectiveDelay)],
  );

  await jobQueue.add({
    name: `send:${data.campaignId}:${data.participantId}:step${nextStepIndex}`,
    data: { ...data, stepIndex: nextStepIndex, scheduledAt: Date.now() + effectiveDelay },
    opts: {
      delay: effectiveDelay,
      jobId: `campaign-${data.campaignId}-${data.participantId}-step${nextStepIndex}`,
      attempts: 3, backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000, removeOnFail: 5000,
    },
  });
}

main().catch((err) => {
  log.error({ message: 'Campaign worker failed to start', error: String(err) });
  process.exit(1);
});
