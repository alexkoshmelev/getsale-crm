import express from 'express';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { EventType } from '@getsale/events';
import { CampaignStatus } from '@getsale/types';

const app = express();
const PORT = process.env.PORT || 3012;

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'postgres_dev'}@localhost:5432/postgres`,
});

const rabbitmq = new RabbitMQClient(
  process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672'
);

const MESSAGING_SERVICE_URL = process.env.MESSAGING_SERVICE_URL || 'http://localhost:3003';
const PIPELINE_SERVICE_URL = process.env.PIPELINE_SERVICE_URL || 'http://localhost:3008';
const CAMPAIGN_SEND_INTERVAL_MS = parseInt(String(process.env.CAMPAIGN_SEND_INTERVAL_MS || 60000), 10); // 1 min
/** Max messages per BD account per calendar day (Telegram rate limit best practice). */
const CAMPAIGN_MAX_SENDS_PER_ACCOUNT_PER_DAY = parseInt(String(process.env.CAMPAIGN_MAX_SENDS_PER_ACCOUNT_PER_DAY || 40), 10);

type Schedule = {
  timezone?: string;
  workingHours?: { start?: string; end?: string };
  daysOfWeek?: number[];
} | null;

/** Extended step conditions (contact fields, pipeline stage). */
export type StepConditions = {
  stopIfReplied?: boolean;
  contact?: Array<{
    field: 'first_name' | 'last_name' | 'email' | 'phone' | 'telegram_id' | 'company_name';
    op: 'equals' | 'not_equals' | 'contains' | 'empty' | 'not_empty';
    value?: string;
  }>;
  inPipelineStage?: { pipelineId: string; stageIds: string[] };
  notInPipelineStage?: { pipelineId: string; stageIds: string[] };
};

function getContactField(
  contact: Record<string, unknown>,
  field: 'first_name' | 'last_name' | 'email' | 'phone' | 'telegram_id' | 'company_name'
): string {
  const v = contact[field];
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function evalContactRule(
  contact: Record<string, unknown>,
  rule: NonNullable<StepConditions['contact']>[number]
): boolean {
  const raw = getContactField(contact, rule.field);
  const val = (rule.value ?? '').trim().toLowerCase();
  const rawLower = raw.toLowerCase();
  switch (rule.op) {
    case 'equals':
      return rawLower === val;
    case 'not_equals':
      return rawLower !== val;
    case 'contains':
      return val ? rawLower.includes(val) : true;
    case 'empty':
      return raw === '';
    case 'not_empty':
      return raw !== '';
    default:
      return true;
  }
}

async function evaluateStepConditions(
  organizationId: string,
  contactId: string,
  conditions: StepConditions | undefined | null,
  contact: Record<string, unknown>,
  participantStatus?: string
): Promise<boolean> {
  if (!conditions || (typeof conditions !== 'object')) return true;
  if (conditions.stopIfReplied && participantStatus === 'replied') return false;
  if (conditions.contact?.length) {
    for (const rule of conditions.contact) {
      if (!evalContactRule(contact, rule)) return false;
    }
  }
  if (conditions.inPipelineStage?.pipelineId && conditions.inPipelineStage.stageIds?.length) {
    const lead = await pool.query(
      `SELECT stage_id FROM leads WHERE organization_id = $1 AND contact_id = $2 AND pipeline_id = $3`,
      [organizationId, contactId, conditions.inPipelineStage.pipelineId]
    );
    const stageId = lead.rows[0]?.stage_id;
    if (!stageId || !conditions.inPipelineStage.stageIds.includes(stageId)) return false;
  }
  if (conditions.notInPipelineStage?.pipelineId && conditions.notInPipelineStage.stageIds?.length) {
    const lead = await pool.query(
      `SELECT stage_id FROM leads WHERE organization_id = $1 AND contact_id = $2 AND pipeline_id = $3`,
      [organizationId, contactId, conditions.notInPipelineStage.pipelineId]
    );
    const stageId = lead.rows[0]?.stage_id;
    if (stageId && conditions.notInPipelineStage.stageIds.includes(stageId)) return false;
  }
  return true;
}

function dateInTz(d: Date, tz: string): { hour: number; minute: number; dayOfWeek: number } {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', hour: 'numeric', minute: 'numeric', hour12: false, weekday: 'short' });
  const parts = fmt.formatToParts(d);
  let hour = 0, minute = 0, dayOfWeek = 1;
  for (const p of parts) {
    if (p.type === 'hour') hour = parseInt(p.value, 10);
    if (p.type === 'minute') minute = parseInt(p.value, 10);
    if (p.type === 'weekday') dayOfWeek = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }[p.value.toLowerCase().slice(0, 3)] ?? 1;
  }
  return { hour, minute, dayOfWeek };
}

function isWithinScheduleAt(d: Date, schedule: Schedule): boolean {
  if (!schedule?.workingHours?.start || !schedule?.workingHours?.end || !schedule.daysOfWeek?.length) return true;
  const tz = schedule.timezone || 'UTC';
  const { hour, minute, dayOfWeek } = dateInTz(d, tz);
  const [startH] = schedule.workingHours.start.split(':').map(Number);
  const [endH] = schedule.workingHours.end.split(':').map(Number);
  const inWindow = hour > startH || (hour === startH && minute >= 0);
  const beforeEnd = hour < endH || (hour === endH && minute === 0);
  return inWindow && beforeEnd && schedule.daysOfWeek.includes(dayOfWeek);
}

function isWithinSchedule(schedule: Schedule): boolean {
  return isWithinScheduleAt(new Date(), schedule);
}

/** Next valid send time: from + delayHours, then advance by 1h until within schedule. */
function nextSendAtWithSchedule(from: Date, delayHours: number, schedule: Schedule): Date {
  const base = new Date(from.getTime() + delayHours * 60 * 60 * 1000);
  if (!schedule?.workingHours?.start || !schedule?.workingHours?.end || !schedule.daysOfWeek?.length) return base;
  let d = new Date(base.getTime());
  for (let i = 0; i < 24 * 8; i++) {
    if (isWithinScheduleAt(d, schedule)) return d;
    d.setTime(d.getTime() + 60 * 60 * 1000);
  }
  return d;
}

/** When outside schedule, retry in 15 min. */
function nextSlotRetry(schedule: Schedule): Date {
  return new Date(Date.now() + 15 * 60 * 1000);
}

async function ensureLeadInPipeline(
  organizationId: string,
  contactId: string,
  pipelineId: string,
  stageId: string | null,
  systemUserId: string,
  responsibleId?: string | null
): Promise<void> {
  try {
    const res = await fetch(`${PIPELINE_SERVICE_URL}/api/pipeline/leads`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-User-Id': systemUserId,
        'X-Organization-Id': organizationId,
      },
      body: JSON.stringify({
        contactId,
        pipelineId,
        ...(stageId ? { stageId } : {}),
        ...(responsibleId ? { responsibleId } : {}),
      }),
    });
    if (res.status === 409) return; // already in pipeline
    if (!res.ok) console.error('Pipeline create lead failed:', await res.text());
  } catch (e) {
    console.error('Pipeline create lead error:', e);
  }
}

/** Parse CSV line (handles quoted fields). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if ((c === ',' && !inQuotes) || c === '\r') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur.trim());
  return out;
}

function parseCsv(content: string): string[][] {
  const lines = content.split('\n').filter((l) => l.trim());
  return lines.map((l) => parseCsvLine(l));
}

function substituteVariables(
  content: string,
  contact: { first_name?: string | null; last_name?: string | null },
  company: { name?: string | null } | null
): string {
  return content
    .replace(/\{\{contact\.first_name\}\}/g, (contact?.first_name ?? '').trim() || '…')
    .replace(/\{\{contact\.last_name\}\}/g, (contact?.last_name ?? '').trim() || '…')
    .replace(/\{\{company\.name\}\}/g, (company?.name ?? '').trim() || '…');
}

(async () => {
  try {
    await rabbitmq.connect();
    await rabbitmq.subscribeToEvents(
      [EventType.MESSAGE_RECEIVED, EventType.LEAD_CREATED, EventType.LEAD_STAGE_CHANGED],
      async (event: any) => {
        if (event.type === EventType.LEAD_CREATED) {
          const { contactId, pipelineId, stageId } = event.data || {};
          if (contactId && pipelineId && stageId) {
            await addContactToDynamicCampaigns(event.organizationId, contactId, pipelineId, stageId);
          }
          return;
        }
        if (event.type === EventType.LEAD_STAGE_CHANGED) {
          const { contactId, pipelineId, toStageId } = event.data || {};
          if (contactId && pipelineId && toStageId) {
            await addContactToDynamicCampaigns(event.organizationId, contactId, pipelineId, toStageId);
          }
          return;
        }
        const contactId = event.data?.contactId;
        if (!contactId) return;
        const participants = await pool.query(
          `SELECT cp.id, cp.campaign_id, cp.current_step, cp.next_send_at
           FROM campaign_participants cp
           JOIN campaigns c ON c.id = cp.campaign_id
           WHERE cp.contact_id = $1 AND c.status = 'active' AND cp.status IN ('pending', 'sent')`,
          [contactId]
        );
        for (const p of participants.rows) {
          const stepsRes = await pool.query(
            `SELECT order_index, trigger_type FROM campaign_sequences WHERE campaign_id = $1 ORDER BY order_index`,
            [p.campaign_id]
          );
          const steps = stepsRes.rows as { order_index: number; trigger_type: string }[];
          const prevStep = p.current_step > 0 ? steps.find((s) => s.order_index === p.current_step - 1) : null;
          const waitingForReply = p.next_send_at === null && prevStep?.trigger_type === 'after_reply';
          if (waitingForReply) {
            await pool.query(
              `UPDATE campaign_participants SET next_send_at = NOW(), updated_at = NOW() WHERE id = $1`,
              [p.id]
            );
          } else {
            await pool.query(
              `UPDATE campaign_participants SET status = 'replied', updated_at = NOW() WHERE id = $1`,
              [p.id]
            );
            const camp = await pool.query(
              'SELECT organization_id, pipeline_id, lead_creation_settings FROM campaigns WHERE id = $1',
              [p.campaign_id]
            );
            const c = camp.rows[0];
      const lcs = c?.lead_creation_settings as { trigger?: string; default_stage_id?: string; default_responsible_id?: string } | null;
      if (c && lcs?.trigger === 'on_reply' && c.pipeline_id) {
              const userRow = await pool.query('SELECT id FROM users WHERE organization_id = $1 LIMIT 1', [c.organization_id]);
              const systemUserId = userRow.rows[0]?.id || '';
              let stageId = lcs.default_stage_id || null;
              if (!stageId) {
                const stageRow = await pool.query(
                  'SELECT id FROM stages WHERE pipeline_id = $1 AND organization_id = $2 ORDER BY order_index ASC LIMIT 1',
                  [c.pipeline_id, c.organization_id]
                );
                stageId = stageRow.rows[0]?.id || null;
              }
              if (stageId) await ensureLeadInPipeline(c.organization_id, contactId, c.pipeline_id, stageId, systemUserId, lcs?.default_responsible_id);
            }
          }
        }
      },
      'events',
      'campaign-service'
    );
  } catch (error) {
    console.error('Failed to connect to RabbitMQ, service will continue without event subscription:', error);
  }
})();

/** Add contact to active dynamic campaigns that target this pipeline + stage. */
async function addContactToDynamicCampaigns(
  organizationId: string,
  contactId: string,
  pipelineId: string,
  stageId: string
): Promise<void> {
  const contactRow = await pool.query(
    'SELECT id, telegram_id FROM contacts WHERE id = $1 AND organization_id = $2',
    [contactId, organizationId]
  );
  if (contactRow.rows.length === 0 || !contactRow.rows[0].telegram_id) return;

  const campaigns = await pool.query(
    `SELECT id, target_audience FROM campaigns
     WHERE organization_id = $1 AND status = $2 AND target_audience IS NOT NULL`,
    [organizationId, CampaignStatus.ACTIVE]
  );
  const stageIdStr = stageId;
  const pipelineIdStr = pipelineId;
  for (const c of campaigns.rows) {
    const aud = (c.target_audience || {}) as { dynamicPipelineId?: string; dynamicStageIds?: string[]; bdAccountId?: string; sendDelaySeconds?: number };
    if (!aud.dynamicPipelineId || aud.dynamicPipelineId !== pipelineIdStr || !Array.isArray(aud.dynamicStageIds) || !aud.dynamicStageIds.includes(stageIdStr)) continue;

    let bdAccountId: string | null = aud.bdAccountId ? (await pool.query('SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2 AND is_active = true', [aud.bdAccountId, organizationId])).rows[0]?.id || null : null;
    if (!bdAccountId) {
      const r = await pool.query('SELECT id FROM bd_accounts WHERE organization_id = $1 AND is_active = true LIMIT 1', [organizationId]);
      bdAccountId = r.rows[0]?.id || null;
    }
    if (!bdAccountId) continue;

    const telegramId = contactRow.rows[0].telegram_id;
    let channelId: string | null = String(telegramId);
    const chatRes = await pool.query(
      'SELECT bd_account_id, telegram_chat_id FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
      [bdAccountId, telegramId]
    );
    if (chatRes.rows.length > 0) {
      channelId = String(chatRes.rows[0].telegram_chat_id);
    }
    if (!channelId) continue;

    const sendDelaySeconds = Math.max(0, aud.sendDelaySeconds ?? 0);
    const nextSendAt = new Date(Date.now() + sendDelaySeconds * 1000);
    await pool.query(
      `INSERT INTO campaign_participants (campaign_id, contact_id, bd_account_id, channel_id, status, current_step, next_send_at)
       VALUES ($1, $2, $3, $4, 'pending', 0, $5)
       ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
      [c.id, contactId, bdAccountId, channelId, nextSendAt]
    );
  }
}

async function processCampaignSends(): Promise<void> {
  try {
    const due = await pool.query(
      `SELECT cp.id as participant_id, cp.campaign_id, cp.contact_id, cp.bd_account_id, cp.channel_id, cp.current_step, cp.status as status, c.organization_id
       FROM campaign_participants cp
       JOIN campaigns c ON c.id = cp.campaign_id
       WHERE c.status = $1 AND cp.status IN ('pending', 'sent') AND cp.next_send_at IS NOT NULL AND cp.next_send_at <= NOW()
       ORDER BY cp.next_send_at
       LIMIT 20`,
      [CampaignStatus.ACTIVE]
    );
    if (due.rows.length === 0) return;

    const campaignIds = [...new Set(due.rows.map((r: any) => r.campaign_id))];
    const campaignsRes = await pool.query(
      'SELECT id, schedule, target_audience, pipeline_id, lead_creation_settings FROM campaigns WHERE id = ANY($1)',
      [campaignIds]
    );
    const campaignMeta = new Map<string, {
      schedule: Schedule;
      sendDelaySeconds: number;
      pipeline_id: string | null;
      lead_creation_settings: { trigger?: string; default_stage_id?: string; default_responsible_id?: string } | null;
    }>();
    for (const c of campaignsRes.rows) {
      const schedule = (c.schedule as Schedule) ?? null;
      const aud = (c.target_audience || {}) as { sendDelaySeconds?: number };
      const lcs = c.lead_creation_settings as { trigger?: string; default_stage_id?: string; default_responsible_id?: string } | null;
      campaignMeta.set(c.id, {
        schedule,
        sendDelaySeconds: Math.max(0, aud.sendDelaySeconds ?? 0),
        pipeline_id: c.pipeline_id ?? null,
        lead_creation_settings: lcs ?? null,
      });
    }

    const stepsByCampaign = new Map<string, any[]>();
    for (const row of due.rows) {
      if (!stepsByCampaign.has(row.campaign_id)) {
        const seq = await pool.query(
          `SELECT cs.id, cs.order_index, cs.template_id, cs.delay_hours, cs.trigger_type, cs.conditions, ct.content
           FROM campaign_sequences cs
           JOIN campaign_templates ct ON ct.id = cs.template_id
           WHERE cs.campaign_id = $1 ORDER BY cs.order_index`,
          [row.campaign_id]
        );
        stepsByCampaign.set(row.campaign_id, seq.rows);
      }
    }

    const userRow = await pool.query('SELECT id FROM users WHERE organization_id = $1 LIMIT 1', [due.rows[0].organization_id]);
    const systemUserId = userRow.rows[0]?.id || '';

    const today = new Date().toISOString().slice(0, 10);
    const sentTodayByAccount = await pool.query(
      `SELECT cp.bd_account_id, COUNT(*)::int AS cnt
       FROM campaign_sends cs
       JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
       JOIN campaigns c ON c.id = cp.campaign_id
       WHERE cs.sent_at::date = $1::date
       GROUP BY cp.bd_account_id`,
      [today]
    );
    const sentMap = new Map((sentTodayByAccount.rows as { bd_account_id: string; cnt: number }[]).map((r) => [r.bd_account_id, r.cnt]));

    for (const row of due.rows) {
      const meta = campaignMeta.get(row.campaign_id);
      const schedule = meta?.schedule ?? null;
      const sendDelaySeconds = meta?.sendDelaySeconds ?? 0;

      if (!isWithinSchedule(schedule)) {
        await pool.query(
          `UPDATE campaign_participants SET next_send_at = $1, updated_at = NOW() WHERE id = $2`,
          [nextSlotRetry(schedule), row.participant_id]
        );
        continue;
      }

      const sentToday = sentMap.get(row.bd_account_id) ?? 0;
      if (sentToday >= CAMPAIGN_MAX_SENDS_PER_ACCOUNT_PER_DAY) {
        const tomorrowStart = new Date(today + 'T00:00:00.000Z');
        tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);
        await pool.query(
          `UPDATE campaign_participants SET next_send_at = $1, updated_at = NOW() WHERE id = $2`,
          [nextSendAtWithSchedule(tomorrowStart, 0, schedule), row.participant_id]
        );
        continue;
      }

      const steps = stepsByCampaign.get(row.campaign_id) || [];
      const step = steps[row.current_step];
      if (!step) {
        await pool.query(
          `UPDATE campaign_participants SET status = 'completed', next_send_at = NULL, updated_at = NOW() WHERE id = $1`,
          [row.participant_id]
        );
        continue;
      }

      const contactRes = await pool.query(
        `SELECT c.first_name, c.last_name, c.email, c.phone, c.telegram_id, co.name as company_name
         FROM contacts c LEFT JOIN companies co ON co.id = c.company_id WHERE c.id = $1`,
        [row.contact_id]
      );
      const contact = contactRes.rows[0] || {};
      const company = contact.company_name != null ? { name: contact.company_name } : null;

      const conditions = (step as { conditions?: StepConditions }).conditions;
      const shouldSend = await evaluateStepConditions(
        row.organization_id,
        row.contact_id,
        conditions,
        contact,
        row.status
      );
      if (!shouldSend) {
        const nextStep = steps[row.current_step + 1];
        const now = new Date();
        if (nextStep) {
          const nextTriggerType = (nextStep as { trigger_type?: string }).trigger_type || 'delay';
          const nextSendAt =
            nextTriggerType === 'after_reply'
              ? null
              : nextSendAtWithSchedule(now, (nextStep as { delay_hours?: number }).delay_hours || 24, schedule);
          await pool.query(
            `UPDATE campaign_participants SET current_step = $1, status = 'sent', next_send_at = $2, updated_at = NOW() WHERE id = $3`,
            [row.current_step + 1, nextSendAt, row.participant_id]
          );
        } else {
          await pool.query(
            `UPDATE campaign_participants SET current_step = $1, status = 'completed', next_send_at = NULL, updated_at = NOW() WHERE id = $2`,
            [row.current_step + 1, row.participant_id]
          );
        }
        continue;
      }

      const content = substituteVariables(step.content || '', contact, company);

      const res = await fetch(`${MESSAGING_SERVICE_URL}/api/messaging/send`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-User-Id': systemUserId,
          'X-Organization-Id': row.organization_id,
        },
        body: JSON.stringify({
          contactId: row.contact_id,
          channel: 'telegram',
          channelId: row.channel_id,
          content,
          bdAccountId: row.bd_account_id,
        }),
      });

      if (res.ok) {
        const nextStep = steps[row.current_step + 1];
        const now = new Date();
        if (nextStep) {
          const triggerType = (step as { trigger_type?: string }).trigger_type || 'delay';
          const nextSendAt =
            triggerType === 'after_reply'
              ? null
              : nextSendAtWithSchedule(now, step.delay_hours || 24, schedule);
          await pool.query(
            `UPDATE campaign_participants SET current_step = $1, status = 'sent', next_send_at = $2, updated_at = NOW() WHERE id = $3`,
            [row.current_step + 1, nextSendAt, row.participant_id]
          );
        } else {
          await pool.query(
            `UPDATE campaign_participants SET current_step = $1, status = 'completed', next_send_at = NULL, updated_at = NOW() WHERE id = $2`,
            [row.current_step + 1, row.participant_id]
          );
        }
        const msgJson = await res.json().catch(() => ({}));
        await pool.query(
          `INSERT INTO campaign_sends (campaign_participant_id, sequence_step, message_id, sent_at, status) VALUES ($1, $2, $3, NOW(), 'sent')`,
          [row.participant_id, row.current_step, (msgJson as any).id || null]
        );
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
          if (stageId) await ensureLeadInPipeline(row.organization_id, row.contact_id, pipelineId, stageId, systemUserId, lcs?.default_responsible_id);
        }

        if (sendDelaySeconds > 0) await new Promise((r) => setTimeout(r, sendDelaySeconds * 1000));
      } else {
        await pool.query(
          `UPDATE campaign_participants SET status = 'failed', metadata = $1, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify({ lastError: await res.text() }), row.participant_id]
        );
      }
    }

    if (campaignIds.length > 0) {
      const completed = await pool.query(
        `SELECT c.id FROM campaigns c
         WHERE c.id = ANY($1::uuid[]) AND c.status = $2
         AND NOT EXISTS (
           SELECT 1 FROM campaign_participants cp
           WHERE cp.campaign_id = c.id AND cp.status NOT IN ('completed', 'replied', 'failed')
         )
         AND EXISTS (SELECT 1 FROM campaign_participants cp WHERE cp.campaign_id = c.id)`,
        [campaignIds, CampaignStatus.ACTIVE]
      );
      for (const r of completed.rows) {
        await pool.query(
          "UPDATE campaigns SET status = $1, updated_at = NOW() WHERE id = $2",
          [CampaignStatus.COMPLETED, r.id]
        );
      }
    }
  } catch (err) {
    console.error('Campaign send worker error:', err);
  }
}

setInterval(processCampaignSends, CAMPAIGN_SEND_INTERVAL_MS);

function getUser(req: express.Request) {
  return {
    id: req.headers['x-user-id'] as string,
    organizationId: req.headers['x-organization-id'] as string,
  };
}

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'campaign-service' });
});

// --- Campaigns ---

app.get('/api/campaigns', async (req, res) => {
  try {
    const user = getUser(req);
    const { status } = req.query;
    let query = 'SELECT * FROM campaigns WHERE organization_id = $1';
    const params: string[] = [user.organizationId];
    if (status && typeof status === 'string') {
      query += ' AND status = $2';
      params.push(status);
    }
    query += ' ORDER BY created_at DESC';
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/campaigns/agents', async (req, res) => {
  try {
    const user = getUser(req);
    const accounts = await pool.query(
      `SELECT a.id, a.display_name, a.phone_number
       FROM bd_accounts a
       WHERE a.organization_id = $1 AND a.is_active = true
       ORDER BY a.display_name NULLS LAST, a.phone_number`,
      [user.organizationId]
    );
    const today = new Date().toISOString().slice(0, 10);
    const sentToday = await pool.query(
      `SELECT cp.bd_account_id, COUNT(*)::int AS sent_today
       FROM campaign_sends cs
       JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
       JOIN campaigns c ON c.id = cp.campaign_id
       WHERE c.organization_id = $1 AND cs.sent_at::date = $2::date
       GROUP BY cp.bd_account_id`,
      [user.organizationId, today]
    );
    const sentMap = new Map((sentToday.rows as { bd_account_id: string; sent_today: number }[]).map((r) => [r.bd_account_id, r.sent_today]));
    const result = accounts.rows.map((a: { id: string; display_name: string | null; phone_number: string | null }) => ({
      id: a.id,
      displayName: a.display_name || a.phone_number || a.id.slice(0, 8),
      sentToday: sentMap.get(a.id) ?? 0,
    }));
    res.json(result);
  } catch (error) {
    console.error('Error fetching campaign agents:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/campaigns/presets', async (req, res) => {
  try {
    const user = getUser(req);
    const result = await pool.query(
      `SELECT id, name, channel, content, created_at
       FROM campaign_templates
       WHERE organization_id = $1 AND campaign_id IS NULL
       ORDER BY name`,
      [user.organizationId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching presets:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/campaigns/presets', async (req, res) => {
  try {
    const user = getUser(req);
    const { name, channel, content } = req.body;
    if (!name || typeof name !== 'string' || !content || typeof content !== 'string') {
      return res.status(400).json({ error: 'Name and content are required' });
    }
    const id = randomUUID();
    await pool.query(
      `INSERT INTO campaign_templates (id, organization_id, campaign_id, name, channel, content)
       VALUES ($1, $2, NULL, $3, $4, $5)`,
      [id, user.organizationId, name.trim(), channel || 'telegram', content]
    );
    const row = await pool.query('SELECT id, name, channel, content, created_at FROM campaign_templates WHERE id = $1', [id]);
    res.status(201).json(row.rows[0]);
  } catch (error) {
    console.error('Error creating preset:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/campaigns/group-sources', async (req, res) => {
  try {
    const user = getUser(req);
    const result = await pool.query(
      `SELECT s.id, s.bd_account_id, s.telegram_chat_id, s.title, s.peer_type, a.display_name as account_name
       FROM bd_account_sync_chats s
       JOIN bd_accounts a ON a.id = s.bd_account_id
       WHERE a.organization_id = $1 AND a.is_active = true AND s.peer_type IN ('chat', 'channel')
       ORDER BY s.title`,
      [user.organizationId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching group sources:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/campaigns/group-sources/contacts', async (req, res) => {
  try {
    const user = getUser(req);
    const { bdAccountId, telegramChatId } = req.query;
    if (!bdAccountId || !telegramChatId) {
      return res.status(400).json({ error: 'bdAccountId and telegramChatId are required' });
    }
    const accountCheck = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [bdAccountId, user.organizationId]
    );
    if (accountCheck.rows.length === 0) return res.status(404).json({ error: 'Account not found' });
    const contacts = await pool.query(
      `SELECT DISTINCT m.contact_id
       FROM messages m
       WHERE m.bd_account_id = $1 AND m.channel_id = $2 AND m.contact_id IS NOT NULL
         AND m.organization_id = $3`,
      [bdAccountId, telegramChatId, user.organizationId]
    );
    const contactIds = contacts.rows.map((r: { contact_id: string }) => r.contact_id);
    res.json({ contactIds });
  } catch (error) {
    console.error('Error fetching group contacts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/campaigns/contacts-for-picker', async (req, res) => {
  try {
    const user = getUser(req);
    const { limit = 500, outreachStatus, search } = req.query;
    const limitNum = Math.min(1000, Math.max(1, parseInt(String(limit), 10)));
    let query = `
      SELECT c.id, c.first_name, c.last_name, c.telegram_id, c.display_name,
        CASE WHEN EXISTS (
          SELECT 1 FROM campaign_participants cp
          JOIN campaigns c2 ON c2.id = cp.campaign_id
          WHERE cp.contact_id = c.id AND c2.organization_id = c.organization_id
        ) THEN 'in_outreach' ELSE 'new' END AS outreach_status
      FROM contacts c
      WHERE c.organization_id = $1 AND c.telegram_id IS NOT NULL AND c.telegram_id != ''
    `;
    const params: any[] = [user.organizationId];
    let idx = 2;
    if (outreachStatus === 'new') {
      query += ` AND NOT EXISTS (SELECT 1 FROM campaign_participants cp JOIN campaigns c2 ON c2.id = cp.campaign_id WHERE cp.contact_id = c.id AND c2.organization_id = c.organization_id)`;
    } else if (outreachStatus === 'in_outreach') {
      query += ` AND EXISTS (SELECT 1 FROM campaign_participants cp JOIN campaigns c2 ON c2.id = cp.campaign_id WHERE cp.contact_id = c.id AND c2.organization_id = c.organization_id)`;
    }
    if (search && typeof search === 'string' && search.trim()) {
      const term = `%${search.trim().replace(/%/g, '\\%')}%`;
      query += ` AND (c.first_name ILIKE $${idx} OR c.last_name ILIKE $${idx} OR c.display_name ILIKE $${idx} OR c.telegram_id ILIKE $${idx})`;
      params.push(term);
      idx++;
    }
    query += ` ORDER BY c.first_name, c.last_name LIMIT $${idx}`;
    params.push(limitNum);
    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching contacts for picker:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/campaigns/:id', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const campaignRes = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (campaignRes.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = campaignRes.rows[0];
    const [templatesRes, sequencesRes] = await Promise.all([
      pool.query(
        'SELECT * FROM campaign_templates WHERE campaign_id = $1 ORDER BY created_at',
        [id]
      ),
      pool.query(
        'SELECT cs.*, ct.name as template_name, ct.channel, ct.content FROM campaign_sequences cs JOIN campaign_templates ct ON ct.id = cs.template_id WHERE cs.campaign_id = $1 ORDER BY cs.order_index',
        [id]
      ),
    ]);
    res.json({
      ...campaign,
      templates: templatesRes.rows,
      sequences: sequencesRes.rows,
    });
  } catch (error) {
    console.error('Error fetching campaign:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/campaigns', async (req, res) => {
  try {
    const user = getUser(req);
    const { name, companyId, pipelineId, targetAudience, schedule } = req.body;
    if (!name || typeof name !== 'string') {
      return res.status(400).json({ error: 'Name is required' });
    }
    const id = randomUUID();
    await pool.query(
      `INSERT INTO campaigns (id, organization_id, company_id, pipeline_id, name, status, target_audience, schedule)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        id,
        user.organizationId,
        companyId || null,
        pipelineId || null,
        name.trim(),
        CampaignStatus.DRAFT,
        JSON.stringify(targetAudience || {}),
        schedule ? JSON.stringify(schedule) : null,
      ]
    );
    const row = await pool.query('SELECT * FROM campaigns WHERE id = $1', [id]);
    const campaign = row.rows[0];
    try {
      await rabbitmq.publishEvent({
        id: randomUUID(),
        type: EventType.CAMPAIGN_CREATED,
        timestamp: new Date(),
        organizationId: user.organizationId,
        userId: user.id,
        data: { campaignId: id },
      } as any);
    } catch (_) {}
    res.status(201).json(campaign);
  } catch (error) {
    console.error('Error creating campaign:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/campaigns/:id', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { name, companyId, pipelineId, targetAudience, schedule, status, leadCreationSettings } = req.body;

    const existing = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const cur = existing.rows[0];
    const onlyStop = status === CampaignStatus.COMPLETED && cur.status === CampaignStatus.ACTIVE;
    if (!onlyStop && cur.status !== CampaignStatus.DRAFT && cur.status !== CampaignStatus.PAUSED) {
      return res.status(400).json({ error: 'Only draft or paused campaigns can be updated' });
    }

    if (onlyStop) {
      await pool.query(
        "UPDATE campaigns SET status = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3",
        [CampaignStatus.COMPLETED, id, user.organizationId]
      );
      const updated = await pool.query('SELECT * FROM campaigns WHERE id = $1', [id]);
      return res.json(updated.rows[0]);
    }

    const updates: string[] = ['updated_at = NOW()'];
    const params: any[] = [];
    let idx = 1;
    if (name !== undefined) {
      params.push(typeof name === 'string' ? name.trim() : name);
      updates.push(`name = $${idx++}`);
    }
    if (companyId !== undefined) {
      params.push(companyId || null);
      updates.push(`company_id = $${idx++}`);
    }
    if (pipelineId !== undefined) {
      params.push(pipelineId || null);
      updates.push(`pipeline_id = $${idx++}`);
    }
    if (targetAudience !== undefined) {
      params.push(JSON.stringify(targetAudience || {}));
      updates.push(`target_audience = $${idx++}`);
    }
    if (schedule !== undefined) {
      params.push(schedule ? JSON.stringify(schedule) : null);
      updates.push(`schedule = $${idx++}`);
    }
    if (leadCreationSettings !== undefined) {
      params.push(leadCreationSettings ? JSON.stringify(leadCreationSettings) : null);
      updates.push(`lead_creation_settings = $${idx++}`);
    }
    if (status !== undefined && [CampaignStatus.DRAFT, CampaignStatus.PAUSED].includes(status)) {
      params.push(status);
      updates.push(`status = $${idx++}`);
    }
    if (params.length === 1) {
      return res.json(existing.rows[0]);
    }
    params.push(id, user.organizationId);
    const result = await pool.query(
      `UPDATE campaigns SET ${updates.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1} RETURNING *`,
      params
    );
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating campaign:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/campaigns/:id', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const existing = await pool.query(
      'SELECT status FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (existing.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const status = existing.rows[0].status;
    if (status === CampaignStatus.ACTIVE) {
      return res.status(400).json({ error: 'Cannot delete active campaign; pause it first' });
    }
    await pool.query('DELETE FROM campaigns WHERE id = $1 AND organization_id = $2', [id, user.organizationId]);
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting campaign:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Audience from CSV: parse CSV, match or create contacts, return contactIds
app.post('/api/campaigns/:id/audience/from-csv', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { content, hasHeader = true } = req.body as { content?: string; hasHeader?: boolean };
    if (!content || typeof content !== 'string') {
      return res.status(400).json({ error: 'content (CSV text) is required' });
    }
    const campaign = await pool.query(
      'SELECT id, organization_id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (campaign.rows.length === 0) return res.status(404).json({ error: 'Campaign not found' });
    const organizationId = campaign.rows[0].organization_id;

    const rows = parseCsv(content);
    if (rows.length === 0) return res.json({ contactIds: [], created: 0, matched: 0 });
    const header = hasHeader ? rows[0] : [];
    const dataRows = hasHeader ? rows.slice(1) : rows;
    const col = (name: string) => {
      const i = header.map((h) => h.toLowerCase().replace(/\s/g, '_')).indexOf(name);
      return i >= 0 ? i : -1;
    };
    const idxTelegram = col('telegram_id') >= 0 ? col('telegram_id') : col('telegram') >= 0 ? col('telegram') : 0;
    const idxFirst = col('first_name') >= 0 ? col('first_name') : col('name') >= 0 ? col('name') : 1;
    const idxLast = col('last_name') >= 0 ? col('last_name') : 2;
    const idxEmail = col('email') >= 0 ? col('email') : -1;

    const contactIds: string[] = [];
    let created = 0, matched = 0;
    for (const row of dataRows) {
      const telegramId = (row[idxTelegram] || '').trim().replace(/^@/, '') || null;
      const email = idxEmail >= 0 ? (row[idxEmail] || '').trim() || null : null;
      const firstName = (row[idxFirst] || '').trim() || 'Contact';
      const lastName = (row[idxLast] || '').trim() || null;
      if (!telegramId && !email) continue;
      let contact: { id: string } | null = null;
      if (telegramId) {
        const r = await pool.query(
          'SELECT id FROM contacts WHERE organization_id = $1 AND telegram_id = $2 LIMIT 1',
          [organizationId, telegramId]
        );
        contact = r.rows[0] || null;
      }
      if (!contact && email) {
        const r = await pool.query(
          'SELECT id FROM contacts WHERE organization_id = $1 AND email = $2 LIMIT 1',
          [organizationId, email]
        );
        contact = r.rows[0] || null;
      }
      if (contact) {
        matched++;
        contactIds.push(contact.id);
      } else {
        const newId = randomUUID();
        await pool.query(
          `INSERT INTO contacts (id, organization_id, first_name, last_name, email, telegram_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
          [newId, organizationId, firstName, lastName || null, email || null, telegramId || null]
        );
        created++;
        contactIds.push(newId);
      }
    }
    res.json({ contactIds, created, matched });
  } catch (error) {
    console.error('Error importing audience from CSV:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start campaign: materialize participants and set status active
app.post('/api/campaigns/:id/start', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const campaignRes = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (campaignRes.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const campaign = campaignRes.rows[0];
    if (campaign.status !== CampaignStatus.DRAFT && campaign.status !== CampaignStatus.PAUSED && campaign.status !== CampaignStatus.COMPLETED) {
      return res.status(400).json({ error: 'Campaign can be started only from draft, paused or completed' });
    }

    // When restarting from completed: clear previous participants (sends are cascade-deleted)
    if (campaign.status === CampaignStatus.COMPLETED) {
      await pool.query('DELETE FROM campaign_participants WHERE campaign_id = $1', [id]);
    }

    const audience = (campaign.target_audience || {}) as {
      filters?: Record<string, unknown>;
      limit?: number;
      onlyNew?: boolean;
      contactIds?: string[];
      bdAccountId?: string;
    };
    const limit = Math.min(audience.limit ?? 5000, 10000);

    // Build audience: contacts with telegram_id; optionally only contactIds, or onlyNew (never in any campaign)
    let contactsQuery: string;
    const queryParams: any[] = [user.organizationId];
    let paramIdx = 2;

    if (audience.contactIds && Array.isArray(audience.contactIds) && audience.contactIds.length > 0) {
      const ids = audience.contactIds.slice(0, limit).filter((x) => typeof x === 'string');
      if (ids.length === 0) {
        return res.status(400).json({ error: 'No valid contact IDs in audience' });
      }
      contactsQuery = `
        SELECT c.id as contact_id, c.organization_id, c.telegram_id
        FROM contacts c
        WHERE c.organization_id = $1 AND c.telegram_id IS NOT NULL AND c.telegram_id != ''
        AND c.id = ANY($${paramIdx}::uuid[])
      `;
      queryParams.push(ids);
      paramIdx++;
    } else {
      contactsQuery = `
        SELECT c.id as contact_id, c.organization_id, c.telegram_id
        FROM contacts c
        WHERE c.organization_id = $1 AND c.telegram_id IS NOT NULL AND c.telegram_id != ''
      `;
      if (audience.filters?.companyId) {
        contactsQuery += ` AND c.company_id = $${paramIdx++}`;
        queryParams.push(audience.filters.companyId);
      }
      if (audience.filters?.pipelineId) {
        contactsQuery += ` AND EXISTS (SELECT 1 FROM leads l WHERE l.contact_id = c.id AND l.pipeline_id = $${paramIdx})`;
        queryParams.push(audience.filters.pipelineId);
        paramIdx++;
      }
      if (audience.onlyNew) {
        contactsQuery += ` AND NOT EXISTS (
          SELECT 1 FROM campaign_participants cp
          JOIN campaigns c2 ON c2.id = cp.campaign_id
          WHERE cp.contact_id = c.id AND c2.organization_id = c.organization_id
        )`;
      }
      contactsQuery += ` LIMIT ${limit}`;
    }

    const contactsResult = await pool.query(contactsQuery, queryParams);
    const contacts = contactsResult.rows;

    // BD account: from audience or first active
    let defaultBdAccountId: string | null = null;
    if (audience.bdAccountId) {
      const check = await pool.query(
        'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2 AND is_active = true',
        [audience.bdAccountId, user.organizationId]
      );
      defaultBdAccountId = check.rows[0]?.id || null;
    }
    if (!defaultBdAccountId) {
      const bdAccountRes = await pool.query(
        `SELECT id FROM bd_accounts WHERE organization_id = $1 AND is_active = true LIMIT 1`,
        [user.organizationId]
      );
      defaultBdAccountId = bdAccountRes.rows[0]?.id || null;
    }

    const now = new Date();
    for (const row of contacts) {
      let bdAccountId = defaultBdAccountId;
      let channelId: string | null = row.telegram_id;
      if (channelId && bdAccountId) {
        const chatRes = await pool.query(
          `SELECT bd_account_id, telegram_chat_id FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1`,
          [bdAccountId, channelId]
        );
        if (chatRes.rows.length > 0) {
          bdAccountId = chatRes.rows[0].bd_account_id;
          channelId = String(chatRes.rows[0].telegram_chat_id);
        }
      }
      if (!channelId || !bdAccountId) continue;
      await pool.query(
        `INSERT INTO campaign_participants (campaign_id, contact_id, bd_account_id, channel_id, status, current_step, next_send_at)
         VALUES ($1, $2, $3, $4, 'pending', 0, $5)
         ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
        [id, row.contact_id, bdAccountId, channelId, now]
      );
    }

    await pool.query(
      "UPDATE campaigns SET status = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3",
      [CampaignStatus.ACTIVE, id, user.organizationId]
    );
    try {
      await rabbitmq.publishEvent({
        id: randomUUID(),
        type: EventType.CAMPAIGN_STARTED,
        timestamp: new Date(),
        organizationId: user.organizationId,
        userId: user.id,
        data: { campaignId: id },
      } as any);
    } catch (_) {}
    const updated = await pool.query('SELECT * FROM campaigns WHERE id = $1', [id]);
    res.json(updated.rows[0]);
  } catch (error) {
    console.error('Error starting campaign:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/campaigns/:id/pause', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const r = await pool.query(
      "UPDATE campaigns SET status = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3 AND status = $4 RETURNING *",
      [CampaignStatus.PAUSED, id, user.organizationId, CampaignStatus.ACTIVE]
    );
    if (r.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found or not active' });
    }
    try {
      await rabbitmq.publishEvent({
        id: randomUUID(),
        type: EventType.CAMPAIGN_PAUSED,
        timestamp: new Date(),
        organizationId: user.organizationId,
        userId: user.id,
        data: { campaignId: id },
      } as any);
    } catch (_) {}
    res.json(r.rows[0]);
  } catch (error) {
    console.error('Error pausing campaign:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Templates ---

app.get('/api/campaigns/:id/templates', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (campaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const result = await pool.query(
      'SELECT * FROM campaign_templates WHERE campaign_id = $1 ORDER BY created_at',
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching templates:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/campaigns/:id/templates', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { name, channel, content, conditions } = req.body;
    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (campaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    if (!name || !channel || content === undefined) {
      return res.status(400).json({ error: 'name, channel, and content are required' });
    }
    const templateId = randomUUID();
    await pool.query(
      `INSERT INTO campaign_templates (id, organization_id, campaign_id, name, channel, content, conditions)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        templateId,
        user.organizationId,
        id,
        String(name).trim(),
        String(channel).trim(),
        typeof content === 'string' ? content : '',
        JSON.stringify(conditions || {}),
      ]
    );
    const row = await pool.query('SELECT * FROM campaign_templates WHERE id = $1', [templateId]);
    res.status(201).json(row.rows[0]);
  } catch (error) {
    console.error('Error creating template:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/campaigns/:campaignId/templates/:templateId', async (req, res) => {
  try {
    const user = getUser(req);
    const { campaignId, templateId } = req.params;
    const { name, channel, content, conditions } = req.body;
    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [campaignId, user.organizationId]
    );
    if (campaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const updates: string[] = ['updated_at = NOW()'];
    const params: any[] = [];
    let idx = 1;
    if (name !== undefined) {
      params.push(String(name).trim());
      updates.push(`name = $${idx++}`);
    }
    if (channel !== undefined) {
      params.push(String(channel).trim());
      updates.push(`channel = $${idx++}`);
    }
    if (content !== undefined) {
      params.push(typeof content === 'string' ? content : '');
      updates.push(`content = $${idx++}`);
    }
    if (conditions !== undefined) {
      params.push(JSON.stringify(conditions || {}));
      updates.push(`conditions = $${idx++}`);
    }
    if (params.length === 0) {
      const r = await pool.query(
        'SELECT * FROM campaign_templates WHERE id = $1 AND campaign_id = $2',
        [templateId, campaignId]
      );
      return r.rows.length ? res.json(r.rows[0]) : res.status(404).json({ error: 'Template not found' });
    }
    params.push(templateId, campaignId);
    const result = await pool.query(
      `UPDATE campaign_templates SET ${updates.join(', ')} WHERE id = $${idx} AND campaign_id = $${idx + 1} RETURNING *`,
      params
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Template not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating template:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Sequences ---

app.get('/api/campaigns/:id/sequences', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (campaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const result = await pool.query(
      'SELECT cs.*, ct.name as template_name, ct.channel, ct.content FROM campaign_sequences cs JOIN campaign_templates ct ON ct.id = cs.template_id WHERE cs.campaign_id = $1 ORDER BY cs.order_index',
      [id]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching sequences:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/campaigns/:id/sequences', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { orderIndex, templateId, delayHours, conditions, triggerType } = req.body;
    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (campaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const template = await pool.query(
      'SELECT id FROM campaign_templates WHERE id = $1 AND campaign_id = $2',
      [templateId, id]
    );
    if (template.rows.length === 0) {
      return res.status(400).json({ error: 'Template not found or does not belong to this campaign' });
    }
    const seqId = randomUUID();
    const trigger = triggerType === 'after_reply' ? 'after_reply' : 'delay';
    await pool.query(
      `INSERT INTO campaign_sequences (id, campaign_id, order_index, template_id, delay_hours, conditions, trigger_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        seqId,
        id,
        typeof orderIndex === 'number' ? orderIndex : 0,
        templateId,
        typeof delayHours === 'number' ? Math.max(0, delayHours) : 24,
        JSON.stringify(conditions || {}),
        trigger,
      ]
    );
    const row = await pool.query(
      'SELECT cs.*, ct.name as template_name FROM campaign_sequences cs JOIN campaign_templates ct ON ct.id = cs.template_id WHERE cs.id = $1',
      [seqId]
    );
    res.status(201).json(row.rows[0]);
  } catch (error) {
    console.error('Error creating sequence step:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/campaigns/:campaignId/sequences/:stepId', async (req, res) => {
  try {
    const user = getUser(req);
    const { campaignId, stepId } = req.params;
    const { orderIndex, templateId, delayHours, conditions, triggerType } = req.body;
    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [campaignId, user.organizationId]
    );
    if (campaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const updates: string[] = ['updated_at = NOW()'];
    const params: any[] = [];
    let idx = 1;
    if (typeof orderIndex === 'number') {
      params.push(orderIndex);
      updates.push(`order_index = $${idx++}`);
    }
    if (templateId !== undefined) {
      params.push(templateId);
      updates.push(`template_id = $${idx++}`);
    }
    if (typeof delayHours === 'number') {
      params.push(Math.max(0, delayHours));
      updates.push(`delay_hours = $${idx++}`);
    }
    if (conditions !== undefined) {
      params.push(JSON.stringify(conditions || {}));
      updates.push(`conditions = $${idx++}`);
    }
    if (triggerType !== undefined) {
      params.push(triggerType === 'after_reply' ? 'after_reply' : 'delay');
      updates.push(`trigger_type = $${idx++}`);
    }
    if (params.length === 0) {
      const r = await pool.query(
        'SELECT cs.*, ct.name as template_name, ct.channel, ct.content FROM campaign_sequences cs JOIN campaign_templates ct ON ct.id = cs.template_id WHERE cs.id = $1 AND cs.campaign_id = $2',
        [stepId, campaignId]
      );
      return r.rows.length ? res.json(r.rows[0]) : res.status(404).json({ error: 'Sequence step not found' });
    }
    params.push(stepId, campaignId);
    const result = await pool.query(
      `UPDATE campaign_sequences SET ${updates.join(', ')} WHERE id = $${idx} AND campaign_id = $${idx + 1} RETURNING *`,
      params
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Sequence step not found' });
    }
    const row = await pool.query(
      'SELECT cs.*, ct.name as template_name, ct.channel, ct.content FROM campaign_sequences cs JOIN campaign_templates ct ON ct.id = cs.template_id WHERE cs.id = $1',
      [stepId]
    );
    res.json(row.rows[0]);
  } catch (error) {
    console.error('Error updating sequence step:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/campaigns/:campaignId/sequences/:stepId', async (req, res) => {
  try {
    const user = getUser(req);
    const { campaignId, stepId } = req.params;
    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [campaignId, user.organizationId]
    );
    if (campaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    await pool.query(
      'DELETE FROM campaign_sequences WHERE id = $1 AND campaign_id = $2',
      [stepId, campaignId]
    );
    res.status(204).send();
  } catch (error) {
    console.error('Error deleting sequence step:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- Participants & Stats ---

app.get('/api/campaigns/:id/stats', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (campaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const totalRes = await pool.query(
      'SELECT COUNT(*)::int AS total FROM campaign_participants WHERE campaign_id = $1',
      [id]
    );
    const byStatusRes = await pool.query(
      `SELECT status, COUNT(*)::int AS cnt FROM campaign_participants WHERE campaign_id = $1 GROUP BY status`,
      [id]
    );
    const total = totalRes.rows[0]?.total ?? 0;
    const byStatus: Record<string, number> = {};
    for (const r of byStatusRes.rows as { status: string; cnt: number }[]) {
      byStatus[r.status] = r.cnt;
    }
    res.json({ total, byStatus });
  } catch (error) {
    console.error('Error fetching campaign stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/campaigns/:id/analytics', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { days = 14 } = req.query;
    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (campaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const daysNum = Math.min(90, Math.max(1, parseInt(String(days), 10)));
    const sendsByDay = await pool.query(
      `SELECT cs.sent_at::date AS day, COUNT(*)::int AS sends
       FROM campaign_sends cs
       JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
       WHERE cp.campaign_id = $1 AND cs.sent_at >= NOW() - ($2::int || ' days')::interval
       GROUP BY cs.sent_at::date
       ORDER BY day`,
      [id, daysNum]
    );
    const repliedByDay = await pool.query(
      `SELECT cp.updated_at::date AS day, COUNT(*)::int AS replied
       FROM campaign_participants cp
       WHERE cp.campaign_id = $1 AND cp.status = 'replied' AND cp.updated_at >= NOW() - ($2::int || ' days')::interval
       GROUP BY cp.updated_at::date
       ORDER BY day`,
      [id, daysNum]
    );
    res.json({
      sendsByDay: (sendsByDay.rows as { day: string; sends: number }[]).map((r) => ({ date: r.day, sends: r.sends })),
      repliedByDay: (repliedByDay.rows as { day: string; replied: number }[]).map((r) => ({ date: r.day, replied: r.replied })),
    });
  } catch (error) {
    console.error('Error fetching campaign analytics:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/api/campaigns/:id/participants', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { page = 1, limit = 50, status } = req.query;
    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (campaign.rows.length === 0) {
      return res.status(404).json({ error: 'Campaign not found' });
    }
    const pageNum = Math.max(1, parseInt(String(page), 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10)));
    const offset = (pageNum - 1) * limitNum;
    let whereStatus = '';
    const params: any[] = [id];
    if (status && typeof status === 'string') {
      whereStatus = ' AND cp.status = $2';
      params.push(status);
    }
    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;
    params.push(limitNum, offset);
    const result = await pool.query(
      `SELECT cp.*, c.first_name, c.last_name, c.telegram_id
       FROM campaign_participants cp
       JOIN contacts c ON c.id = cp.contact_id
       WHERE cp.campaign_id = $1 ${whereStatus}
       ORDER BY cp.created_at
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching participants:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Campaign service running on port ${PORT}`);
});