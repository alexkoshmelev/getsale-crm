import { createServiceApp, ServiceHttpClient, interServiceHttpDefaults } from '@getsale/service-core';
import { RedisClient } from '@getsale/utils';
import { TelegramManager } from './telegram';
import { accountsRouter } from './routes/accounts';
import { authRouter } from './routes/auth';
import { syncRouter } from './routes/sync';
import { messagingRouter } from './routes/messaging';
import { mediaRouter } from './routes/media';
import { internalBdAccountsRouter } from './routes/internal';
import { messagingOrphanFallbackTotal, messageDbSqlBypassTotal } from './metrics';
import { setBdAccountFloodPublishRabbitmq } from './bd-account-flood-persist';
import { setBdAccountSpamPublishRabbitmq } from './bd-account-spam-persist';
import { runSpamBotCheckAllStale } from './spambot-check';

const MESSAGING_SERVICE_URL = process.env.MESSAGING_SERVICE_URL || 'http://localhost:3003';

async function main() {
  let telegramManager: TelegramManager;
  const ctx = await createServiceApp({
    name: 'bd-accounts-service',
    port: 3007,
    onShutdown: async () => {
      await telegramManager?.shutdown();
    },
  });
  ctx.registry.registerMetric(messagingOrphanFallbackTotal);
  ctx.registry.registerMetric(messageDbSqlBypassTotal);
  const { pool, rabbitmq, log, registry } = ctx;
  setBdAccountFloodPublishRabbitmq(rabbitmq);
  setBdAccountSpamPublishRabbitmq(rabbitmq);

  const redisUrl = process.env.REDIS_URL;
  const redis = redisUrl ? new RedisClient(redisUrl) : null;

  const messagingClient = new ServiceHttpClient(
    {
      ...interServiceHttpDefaults(),
      baseUrl: MESSAGING_SERVICE_URL,
      name: 'messaging-service',
      retries: 2,
      metricsRegistry: registry,
    },
    log
  );
  telegramManager = new TelegramManager(pool, rabbitmq, redis, log, messagingClient, messageDbSqlBypassTotal);

  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    if (msg?.includes?.('builder.resolve') || stack?.includes?.('builder.resolve')) {
      return;
    }
    if (msg === 'TIMEOUT' || String(msg).includes('TIMEOUT')) {
      if (stack?.includes('updates.js')) {
        log.warn({ message: 'Update loop TIMEOUT (GramJS) — per-account reconnect handled by ConnectionManager' });
      }
      return;
    }
    log.error({ message: 'Unhandled promise rejection', error: String(reason) });
  });

  process.on('uncaughtException', (error: unknown) => {
    const err = error instanceof Error ? error : new Error(String(error));
    if (err.message?.includes('builder.resolve') ||
        err.message?.includes('builder.resolve') ||
        err.stack?.includes('builder.resolve')) {
      return;
    }
    if (err.message === 'TIMEOUT' || err.message?.includes?.('TIMEOUT')) {
      if (err.stack?.includes('updates.js')) {
        log.warn({ message: 'Update loop TIMEOUT (GramJS) — per-account reconnect handled by ConnectionManager' });
      }
      return;
    }
    log.error({ message: 'Uncaught exception', error: err.message, stack: err.stack });
  });

  telegramManager.initializeActiveAccounts().catch((error: unknown) => {
    log.error({ message: 'Failed to initialize active accounts', error: String(error) });
  });

  const spambotEnabled = String(process.env.SPAMBOT_CHECK_ENABLED || 'true').toLowerCase() !== 'false';
  const spambotIntervalHours = Math.max(1, parseInt(String(process.env.SPAMBOT_CHECK_INTERVAL_HOURS || '6'), 10) || 6);
  const spambotGapMs = parseInt(String(process.env.SPAMBOT_CHECK_GAP_MS || '8000'), 10) || 8000;
  if (spambotEnabled) {
    const jitter = () => Math.floor(Math.random() * 120_000);
    const scheduleNext = (): void => {
      setTimeout(() => {
        runSpamBotCheckAllStale(pool, telegramManager, log, {
          intervalHours: spambotIntervalHours,
          gapMs: spambotGapMs,
        }).catch((e: unknown) =>
          log.warn({ message: 'Periodic SpamBot check failed', error: String(e) })
        );
        scheduleNext();
      }, spambotIntervalHours * 3600 * 1000 + jitter());
    };
    setTimeout(() => {
      runSpamBotCheckAllStale(pool, telegramManager, log, {
        intervalHours: spambotIntervalHours,
        gapMs: spambotGapMs,
      }).catch((e: unknown) =>
        log.warn({ message: 'Initial SpamBot check failed', error: String(e) })
      );
    }, 90_000 + jitter());
    scheduleNext();
  }

  const deps = { pool, rabbitmq, log, telegramManager, messagingClient, messagingOrphanFallbackTotal };

  // Auth (literal paths) and media (/:id/avatar, /:id/chats/:chatId/avatar) before accounts (/:id)
  ctx.mount('/api/bd-accounts', authRouter(deps));
  ctx.mount('/api/bd-accounts', mediaRouter(deps));
  ctx.mount('/api/bd-accounts', accountsRouter(deps));
  ctx.mount('/api/bd-accounts', syncRouter(deps));
  ctx.mount('/api/bd-accounts', messagingRouter(deps));
  ctx.mount('/internal', internalBdAccountsRouter({ pool, log }));

  ctx.start();
}

main().catch((err) => {
  console.error('Fatal: bd-accounts-service failed to start:', err);
  process.exit(1);
});
