import { createService } from '@getsale/service-framework';
import { RedisClient, CacheManager } from '@getsale/cache';
import { EventType } from '@getsale/events';
import { registerContactRoutes } from './routes/contacts';
import { registerCompanyRoutes } from './routes/companies';
import { registerDealRoutes } from './routes/deals';
import { registerPipelineRoutes } from './routes/pipelines';
import { registerStageRoutes } from './routes/stages';
import { registerLeadRoutes } from './routes/leads';
import { registerTeamRoutes } from './routes/team';
import { registerActivityRoutes } from './routes/activity';
import { registerNoteRoutes } from './routes/notes';
import { registerReminderRoutes } from './routes/reminders';
import { registerAnalyticsRoutes } from './routes/analytics';
import { registerDiscoveryRoutes } from './routes/discovery';
import { startDiscoveryLoop } from './discovery-loop';

async function main() {
  const redis = new RedisClient({ url: process.env.REDIS_URL || 'redis://localhost:6380' });
  const pipelineCache = new CacheManager(redis, { ttlSeconds: 30, prefix: 'cache:pipeline' });
  const contactsCache = new CacheManager(redis, { ttlSeconds: 60, prefix: 'cache:contacts' });

  const ctx = await createService({
    name: 'core-api',
    port: 4002,
    dbConfig: {
      readUrl: process.env.DATABASE_READ_URL,
    },
    onShutdown: () => redis.disconnect(),
  });

  const { db, rabbitmq, log, app } = ctx;
  const deps = { db, rabbitmq, log, redis, pipelineCache, contactsCache };

  registerContactRoutes(app, deps);
  registerCompanyRoutes(app, deps);
  registerDealRoutes(app, deps);
  registerPipelineRoutes(app, deps);
  registerStageRoutes(app, deps);
  registerLeadRoutes(app, deps);
  registerTeamRoutes(app, deps);
  registerActivityRoutes(app, deps);
  registerNoteRoutes(app, deps);
  registerReminderRoutes(app, deps);
  registerAnalyticsRoutes(app, deps);
  registerDiscoveryRoutes(app, deps);

  // Event subscriptions for cache invalidation
  await rabbitmq.subscribeToEvents(
    [EventType.ORGANIZATION_CREATED],
    async (event) => {
      if (event.type === EventType.ORGANIZATION_CREATED) {
        const orgId = (event.data as { organizationId: string }).organizationId;
        const client = await db.write.connect();
        try {
          await client.query('BEGIN');
          await client.query("SELECT set_config('app.current_org_id', $1, true)", [orgId]);
          await client.query(
            `INSERT INTO pipelines (organization_id, name, is_default) VALUES ($1, $2, true) ON CONFLICT DO NOTHING`,
            [orgId, 'Sales Pipeline'],
          );
          const pipeline = await client.query('SELECT id FROM pipelines WHERE organization_id = $1 AND is_default = true', [orgId]);
          if (pipeline.rows.length) {
            const stages = ['New', 'Contacted', 'Qualified', 'Proposal', 'Won', 'Lost'];
            for (let i = 0; i < stages.length; i++) {
              await client.query(
                'INSERT INTO stages (pipeline_id, name, order_index, organization_id) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
                [pipeline.rows[0].id, stages[i], i + 1, orgId],
              );
            }
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          log.error({ message: 'Failed to create default pipeline', error: String(err) });
        } finally {
          client.release();
        }
      }
    },
    'events',
    'core-api.org-created',
  );

  // Activity event recording
  const ACTIVITY_EVENTS = [
    EventType.LEAD_CREATED, EventType.CAMPAIGN_STARTED, EventType.CAMPAIGN_CREATED,
    EventType.COMPANY_CREATED, EventType.CONTACT_CREATED, EventType.DEAL_CREATED,
  ];
  await rabbitmq.subscribeToEvents(
    ACTIVITY_EVENTS,
    async (event) => {
      try {
        await db.write.query(
          `INSERT INTO organization_activity (organization_id, user_id, action_type, entity_type, entity_id, metadata, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            event.organizationId, event.userId, event.type,
            (event.data as Record<string, unknown>)?.entityType ?? event.type.split('.')[0],
            (event.data as Record<string, unknown>)?.entityId ?? null,
            JSON.stringify(event.data),
            event.timestamp,
          ],
        );
      } catch (err) {
        log.error({ message: 'Failed to record activity', event_type: event.type, error: String(err) });
      }
    },
    'events',
    'core-api.activity',
  );

  startDiscoveryLoop({ db, log, redis });

  await ctx.start();
}

main().catch((err) => {
  console.error('Fatal: core-api failed to start:', err);
  process.exit(1);
});
