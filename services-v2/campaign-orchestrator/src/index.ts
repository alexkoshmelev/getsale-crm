import { createService } from '@getsale/service-framework';
import { RedisClient } from '@getsale/cache';
import { JobQueue } from '@getsale/queue';
import { CampaignScheduler, CampaignJobData } from './scheduler';
import { registerCampaignRoutes } from './routes/campaigns';
import { registerTemplateRoutes } from './routes/templates';
import { registerSequenceRoutes } from './routes/sequences';
import { registerExecutionRoutes } from './routes/execution';
import { registerParticipantRoutes } from './routes/participants';
import { registerStaticDataRoutes } from './routes/static-data';

async function main() {
  const redis = new RedisClient({ url: process.env.REDIS_URL || 'redis://localhost:6380' });
  const jobQueue = new JobQueue<CampaignJobData>('campaign-jobs', {
    redis: process.env.REDIS_URL || 'redis://localhost:6380',
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: 'exponential', delay: 5000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    },
  });

  const ctx = await createService({
    name: 'campaign-orchestrator-v2',
    port: 4006,
    onShutdown: async () => {
      await jobQueue.close();
      redis.disconnect();
    },
  });

  const { db, rabbitmq, log, app } = ctx;

  const scheduler = new CampaignScheduler({
    pool: db.write,
    log,
    jobQueue,
    redis,
  });

  registerCampaignRoutes(app, { db, rabbitmq, log, scheduler });
  registerStaticDataRoutes(app, { db, log });
  registerTemplateRoutes(app, { db, log });
  registerSequenceRoutes(app, { db, log });
  registerExecutionRoutes(app, { db, rabbitmq, log });
  registerParticipantRoutes(app, { db, log });

  await ctx.start();
}

main().catch((err) => {
  console.error('Fatal: campaign-orchestrator-v2 failed to start:', err);
  process.exit(1);
});
