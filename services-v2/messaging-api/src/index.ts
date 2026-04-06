import { createService, ServiceHttpClient, interServiceHttpDefaults } from '@getsale/service-framework';
import { RedisClient, InboxModel } from '@getsale/cache';
import { EventType } from '@getsale/events';
import { registerInboxRoutes } from './routes/inbox';
import { registerConversationRoutes } from './routes/conversations';
import { registerSendRoutes } from './routes/send';
import { registerChatRoutes } from './routes/chats';
import { registerMessageActionRoutes } from './routes/message-actions';
import { registerConversationFeatureRoutes } from './routes/conversation-features';

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
    [EventType.MESSAGE_RECEIVED, EventType.MESSAGE_SENT, EventType.MESSAGE_READ],
    async (event) => {
      try {
        const data = event.data as Record<string, unknown>;
        if (event.type === EventType.MESSAGE_RECEIVED || event.type === EventType.MESSAGE_SENT) {
          const conversationId = data.conversationId as string;
          const orgId = event.organizationId;
          const userId = data.assignedUserId as string || event.userId;

          if (conversationId && orgId && userId) {
            await inbox.onMessage({
              orgId,
              userId,
              conversationId,
              messagePreview: (data.text as string || '').slice(0, 200),
              contactName: (data.contactName as string) || '',
              contactId: (data.contactId as string) || '',
              timestamp: event.timestamp.getTime(),
              incrementUnread: event.type === EventType.MESSAGE_RECEIVED,
            });
          }
        } else if (event.type === EventType.MESSAGE_READ) {
          const conversationId = data.conversationId as string;
          if (conversationId) await inbox.markRead(conversationId);
        }
      } catch (err) {
        log.error({ message: 'Inbox model update failed', event_type: event.type, error: String(err) });
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
