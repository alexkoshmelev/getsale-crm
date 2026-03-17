import { createServiceApp, ServiceHttpClient } from '@getsale/service-core';
import { createLogger } from '@getsale/logger';
import { subscribeToEvents } from './event-handlers';
import { startCampaignLoop } from './campaign-loop';
import { campaignsRouter } from './routes/campaigns';
import { templatesRouter } from './routes/templates';
import { sequencesRouter } from './routes/sequences';
import { executionRouter } from './routes/execution';
import { participantsRouter } from './routes/participants';

async function main() {
  const ctx = await createServiceApp({
    name: 'campaign-service',
    port: parseInt(process.env.PORT || '3012', 10),
    poolConfig: { max: 20 },
  });
  const { pool, rabbitmq, log } = ctx;

  const pipelineClient = new ServiceHttpClient({
    baseUrl: process.env.PIPELINE_SERVICE_URL || 'http://localhost:3008',
    name: 'pipeline-service',
  }, log);

  const messagingClient = new ServiceHttpClient({
    baseUrl: process.env.MESSAGING_SERVICE_URL || 'http://localhost:3003',
    name: 'messaging-service',
    retries: 2,
  }, log);

  const bdAccountsClient = new ServiceHttpClient({
    baseUrl: process.env.BD_ACCOUNTS_SERVICE_URL || 'http://localhost:3007',
    name: 'bd-accounts-service',
    retries: 2,
  }, log);

  try {
    await subscribeToEvents({ pool, rabbitmq, log, pipelineClient });
  } catch (error) {
    log.warn({
      message: 'RabbitMQ event subscription failed, service will continue without events',
      error: String(error),
    });
  }

  startCampaignLoop({ pool, log, messagingClient, pipelineClient, bdAccountsClient });

  const routeDeps = { pool, rabbitmq, log };

  ctx.mount('/api/campaigns', campaignsRouter(routeDeps));
  ctx.mount('/api/campaigns', templatesRouter(routeDeps));
  ctx.mount('/api/campaigns', sequencesRouter(routeDeps));
  ctx.mount('/api/campaigns', executionRouter(routeDeps));
  ctx.mount('/api/campaigns', participantsRouter(routeDeps));

  ctx.start();
}

main().catch((err) => {
  createLogger('campaign-service').error({ message: 'Fatal: campaign-service failed to start', error: String(err) });
  process.exit(1);
});
