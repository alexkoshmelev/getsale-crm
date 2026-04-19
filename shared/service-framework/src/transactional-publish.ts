import { Pool, PoolClient } from 'pg';
import type { RabbitMQClient } from '@getsale/queue';
import type { Event } from '@getsale/events';

/**
 * Executes database operations in a transaction and publishes events only after
 * successful commit. If the transaction fails, no events are published.
 * If event publishing fails after commit, events are logged for retry.
 */
export async function withTransactionalPublish(
  pool: Pool,
  events: { rabbitmq: RabbitMQClient; log: { warn: (data: Record<string, unknown>) => void } },
  fn: (client: PoolClient, pendingEvents: Event[]) => Promise<void>,
): Promise<void> {
  const client = await pool.connect();
  const pendingEvents: Event[] = [];

  try {
    await client.query('BEGIN');
    await fn(client, pendingEvents);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  for (const event of pendingEvents) {
    try {
      await events.rabbitmq.publishEvent(event);
    } catch (publishErr) {
      events.log.warn({
        message: 'Post-commit event publish failed',
        eventType: event.type,
        eventId: event.id,
        error: String(publishErr),
      });
    }
  }
}
