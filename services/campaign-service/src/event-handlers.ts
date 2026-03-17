import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { EventType } from '@getsale/events';
import { CampaignStatus } from '@getsale/types';
import { Logger } from '@getsale/logger';
import { ServiceHttpClient } from '@getsale/service-core';
import { CHANNEL_TELEGRAM, ensureLeadInPipeline, delayHoursFromStep } from './helpers';

export interface EventHandlerDeps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  pipelineClient: ServiceHttpClient;
}

export async function subscribeToEvents(deps: EventHandlerDeps): Promise<void> {
  const { rabbitmq } = deps;
  await rabbitmq.subscribeToEvents(
    [EventType.MESSAGE_RECEIVED, EventType.LEAD_CREATED, EventType.LEAD_STAGE_CHANGED],
    (event: any) => processEvent(deps, event),
    'events',
    'campaign-service'
  );
}

async function processEvent(deps: EventHandlerDeps, event: any): Promise<void> {
  const { pool, log, pipelineClient, rabbitmq } = deps;

  if (event.type === EventType.LEAD_CREATED) {
    const { contactId, pipelineId, stageId } = event.data || {};
    if (contactId && pipelineId && stageId) {
      await addContactToDynamicCampaigns(deps, event.organizationId, contactId, pipelineId, stageId);
    }
    return;
  }

  if (event.type === EventType.LEAD_STAGE_CHANGED) {
    const { contactId, pipelineId, toStageId } = event.data || {};
    if (contactId && pipelineId && toStageId) {
      await addContactToDynamicCampaigns(deps, event.organizationId, contactId, pipelineId, toStageId);
    }
    return;
  }

  const contactId = event.data?.contactId;
  if (!contactId) {
    log.info({ message: 'MESSAGE_RECEIVED skipped: no contactId', eventId: event.id });
    return;
  }

  const bdAccountId = event.data?.bdAccountId ?? null;
  const channelId = event.data?.channelId ?? null;

  const participants = await pool.query(
    `SELECT cp.id, cp.campaign_id, cp.current_step, cp.next_send_at, cp.bd_account_id, cp.channel_id
     FROM campaign_participants cp
     JOIN campaigns c ON c.id = cp.campaign_id
     WHERE cp.contact_id = $1 AND c.status IN ('active', 'completed') AND cp.status IN ('pending', 'sent', 'completed')
     AND (($2::text IS NULL AND $3::text IS NULL) OR (cp.bd_account_id = $2 AND cp.channel_id = $3))`,
    [contactId, bdAccountId, channelId]
  );

  if (participants.rows.length === 0 && (bdAccountId || channelId)) {
    log.info({
      message: 'MESSAGE_RECEIVED skipped: no matching participant for chat',
      contactId,
      bdAccountId,
      channelId,
      eventId: event.id,
    });
    return;
  }

  for (const p of participants.rows) {
    const stepsRes = await pool.query(
      `SELECT order_index, trigger_type, delay_hours, delay_minutes FROM campaign_sequences WHERE campaign_id = $1 ORDER BY order_index`,
      [p.campaign_id]
    );
    const steps = stepsRes.rows as { order_index: number; trigger_type: string; delay_hours?: number; delay_minutes?: number }[];
    const prevStep = p.current_step > 0 ? steps.find((s) => s.order_index === p.current_step - 1) : null;
    const waitingForReply = p.next_send_at === null && prevStep?.trigger_type === 'after_reply';

    if (waitingForReply) {
      const currentStep = steps.find((s) => s.order_index === p.current_step);
      const stepDelayHours = delayHoursFromStep(currentStep ?? null);
      const humanJitterMs = 120_000 + Math.floor(Math.random() * 180_000);
      const delayMs = Math.max(humanJitterMs, stepDelayHours * 3_600_000);
      const nextSendAt = new Date(Date.now() + delayMs);
      await pool.query(
        `UPDATE campaign_participants SET next_send_at = $1, updated_at = NOW() WHERE id = $2`,
        [nextSendAt, p.id]
      );
      log.info({
        message: 'Campaign participant next_send_at set after reply',
        participantId: p.id,
        campaignId: p.campaign_id,
        contactId,
        nextSendAt: nextSendAt.toISOString(),
      });
    } else {
      await pool.query(
        `UPDATE campaign_participants SET status = 'replied', updated_at = NOW() WHERE id = $1`,
        [p.id]
      );
      log.info({
        message: 'Campaign participant marked replied',
        participantId: p.id,
        campaignId: p.campaign_id,
        contactId,
      });

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
        if (stageId) {
          const leadId = await ensureLeadInPipeline(pipelineClient, log, c.organization_id, contactId, c.pipeline_id, stageId, systemUserId, lcs?.default_responsible_id);
          if (leadId) {
            let conversationId: string | null = null;
            const bdAccountId = p.bd_account_id ?? null;
            const channelId = p.channel_id ?? null;
            if (bdAccountId && channelId) {
              const conv = await pool.query(
                `SELECT id FROM conversations WHERE organization_id = $1 AND bd_account_id = $2 AND channel = $3 AND channel_id = $4 LIMIT 1`,
                [c.organization_id, bdAccountId, CHANNEL_TELEGRAM, channelId]
              );
              conversationId = conv.rows[0]?.id ?? null;
            }
            const repliedAt = new Date();
            try {
              await pool.query(
                `INSERT INTO lead_activity_log (id, lead_id, type, metadata, created_at) VALUES (gen_random_uuid(), $1, 'campaign_reply_received', $2, $3)`,
                [leadId, JSON.stringify({ campaign_id: p.campaign_id }), repliedAt]
              );
              await pool.query(
                `INSERT INTO lead_activity_log (id, lead_id, type, metadata, created_at) VALUES (gen_random_uuid(), $1, 'lead_created', $2, $3)`,
                [leadId, JSON.stringify({ source: 'campaign', campaign_id: p.campaign_id, conversation_id: conversationId }), repliedAt]
              );
            } catch (logErr) {
              log.error({ message: 'Lead activity log insert error', error: String(logErr) });
            }
            try {
              await rabbitmq.publishEvent({
                id: randomUUID(),
                type: EventType.LEAD_CREATED_FROM_CAMPAIGN,
                timestamp: repliedAt,
                organizationId: c.organization_id,
                data: {
                  leadId,
                  contactId,
                  campaignId: p.campaign_id,
                  organizationId: c.organization_id,
                  conversationId: conversationId ?? undefined,
                  pipelineId: c.pipeline_id,
                  stageId,
                  repliedAt: repliedAt.toISOString(),
                },
              } as any);
            } catch (pubErr) {
              log.error({ message: 'LEAD_CREATED_FROM_CAMPAIGN publish error', error: String(pubErr) });
            }
          }
        }
      }
    }
  }
}

async function addContactToDynamicCampaigns(
  deps: EventHandlerDeps,
  organizationId: string,
  contactId: string,
  pipelineId: string,
  stageId: string
): Promise<void> {
  const { pool } = deps;

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
