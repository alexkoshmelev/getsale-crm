import { Counter } from 'prom-client';
import { createLogger } from '@getsale/logger';
import { createServiceApp, ServiceHttpClient } from '@getsale/service-core';
import { subscribeToEvents, executeRule } from './event-handlers';
import { runSlaCronOnce, startCronJobs } from './sla-cron';
import { rulesRouter } from './routes/rules';

async function main() {
  const ctx = await createServiceApp({
    name: 'automation-service',
    port: parseInt(process.env.PORT || '3009', 10),
  });
  const { pool, rabbitmq, log, registry } = ctx;

  const automationEventsTotal = new Counter({
    name: 'automation_events_total',
    help: 'Total events consumed by automation',
    labelNames: ['event_type'],
    registers: [registry],
  });
  const automationProcessedTotal = new Counter({
    name: 'automation_processed_total',
    help: 'Events processed successfully',
    registers: [registry],
  });
  const automationSkippedTotal = new Counter({
    name: 'automation_skipped_total',
    help: 'Events skipped (e.g. already executed)',
    registers: [registry],
  });
  const automationFailedTotal = new Counter({
    name: 'automation_failed_total',
    help: 'Events that failed processing',
    registers: [registry],
  });
  const dealCreatedTotal = new Counter({
    name: 'deal_created_total',
    help: 'Deals created by automation',
    registers: [registry],
  });
  const automationDlqTotal = new Counter({
    name: 'automation_dlq_total',
    help: 'Events sent to DLQ after retries exceeded',
    labelNames: ['event_type'],
    registers: [registry],
  });
  const automationSlaProcessedTotal = new Counter({
    name: 'automation_sla_processed_total',
    help: 'SLA breach events processed',
    registers: [registry],
  });
  const automationSlaSkippedTotal = new Counter({
    name: 'automation_sla_skipped_total',
    help: 'SLA breach events skipped (already executed for this breach_date)',
    registers: [registry],
  });
  const automationSlaPublishedTotal = new Counter({
    name: 'automation_sla_published_total',
    help: 'SLA breach events published by cron',
    labelNames: ['event_type'],
    registers: [registry],
  });

  const crmClient = new ServiceHttpClient(
    {
      baseUrl: process.env.CRM_SERVICE_URL || 'http://crm-service:3002',
      name: 'crm-service',
      timeoutMs: 15_000,
      retries: 2,
    },
    log
  );
  const pipelineClient = new ServiceHttpClient(
    {
      baseUrl: process.env.PIPELINE_SERVICE_URL || 'http://pipeline-service:3008',
      name: 'pipeline-service',
      timeoutMs: 15_000,
      retries: 2,
    },
    log
  );

  const eventHandlerDeps = {
    pool,
    rabbitmq,
    log,
    crmClient,
    pipelineClient,
    automationEventsTotal,
    automationProcessedTotal,
    automationSkippedTotal,
    automationFailedTotal,
    dealCreatedTotal,
    automationDlqTotal,
    automationSlaProcessedTotal,
    automationSlaSkippedTotal,
  };

  try {
    await subscribeToEvents(eventHandlerDeps);
  } catch (error) {
    log.warn({
      message: 'RabbitMQ event subscription failed, service will continue without events',
      error: String(error),
    });
  }

  const slaCronDeps = {
    pool,
    rabbitmq,
    log,
    automationSlaPublishedTotal,
  };
  const runSlaCronOnceFn = (filterOrgId?: string, filterLeadId?: string) =>
    runSlaCronOnce(slaCronDeps, filterOrgId, filterLeadId);

  const executeRuleBound = (rule: import('./event-handlers').AutomationRuleRow, event: import('./event-handlers').AutomationEventPayload) =>
    executeRule(eventHandlerDeps, rule, event);

  startCronJobs(
    slaCronDeps,
    runSlaCronOnceFn,
    { pool, log, executeRule: executeRuleBound }
  );

  ctx.mount(
    '/api/automation',
    rulesRouter({
      pool,
      rabbitmq,
      log,
      runSlaCronOnce: runSlaCronOnceFn,
    })
  );

  ctx.start();
}

main().catch((err) => {
  createLogger('automation-service').error({ message: 'Fatal: automation-service failed to start', error: String(err) });
  process.exit(1);
});
