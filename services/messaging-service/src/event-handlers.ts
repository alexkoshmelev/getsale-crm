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

export async function subscribeToEvents(deps: EventHandlerDeps): Promise<void> {
  const { pool, rabbitmq, log } = deps;
  await rabbitmq.subscribeToEvents(
    [EventType.LEAD_CREATED_FROM_CAMPAIGN],
    async (event: any) => {
      if (event.type !== EventType.LEAD_CREATED_FROM_CAMPAIGN) return;
      const { conversationId, leadId, campaignId } = event.data || {};
      if (!conversationId || !leadId || !campaignId) return;
      try {
        const updated = await attachLead(pool, { conversationId, leadId, campaignId });
        if (updated === 0) log.info({ message: 'attachLead no-op (already attached)', conversationId, leadId });
      } catch (err) {
        log.error({ message: 'attachLead error', error: String(err) });
      }
    },
    'events',
    'messaging-service'
  );
}
