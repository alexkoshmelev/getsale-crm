import { createServiceApp, ServiceHttpClient, interServiceHttpDefaults } from '@getsale/service-core';
import { createLogger } from '@getsale/logger';
import { Counter, Histogram } from 'prom-client';
import { subscribeToEvents } from './event-handlers';
import { messagesRouter } from './routes/messages';
import { chatsRouter } from './routes/chats';
import { conversationsRouter } from './routes/conversations';
import { conversationLeadsRouter } from './routes/conversation-leads';
import { conversationAiRouter } from './routes/conversation-ai';
import { sharedChatsRouter } from './routes/shared-chats';
import { conversationDealsRouter } from './routes/conversation-deals';
import { internalMessagingRouter } from './routes/internal';

/** Long-running LLM calls; align with campaign-service → ai (65s). Override: MESSAGING_AI_HTTP_TIMEOUT_MS. */
function messagingAiTimeoutMs(): number {
  const raw = process.env.MESSAGING_AI_HTTP_TIMEOUT_MS?.trim();
  if (!raw) return 65_000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 5_000 ? n : 65_000;
}

/** Outbound send waits on Telegram; default 90s. Override: MESSAGING_BD_ACCOUNTS_HTTP_TIMEOUT_MS. */
function messagingBdAccountsTimeoutMs(): number {
  const raw = process.env.MESSAGING_BD_ACCOUNTS_HTTP_TIMEOUT_MS?.trim();
  if (!raw) return 90_000;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n >= 10_000 ? n : 90_000;
}

async function main() {
  const ctx = await createServiceApp({
    name: 'messaging-service',
    port: parseInt(process.env.PORT || '3003', 10),
  });
  const { pool, rabbitmq, log, registry } = ctx;

  const bdAccountsClient = new ServiceHttpClient({
    ...interServiceHttpDefaults(),
    baseUrl: process.env.BD_ACCOUNTS_SERVICE_URL || 'http://bd-accounts-service:3007',
    name: 'bd-accounts-service',
    retries: 0,
    timeoutMs: messagingBdAccountsTimeoutMs(),
    metricsRegistry: registry,
  }, log);

  const aiClient = new ServiceHttpClient({
    ...interServiceHttpDefaults(),
    baseUrl: process.env.AI_SERVICE_URL || 'http://localhost:3005',
    name: 'ai-service',
    timeoutMs: messagingAiTimeoutMs(),
    metricsRegistry: registry,
  }, log);

  try {
    await subscribeToEvents({ pool, rabbitmq, log });
  } catch (error) {
    log.warn({
      message: 'RabbitMQ event subscription failed, service will continue without events',
      error: String(error),
    });
  }

  const conflicts409Total = new Counter({
    name: 'conflicts_409_total',
    help: 'Total 409 Conflict responses',
    labelNames: ['endpoint'],
    registers: [registry],
  });
  const sharedChatCreatedTotal = new Counter({
    name: 'shared_chat_created_total',
    help: 'Total shared chats created',
    registers: [registry],
  });
  const dealsWonTotal = new Counter({
    name: 'deals_won_total',
    help: 'Total deals marked as won',
    registers: [registry],
  });
  const externalCallDuration = new Histogram({
    name: 'external_call_duration_seconds',
    help: 'External HTTP call duration (e.g. bd-accounts)',
    labelNames: ['target'],
    registers: [registry],
  });

  ctx.mount('/api/messaging', messagesRouter({ pool, rabbitmq, log, bdAccountsClient }));
  ctx.mount('/api/messaging', chatsRouter({ pool, log, bdAccountsClient }));
  ctx.mount('/api/messaging', conversationsRouter({ pool }));
  ctx.mount('/api/messaging', conversationLeadsRouter({ pool }));
  ctx.mount('/api/messaging', conversationAiRouter({ pool, log, aiClient }));
  ctx.mount('/api/messaging', sharedChatsRouter({ pool, log, bdAccountsClient, conflicts409Total, sharedChatCreatedTotal, externalCallDuration }));
  ctx.mount('/api/messaging', conversationDealsRouter({ pool, log, conflicts409Total, dealsWonTotal }));
  ctx.mount('/internal', internalMessagingRouter({ pool, log }));

  ctx.start();
}

main().catch((err) => {
  createLogger('messaging-service').error({ message: 'Fatal: messaging-service failed to start', error: String(err) });
  process.exit(1);
});
