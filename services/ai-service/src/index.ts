import './load-env';
import OpenAI from 'openai';
import { RedisClient } from '@getsale/utils';
import { EventType } from '@getsale/events';
import { AIDraftStatus } from '@getsale/types';
import { createServiceApp } from '@getsale/service-core';
import { draftsRouter } from './routes/drafts';
import { analyzeRouter } from './routes/analyze';
import { usageRouter } from './routes/usage';
import { searchQueriesRouter } from './routes/search-queries';
import { campaignRephraseRouter } from './routes/campaign-rephrase';
import { autoRespondRouter } from './routes/auto-respond';
import { AIRateLimiter } from './rate-limiter';
import { DRAFT_SYSTEM, PROMPT_VERSION } from './prompts';
import { DEFAULT_OPENROUTER_CAMPAIGN_MODEL, DEFAULT_OPENROUTER_CAMPAIGN_PRESET } from './openrouter-campaign-config';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY?.trim() || '';
const isPlaceholder = /your[_\-]?openai|placeholder|your_ope/i.test(OPENAI_API_KEY);
const isKeyConfigured = OPENAI_API_KEY.length > 0 && !isPlaceholder && OPENAI_API_KEY.startsWith('sk-');

const models = {
  draft: process.env.AI_MODEL_DRAFT || 'gpt-4o',
  analyze: process.env.AI_MODEL_ANALYZE || 'gpt-4o',
  summarize: process.env.AI_MODEL_SUMMARIZE || 'gpt-4o-mini',
};

async function main() {
  const ctx = await createServiceApp({ name: 'ai-service', port: 3005, skipDb: true });
  const { rabbitmq, log } = ctx;

  const openai = isKeyConfigured ? new OpenAI({ apiKey: OPENAI_API_KEY }) : null;

  if (!openai) {
    log.warn({ message: 'OPENAI_API_KEY not configured. AI endpoints will return 503.' });
  } else {
    log.info({ message: 'OpenAI configured', models: JSON.stringify(models), prompt_version: PROMPT_VERSION });
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  const envOpenRouterModel = process.env.OPENROUTER_MODEL?.trim();
  const campaignRephraseModel = envOpenRouterModel || DEFAULT_OPENROUTER_CAMPAIGN_PRESET;
  const autoRespondModel = envOpenRouterModel || DEFAULT_OPENROUTER_CAMPAIGN_MODEL;
  if (openRouterKey) {
    log.info({
      message: 'OPENROUTER_API_KEY is set; campaign rephrase and auto-respond endpoints are available',
      openrouter_campaign_rephrase_model: campaignRephraseModel,
      openrouter_auto_respond_model: autoRespondModel,
    });
  } else {
    log.warn({ message: 'OPENROUTER_API_KEY not set; campaign rephrase will return 503' });
  }

  const redis = new RedisClient(process.env.REDIS_URL || 'redis://localhost:6380');
  const maxPerHour = parseInt(process.env.AI_RATE_LIMIT_PER_HOUR || '200', 10);
  const rateLimiter = new AIRateLimiter(redis, maxPerHour);

  const deps = { openai, redis, rabbitmq, log, rateLimiter, models };

  // Event-driven: generate draft on inbound messages
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
      'ai-service'
    );
  }

  ctx.mount('/api/ai/drafts', draftsRouter(deps));
  ctx.mount('/api/ai', analyzeRouter(deps));
  ctx.mount('/api/ai', usageRouter(deps));
  ctx.mount('/api/ai', searchQueriesRouter(deps));
  ctx.mount('/api/ai', campaignRephraseRouter({ log, rateLimiter }));
  ctx.mount('/api/ai', autoRespondRouter({ log, rateLimiter }));

  ctx.start();
}

main().catch((err) => {
  console.error('Fatal: AI service failed to start:', err);
  process.exit(1);
});
