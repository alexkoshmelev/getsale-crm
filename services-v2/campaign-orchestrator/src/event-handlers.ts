import { Pool } from 'pg';
import { EventType } from '@getsale/events';
import { Logger } from '@getsale/logger';
import { type RabbitMQClient } from '@getsale/queue';
import { RedisClient } from '@getsale/cache';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  redis: RedisClient;
}

export async function subscribeToCampaignEvents(deps: Deps): Promise<void> {
  const { pool, rabbitmq, log, redis } = deps;

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
        await handleCampaignReply(pool, log, redis, {
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
  opts: { organizationId: string; bdAccountId: string; channelId: string; contactId: string | null },
): Promise<void> {
  const { organizationId, bdAccountId, channelId, contactId } = opts;

  let participantsRes = await pool.query(
    `SELECT cp.id, cp.campaign_id, cp.current_step, cp.status
     FROM campaign_participants cp
     JOIN campaigns c ON c.id = cp.campaign_id
     WHERE c.organization_id = $1
       AND cp.bd_account_id = $2
       AND cp.channel_id = $3
       AND c.status IN ('active', 'completed')
       AND cp.status IN ('pending', 'sent')`,
    [organizationId, bdAccountId, channelId],
  );

  if (participantsRes.rows.length === 0 && contactId) {
    participantsRes = await pool.query(
      `SELECT cp.id, cp.campaign_id, cp.current_step, cp.status
       FROM campaign_participants cp
       JOIN campaigns c ON c.id = cp.campaign_id
       WHERE cp.contact_id = $1
         AND c.organization_id = $2
         AND cp.bd_account_id = $3
         AND c.status IN ('active', 'completed')
         AND cp.status IN ('pending', 'sent')`,
      [contactId, organizationId, bdAccountId],
    );
  }

  if (participantsRes.rows.length === 0) return;

  for (const p of participantsRes.rows as { id: string; campaign_id: string; status: string }[]) {
    const sentCheck = await pool.query(
      `SELECT 1 FROM campaign_sends WHERE campaign_participant_id = $1 AND status = 'sent' LIMIT 1`,
      [p.id],
    );
    if (sentCheck.rows.length === 0) continue;

    await pool.query(
      `UPDATE campaign_participants SET status = 'replied', updated_at = NOW() WHERE id = $1 AND status IN ('pending', 'sent')`,
      [p.id],
    );

    log.info({
      message: 'Campaign participant marked replied',
      participantId: p.id,
      campaignId: p.campaign_id,
    });

    await redis.del(`campaign:stats:${p.campaign_id}`);
  }
}
