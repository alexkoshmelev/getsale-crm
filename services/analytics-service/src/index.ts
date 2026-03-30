import { createServiceApp } from '@getsale/service-core';
import { EventType } from '@getsale/events';
import { RedisClient } from '@getsale/utils';
import { analyticsRouter } from './routes/analytics';

async function main() {
  const ctx = await createServiceApp({ name: 'analytics-service', port: 3010 });
  const { pool, rabbitmq, log } = ctx;

  const redis = new RedisClient(process.env.REDIS_URL || 'redis://localhost:6380');

  async function recordMetric(event: { type: string; organizationId: string; data?: Record<string, unknown> }) {
    try {
      const metricType = event.type;
      let metricName = '';
      let value = 1;

      switch (event.type) {
        case EventType.DEAL_STAGE_CHANGED:
          metricName = 'stage_transition';
          value = 1;
          break;
        case EventType.DEAL_CLOSED:
          metricName = 'deal_closed';
          value = (event.data?.value as number) ?? 1;
          break;
        case EventType.MESSAGE_SENT:
          metricName = 'message_sent';
          value = 1;
          break;
      }

      await pool.query(
        `INSERT INTO analytics_metrics (organization_id, metric_type, metric_name, value, dimensions)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          event.organizationId,
          metricType,
          metricName,
          value,
          JSON.stringify(event.data || {}),
        ]
      );

      const cacheKey = `analytics:${event.organizationId}:${metricName}:${new Date().toISOString().split('T')[0]}`;
      const cached = (await redis.get<number>(cacheKey)) ?? 0;
      await redis.set(cacheKey, cached + value, 86400);
    } catch (err) {
      log.error({
        message: 'Error recording metric',
        error: String(err),
        organization_id: event.organizationId,
        metric_type: event.type,
      });
    }
  }

  try {
    await rabbitmq.subscribeToEvents(
      [EventType.DEAL_STAGE_CHANGED, EventType.DEAL_CLOSED, EventType.MESSAGE_SENT],
      async (event) => recordMetric(event),
      'events',
      'analytics-service'
    );
  } catch (err) {
    log.warn({
      message: 'Failed to subscribe to events, continuing without event ingestion',
      error: String(err),
    });
  }

  const deps = { pool, log };
  ctx.mount('/api/analytics', analyticsRouter(deps));
  ctx.start();
}

main().catch((err) => {
  console.error('Fatal: Analytics service failed to start:', err);
  process.exit(1);
});
