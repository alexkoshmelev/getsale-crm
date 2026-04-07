import { createService, ServiceHttpClient, interServiceHttpDefaults } from '@getsale/service-framework';
import { RedisClient, InboxModel } from '@getsale/cache';
import { EventType } from '@getsale/events';
import { registerInboxRoutes } from './routes/inbox';
import { registerConversationRoutes } from './routes/conversations';
import { registerSendRoutes } from './routes/send';
import { registerChatRoutes } from './routes/chats';
import { registerMessageActionRoutes } from './routes/message-actions';
import { registerConversationFeatureRoutes } from './routes/conversation-features';
import { handleMessagingRabbitEvent } from './messaging-event-handlers';

async function main() {
  const redis = new RedisClient({ url: process.env.REDIS_URL || 'redis://localhost:6380' });
  const inbox = new InboxModel(redis);

  const ctx = await createService({
    name: 'messaging-api-v2',
    port: 4003,
    dbConfig: { readUrl: process.env.DATABASE_READ_URL },
    onShutdown: () => redis.disconnect(),
  });

  const { db, rabbitmq, log, app } = ctx;

  const aiClient = new ServiceHttpClient({
    baseUrl: process.env.AI_SERVICE_URL || 'http://ai-service:4010',
    name: 'ai-service',
    ...interServiceHttpDefaults(),
  }, log);

  const deps = { db, rabbitmq, log, redis, inbox, aiClient };

  registerInboxRoutes(app, deps);
  registerConversationRoutes(app, deps);
  registerSendRoutes(app, deps);
  registerChatRoutes(app, deps);
  registerMessageActionRoutes(app, deps);
  registerConversationFeatureRoutes(app, deps);

  await rabbitmq.subscribeToEvents(
    [
      EventType.MESSAGE_RECEIVED,
      EventType.MESSAGE_SENT,
      EventType.MESSAGE_READ,
      EventType.MESSAGE_DELETED,
      EventType.MESSAGE_EDITED,
    ],
    async (event) => {
      try {
        await handleMessagingRabbitEvent(event, deps);
      } catch (err) {
        log.error({ message: 'Messaging RabbitMQ event handler failed', event_type: event.type, error: String(err) });
      }
    },
    'events',
    'messaging-api-v2.inbox',
  );

  await ctx.start();
}

main().catch((err) => {
  console.error('Fatal: messaging-api-v2 failed to start:', err);
  process.exit(1);
});
