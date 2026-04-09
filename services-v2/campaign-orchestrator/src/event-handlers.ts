import { Pool } from 'pg';
import { EventType } from '@getsale/events';
import { Logger } from '@getsale/logger';
import { type RabbitMQClient } from '@getsale/queue';
import { RedisClient } from '@getsale/cache';
import { JobQueue } from '@getsale/queue';
import { type CampaignJobData } from './scheduler';

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

      try {
        await handleCampaignReply(pool, log, redis, jobQueue, {
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

    await redis.del(`campaign:stats:${p.campaign_id}`);
  }
}
