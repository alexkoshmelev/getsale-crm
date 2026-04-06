import { createService } from '@getsale/service-framework';
import { RedisClient } from '@getsale/cache';
import { registerAuthRoutes } from './routes/auth';
import { registerWorkspaceRoutes } from './routes/workspaces';
import { registerOrganizationRoutes } from './routes/organization';
import { registerInviteRoutes } from './routes/invites';
import { registerTwoFactorRoutes } from './routes/two-factor';

async function main() {
  const redis = new RedisClient({ url: process.env.REDIS_URL || 'redis://localhost:6380' });

  const ctx = await createService({
    name: 'auth-service-v2',
    port: 4001,
    cors: true,
    skipUserExtract: true,
    onShutdown: () => redis.disconnect(),
  });

  const { db, rabbitmq, log } = ctx;
  const pool = db.write;

  registerAuthRoutes(ctx.app, { pool, rabbitmq, log, redis });
  registerWorkspaceRoutes(ctx.app, { pool, rabbitmq, log });
  registerOrganizationRoutes(ctx.app, { pool, log });
  registerInviteRoutes(ctx.app, { pool, log });
  registerTwoFactorRoutes(ctx.app, { pool, log, redis });

  await ctx.start();
}

main().catch((err) => {
  console.error('Fatal: auth-service-v2 failed to start:', err);
  process.exit(1);
});
