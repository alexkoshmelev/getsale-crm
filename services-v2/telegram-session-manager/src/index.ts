import { randomUUID } from 'crypto';
import { createService } from '@getsale/service-framework';
import { RedisClient } from '@getsale/cache';
import { SessionCoordinator } from './coordinator';
import { PhoneLoginHandler } from './phone-login-handler';
import { QrLoginHandler } from './qr-login-handler';
import { registerBdAccountRoutes } from './routes/bd-accounts';
import { registerAuthRoutes } from './routes/auth';
import { registerAccountRoutes } from './routes/accounts';
import { registerSyncRoutes } from './routes/sync';
import { registerMessagingRoutes } from './routes/messaging';
import { registerMediaRoutes } from './routes/media';
import { registerDiscoveryRoutes } from './routes/discovery';

async function main() {
  const redis = new RedisClient({ url: process.env.REDIS_URL || 'redis://localhost:6380' });
  const instanceId = `tsm-${randomUUID().slice(0, 8)}`;

  const ctx = await createService({
    name: 'telegram-session-manager-v2',
    port: 4005,
    onShutdown: async () => {
      await phoneLoginHandler.cleanup();
      await coordinator.stop();
      redis.disconnect();
    },
  });

  const { db, rabbitmq, log, app } = ctx;

  const apiId = parseInt(process.env.TELEGRAM_API_ID || '0', 10);
  const apiHash = process.env.TELEGRAM_API_HASH || '';

  const coordinator = new SessionCoordinator({
    pool: db.write,
    rabbitmq,
    redis,
    log,
    instanceId,
    apiId,
    apiHash,
  });

  const onAccountCreated = async (accountId: string, _orgId: string, _userId: string) => {
    log.info({ message: `Account ${accountId} created, will be discovered next cycle` });
  };

  const phoneLoginHandler = new PhoneLoginHandler(
    db.write,
    rabbitmq,
    log,
    apiId,
    apiHash,
    onAccountCreated,
  );

  const qrLoginHandler = new QrLoginHandler(
    db.write,
    rabbitmq,
    redis,
    log,
    apiId,
    apiHash,
    onAccountCreated,
  );

  const routeDeps = { db, rabbitmq, log, redis, coordinator, phoneLoginHandler };
  registerBdAccountRoutes(app, routeDeps);
  registerAuthRoutes(app, { log, qrLoginHandler });
  registerAccountRoutes(app, routeDeps);
  registerSyncRoutes(app, routeDeps);
  registerMessagingRoutes(app, routeDeps);
  registerMediaRoutes(app, routeDeps);
  registerDiscoveryRoutes(app, routeDeps);

  // Expose coordinator status
  app.get('/api/bd-accounts/tsm/status', async () => ({
    instanceId,
    actorCount: coordinator.getActorCount(),
    actors: coordinator.getActorStates(),
  }));

  await ctx.start();
  await coordinator.start();

  log.info({ message: `TSM started (instance: ${instanceId})` });
}

main().catch((err) => {
  console.error('Fatal: telegram-session-manager-v2 failed to start:', err);
  process.exit(1);
});
