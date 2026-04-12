import { createService } from '@getsale/service-framework';
import { RedisClient } from '@getsale/cache';
import { EventType } from '@getsale/events';
import { AIDraftStatus } from '@getsale/types';
import { createOpenAIClient, resolveModels } from './openai-client';
import { AIRateLimiter } from './rate-limiter';
import { DRAFT_SYSTEM, PROMPT_VERSION } from './prompts';
import {
  resolveOpenRouterCampaignModel,
  resolveOpenRouterAutoRespondModel,
  resolveOpenRouterChatSummarizeModel,
} from './openrouter-models';
import { registerDraftRoutes } from './routes/drafts';
import { registerAnalyzeRoutes } from './routes/analyze';
import { registerUsageRoutes } from './routes/usage';
import { registerSearchQueryRoutes } from './routes/search-queries';
import { registerCampaignRephraseRoutes } from './routes/campaign-rephrase';
import { registerAutoRespondRoutes } from './routes/auto-respond';

async function main() {
  const redis = new RedisClient({ url: process.env.REDIS_URL || 'redis://localhost:6380' });
  const maxPerHour = parseInt(process.env.AI_RATE_LIMIT_PER_HOUR || '200', 10);
  const rateLimiter = new AIRateLimiter(redis, maxPerHour);
  const models = resolveModels();
  const openai = createOpenAIClient();

  const ctx = await createService({
    name: 'ai-service',
    port: parseInt(process.env.PORT || '4010', 10),
    skipDb: true,
    onShutdown: () => redis.disconnect(),
  });

  const { app, rabbitmq, log } = ctx;

  if (openai) {
    log.info({ message: 'OpenAI configured', models: JSON.stringify(models), prompt_version: PROMPT_VERSION });
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  if (openRouterKey) {
    const summarizeOr = resolveOpenRouterChatSummarizeModel();
    log.info({
      message: 'OpenRouter configured',
      openrouter_campaign_model: resolveOpenRouterCampaignModel(),
      openrouter_auto_respond_model: resolveOpenRouterAutoRespondModel(),
      chat_summarize: summarizeOr
        ? { provider: 'openrouter', model: summarizeOr }
        : { provider: 'openai', model: models.summarize },
    });
  } else {
    log.warn({ message: 'OPENROUTER_API_KEY not set; campaign rephrase and OpenRouter summarize will return 503' });
  }

  const deps = { openai, redis, rabbitmq, log, rateLimiter, models };

  registerDraftRoutes(app, deps);
  registerAnalyzeRoutes(app, deps);
  registerUsageRoutes(app, deps);
  registerSearchQueryRoutes(app, deps);
  registerCampaignRephraseRoutes(app, { log, rateLimiter });
  registerAutoRespondRoutes(app, { log, rateLimiter });

  if (rabbitmq.isConnected()) {
    await rabbitmq.subscribeToEvents(
      [EventType.MESSAGE_RECEIVED],
      async (event) => {
        if (event.type !== EventType.MESSAGE_RECEIVED || !openai) return;
        const data = event.data as { contactId?: string; content: string; organizationId?: string };
        const orgId = event.organizationId || (data as Record<string, unknown>).organizationId as string || '';

        if (!orgId) {
          log.warn({ message: 'Skipping draft generation — no organizationId in event', event_id: event.id });
          return;
        }

        try {
          const rateCheck = await rateLimiter.check(orgId);
          if (!rateCheck.allowed) return;

          const contactKey = data.contactId ? `contact:${data.contactId}` : null;
          const cached = contactKey ? await redis.get<{ name: string; company: string }>(contactKey) : null;
          const contact = cached ?? { name: 'Contact', company: 'Company' };

          const completion = await openai.chat.completions.create({
            model: models.draft,
            messages: [
              { role: 'system', content: DRAFT_SYSTEM },
              { role: 'user', content: `Generate a response to this message: "${data.content}" for contact ${contact.name}` },
            ],
            temperature: 0.7,
            max_tokens: 200,
          });

          await rateLimiter.increment(orgId);

          const draft = {
            id: crypto.randomUUID(),
            organizationId: orgId,
            contactId: data.contactId,
            content: completion.choices[0].message.content || '',
            status: AIDraftStatus.GENERATED,
            generatedBy: 'ai-agent',
            promptVersion: PROMPT_VERSION,
            model: models.draft,
            createdAt: new Date(),
          };

          await redis.set(`draft:${draft.id}`, draft, 3600);

          await rabbitmq.publishEvent({
            id: crypto.randomUUID(),
            type: EventType.AI_DRAFT_GENERATED,
            timestamp: new Date(),
            organizationId: orgId,
            data: { draftId: draft.id, contactId: data.contactId, content: draft.content },
          } as any);
        } catch (err: unknown) {
          const e = err as Error;
          log.warn({ message: 'Event-driven draft generation failed', error: e.message, event_id: event.id });
        }
      },
      'events',
      'ai-service',
    );
  }

  await ctx.start();
}

main().catch((err) => {
  console.error('Fatal: ai-service failed to start:', err);
  process.exit(1);
});
