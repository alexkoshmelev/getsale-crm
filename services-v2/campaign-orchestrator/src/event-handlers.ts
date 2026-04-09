import { Pool } from 'pg';
import { EventType } from '@getsale/events';
import { Logger } from '@getsale/logger';
import { type RabbitMQClient } from '@getsale/queue';
import { RedisClient } from '@getsale/cache';
import { JobQueue } from '@getsale/queue';
import { type CampaignJobData } from './scheduler';
import { randomUUID } from 'node:crypto';

const TELEGRAM_SPAMBOT_USER_ID = '178220800';
const IGNORED_BOT_IDS = new Set([
  TELEGRAM_SPAMBOT_USER_ID,
  '777000',    // Telegram service notifications
]);
const CHANNEL_TELEGRAM = 'telegram';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  redis: RedisClient;
  jobQueue: JobQueue<CampaignJobData>;
}

export async function subscribeToCampaignEvents(deps: Deps): Promise<void> {
  const { pool, rabbitmq, log, redis, jobQueue } = deps;

  await rabbitmq.subscribeToEvents(
    [EventType.MESSAGE_RECEIVED],
    async (event: any) => {
      if (event.type !== EventType.MESSAGE_RECEIVED) return;
      const data = event.data as {
        messageId?: string;
        channelId?: string;
        bdAccountId?: string;
        contactId?: string;
        direction?: string;
        content?: string;
      };

      if (data.direction !== 'inbound') return;
      const orgId = event.organizationId ?? '';
      if (!orgId) return;

      const bdAccountId = data.bdAccountId ?? null;
      const channelId = data.channelId ?? null;
      if (!bdAccountId || !channelId) return;

      if (IGNORED_BOT_IDS.has(String(channelId))) return;

      const senderTelegramId = (data as any).senderTelegramId ?? (data as any).telegramUserId ?? null;
      if (senderTelegramId && IGNORED_BOT_IDS.has(String(senderTelegramId))) return;

      try {
        await handleCampaignReply(pool, log, redis, jobQueue, rabbitmq, {
          organizationId: orgId,
          bdAccountId,
          channelId,
          contactId: data.contactId ?? null,
        });
      } catch (err) {
        log.warn({ message: 'Campaign reply handler error', error: String(err) });
      }
    },
    'events',
    'campaign-orchestrator-v2',
  );

  log.info({ message: 'Campaign event subscriptions active' });
}

async function handleCampaignReply(
  pool: Pool,
  log: Logger,
  redis: RedisClient,
  jobQueue: JobQueue<CampaignJobData>,
  rabbitmq: RabbitMQClient,
  opts: { organizationId: string; bdAccountId: string; channelId: string; contactId: string | null },
): Promise<void> {
  const { organizationId, bdAccountId, channelId, contactId } = opts;

  // Find participants in active/completed campaigns that match this inbound message
  let participantsRes = await pool.query(
    `SELECT cp.id, cp.campaign_id, cp.current_step, cp.status, cp.contact_id,
            c.organization_id
     FROM campaign_participants cp
     JOIN campaigns c ON c.id = cp.campaign_id
     WHERE c.organization_id = $1
       AND cp.bd_account_id = $2
       AND cp.channel_id = $3
       AND c.status IN ('active', 'completed')
       AND cp.status IN ('pending', 'sent', 'in_progress', 'awaiting_reply')`,
    [organizationId, bdAccountId, channelId],
  );

  if (participantsRes.rows.length === 0 && contactId) {
    participantsRes = await pool.query(
      `SELECT cp.id, cp.campaign_id, cp.current_step, cp.status, cp.contact_id,
              c.organization_id
       FROM campaign_participants cp
       JOIN campaigns c ON c.id = cp.campaign_id
       WHERE cp.contact_id = $1
         AND c.organization_id = $2
         AND cp.bd_account_id = $3
         AND c.status IN ('active', 'completed')
         AND cp.status IN ('pending', 'sent', 'in_progress', 'awaiting_reply')`,
      [contactId, organizationId, bdAccountId],
    );
  }

  if (participantsRes.rows.length === 0) return;

  for (const p of participantsRes.rows as {
    id: string;
    campaign_id: string;
    current_step: number;
    status: string;
    contact_id: string;
    organization_id: string;
  }[]) {
    // Verify at least one message was sent to this participant
    const sentCheck = await pool.query(
      `SELECT 1 FROM campaign_sends WHERE campaign_participant_id = $1 AND status IN ('sent', 'queued') LIMIT 1`,
      [p.id],
    );
    if (sentCheck.rows.length === 0) continue;

    if (p.status === 'awaiting_reply') {
      // Reply-triggered next step: enqueue next step, set status to in_progress
      const stepIndex = p.current_step;

      const seqRes = await pool.query(
        `SELECT cs.order_index, cs.trigger_type, cs.delay_hours, cs.delay_minutes
         FROM campaign_sequences cs
         WHERE cs.campaign_id = $1
         ORDER BY cs.order_index`,
        [p.campaign_id],
      );
      const steps = seqRes.rows as { order_index: number; trigger_type: string; delay_hours: number; delay_minutes: number }[];

      if (stepIndex < steps.length) {
        const currentStep = steps[stepIndex];
        const delayMs = currentStep
          ? (currentStep.delay_hours * 3600000) + ((currentStep.delay_minutes || 0) * 60000)
          : 0;
        const effectiveDelay = Math.max(delayMs, 5000);

        // Get BD account info for the job
        const accRes = await pool.query(
          'SELECT bd_account_id, channel_id FROM campaign_participants WHERE id = $1',
          [p.id],
        );
        const acc = accRes.rows[0] as { bd_account_id: string; channel_id: string } | undefined;

        if (acc) {
          await jobQueue.add({
            name: `send:${p.campaign_id}:${p.id}:step${stepIndex}`,
            data: {
              participantId: p.id,
              campaignId: p.campaign_id,
              stepIndex,
              bdAccountId: acc.bd_account_id,
              contactId: p.contact_id,
              channelId: acc.channel_id,
              organizationId: p.organization_id,
              scheduledAt: Date.now() + effectiveDelay,
            },
            opts: {
              delay: effectiveDelay,
              jobId: `campaign:${p.campaign_id}:${p.id}:step${stepIndex}:reply-${Date.now()}`,
              attempts: 3,
              backoff: { type: 'exponential', delay: 5000 },
              removeOnComplete: 1000,
              removeOnFail: 5000,
            },
          });

          await pool.query(
            "UPDATE campaign_participants SET status = 'in_progress', replied_at = NOW(), updated_at = NOW() WHERE id = $1",
            [p.id],
          );

          log.info({
            message: 'Reply triggered next step enqueue',
            participantId: p.id,
            campaignId: p.campaign_id,
            nextStep: stepIndex,
          });
        }
      } else {
        // No more steps after reply, mark as replied (final state)
        await pool.query(
          "UPDATE campaign_participants SET status = 'replied', replied_at = NOW(), updated_at = NOW() WHERE id = $1",
          [p.id],
        );
      }
    } else {
      // Normal reply: mark participant as replied with timestamp
      await pool.query(
        `UPDATE campaign_participants SET status = 'replied', replied_at = NOW(), updated_at = NOW()
         WHERE id = $1 AND status IN ('pending', 'sent', 'in_progress')`,
        [p.id],
      );

      log.info({
        message: 'Campaign participant marked replied',
        participantId: p.id,
        campaignId: p.campaign_id,
      });
    }

    await tryCreateLeadOnReply(pool, log, rabbitmq, {
      campaignId: p.campaign_id,
      contactId: p.contact_id,
      bdAccountId: opts.bdAccountId,
      channelId: opts.channelId,
    });

    await redis.del(`campaign:stats:${p.campaign_id}`);
  }
}

async function tryCreateLeadOnReply(
  pool: Pool,
  log: Logger,
  rabbitmq: RabbitMQClient,
  opts: { campaignId: string; contactId: string; bdAccountId: string; channelId: string },
): Promise<void> {
  try {
    const camp = await pool.query(
      'SELECT organization_id, pipeline_id, lead_creation_settings FROM campaigns WHERE id = $1',
      [opts.campaignId],
    );
    const c = camp.rows[0] as { organization_id: string; pipeline_id: string | null; lead_creation_settings: any } | undefined;
    if (!c) return;

    const lcs = c.lead_creation_settings as { trigger?: string; default_stage_id?: string; default_responsible_id?: string } | null;
    if (!lcs || lcs.trigger !== 'on_reply' || !c.pipeline_id) return;

    const existing = await pool.query(
      'SELECT id FROM leads WHERE contact_id = $1 AND pipeline_id = $2 AND organization_id = $3 LIMIT 1',
      [opts.contactId, c.pipeline_id, c.organization_id],
    );
    if (existing.rows.length > 0) return;

    let stageId = lcs.default_stage_id || null;
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

    const responsibleId = lcs.default_responsible_id || systemUserId;

    const maxOrder = await pool.query(
      'SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM leads WHERE stage_id = $1',
      [stageId],
    );
    const orderIndex = (maxOrder.rows[0] as { next: number })?.next ?? 0;

    const result = await pool.query(
      `INSERT INTO leads (organization_id, contact_id, pipeline_id, stage_id, order_index, responsible_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [c.organization_id, opts.contactId, c.pipeline_id, stageId, orderIndex, responsibleId],
    );
    const leadId = (result.rows[0] as { id: string })?.id;
    if (!leadId) return;

    let conversationId: string | null = null;
    if (opts.bdAccountId && opts.channelId) {
      const conv = await pool.query(
        `SELECT id FROM conversations WHERE organization_id = $1 AND bd_account_id = $2::uuid AND channel = $3 AND channel_id = $4 LIMIT 1`,
        [c.organization_id, opts.bdAccountId, CHANNEL_TELEGRAM, opts.channelId],
      );
      conversationId = (conv.rows[0] as { id: string } | undefined)?.id ?? null;
    }

    const repliedAt = new Date();
    await pool.query(
      `INSERT INTO lead_activity_log (id, lead_id, type, metadata, created_at) VALUES (gen_random_uuid(), $1, 'campaign_reply_received', $2, $3)`,
      [leadId, JSON.stringify({ campaign_id: opts.campaignId }), repliedAt],
    ).catch((e) => log.warn({ message: 'Lead activity log insert error', error: String(e) }));

    await pool.query(
      `INSERT INTO lead_activity_log (id, lead_id, type, metadata, created_at) VALUES (gen_random_uuid(), $1, 'lead_created', $2, $3)`,
      [leadId, JSON.stringify({ source: 'campaign', campaign_id: opts.campaignId, conversation_id: conversationId }), repliedAt],
    ).catch((e) => log.warn({ message: 'Lead activity log insert error', error: String(e) }));

    rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.LEAD_CREATED_FROM_CAMPAIGN,
      timestamp: repliedAt,
      organizationId: c.organization_id,
      userId: systemUserId,
      data: {
        leadId,
        contactId: opts.contactId,
        campaignId: opts.campaignId,
        organizationId: c.organization_id,
        conversationId: conversationId ?? undefined,
        pipelineId: c.pipeline_id,
        stageId,
        repliedAt: repliedAt.toISOString(),
      },
    } as any).catch((e) => log.warn({ message: 'LEAD_CREATED_FROM_CAMPAIGN publish error', error: String(e) }));

    log.info({ message: 'Lead created from campaign reply', leadId, campaignId: opts.campaignId, contactId: opts.contactId });
  } catch (err) {
    log.warn({ message: 'Lead creation on reply failed', error: String(err), campaignId: opts.campaignId });
  }
}
