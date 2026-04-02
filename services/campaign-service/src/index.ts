import { createServiceApp, ServiceHttpClient, interServiceHttpDefaults } from '@getsale/service-core';
import { createLogger } from '@getsale/logger';
import { subscribeToEvents } from './event-handlers';
import { startCampaignLoop } from './campaign-loop';
import { campaignMinGapDeferTotal } from './metrics';
import { campaignsRouter } from './routes/campaigns';
import { templatesRouter } from './routes/templates';
import { sequencesRouter } from './routes/sequences';
import { executionRouter } from './routes/execution';
import { participantsRouter } from './routes/participants';

/** Inter-service POST /api/messaging/send can wait on Telegram via bd-accounts; default 90s. */
function campaignMessagingTimeoutMs(): number {
  const raw = process.env.CAMPAIGN_MESSAGING_HTTP_TIMEOUT_MS?.trim();
  if (!raw) return 90_000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 10_000 ? n : 90_000;
}

async function main() {
  const ctx = await createServiceApp({
    name: 'campaign-service',
    port: parseInt(process.env.PORT || '3012', 10),
    poolConfig: { max: 20 },
  });
  const { pool, rabbitmq, log, registry } = ctx;
  ctx.registry.registerMetric(campaignMinGapDeferTotal);

  const pipelineClient = new ServiceHttpClient({
    ...interServiceHttpDefaults(),
    baseUrl: process.env.PIPELINE_SERVICE_URL || 'http://localhost:3008',
    name: 'pipeline-service',
    metricsRegistry: registry,
  }, log);

  const messagingClient = new ServiceHttpClient({
    ...interServiceHttpDefaults(),
    baseUrl: process.env.MESSAGING_SERVICE_URL || 'http://localhost:3003',
    name: 'messaging-service',
    retries: 0,
    timeoutMs: campaignMessagingTimeoutMs(),
    metricsRegistry: registry,
  }, log);

  const bdAccountsClient = new ServiceHttpClient({
    ...interServiceHttpDefaults(),
    baseUrl: process.env.BD_ACCOUNTS_SERVICE_URL || 'http://localhost:3007',
    name: 'bd-accounts-service',
    retries: 0,
    metricsRegistry: registry,
  }, log);

  const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://localhost:3005';
  const aiClient = new ServiceHttpClient({
    ...interServiceHttpDefaults(),
    baseUrl: aiServiceUrl,
    name: 'ai-service',
    retries: 1,
    timeoutMs: 65_000,
    metricsRegistry: registry,
  }, log);
  log.info({
    message: 'AI service client configured for campaign rephrase',
    aiServiceUrl,
    hint: !process.env.AI_SERVICE_URL ? 'AI_SERVICE_URL not set, using default. Set it in .env or docker so campaign-service can reach ai-service.' : undefined,
  });

  try {
    await subscribeToEvents({
      pool,
      rabbitmq,
      log,
      pipelineClient,
      messagingClient,
      bdAccountsClient,
      aiClient,
    });
  } catch (error) {
    log.warn({
      message: 'RabbitMQ event subscription failed, service will continue without events',
      error: String(error),
    });
  }

  startCampaignLoop({ pool, log, messagingClient, pipelineClient, bdAccountsClient, aiClient });

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
