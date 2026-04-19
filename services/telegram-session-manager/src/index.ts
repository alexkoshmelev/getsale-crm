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
    name: 'telegram-session-manager',
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

  const SPAMBOT_CHECK_INTERVAL_MS = parseInt(process.env.SPAMBOT_CHECK_INTERVAL_HOURS || '6', 10) * 3600 * 1000;
  let spambotSweepLoop: ReturnType<typeof setInterval> | null = null;

  app.addHook('onClose', () => {
    if (spambotSweepLoop) clearInterval(spambotSweepLoop);
  });

  await ctx.start();
  await coordinator.start();

  spambotSweepLoop = setInterval(async () => {
    try {
      const jitterMs = Math.random() * 10 * 60 * 1000;
      await new Promise((r) => setTimeout(r, jitterMs));

      const staleAccounts = await db.write.query(
        `SELECT id FROM bd_accounts
         WHERE is_active = true
           AND connection_state = 'connected'
           AND (last_spambot_check_at IS NULL OR last_spambot_check_at < NOW() - make_interval(hours => $1))
         LIMIT 10`,
        [parseInt(process.env.SPAMBOT_CHECK_INTERVAL_HOURS || '6', 10)],
      );

      for (const row of staleAccounts.rows as { id: string }[]) {
        const commandQueue = `telegram:commands:${row.id}`;
        await rabbitmq.publishCommand(commandQueue, {
          id: randomUUID(),
          type: 'SPAMBOT_CHECK',
          priority: 2,
          payload: {},
        });
      }

      if (staleAccounts.rows.length > 0) {
        log.info({ message: `Periodic SpamBot sweep: queued ${staleAccounts.rows.length} checks` });
      }
    } catch (err) {
      log.warn({ message: 'SpamBot sweep loop error', error: String(err) });
    }
  }, SPAMBOT_CHECK_INTERVAL_MS);

  log.info({ message: `TSM started (instance: ${instanceId})` });
}

main().catch((err) => {
  console.error('Fatal: telegram-session-manager failed to start:', err);
  process.exit(1);
});
