import { createService } from '@getsale/service-framework';
import { RedisClient } from '@getsale/cache';
import { JobQueue } from '@getsale/queue';
import { EventType } from '@getsale/events';
import { registerAutomationRoutes } from './routes/automation';
import { RuleEngine } from './rule-engine';

async function main() {
  const redis = new RedisClient({ url: process.env.REDIS_URL || 'redis://localhost:6380' });
  const slaQueue = new JobQueue('automation-sla', {
    redis: process.env.REDIS_URL || 'redis://localhost:6380',
  });

  const ctx = await createService({
    name: 'automation-engine-v2',
    port: 4007,
    onShutdown: async () => {
      await slaQueue.close();
      redis.disconnect();
    },
  });

  const { db, rabbitmq, log, app } = ctx;
  const ruleEngine = new RuleEngine(db.write, rabbitmq, log);

  registerAutomationRoutes(app, { db, rabbitmq, log });

  // Event-driven rule matching (matches v1 subscriptions + task requirements)
  const AUTOMATION_EVENTS = [
    EventType.MESSAGE_RECEIVED,
    EventType.MESSAGE_SENT,
    EventType.CONTACT_CREATED,
    EventType.DEAL_CREATED,
    EventType.DEAL_UPDATED,
    EventType.DEAL_STAGE_CHANGED,
    EventType.LEAD_CREATED,
    EventType.LEAD_STAGE_CHANGED,
    EventType.CAMPAIGN_COMPLETED,
    EventType.LEAD_SLA_BREACH,
    EventType.DEAL_SLA_BREACH,
  ];

  await rabbitmq.subscribeToEvents(
    AUTOMATION_EVENTS,
    async (event) => {
      try {
        await ruleEngine.evaluate(event);
      } catch (err) {
        log.error({ message: 'Rule evaluation failed', event_type: event.type, error: String(err) });
      }
    },
    'events',
    'automation-engine-v2.rules',
  );

  // SLA checks as BullMQ recurring job (replaces node-cron)
  await slaQueue.addRecurring({
    name: 'sla-check',
    data: {},
    pattern: '*/5 * * * *',
    opts: { jobId: 'sla-check-recurring' },
  });

  slaQueue.process(async (job) => {
    if (job.name === 'sla-check') {
      try {
        const rules = await db.read.query(
          `SELECT ar.*, o.id as org_id FROM automation_rules ar
           JOIN organizations o ON ar.organization_id = o.id
           WHERE ar.trigger_type = 'sla' AND ar.is_active = true`,
        );

        for (const rule of rules.rows) {
          try {
            await ruleEngine.checkSla(rule);
          } catch (err) {
            log.error({ message: 'SLA check failed', rule_id: rule.id, organization_id: rule.org_id, error: String(err) });
          }
        }
      } catch (err) {
        log.error({ message: 'SLA check batch failed', error: String(err) });
      }
    }
  }, 1);

  await ctx.start();
}

main().catch((err) => {
  console.error('Fatal: automation-engine-v2 failed to start:', err);
  process.exit(1);
});
