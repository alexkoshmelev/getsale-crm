import cookieParser from 'cookie-parser';
import { createServiceApp } from '@getsale/service-core';
import { RedisClient } from '@getsale/utils';
import { authRouter } from './routes/auth';
import { twoFactorRouter } from './routes/two-factor';
import { organizationRouter } from './routes/organization';
import { workspacesRouter } from './routes/workspaces';
import { invitesRouter } from './routes/invites';

async function main() {
  const redis = new RedisClient(process.env.REDIS_URL || 'redis://localhost:6380');
  const ctx = await createServiceApp({
    name: 'auth-service',
    port: 3001,
    cors: true,
    skipUserExtract: true,
    onShutdown: () => redis.disconnect(),
  });

  ctx.app.use(cookieParser());

  const { pool, rabbitmq, log } = ctx;
  const deps = { pool, rabbitmq, log, redis };

  ctx.mount('/api/auth', authRouter(deps));
  ctx.mount('/api/auth/2fa', twoFactorRouter(deps));
  ctx.mount('/api/auth', organizationRouter(deps));
  ctx.mount('/api/auth', workspacesRouter({ pool, rabbitmq, log }));
  ctx.mount('/api/invite', invitesRouter(deps));

  ctx.start();
}

main().catch((err) => {
  console.error('Fatal: Auth service failed to start:', err);
  process.exit(1);
});
