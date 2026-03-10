import { createServiceApp } from '@getsale/service-core';
import { activityRouter } from './routes/activity';
import { handleActivityEvent, ACTIVITY_EVENT_TYPES } from './event-handler';

async function main() {
  const ctx = await createServiceApp({ name: 'activity-service', port: 3013 });
  const { pool, rabbitmq, log } = ctx;

  try {
    await rabbitmq.subscribeToEvents(
      ACTIVITY_EVENT_TYPES,
      async (event) => handleActivityEvent(pool, log, event as Parameters<typeof handleActivityEvent>[2]),
      'events',
      'activity-service'
    );
  } catch (err) {
    log.warn({
      message: 'Failed to subscribe to events, continuing without activity feed',
      error: String(err),
    });
  }

  ctx.mount('/api/activity', activityRouter({ pool, log }));
  ctx.start();
}

main().catch((err) => {
  console.error('Fatal: Activity service failed to start:', err);
  process.exit(1);
});
