import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { EventType } from '@getsale/events';
import { Logger } from '@getsale/logger';
import { attachLead } from './helpers';

export interface EventHandlerDeps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
}

/** Persist read receipts: when contact reads our messages (read_outbox), mark outbound messages as read in DB. */
async function handleReadOutbox(
  pool: Pool,
  organizationId: string,
  bdAccountId: string,
  channelId: string,
  maxId: number,
  log: Logger
): Promise<void> {
  try {
    const result = await pool.query(
      `UPDATE messages
       SET unread = false, status = 'read', updated_at = NOW()
       WHERE organization_id = $1 AND bd_account_id = $2
         AND (
           channel_id = $3
           OR contact_id IN (
             SELECT id FROM contacts WHERE organization_id = $1 AND telegram_id = $3
           )
         )
         AND direction = 'outbound' AND telegram_message_id IS NOT NULL
         AND (telegram_message_id ~ '^[0-9]+$' AND telegram_message_id::bigint <= $4)`,
      [organizationId, bdAccountId, channelId, maxId]
    );
    if (result.rowCount && result.rowCount > 0) {
      log.info({
        message: 'Marked outbound messages as read',
        bd_account_id: bdAccountId,
        channel_id: channelId,
        max_id: maxId,
        updated: result.rowCount,
      });
    }
  } catch (err) {
    log.error({
      message: 'handleReadOutbox failed',
      error: String(err),
      bd_account_id: bdAccountId,
      channel_id: channelId,
    });
  }
}

export async function subscribeToEvents(deps: EventHandlerDeps): Promise<void> {
  const { pool, rabbitmq, log } = deps;
  // Single queue + one consumer: two subscribeToEvents() with the same queue name would register
  // two competing consumers and round-robin delivery — LEAD_CREATED could be acked without attachLead.
  await rabbitmq.subscribeToEvents(
    [EventType.LEAD_CREATED_FROM_CAMPAIGN, EventType.BD_ACCOUNT_TELEGRAM_UPDATE],
    async (event: any) => {
      if (event.type === EventType.LEAD_CREATED_FROM_CAMPAIGN) {
        const { conversationId, leadId, campaignId } = event.data || {};
        const organizationId = event.organizationId;
        if (!conversationId || !leadId || !campaignId || !organizationId) return;
        try {
          const updated = await attachLead(pool, { conversationId, leadId, campaignId, organizationId });
          if (updated === 0) log.info({ message: 'attachLead no-op (already attached)', conversationId, leadId });
        } catch (err) {
          log.error({ message: 'attachLead error', error: String(err) });
        }
        return;
      }
      if (event.type !== EventType.BD_ACCOUNT_TELEGRAM_UPDATE) return;
      const data = event.data || {};
      const updateKind = data.updateKind;
      if (updateKind !== 'read_outbox' && updateKind !== 'read_channel_outbox') return;
      const organizationId = event.organizationId ?? data.organizationId;
      const bdAccountId = data.bdAccountId;
      const channelId = data.channelId;
      const maxIdRaw = data.maxId;
      const maxId =
        typeof maxIdRaw === 'number'
          ? maxIdRaw
          : typeof maxIdRaw === 'string'
            ? parseInt(maxIdRaw, 10)
            : NaN;
      if (!organizationId || !bdAccountId || !channelId || !Number.isFinite(maxId)) return;
      await handleReadOutbox(pool, organizationId, bdAccountId, channelId, maxId, log);
    },
    'events',
    'messaging-service'
  );
}
