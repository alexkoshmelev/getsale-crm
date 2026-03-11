import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { CampaignStatus } from '@getsale/types';
import { ServiceHttpClient } from '@getsale/service-core';
import {
  Schedule, StepConditions,
  evaluateStepConditions, isWithinSchedule, nextSendAtWithSchedule,
  delayHoursFromStep, nextSlotRetry, substituteVariables, ensureLeadInPipeline,
} from './helpers';

const CAMPAIGN_SEND_INTERVAL_MS = parseInt(String(process.env.CAMPAIGN_SEND_INTERVAL_MS || 60000), 10);
const CAMPAIGN_MAX_SENDS_PER_ACCOUNT_PER_DAY = parseInt(String(process.env.CAMPAIGN_MAX_SENDS_PER_ACCOUNT_PER_DAY || 40), 10);

export interface CampaignLoopDeps {
  pool: Pool;
  log: Logger;
  messagingClient: ServiceHttpClient;
  pipelineClient: ServiceHttpClient;
}

export function startCampaignLoop(deps: CampaignLoopDeps): void {
  setInterval(() => processCampaignSends(deps), CAMPAIGN_SEND_INTERVAL_MS);
}

async function processCampaignSends(deps: CampaignLoopDeps): Promise<void> {
  const { pool, log, messagingClient, pipelineClient } = deps;

  try {
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
    const campaignMeta = new Map<string, {
      schedule: Schedule;
      sendDelaySeconds: number;
      pipeline_id: string | null;
      lead_creation_settings: { trigger?: string; default_stage_id?: string; default_responsible_id?: string } | null;
    }>();
    const stepsByCampaign = new Map<string, any[]>();
    const processedCampaignIds = new Set<string>();
    const BATCH = 20;

    for (let i = 0; i < BATCH; i++) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
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
        if (due.rows.length === 0) {
          await client.query('COMMIT');
          break;
        }
        const row = due.rows[0] as any;
        processedCampaignIds.add(row.campaign_id);

        if (!campaignMeta.has(row.campaign_id)) {
          const campaignsRes = await pool.query(
            'SELECT id, schedule, target_audience, pipeline_id, lead_creation_settings FROM campaigns WHERE id = $1',
            [row.campaign_id]
          );
          const c = campaignsRes.rows[0];
          if (c) {
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
        }
        if (!stepsByCampaign.has(row.campaign_id)) {
          const seq = await pool.query(
            `SELECT cs.id, cs.order_index, cs.template_id, cs.delay_hours, cs.delay_minutes, cs.trigger_type, cs.conditions, ct.content
             FROM campaign_sequences cs
             JOIN campaign_templates ct ON ct.id = cs.template_id
             WHERE cs.campaign_id = $1 ORDER BY cs.order_index`,
            [row.campaign_id]
          );
          stepsByCampaign.set(row.campaign_id, seq.rows);
        }

        const meta = campaignMeta.get(row.campaign_id);
        const schedule = meta?.schedule ?? null;
        const sendDelaySeconds = meta?.sendDelaySeconds ?? 0;

        if (!isWithinSchedule(schedule)) {
          await client.query(
            `UPDATE campaign_participants SET next_send_at = $1, updated_at = NOW() WHERE id = $2`,
            [nextSlotRetry(schedule), row.participant_id]
          );
          await client.query('COMMIT');
          continue;
        }

        const sentToday = sentMap.get(row.bd_account_id) ?? 0;
        if (sentToday >= CAMPAIGN_MAX_SENDS_PER_ACCOUNT_PER_DAY) {
          const tomorrowStart = new Date(today + 'T00:00:00.000Z');
          tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);
          await client.query(
            `UPDATE campaign_participants SET next_send_at = $1, updated_at = NOW() WHERE id = $2`,
            [nextSendAtWithSchedule(tomorrowStart, 0, schedule), row.participant_id]
          );
          await client.query('COMMIT');
          continue;
        }

        const steps = stepsByCampaign.get(row.campaign_id) || [];
        const step = steps[row.current_step];
        if (!step) {
          await client.query(
            `UPDATE campaign_participants SET status = 'completed', next_send_at = NULL, updated_at = NOW() WHERE id = $1`,
            [row.participant_id]
          );
          await client.query('COMMIT');
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
          pool,
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
                : nextSendAtWithSchedule(now, delayHoursFromStep(nextStep), schedule);
            await client.query(
              `UPDATE campaign_participants SET current_step = $1, status = 'sent', next_send_at = $2, updated_at = NOW() WHERE id = $3`,
              [row.current_step + 1, nextSendAt, row.participant_id]
            );
          } else {
            await client.query(
              `UPDATE campaign_participants SET current_step = $1, status = 'completed', next_send_at = NULL, updated_at = NOW() WHERE id = $2`,
              [row.current_step + 1, row.participant_id]
            );
          }
          await client.query('COMMIT');
          continue;
        }

        const userRow = await pool.query('SELECT id FROM users WHERE organization_id = $1 LIMIT 1', [row.organization_id]);
        const systemUserId = userRow.rows[0]?.id || '';
        const content = substituteVariables(step.content || '', contact, company);

        let msgJson: { id?: string } | null = null;
        try {
          msgJson = await messagingClient.post<{ id?: string }>('/api/messaging/send', {
            contactId: row.contact_id,
            channel: 'telegram',
            channelId: row.channel_id,
            content,
            bdAccountId: row.bd_account_id,
          }, undefined, { userId: systemUserId, organizationId: row.organization_id });
        } catch (sendErr) {
          await client.query(
            `UPDATE campaign_participants SET status = 'failed', metadata = $1, updated_at = NOW() WHERE id = $2`,
            [JSON.stringify({ lastError: sendErr instanceof Error ? sendErr.message : String(sendErr) }), row.participant_id]
          );
          await client.query('COMMIT');
          continue;
        }

        const nextStep = steps[row.current_step + 1];
        const now = new Date();
        if (nextStep) {
          const triggerType = (step as { trigger_type?: string }).trigger_type || 'delay';
          const nextSendAt =
            triggerType === 'after_reply'
              ? null
              : nextSendAtWithSchedule(now, delayHoursFromStep(step), schedule);
          await client.query(
            `UPDATE campaign_participants SET current_step = $1, status = 'sent', next_send_at = $2, updated_at = NOW() WHERE id = $3`,
            [row.current_step + 1, nextSendAt, row.participant_id]
          );
        } else {
          await client.query(
            `UPDATE campaign_participants SET current_step = $1, status = 'completed', next_send_at = NULL, updated_at = NOW() WHERE id = $2`,
            [row.current_step + 1, row.participant_id]
          );
        }
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

        if (sendDelaySeconds > 0) await new Promise((r) => setTimeout(r, sendDelaySeconds * 1000));
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
    }

    if (processedCampaignIds.size > 0) {
      const campaignIds = Array.from(processedCampaignIds);
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
    log.error({ message: 'Campaign send worker error', error: String(err) });
  }
}
