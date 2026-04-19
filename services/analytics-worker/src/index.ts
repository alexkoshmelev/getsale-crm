import { Pool } from 'pg';
import { createLogger } from '@getsale/logger';
import { RedisClient } from '@getsale/cache';
import { RabbitMQClient, JobQueue } from '@getsale/queue';
import { EventType } from '@getsale/events';

const log = createLogger('analytics-worker');
const redis = new RedisClient({ url: process.env.REDIS_URL || 'redis://localhost:6380' });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres_dev@localhost:5433/postgres',
  max: 3,
});

async function ensureMaterializedViews(p: Pool): Promise<void> {
  const views = [
    {
      name: 'mv_daily_message_counts',
      sql: `CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_message_counts AS
        SELECT organization_id, DATE(created_at) AS day,
               COUNT(*) AS total_messages,
               COUNT(*) FILTER (WHERE direction = 'outbound') AS outbound,
               COUNT(*) FILTER (WHERE direction = 'inbound') AS inbound
        FROM messages GROUP BY organization_id, DATE(created_at) WITH DATA`,
      index: `CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_daily_msg_org_day ON mv_daily_message_counts (organization_id, day)`,
    },
    {
      name: 'mv_campaign_stats',
      sql: `CREATE MATERIALIZED VIEW IF NOT EXISTS mv_campaign_stats AS
        SELECT cp.campaign_id, c.organization_id,
               COUNT(*) AS total_participants,
               COUNT(*) FILTER (WHERE cp.status = 'sent') AS sent,
               COUNT(*) FILTER (WHERE cp.status = 'replied') AS replied,
               COUNT(*) FILTER (WHERE cp.status = 'failed') AS failed,
               COUNT(*) FILTER (WHERE cp.status = 'pending') AS pending
        FROM campaign_participants cp JOIN campaigns c ON c.id = cp.campaign_id
        GROUP BY cp.campaign_id, c.organization_id WITH DATA`,
      index: `CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_campaign_stats_id ON mv_campaign_stats (campaign_id)`,
    },
    {
      name: 'mv_conversion_funnel',
      sql: `CREATE MATERIALIZED VIEW IF NOT EXISTS mv_conversion_funnel AS
        SELECT s.pipeline_id, p.organization_id, s.id AS stage_id, s.name AS stage_name,
               s.order_index AS stage_order, COUNT(l.id) AS lead_count,
               COALESCE(SUM(l.revenue_amount), 0) AS total_value
        FROM stages s JOIN pipelines p ON p.id = s.pipeline_id
        LEFT JOIN leads l ON l.stage_id = s.id AND l.deleted_at IS NULL
        GROUP BY s.pipeline_id, p.organization_id, s.id, s.name, s.order_index WITH DATA`,
      index: `CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_conversion_funnel_stage ON mv_conversion_funnel (pipeline_id, stage_id)`,
    },
  ];

  for (const v of views) {
    try {
      const check = await p.query(
        `SELECT 1 FROM pg_matviews WHERE matviewname = $1 LIMIT 1`,
        [v.name],
      );
      if (check.rows.length === 0) {
        log.info({ message: `Creating materialized view ${v.name}` });
        await p.query(v.sql);
        await p.query(v.index);
      }
    } catch (err) {
      log.warn({ message: `Failed to ensure view ${v.name}`, error: String(err) });
    }
  }
}

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
    'analytics-worker.counters',
  );

  // Ensure materialized views exist before scheduling refresh
  await ensureMaterializedViews(pool);

  // Periodic materialized view refresh
  await refreshQueue.addRecurring({
    name: 'refresh-views',
    data: {},
    every: 5 * 60 * 1000,
    opts: { jobId: 'refresh-views-recurring' },
  });

  // Concurrency 1: materialized view refreshes are heavy and serialized intentionally.
  // Scale analytics event throughput horizontally with multiple container replicas instead.
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
