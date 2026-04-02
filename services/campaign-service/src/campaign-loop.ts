import { randomUUID } from 'crypto';
import { Pool, PoolClient } from 'pg';
import { Logger } from '@getsale/logger';
import { CampaignStatus } from '@getsale/types';
import { ServiceHttpClient, ServiceCallError } from '@getsale/service-core';
import {
  type Schedule,
  SendDelayRange,
  StepConditions,
  evaluateStepConditions,
  isWithinSchedule,
  nextSendAtWithSchedule,
  delayHoursFromStep,
  nextSlotRetry,
  substituteVariables,
  expandSpintax,
  ensureLeadInPipeline,
  getSentTodayByAccount,
  resolveDelayRange,
  sampleDelaySeconds,
  scheduleFromBdAccountRow,
  getEffectiveSchedule,
  DEFAULT_DAILY_SEND_CAP,
} from './helpers';
import { campaignMinGapDeferTotal } from './metrics';
import type { CampaignStep, DueParticipantRow } from './types';

const CAMPAIGN_SEND_INTERVAL_MS = parseInt(String(process.env.CAMPAIGN_SEND_INTERVAL_MS || 60000), 10);
/** Min milliseconds between two campaign-initiated sends for the same bd_account_id within one worker batch (0 = off). Reduces TG flood risk when many participants share an account. */
/** Default 6 minutes (5–7 min range) between campaign sends per BD account unless overridden by env. */
const CAMPAIGN_MIN_GAP_MS_SAME_BD_ACCOUNT = parseInt(
  String(process.env.CAMPAIGN_MIN_GAP_MS_SAME_BD_ACCOUNT || '360000'),
  10
);
const SEND_MAX_RETRIES = 3;
const CAMPAIGN_BATCH_SIZE = 20;
const CAMPAIGN_429_RETRY_AFTER_MINUTES = parseInt(String(process.env.CAMPAIGN_429_RETRY_AFTER_MINUTES || '30'), 10);

export interface CampaignLoopDeps {
  pool: Pool;
  log: Logger;
  messagingClient: ServiceHttpClient;
  pipelineClient: ServiceHttpClient;
  bdAccountsClient: ServiceHttpClient;
  aiClient: ServiceHttpClient;
}

interface CampaignMeta {
  schedule: Schedule;
  sendDelayRange: SendDelayRange;
  pipeline_id: string | null;
  lead_creation_settings: { trigger?: string; default_stage_id?: string; default_responsible_id?: string } | null;
  randomizeWithAI?: boolean;
  dailySendTarget?: number | null;
}

export function startCampaignLoop(deps: CampaignLoopDeps): void {
  processCampaignSends(deps).catch((err) => deps.log.error({ message: 'Campaign send initial run error', error: String(err) }));
  setInterval(() => processCampaignSends(deps), CAMPAIGN_SEND_INTERVAL_MS);
}

async function simulateHumanBehavior(
  bdAccountsClient: ServiceHttpClient,
  bdAccountId: string,
  channelId: string,
  messageLength: number,
  organizationId: string,
  log: Logger
): Promise<void> {
  const ctx = { organizationId };
  try {
    await bdAccountsClient.post('/api/bd-accounts/' + bdAccountId + '/read', { chatId: channelId }, undefined, ctx);
  } catch (e) {
    log.warn({ message: 'Human sim: markAsRead failed', bdAccountId, error: e instanceof Error ? e.message : String(e) });
  }

  const readDelay = 1000 + Math.floor(Math.random() * 2000);
  await new Promise((r) => setTimeout(r, readDelay));

  const typingDelay = Math.min(12000, Math.max(3000, messageLength * 40 + Math.floor(Math.random() * 2000)));

  const renewTyping = async (): Promise<void> => {
    try {
      await bdAccountsClient.post('/api/bd-accounts/' + bdAccountId + '/typing', { chatId: channelId }, undefined, ctx);
    } catch (e) {
      log.warn({ message: 'Human sim: setTyping failed', bdAccountId, error: e instanceof Error ? e.message : String(e) });
    }
  };

  await renewTyping();

  const TYPING_STATUS_TTL_MS = 5500;
  const midPause =
    messageLength > 120 && Math.random() < 0.45
      ? 800 + Math.floor(Math.random() * 2200)
      : 0;
  let remaining = typingDelay;
  if (midPause > 0 && remaining > midPause + 1500) {
    const first = Math.floor(remaining / 2);
    remaining -= first;
    let elapsed = 0;
    while (elapsed < first) {
      const chunk = Math.min(TYPING_STATUS_TTL_MS, first - elapsed);
      await new Promise((r) => setTimeout(r, chunk));
      elapsed += chunk;
      if (messageLength > 200 && elapsed < first - 500) await renewTyping();
    }
    await new Promise((r) => setTimeout(r, midPause));
    if (messageLength > 200) await renewTyping();
    while (remaining > 0) {
      const chunk = Math.min(TYPING_STATUS_TTL_MS, remaining);
      await new Promise((r) => setTimeout(r, chunk));
      remaining -= chunk;
      if (messageLength > 200 && remaining > 500) await renewTyping();
    }
  } else {
    let elapsed = 0;
    while (elapsed < typingDelay) {
      const chunk = Math.min(TYPING_STATUS_TTL_MS, typingDelay - elapsed);
      await new Promise((r) => setTimeout(r, chunk));
      elapsed += chunk;
      if (messageLength > 200 && elapsed < typingDelay - 500) await renewTyping();
    }
  }
}

async function fetchDueParticipant(client: PoolClient): Promise<DueParticipantRow | null> {
  const due = await client.query(
    `SELECT cp.id as participant_id, cp.campaign_id, cp.contact_id, cp.bd_account_id, cp.channel_id, cp.current_step, cp.status as status, c.organization_id, COALESCE(cp.enqueue_order, 0) AS enqueue_order, ba.max_dm_per_day
     FROM campaign_participants cp
     JOIN campaigns c ON c.id = cp.campaign_id
     JOIN bd_accounts ba ON ba.id = cp.bd_account_id
       AND (ba.send_blocked_until IS NULL OR ba.send_blocked_until <= NOW())
       AND ba.spam_restricted_at IS NULL
     WHERE c.status = $1 AND cp.status IN ('pending', 'sent') AND cp.next_send_at IS NOT NULL AND cp.next_send_at <= NOW()
     ORDER BY cp.next_send_at ASC, cp.enqueue_order ASC
     LIMIT 1
     FOR UPDATE OF cp SKIP LOCKED`,
    [CampaignStatus.ACTIVE]
  );
  const row = due.rows[0];
  if (!row) return null;
  return {
    ...row,
    enqueue_order: row.enqueue_order != null ? Number(row.enqueue_order) : 0,
    max_dm_per_day: row.max_dm_per_day != null ? Number(row.max_dm_per_day) : null,
  } as DueParticipantRow;
}

function checkDailyLimits(sentMap: Map<string, number>, accountId: string, dailyLimit: number): boolean {
  return (sentMap.get(accountId) ?? 0) < dailyLimit;
}

async function loadCampaignMeta(
  pool: Pool,
  campaignId: string,
  cache: Map<string, CampaignMeta>
): Promise<CampaignMeta | undefined> {
  if (cache.has(campaignId)) return cache.get(campaignId);

  const campaignsRes = await pool.query(
    'SELECT id, schedule, target_audience, pipeline_id, lead_creation_settings FROM campaigns WHERE id = $1',
    [campaignId]
  );
  const c = campaignsRes.rows[0];
  if (!c) return undefined;

  const schedule = (c.schedule as Schedule) ?? null;
  const aud = (c.target_audience || {}) as {
    sendDelaySeconds?: number;
    sendDelayMinSeconds?: number;
    sendDelayMaxSeconds?: number;
    randomizeWithAI?: boolean;
    dailySendTarget?: number;
  };
  const lcs = c.lead_creation_settings as CampaignMeta['lead_creation_settings'];
  const meta: CampaignMeta = {
    schedule,
    sendDelayRange: resolveDelayRange(aud, 60),
    pipeline_id: c.pipeline_id ?? null,
    lead_creation_settings: lcs ?? null,
    randomizeWithAI: !!aud.randomizeWithAI,
    dailySendTarget: aud.dailySendTarget ?? null,
  };
  cache.set(campaignId, meta);
  return meta;
}

async function loadCampaignSteps(
  pool: Pool,
  campaignId: string,
  cache: Map<string, CampaignStep[]>
): Promise<CampaignStep[]> {
  if (cache.has(campaignId)) return cache.get(campaignId)!;

  const seq = await pool.query(
    `SELECT cs.id, cs.order_index, cs.template_id, cs.delay_hours, cs.delay_minutes, cs.trigger_type, cs.conditions, COALESCE(cs.is_hidden, false) AS is_hidden, ct.content
     FROM campaign_sequences cs
     JOIN campaign_templates ct ON ct.id = cs.template_id
     WHERE cs.campaign_id = $1 ORDER BY cs.order_index`,
    [campaignId]
  );
  const steps = seq.rows as CampaignStep[];
  cache.set(campaignId, steps);
  return steps;
}

async function advanceToNextStep(
  client: PoolClient,
  participantId: string,
  currentStep: number,
  steps: CampaignStep[],
  schedule: Schedule,
  opts?: { enqueueOrder?: number; sendDelayRange?: SendDelayRange }
): Promise<void> {
  const enqueueOrder = opts?.enqueueOrder ?? 0;
  const sampledDelaySeconds = sampleDelaySeconds(opts?.sendDelayRange ?? { minSeconds: 0, maxSeconds: 0 });
  const nextStep = steps[currentStep + 1];
  if (nextStep) {
    const nextTriggerType = nextStep.trigger_type || 'delay';
    const nextSendAt =
      nextTriggerType === 'after_reply'
        ? null
        : (() => {
            const base = nextSendAtWithSchedule(new Date(), delayHoursFromStep(nextStep), schedule);
            return new Date(base.getTime() + enqueueOrder * sampledDelaySeconds * 1000);
          })();
    await client.query(
      `UPDATE campaign_participants SET current_step = $1, status = 'sent', next_send_at = $2, updated_at = NOW() WHERE id = $3`,
      [currentStep + 1, nextSendAt, participantId]
    );
  } else {
    await client.query(
      `UPDATE campaign_participants SET current_step = $1, status = 'completed', next_send_at = NULL, updated_at = NOW() WHERE id = $2`,
      [currentStep + 1, participantId]
    );
  }
}

const NOT_CONNECTED_BACKOFF_MS = 15000;
const NOT_CONNECTED_EXTRA_RETRIES = 2;

function isNotConnectedError(err: unknown): boolean {
  if (!(err instanceof ServiceCallError) || err.statusCode !== 400) return false;
  const msg = typeof err.message === 'string' ? err.message : String(err);
  return /not connected|account is not connected/i.test(msg);
}

/** Human-readable reason from messaging-service / downstream JSON body. */
function campaignSendDownstreamReason(err: unknown): string {
  if (err instanceof ServiceCallError) {
    const b = err.body;
    if (b != null && typeof b === 'object') {
      const o = b as { message?: unknown; error?: unknown };
      const m = typeof o.message === 'string' ? o.message.trim() : '';
      const e = typeof o.error === 'string' ? o.error.trim() : '';
      if (m) return m;
      if (e) return e;
    }
    return typeof err.message === 'string' ? err.message : String(err);
  }
  return err instanceof Error ? err.message : String(err);
}

/**
 * Permanent client errors: retries only add latency and log noise (Telegram peer/privacy/deactivated, etc.).
 */
function isNonRetryableCampaignSendError(err: unknown): boolean {
  if (!(err instanceof ServiceCallError)) return false;
  if (err.statusCode === 409) return true;
  if (err.statusCode === 413) return true;
  if (err.statusCode !== 400) return false;
  const msg = campaignSendDownstreamReason(err).toLowerCase();
  const needles = [
    'user or chat not found',
    'telegram: recipient only accepts messages from premium',
    "telegram: recipient's privacy settings block",
    'telegram: sending to this chat is not allowed',
    'not a mutual contact per their privacy',
    'telegram: premium is required',
    'recipient telegram account is deactivated',
    'privacy_premium_required',
    'user_privacy_restricted',
    'chat_write_forbidden',
    'user_not_mutual_contact',
    'file too large',
    'maximum file size',
  ];
  return needles.some((n) => msg.includes(n));
}

async function sendMessageWithRetry(
  messagingClient: ServiceHttpClient,
  payload: { contactId: string; channelId: string; content: string; bdAccountId: string; idempotencyKey: string },
  headers: { userId: string; organizationId: string },
  maxRetries: number,
  log: Logger
): Promise<{ id?: string; channel_id?: string }> {
  let lastErr: unknown;
  let notConnectedRetries = 0;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await messagingClient.post<{ id?: string; channel_id?: string }>('/api/messaging/send', {
        contactId: payload.contactId,
        channel: 'telegram',
        channelId: payload.channelId,
        content: payload.content,
        bdAccountId: payload.bdAccountId,
        source: 'campaign',
        idempotencyKey: payload.idempotencyKey,
      }, undefined, { userId: headers.userId, organizationId: headers.organizationId });
    } catch (err) {
      lastErr = err;
      if (err instanceof ServiceCallError && err.statusCode === 429) {
        throw err;
      }
      if (isNonRetryableCampaignSendError(err)) {
        log.info({
          message: 'Campaign send: non-retryable error, skipping further attempts',
          attempt,
          reason: campaignSendDownstreamReason(err),
        });
        throw err;
      }
      const isNotConnected = isNotConnectedError(err);
      if (isNotConnected && notConnectedRetries < NOT_CONNECTED_EXTRA_RETRIES) {
        notConnectedRetries++;
        log.info({ message: 'Campaign send: BD account not connected, waiting for reconnect', backoffMs: NOT_CONNECTED_BACKOFF_MS, extraAttempt: notConnectedRetries });
        await new Promise((r) => setTimeout(r, NOT_CONNECTED_BACKOFF_MS));
        attempt -= 1;
        continue;
      }
      if (attempt < maxRetries) {
        const backoff = attempt * 2000;
        log.info({ message: 'Campaign send retry', attempt, backoffMs: backoff });
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }
  throw lastErr;
}

async function markCompletedCampaigns(pool: Pool, campaignIds: Set<string>): Promise<void> {
  const ids = Array.from(campaignIds);
  if (ids.length > 0) {
    const completed = await pool.query(
      `SELECT c.id FROM campaigns c
       WHERE c.id = ANY($1::uuid[]) AND c.status = $2
       AND NOT EXISTS (
         SELECT 1 FROM campaign_participants cp
         WHERE cp.campaign_id = c.id AND cp.status NOT IN ('completed', 'replied', 'failed')
       )
       AND EXISTS (SELECT 1 FROM campaign_participants cp WHERE cp.campaign_id = c.id)`,
      [ids, CampaignStatus.ACTIVE]
    );
    for (const r of completed.rows) {
      await pool.query(
        "UPDATE campaigns SET status = $1, updated_at = NOW() WHERE id = $2",
        [CampaignStatus.COMPLETED, r.id]
      );
    }
  }
  // Also mark any active campaign as completed when all participants are done (no one has pending/sent)
  const allDone = await pool.query(
    `SELECT c.id FROM campaigns c
     WHERE c.status = $1
     AND NOT EXISTS (
       SELECT 1 FROM campaign_participants cp
       WHERE cp.campaign_id = c.id AND cp.status NOT IN ('completed', 'replied', 'failed')
     )
     AND EXISTS (SELECT 1 FROM campaign_participants cp WHERE cp.campaign_id = c.id)`,
    [CampaignStatus.ACTIVE]
  );
  for (const r of allDone.rows) {
    await pool.query(
      "UPDATE campaigns SET status = $1, updated_at = NOW() WHERE id = $2",
      [CampaignStatus.COMPLETED, r.id]
    );
  }
}

async function processParticipant(
  client: PoolClient,
  pool: Pool,
  row: DueParticipantRow,
  step: CampaignStep,
  steps: CampaignStep[],
  meta: CampaignMeta | undefined,
  sentMap: Map<string, number>,
  deps: CampaignLoopDeps,
  lastCampaignSendAtMsByBdAccount: Map<string, number> | undefined,
  bdScheduleCache: Map<string, Schedule | null>
): Promise<void> {
  const { log, messagingClient, pipelineClient, bdAccountsClient, aiClient } = deps;
  let accSched = bdScheduleCache.get(row.bd_account_id);
  if (accSched === undefined) {
    const r = await pool.query(
      `SELECT timezone, working_hours_start, working_hours_end, working_days FROM bd_accounts WHERE id = $1`,
      [row.bd_account_id]
    );
    accSched = scheduleFromBdAccountRow(r.rows[0]);
    bdScheduleCache.set(row.bd_account_id, accSched);
  }
  const schedule = getEffectiveSchedule(meta?.schedule ?? null, accSched);

  const contactRes = await pool.query(
    `SELECT c.first_name, c.last_name, c.email, c.phone, c.telegram_id, c.username, co.name as company_name
     FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE c.id = $1`,
    [row.contact_id]
  );
  const contact = contactRes.rows[0] || {};
  const company = contact.company_name != null ? { name: contact.company_name } : null;

  const conditions = step.conditions as StepConditions | null;
  const shouldSend = await evaluateStepConditions(
    pool, row.organization_id, row.contact_id, conditions, contact, row.status
  );
  if (!shouldSend) {
    await advanceToNextStep(client, row.participant_id, row.current_step, steps, schedule, {
      enqueueOrder: row.enqueue_order,
      sendDelayRange: meta?.sendDelayRange ?? { minSeconds: 0, maxSeconds: 0 },
    });
    await client.query('COMMIT');
    return;
  }

  if (step.is_hidden) {
    await advanceToNextStep(client, row.participant_id, row.current_step, steps, schedule, {
      enqueueOrder: row.enqueue_order,
      sendDelayRange: meta?.sendDelayRange ?? { minSeconds: 0, maxSeconds: 0 },
    });
    await client.query('COMMIT');
    return;
  }

  const userRow = await pool.query('SELECT id FROM users WHERE organization_id = $1 LIMIT 1', [row.organization_id]);
  const systemUserId = userRow.rows[0]?.id || '';
  let content = expandSpintax(substituteVariables(step.content || '', contact, company));
  if (meta?.randomizeWithAI) {
    log.info({
      message: 'Campaign AI rephrase requested',
      campaignId: row.campaign_id,
      participantId: row.participant_id,
    });
    try {
      const result = await aiClient.post<{ content?: string }>(
        '/api/ai/campaigns/rephrase',
        { text: content },
        undefined,
        { userId: systemUserId, organizationId: row.organization_id }
      );
      if (result?.content && typeof result.content === 'string') {
        content = result.content;
        log.info({
          message: 'Using AI rephrased content for participant',
          campaignId: row.campaign_id,
          participantId: row.participant_id,
        });
      }
    } catch (err) {
      const statusCode = err instanceof ServiceCallError ? err.statusCode : undefined;
      const body = err instanceof ServiceCallError && err.body != null ? err.body : undefined;
      log.warn({
        message: 'AI rephrase failed, using original campaign text',
        campaignId: row.campaign_id,
        participantId: row.participant_id,
        error: err instanceof Error ? err.message : String(err),
        ...(statusCode != null && { statusCode }),
        ...(body != null && { responseBody: body }),
      });
    }
  }

  await simulateHumanBehavior(bdAccountsClient, row.bd_account_id, row.channel_id, content.length, row.organization_id, log);

  let msgJson: { id?: string; channel_id?: string };
  let deliveredChannelId = row.channel_id;
  const idempotencyKey = `campaign:${row.campaign_id}:participant:${row.participant_id}:step:${row.current_step}`;
  try {
    msgJson = await sendMessageWithRetry(
      messagingClient,
      { contactId: row.contact_id, channelId: row.channel_id, content, bdAccountId: row.bd_account_id, idempotencyKey },
      { userId: systemUserId, organizationId: row.organization_id },
      SEND_MAX_RETRIES,
      log
    );
    if (msgJson.channel_id) deliveredChannelId = msgJson.channel_id;
  } catch (sendErr) {
    const reasonMessage =
      sendErr instanceof ServiceCallError && sendErr.body != null && typeof sendErr.body === 'object'
        ? (sendErr.body as { message?: string }).message ?? (sendErr.body as { error?: string }).error ?? (sendErr instanceof Error ? sendErr.message : String(sendErr))
        : sendErr instanceof Error ? sendErr.message : String(sendErr);

    const sendErrSvc = sendErr instanceof ServiceCallError ? sendErr : null;
    const is429 = sendErrSvc?.statusCode === 429;
    if (is429) {
      const body = sendErrSvc?.body as { details?: { retryAfterSeconds?: number } } | undefined;
      const retryAfterSeconds =
        body?.details?.retryAfterSeconds ?? CAMPAIGN_429_RETRY_AFTER_MINUTES * 60;
      const retryAt = new Date(Date.now() + retryAfterSeconds * 1000);
      const isPeerFlood =
        typeof reasonMessage === 'string' && reasonMessage.toUpperCase().includes('PEER_FLOOD');
      await client.query(
        `INSERT INTO campaign_sends (campaign_participant_id, sequence_step, message_id, sent_at, status, metadata)
         VALUES ($1, $2, NULL, NOW(), 'deferred', $3::jsonb)`,
        [
          row.participant_id,
          row.current_step,
          JSON.stringify({
            event: isPeerFlood ? 'peer_flood' : 'rate_limit_429',
            retryAfterSeconds,
            retryAt: retryAt.toISOString(),
            message: reasonMessage,
          }),
        ]
      );
      await client.query(
        `UPDATE campaign_participants SET next_send_at = $1, metadata = $2, updated_at = NOW() WHERE id = $3`,
        [
          retryAt.toISOString(),
          JSON.stringify({ lastError: reasonMessage, last429At: new Date().toISOString(), retryAfterSeconds }),
          row.participant_id,
        ]
      );
      await client.query(
        `UPDATE bd_accounts SET send_blocked_until = $1,
           flood_wait_until = $1,
           flood_wait_seconds = $2,
           updated_at = NOW()
         WHERE id = $3`,
        [retryAt.toISOString(), retryAfterSeconds, row.bd_account_id]
      );
      await client.query('COMMIT');
      log.warn({
        message: 'Campaign send rate limited (429), deferred retry',
        participantId: row.participant_id,
        bdAccountId: row.bd_account_id,
        reason: reasonMessage,
        retryAt: retryAt.toISOString(),
      });
      return;
    }

    await client.query(
      `INSERT INTO campaign_sends (campaign_participant_id, sequence_step, message_id, sent_at, status, metadata)
       VALUES ($1, $2, NULL, NOW(), 'failed', $3::jsonb)`,
      [
        row.participant_id,
        row.current_step,
        JSON.stringify({
          event: 'send_failed',
          message: reasonMessage,
          attempts: SEND_MAX_RETRIES,
        }),
      ]
    );
    await client.query(
      `UPDATE campaign_participants SET status = 'failed', metadata = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify({ lastError: reasonMessage, attempts: SEND_MAX_RETRIES }), row.participant_id]
    );
    await client.query('COMMIT');
    log.warn({
      message: 'Campaign send failed after retries',
      participantId: row.participant_id,
      attempts: SEND_MAX_RETRIES,
      reason: reasonMessage,
    });
    return;
  }

  if (deliveredChannelId !== row.channel_id) {
    await client.query(
      `UPDATE campaign_participants SET channel_id = $1, updated_at = NOW() WHERE id = $2`,
      [deliveredChannelId, row.participant_id]
    );
  }

  await advanceToNextStep(client, row.participant_id, row.current_step, steps, schedule, {
    enqueueOrder: row.enqueue_order,
    sendDelayRange: meta?.sendDelayRange ?? { minSeconds: 0, maxSeconds: 0 },
  });
  await client.query(
    `INSERT INTO campaign_sends (campaign_participant_id, sequence_step, message_id, sent_at, status, metadata)
     VALUES ($1, $2, $3, NOW(), 'sent', '{}'::jsonb)`,
    [row.participant_id, row.current_step, msgJson?.id || randomUUID()]
  );
  await client.query('COMMIT');
  sentMap.set(row.bd_account_id, (sentMap.get(row.bd_account_id) ?? 0) + 1);
  lastCampaignSendAtMsByBdAccount?.set(row.bd_account_id, Date.now());

  const sendCountRes = await pool.query(
    `SELECT COUNT(*)::int AS c FROM campaign_sends WHERE campaign_participant_id = $1`,
    [row.participant_id]
  );
  const isFirstSend = Number(sendCountRes.rows[0]?.c ?? 0) === 1;

  const lcs = meta?.lead_creation_settings;
  const pipelineId = meta?.pipeline_id;
  const trigger = lcs?.trigger ?? (pipelineId ? 'on_first_send' : undefined);
  if (isFirstSend && pipelineId && trigger === 'on_first_send') {
    let stageId = lcs?.default_stage_id || null;
    if (!stageId) {
      const stageRow = await pool.query(
        'SELECT id FROM stages WHERE pipeline_id = $1 AND organization_id = $2 ORDER BY order_index ASC LIMIT 1',
        [pipelineId, row.organization_id]
      );
      stageId = stageRow.rows[0]?.id || null;
    }
    await ensureLeadInPipeline(
      pipelineClient,
      log,
      row.organization_id,
      row.contact_id,
      pipelineId,
      stageId,
      systemUserId,
      lcs?.default_responsible_id
    );
  }

  const sendDelaySeconds = sampleDelaySeconds(meta?.sendDelayRange ?? { minSeconds: 0, maxSeconds: 0 });
  if (sendDelaySeconds > 0) await new Promise((r) => setTimeout(r, sendDelaySeconds * 1000));
}

async function processCampaignSends(deps: CampaignLoopDeps): Promise<void> {
  const { pool, log } = deps;

  try {
    const sentMap = await getSentTodayByAccount(pool);
    const campaignMetaCache = new Map<string, CampaignMeta>();
    const stepsCache = new Map<string, CampaignStep[]>();
    const bdScheduleCache = new Map<string, Schedule | null>();
    const processedCampaignIds = new Set<string>();
    const lastCampaignSendAtMsByBdAccount = new Map<string, number>();

    for (let i = 0; i < CAMPAIGN_BATCH_SIZE; i++) {
      let client: PoolClient | null = null;
      try {
        client = await pool.connect();
        await client.query('BEGIN');

        const row = await fetchDueParticipant(client);
        if (!row) {
          await client.query('COMMIT');
          break;
        }
        processedCampaignIds.add(row.campaign_id);

        if (CAMPAIGN_MIN_GAP_MS_SAME_BD_ACCOUNT > 0) {
          const lastMs = lastCampaignSendAtMsByBdAccount.get(row.bd_account_id) ?? 0;
          const now = Date.now();
          const elapsed = now - lastMs;
          if (lastMs > 0 && elapsed < CAMPAIGN_MIN_GAP_MS_SAME_BD_ACCOUNT) {
            const deferMs = CAMPAIGN_MIN_GAP_MS_SAME_BD_ACCOUNT - elapsed;
            const retryAt = new Date(now + deferMs);
            await client.query(
              `UPDATE campaign_participants SET next_send_at = $1, updated_at = NOW() WHERE id = $2`,
              [retryAt.toISOString(), row.participant_id]
            );
            await client.query(
              `INSERT INTO campaign_sends (campaign_participant_id, sequence_step, message_id, sent_at, status, metadata)
               VALUES ($1, $2, NULL, NOW(), 'deferred', $3::jsonb)`,
              [
                row.participant_id,
                row.current_step,
                JSON.stringify({
                  event: 'min_gap',
                  deferMs,
                  bdAccountId: row.bd_account_id,
                }),
              ]
            );
            await client.query('COMMIT');
            log.info({
              message: 'Campaign send deferred: min gap per BD account',
              bdAccountId: row.bd_account_id,
              participantId: row.participant_id,
              deferMs,
            });
            campaignMinGapDeferTotal.inc();
            continue;
          }
        }

        const meta = await loadCampaignMeta(pool, row.campaign_id, campaignMetaCache);
        const steps = await loadCampaignSteps(pool, row.campaign_id, stepsCache);
        let accSchedLoop = bdScheduleCache.get(row.bd_account_id);
        if (accSchedLoop === undefined) {
          const rSch = await pool.query(
            `SELECT timezone, working_hours_start, working_hours_end, working_days FROM bd_accounts WHERE id = $1`,
            [row.bd_account_id]
          );
          accSchedLoop = scheduleFromBdAccountRow(rSch.rows[0]);
          bdScheduleCache.set(row.bd_account_id, accSchedLoop);
        }
        const effectiveScheduleLoop = getEffectiveSchedule(meta?.schedule ?? null, accSchedLoop);

        if (!isWithinSchedule(effectiveScheduleLoop)) {
          const nextAt = nextSlotRetry(effectiveScheduleLoop);
          await client.query(
            `UPDATE campaign_participants SET next_send_at = $1, updated_at = NOW() WHERE id = $2`,
            [nextAt, row.participant_id]
          );
          await client.query(
            `INSERT INTO campaign_sends (campaign_participant_id, sequence_step, message_id, sent_at, status, metadata)
             VALUES ($1, $2, NULL, NOW(), 'deferred', $3::jsonb)`,
            [
              row.participant_id,
              row.current_step,
              JSON.stringify({ event: 'outside_schedule', nextSendAt: nextAt }),
            ]
          );
          await client.query('COMMIT');
          continue;
        }

        const campaignDaily = meta?.dailySendTarget;
        const accountMax =
          row.max_dm_per_day != null && row.max_dm_per_day >= 0 ? row.max_dm_per_day : DEFAULT_DAILY_SEND_CAP;
        const accountDailyLimit =
          campaignDaily != null && campaignDaily > 0 ? Math.min(campaignDaily, accountMax) : accountMax;
        if (!checkDailyLimits(sentMap, row.bd_account_id, accountDailyLimit)) {
          const tomorrowStart = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
          tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);
          const nextDaily = nextSendAtWithSchedule(tomorrowStart, 0, effectiveScheduleLoop);
          await client.query(
            `UPDATE campaign_participants SET next_send_at = $1, updated_at = NOW() WHERE id = $2`,
            [nextDaily, row.participant_id]
          );
          await client.query(
            `INSERT INTO campaign_sends (campaign_participant_id, sequence_step, message_id, sent_at, status, metadata)
             VALUES ($1, $2, NULL, NOW(), 'deferred', $3::jsonb)`,
            [
              row.participant_id,
              row.current_step,
              JSON.stringify({
                event: 'daily_cap',
                accountDailyLimit,
                nextSendAt: nextDaily,
              }),
            ]
          );
          await client.query('COMMIT');
          continue;
        }

        const step = steps[row.current_step];
        if (!step) {
          const reason = { no_sequence_step: true, current_step: row.current_step };
          await client.query(
            `INSERT INTO campaign_sends (campaign_participant_id, sequence_step, message_id, sent_at, status, metadata)
             VALUES ($1, $2, NULL, NOW(), 'failed', $3::jsonb)`,
            [row.participant_id, row.current_step, JSON.stringify({ event: 'no_sequence_step', ...reason })]
          );
          await client.query(
            `UPDATE campaign_participants SET status = 'failed', next_send_at = NULL, metadata = $1, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(reason), row.participant_id]
          );
          await client.query('COMMIT');
          log.warn({ message: 'Campaign participant failed: no sequence step', campaignId: row.campaign_id, participantId: row.participant_id, currentStep: row.current_step });
          continue;
        }

        await processParticipant(
          client,
          pool,
          row,
          step,
          steps,
          meta,
          sentMap,
          deps,
          lastCampaignSendAtMsByBdAccount,
          bdScheduleCache
        );
      } catch (e) {
        await client?.query('ROLLBACK').catch(() => {});
        log.warn({
          message: 'Campaign iteration error, continuing with next participant',
          error: e instanceof Error ? e.message : String(e),
          participantId: (e as { participantId?: string })?.participantId,
        });
      } finally {
        client?.release();
      }
    }

    await markCompletedCampaigns(pool, processedCampaignIds);
  } catch (err) {
    log.error({ message: 'Campaign send worker error', error: String(err) });
  }
}
