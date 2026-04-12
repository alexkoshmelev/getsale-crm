import { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { RedisClient } from '@getsale/cache';
import { RabbitMQClient } from '@getsale/queue';
import { EventType, AIDraftGeneratedEvent } from '@getsale/events';
import { AIDraftStatus } from '@getsale/types';
import { Logger } from '@getsale/logger';
import { requireUser, validate, AppError, ErrorCodes } from '@getsale/service-framework';
import { DRAFT_SYSTEM, PROMPT_VERSION } from '../prompts';
import { AIRateLimiter } from '../rate-limiter';
import { AiDraftGenerateSchema } from '../validation';
import type { AIModels } from '../openai-client';

interface Deps {
  openai: OpenAI | null;
  redis: RedisClient;
  rabbitmq: RabbitMQClient;
  log: Logger;
  rateLimiter: AIRateLimiter;
  models: AIModels;
}

export function registerDraftRoutes(app: FastifyInstance, deps: Deps): void {
  const { openai, redis, rabbitmq, log, rateLimiter, models } = deps;

  app.post(
    '/api/ai/drafts/generate',
    { preHandler: [requireUser, validate(AiDraftGenerateSchema)] },
    async (request) => {
      if (!openai) throw new AppError(503, 'AI service not configured', ErrorCodes.SERVICE_UNAVAILABLE);

      const { organizationId } = request.user!;
      const { contactId, context } = request.body as { contactId?: string; context?: string };

      const rateCheck = await rateLimiter.check(organizationId);
      if (!rateCheck.allowed) {
        throw new AppError(429, `AI rate limit exceeded. Reset in ${rateCheck.resetInSeconds}s`, ErrorCodes.RATE_LIMITED);
      }

      const contactKey = contactId ? `contact:${contactId}` : null;
      const cached = contactKey ? await redis.get<{ name: string; company: string }>(contactKey) : null;
      const contact = cached ?? { name: 'Contact', company: 'Company' };

      const completion = await openai.chat.completions.create({
        model: models.draft,
        messages: [
          { role: 'system', content: DRAFT_SYSTEM },
          { role: 'user', content: `Generate a response to this message: "${context || ''}" for contact ${contact.name}` },
        ],
        temperature: 0.7,
        max_tokens: 200,
      });

      await rateLimiter.increment(organizationId);

      const draftContent = completion.choices[0].message.content || '';
      const draft = {
        id: crypto.randomUUID(),
        organizationId,
        contactId,
        content: draftContent,
        status: AIDraftStatus.GENERATED,
        generatedBy: 'ai-agent',
        promptVersion: PROMPT_VERSION,
        model: models.draft,
        createdAt: new Date(),
      };

      await redis.set(`draft:${draft.id}`, draft, 3600);

      const event: AIDraftGeneratedEvent = {
        id: crypto.randomUUID(),
        type: EventType.AI_DRAFT_GENERATED,
        timestamp: new Date(),
        organizationId,
        correlationId: request.correlationId,
        data: { draftId: draft.id, contactId, content: draftContent },
      };
      await rabbitmq.publishEvent(event);

      log.info({
        message: 'Draft generated',
        entity_type: 'ai_draft',
        entity_id: draft.id,
        model: models.draft,
        organization_id: organizationId,
      });

      return draft;
    },
  );

  app.get(
    '/api/ai/drafts/:id',
    { preHandler: [requireUser] },
    async (request) => {
      const { organizationId } = request.user!;
      const { id } = request.params as { id: string };

      const draft = await redis.get<Record<string, unknown>>(`draft:${id}`);
      if (!draft || draft.organizationId !== organizationId) {
        throw new AppError(404, 'Draft not found', ErrorCodes.NOT_FOUND);
      }

      return draft;
    },
  );

  app.post(
    '/api/ai/drafts/:id/approve',
    { preHandler: [requireUser] },
    async (request) => {
      const { id: userId, organizationId } = request.user!;
      const { id } = request.params as { id: string };

      const draft = await redis.get<Record<string, unknown>>(`draft:${id}`);
      if (!draft || draft.organizationId !== organizationId) {
        throw new AppError(404, 'Draft not found', ErrorCodes.NOT_FOUND);
      }

      const updatedDraft = { ...draft, status: AIDraftStatus.APPROVED, approvedBy: userId };
      await redis.set(`draft:${id}`, updatedDraft, 3600);

      await rabbitmq.publishEvent({
        id: crypto.randomUUID(),
        type: EventType.AI_DRAFT_APPROVED,
        timestamp: new Date(),
        organizationId,
        userId,
        correlationId: request.correlationId,
        data: { draftId: id },
      } as any);

      return updatedDraft;
    },
  );
}
