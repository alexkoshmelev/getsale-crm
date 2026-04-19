import { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { Logger } from '@getsale/logger';
import { requireUser, validate, AppError, ErrorCodes } from '@getsale/service-framework';
import { AIRateLimiter } from '../rate-limiter';
import { AiGenerateSearchQueriesSchema } from '../validation';
import type { AIModels } from '../openai-client';

const SEARCH_QUERIES_SYSTEM = `You are a helper that generates short Telegram search queries. Given a topic or niche (e.g. "crypto", "B2B marketing"), output 10-15 search phrases that people would use to find relevant Telegram groups and channels. One phrase per line. No numbering, no bullets. Only the phrases, in English or the same language as the topic. Keep each phrase under 5 words.`;

interface Deps {
  openai: OpenAI | null;
  log: Logger;
  rateLimiter: AIRateLimiter;
  models: AIModels;
}

export function registerSearchQueryRoutes(app: FastifyInstance, deps: Deps): void {
  const { openai, log, rateLimiter, models } = deps;

  app.post(
    '/api/ai/generate-search-queries',
    { preHandler: [requireUser, validate(AiGenerateSearchQueriesSchema)] },
    async (request) => {
      if (!openai) throw new AppError(503, 'AI service not configured', ErrorCodes.SERVICE_UNAVAILABLE);

      const { organizationId } = request.user!;
      const { topic } = request.body as { topic: string };

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

      return { queries };
    },
  );
}
