import { Counter } from 'prom-client';
import { createServiceApp, ServiceHttpClient } from '@getsale/service-core';
import { RedisClient } from '@getsale/utils';
import { companiesRouter } from './routes/companies';
import { contactsRouter } from './routes/contacts';
import { dealsRouter } from './routes/deals';
import { notesRouter } from './routes/notes';
import { remindersRouter } from './routes/reminders';
import { analyticsRouter } from './routes/analytics';
import { discoveryTasksRouter } from './routes/discovery-tasks';
import { parseRouter } from './routes/parse';
import { startDiscoveryLoop } from './discovery-loop';

async function main() {
  const ctx = await createServiceApp({ name: 'crm-service', port: 3002 });
  const { pool, rabbitmq, log, registry } = ctx;

  const redis = process.env.REDIS_URL
    ? new RedisClient(process.env.REDIS_URL)
    : null;

  const bdAccountsClient = new ServiceHttpClient({
    baseUrl: process.env.BD_ACCOUNTS_SERVICE_URL || 'http://bd-accounts-service:3007',
    name: 'bd-accounts-service',
    timeoutMs: 60000,
    retries: 0,
  }, log);

  const campaignServiceClient = new ServiceHttpClient({
    baseUrl: process.env.CAMPAIGN_SERVICE_URL || 'http://campaign-service:3012',
    name: 'campaign-service',
    timeoutMs: 60000,
    retries: 0,
  }, log);

  const dealCreatedTotal = new Counter({
    name: 'deal_created_total', help: 'Deals created', registers: [registry],
  });
  const dealStageChangedTotal = new Counter({
    name: 'deal_stage_changed_total', help: 'Deal stage transitions', registers: [registry],
  });

  const deps = { pool, rabbitmq, log };
  const contactsDeps = { pool, rabbitmq, log, bdAccountsClient };

  ctx.mount('/api/crm/companies', companiesRouter(deps));
  ctx.mount('/api/crm/contacts', contactsRouter(contactsDeps));
  ctx.mount('/api/crm/deals', dealsRouter({ ...deps, dealCreatedTotal, dealStageChangedTotal }));
  ctx.mount('/api/crm/discovery-tasks', discoveryTasksRouter({ pool, log, campaignServiceClient }));
  ctx.mount('/api/crm/parse', parseRouter({ pool, log, bdAccountsClient, redis }));
  ctx.mount('/api/crm', notesRouter(deps));
  ctx.mount('/api/crm', remindersRouter(deps));
  ctx.mount('/api/crm/analytics', analyticsRouter(deps));

  ctx.start();
  
  startDiscoveryLoop({ pool, log, bdAccountsClient, campaignServiceClient, redis });
}

main().catch((err) => {
  console.error('Fatal: CRM service failed to start:', err);
  process.exit(1);
});
