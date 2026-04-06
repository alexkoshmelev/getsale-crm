import { Pool } from 'pg';
import { createLogger } from '@getsale/logger';
import { RedisClient } from '@getsale/cache';
import { RabbitMQClient, JobQueue } from '@getsale/queue';
import { EventType } from '@getsale/events';

const log = createLogger('analytics-worker-v2');
const redis = new RedisClient({ url: process.env.REDIS_URL || 'redis://localhost:6380' });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres_dev@localhost:5433/postgres',
  max: 3,
});

/**
 * Analytics worker: CQRS read model builder.
 * Consumes ALL events, updates Redis counters atomically,
 * and periodically refreshes materialized views.
 */
async function main() {
  const rabbitmq = new RabbitMQClient({ url: process.env.RABBITMQ_URL, log });
  await rabbitmq.connect();

  const refreshQueue = new JobQueue('analytics-refresh', {
    redis: process.env.REDIS_URL || 'redis://localhost:6380',
  });

  // Consume events and update Redis counters
  const ALL_EVENTS = [
    EventType.MESSAGE_RECEIVED, EventType.MESSAGE_SENT,
    EventType.CONTACT_CREATED, EventType.CONTACT_UPDATED,
    EventType.DEAL_CREATED, EventType.DEAL_STAGE_CHANGED,
    EventType.CAMPAIGN_STARTED, EventType.CAMPAIGN_COMPLETED,
    EventType.LEAD_CREATED,
  ];

  await rabbitmq.subscribeToEvents(
    ALL_EVENTS,
    async (event) => {
      const orgId = event.organizationId;
      if (!orgId) return;

      try {
        const today = new Date().toISOString().slice(0, 10);

        switch (event.type) {
          case EventType.MESSAGE_RECEIVED:
          case EventType.MESSAGE_SENT: {
            const direction = event.type === EventType.MESSAGE_RECEIVED ? 'inbound' : 'outbound';
            const pipe = redis.pipeline();
            pipe.hincrby(`analytics:${orgId}:messages:${today}`, 'total', 1);
            pipe.hincrby(`analytics:${orgId}:messages:${today}`, direction, 1);
            pipe.expire(`analytics:${orgId}:messages:${today}`, 86400 * 90);
            await pipe.exec();
            break;
          }
          case EventType.CONTACT_CREATED: {
            await redis.incr(`analytics:${orgId}:contacts:${today}`, 86400 * 90);
            break;
          }
          case EventType.DEAL_CREATED: {
            await redis.incr(`analytics:${orgId}:deals:${today}`, 86400 * 90);
            break;
          }
          case EventType.LEAD_CREATED: {
            await redis.incr(`analytics:${orgId}:leads:${today}`, 86400 * 90);
            break;
          }
        }
      } catch (err) {
        log.error({ message: 'Counter update failed', event_type: event.type, error: String(err) });
      }
    },
    'events',
    'analytics-worker-v2.counters',
  );

  // Periodic materialized view refresh
  await refreshQueue.addRecurring({
    name: 'refresh-views',
    data: {},
    every: 5 * 60 * 1000,
    opts: { jobId: 'refresh-views-recurring' },
  });

  refreshQueue.process(async (job) => {
    if (job.name === 'refresh-views') {
      log.info({ message: 'Refreshing materialized views' });
      try {
        await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_daily_message_counts');
        await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_campaign_stats');
        await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_conversion_funnel');
        log.info({ message: 'Materialized views refreshed' });
      } catch (err) {
        log.error({ message: 'View refresh failed', error: String(err) });
      }
    }
  }, 1);

  log.info({ message: 'Analytics worker started' });

  const shutdown = async () => {
    log.info({ message: 'Analytics worker shutting down' });
    await refreshQueue.close();
    await rabbitmq.close();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.error({ message: 'Analytics worker failed to start', error: String(err) });
  process.exit(1);
});
