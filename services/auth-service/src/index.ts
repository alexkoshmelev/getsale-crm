import cookieParser from 'cookie-parser';
import { createServiceApp, ServiceHttpClient } from '@getsale/service-core';
import { RedisClient } from '@getsale/utils';
import { authRouter } from './routes/auth';
import { organizationRouter } from './routes/organization';
import { workspacesRouter } from './routes/workspaces';
import { invitesRouter } from './routes/invites';

const PIPELINE_SERVICE_URL = process.env.PIPELINE_SERVICE_URL || 'http://localhost:3008';

async function main() {
  const redis = new RedisClient(process.env.REDIS_URL || 'redis://localhost:6379');
  const ctx = await createServiceApp({
    name: 'auth-service',
    port: 3001,
    cors: true,
    skipUserExtract: true,
    onShutdown: () => redis.disconnect(),
  });

  ctx.app.use(cookieParser());

  const { pool, rabbitmq, log } = ctx;
  const pipelineClient = new ServiceHttpClient(
    { baseUrl: PIPELINE_SERVICE_URL, name: 'pipeline-service' },
    log
  );
  const deps = { pool, rabbitmq, log, redis, pipelineClient };

  ctx.mount('/api/auth', authRouter(deps));
  ctx.mount('/api/auth', organizationRouter(deps));
  ctx.mount('/api/auth', workspacesRouter(deps));
  ctx.mount('/api/invite', invitesRouter(deps));

  ctx.start();
}

main().catch((err) => {
  console.error('Fatal: Auth service failed to start:', err);
  process.exit(1);
});
