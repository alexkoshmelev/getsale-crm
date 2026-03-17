import { Pool, PoolClient } from 'pg';
import { Logger } from '@getsale/logger';
import { CampaignStatus } from '@getsale/types';
import { ServiceHttpClient, ServiceCallError } from '@getsale/service-core';
import {
  Schedule, StepConditions,
  evaluateStepConditions, isWithinSchedule, nextSendAtWithSchedule,
  delayHoursFromStep, nextSlotRetry, substituteVariables, ensureLeadInPipeline,
  getSentTodayByAccount,
} from './helpers';
import type { CampaignStep, DueParticipantRow } from './types';

const CAMPAIGN_SEND_INTERVAL_MS = parseInt(String(process.env.CAMPAIGN_SEND_INTERVAL_MS || 60000), 10);
const CAMPAIGN_MAX_SENDS_PER_ACCOUNT_PER_DAY = parseInt(String(process.env.CAMPAIGN_MAX_SENDS_PER_ACCOUNT_PER_DAY || 40), 10);
const SEND_MAX_RETRIES = 3;
const CAMPAIGN_BATCH_SIZE = 20;

export interface CampaignLoopDeps {
  pool: Pool;
  log: Logger;
  messagingClient: ServiceHttpClient;
  pipelineClient: ServiceHttpClient;
  bdAccountsClient: ServiceHttpClient;
}

interface CampaignMeta {
  schedule: Schedule;
  sendDelaySeconds: number;
  pipeline_id: string | null;
  lead_creation_settings: { trigger?: string; default_stage_id?: string; default_responsible_id?: string } | null;
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
  try {
    await bdAccountsClient.post('/api/bd-accounts/' + bdAccountId + '/read', { chatId: channelId }, undefined, { organizationId });
  } catch (e) {
    log.warn({ message: 'Human sim: markAsRead failed', bdAccountId, error: e instanceof Error ? e.message : String(e) });
  }

  const readDelay = 1000 + Math.floor(Math.random() * 2000);
  await new Promise((r) => setTimeout(r, readDelay));

  try {
    await bdAccountsClient.post('/api/bd-accounts/' + bdAccountId + '/typing', { chatId: channelId }, undefined, { organizationId });
  } catch (e) {
    log.warn({ message: 'Human sim: setTyping failed', bdAccountId, error: e instanceof Error ? e.message : String(e) });
  }

  const typingDelay = Math.min(12000, Math.max(3000, messageLength * 40 + Math.floor(Math.random() * 2000)));
  await new Promise((r) => setTimeout(r, typingDelay));
}

async function fetchDueParticipant(client: PoolClient): Promise<DueParticipantRow | null> {
  const due = await client.query(
    `SELECT cp.id as participant_id, cp.campaign_id, cp.contact_id, cp.bd_account_id, cp.channel_id, cp.current_step, cp.status as status, c.organization_id
     FROM campaign_participants cp
     JOIN campaigns c ON c.id = cp.campaign_id
     WHERE c.status = $1 AND cp.status IN ('pending', 'sent') AND cp.next_send_at IS NOT NULL AND cp.next_send_at <= NOW()
     ORDER BY cp.next_send_at
     LIMIT 1
     FOR UPDATE OF cp SKIP LOCKED`,
    [CampaignStatus.ACTIVE]
  );
  return due.rows.length > 0 ? due.rows[0] as DueParticipantRow : null;
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
  const aud = (c.target_audience || {}) as { sendDelaySeconds?: number };
  const lcs = c.lead_creation_settings as CampaignMeta['lead_creation_settings'];
  const meta: CampaignMeta = {
    schedule,
    sendDelaySeconds: Math.max(0, aud.sendDelaySeconds ?? 0),
    pipeline_id: c.pipeline_id ?? null,
    lead_creation_settings: lcs ?? null,
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
    `SELECT cs.id, cs.order_index, cs.template_id, cs.delay_hours, cs.delay_minutes, cs.trigger_type, cs.conditions, ct.content
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
  schedule: Schedule
): Promise<void> {
  const nextStep = steps[currentStep + 1];
  if (nextStep) {
    const nextTriggerType = nextStep.trigger_type || 'delay';
    const nextSendAt =
      nextTriggerType === 'after_reply'
        ? null
        : nextSendAtWithSchedule(new Date(), delayHoursFromStep(nextStep), schedule);
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

async function sendMessageWithRetry(
  messagingClient: ServiceHttpClient,
  payload: { contactId: string; channelId: string; content: string; bdAccountId: string },
  headers: { userId: string; organizationId: string },
  maxRetries: number,
  log: Logger
): Promise<{ id?: string }> {
  let lastErr: unknown;
  let notConnectedRetries = 0;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await messagingClient.post<{ id?: string }>('/api/messaging/send', {
        contactId: payload.contactId,
        channel: 'telegram',
        channelId: payload.channelId,
        content: payload.content,
        bdAccountId: payload.bdAccountId,
        source: 'campaign',
      }, undefined, { userId: headers.userId, organizationId: headers.organizationId });
    } catch (err) {
      lastErr = err;
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
  deps: CampaignLoopDeps
): Promise<void> {
  const { log, messagingClient, pipelineClient, bdAccountsClient } = deps;
  const schedule = meta?.schedule ?? null;

  const contactRes = await pool.query(
    `SELECT c.first_name, c.last_name, c.email, c.phone, c.telegram_id, co.name as company_name
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
    await advanceToNextStep(client, row.participant_id, row.current_step, steps, schedule);
    await client.query('COMMIT');
    return;
  }

  const userRow = await pool.query('SELECT id FROM users WHERE organization_id = $1 LIMIT 1', [row.organization_id]);
  const systemUserId = userRow.rows[0]?.id || '';
  const content = substituteVariables(step.content || '', contact, company);

  await simulateHumanBehavior(bdAccountsClient, row.bd_account_id, row.channel_id, content.length, row.organization_id, log);

  let msgJson: { id?: string };
  try {
    msgJson = await sendMessageWithRetry(
      messagingClient,
      { contactId: row.contact_id, channelId: row.channel_id, content, bdAccountId: row.bd_account_id },
      { userId: systemUserId, organizationId: row.organization_id },
      SEND_MAX_RETRIES,
      log
    );
  } catch (sendErr) {
    await client.query(
      `UPDATE campaign_participants SET status = 'failed', metadata = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify({ lastError: sendErr instanceof Error ? sendErr.message : String(sendErr), attempts: SEND_MAX_RETRIES }), row.participant_id]
    );
    await client.query('COMMIT');
    log.warn({ message: 'Campaign send failed after retries', participantId: row.participant_id, attempts: SEND_MAX_RETRIES, error: sendErr instanceof Error ? sendErr.message : String(sendErr) });
    return;
  }

  await advanceToNextStep(client, row.participant_id, row.current_step, steps, schedule);
  await client.query(
    `INSERT INTO campaign_sends (campaign_participant_id, sequence_step, message_id, sent_at, status) VALUES ($1, $2, $3, NOW(), 'sent')`,
    [row.participant_id, row.current_step, msgJson?.id || null]
  );
  await client.query('COMMIT');
  sentMap.set(row.bd_account_id, (sentMap.get(row.bd_account_id) ?? 0) + 1);

  const lcs = meta?.lead_creation_settings;
  const pipelineId = meta?.pipeline_id;
  if (row.current_step === 0 && lcs?.trigger === 'on_first_send' && pipelineId) {
    let stageId = lcs.default_stage_id || null;
    if (!stageId) {
      const stageRow = await pool.query(
        'SELECT id FROM stages WHERE pipeline_id = $1 AND organization_id = $2 ORDER BY order_index ASC LIMIT 1',
        [pipelineId, row.organization_id]
      );
      stageId = stageRow.rows[0]?.id || null;
    }
    if (stageId) await ensureLeadInPipeline(pipelineClient, log, row.organization_id, row.contact_id, pipelineId, stageId, systemUserId, lcs?.default_responsible_id);
  }

  const sendDelaySeconds = meta?.sendDelaySeconds ?? 0;
  if (sendDelaySeconds > 0) await new Promise((r) => setTimeout(r, sendDelaySeconds * 1000));
}

async function processCampaignSends(deps: CampaignLoopDeps): Promise<void> {
  const { pool, log } = deps;

  try {
    const sentMap = await getSentTodayByAccount(pool);
    const campaignMetaCache = new Map<string, CampaignMeta>();
    const stepsCache = new Map<string, CampaignStep[]>();
    const processedCampaignIds = new Set<string>();

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

        const meta = await loadCampaignMeta(pool, row.campaign_id, campaignMetaCache);
        const steps = await loadCampaignSteps(pool, row.campaign_id, stepsCache);
        const schedule = meta?.schedule ?? null;

        if (!isWithinSchedule(schedule)) {
          await client.query(
            `UPDATE campaign_participants SET next_send_at = $1, updated_at = NOW() WHERE id = $2`,
            [nextSlotRetry(schedule), row.participant_id]
          );
          await client.query('COMMIT');
          continue;
        }

        if (!checkDailyLimits(sentMap, row.bd_account_id, CAMPAIGN_MAX_SENDS_PER_ACCOUNT_PER_DAY)) {
          const tomorrowStart = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
          tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);
          await client.query(
            `UPDATE campaign_participants SET next_send_at = $1, updated_at = NOW() WHERE id = $2`,
            [nextSendAtWithSchedule(tomorrowStart, 0, schedule), row.participant_id]
          );
          await client.query('COMMIT');
          continue;
        }

        const step = steps[row.current_step];
        if (!step) {
          const reason = { no_sequence_step: true, current_step: row.current_step };
          await client.query(
            `UPDATE campaign_participants SET status = 'failed', next_send_at = NULL, metadata = $1, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify(reason), row.participant_id]
          );
          await client.query('COMMIT');
          log.warn({ message: 'Campaign participant failed: no sequence step', campaignId: row.campaign_id, participantId: row.participant_id, currentStep: row.current_step });
          continue;
        }

        await processParticipant(client, pool, row, step, steps, meta, sentMap, deps);
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
