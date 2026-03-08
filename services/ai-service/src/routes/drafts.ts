import { Router } from 'express';
import OpenAI from 'openai';
import { RedisClient, RabbitMQClient } from '@getsale/utils';
import { EventType, AIDraftGeneratedEvent } from '@getsale/events';
import { AIDraftStatus } from '@getsale/types';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes } from '@getsale/service-core';
import { DRAFT_SYSTEM, PROMPT_VERSION } from '../prompts';
import { AIRateLimiter } from '../rate-limiter';

interface Deps {
  openai: OpenAI | null;
  redis: RedisClient;
  rabbitmq: RabbitMQClient;
  log: Logger;
  rateLimiter: AIRateLimiter;
  models: { draft: string; analyze: string; summarize: string };
}

export function draftsRouter({ openai, redis, rabbitmq, log, rateLimiter, models }: Deps): Router {
  const router = Router();

  router.post('/generate', asyncHandler(async (req, res) => {
    if (!openai) throw new AppError(503, 'AI service not configured', ErrorCodes.SERVICE_UNAVAILABLE);

    const { id: userId, organizationId } = req.user;
    const { contactId, context } = req.body;

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
      data: { draftId: draft.id, contactId, content: draftContent },
    };
    await rabbitmq.publishEvent(event);

    log.info({
      message: 'Draft generated',
      entity_type: 'ai_draft', entity_id: draft.id,
      model: models.draft, organization_id: organizationId,
    });

    res.json(draft);
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const draft = await redis.get<Record<string, unknown>>(`draft:${req.params.id}`);
    if (!draft) throw new AppError(404, 'Draft not found', ErrorCodes.NOT_FOUND);
    if (draft.organizationId !== organizationId) {
      throw new AppError(404, 'Draft not found', ErrorCodes.NOT_FOUND);
    }
    res.json(draft);
  }));

  router.post('/:id/approve', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const draft = await redis.get<Record<string, unknown>>(`draft:${req.params.id}`);
    if (!draft) throw new AppError(404, 'Draft not found', ErrorCodes.NOT_FOUND);
    if (draft.organizationId !== organizationId) {
      throw new AppError(404, 'Draft not found', ErrorCodes.NOT_FOUND);
    }

    const updatedDraft = { ...draft, status: AIDraftStatus.APPROVED, approvedBy: userId };
    await redis.set(`draft:${req.params.id}`, updatedDraft, 3600);

    await rabbitmq.publishEvent({
      id: crypto.randomUUID(),
      type: EventType.AI_DRAFT_APPROVED,
      timestamp: new Date(),
      organizationId,
      userId,
      data: { draftId: req.params.id },
    } as any);

    res.json(updatedDraft);
  }));

  return router;
}
