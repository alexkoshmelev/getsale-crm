import { Router } from 'express';
import OpenAI from 'openai';
import { RedisClient, RabbitMQClient } from '@getsale/utils';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes } from '@getsale/service-core';
import { AIRateLimiter } from '../rate-limiter';

const SEARCH_QUERIES_SYSTEM = `You are a helper that generates short Telegram search queries. Given a topic or niche (e.g. "crypto", "B2B marketing"), output 10-15 search phrases that people would use to find relevant Telegram groups and channels. One phrase per line. No numbering, no bullets. Only the phrases, in English or the same language as the topic. Keep each phrase under 5 words.`;

interface Deps {
  openai: OpenAI | null;
  redis: RedisClient;
  rabbitmq: RabbitMQClient;
  log: Logger;
  rateLimiter: AIRateLimiter;
  models: { draft: string; analyze: string; summarize: string };
}

export function searchQueriesRouter({ openai, log, rateLimiter, models }: Deps): Router {
  const router = Router();

  router.post('/generate-search-queries', asyncHandler(async (req, res) => {
    if (!openai) throw new AppError(503, 'AI service not configured', ErrorCodes.SERVICE_UNAVAILABLE);

    const { organizationId } = req.user;
    const topic = typeof req.body?.topic === 'string' ? req.body.topic.trim() : '';
    if (!topic || topic.length > 500) {
      throw new AppError(400, 'topic is required and must be 1-500 characters', ErrorCodes.VALIDATION);
    }

    const rateCheck = await rateLimiter.check(organizationId);
    if (!rateCheck.allowed) {
      throw new AppError(429, `AI rate limit exceeded. Reset in ${rateCheck.resetInSeconds}s`, ErrorCodes.RATE_LIMITED);
    }

    const completion = await openai.chat.completions.create({
      model: models.draft,
      messages: [
        { role: 'system', content: SEARCH_QUERIES_SYSTEM },
        { role: 'user', content: `Topic: ${topic}` },
      ],
      temperature: 0.7,
      max_tokens: 400,
    });

    await rateLimiter.increment(organizationId);

    const raw = completion.choices[0].message.content || '';
    const queries = raw
      .split(/\n/)
      .map((s) => s.replace(/^[\d.)\-\s*]+/, '').trim())
      .filter((s) => s.length > 0 && s.length <= 100)
      .slice(0, 20);

    res.json({ queries });
  }));

  return router;
}
