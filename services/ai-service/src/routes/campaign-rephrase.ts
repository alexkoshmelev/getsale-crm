import { FastifyInstance } from 'fastify';
import { Logger } from '@getsale/logger';
import { requireUser, validate, AppError, ErrorCodes } from '@getsale/service-framework';
import { AIRateLimiter } from '../rate-limiter';
import { resolveOpenRouterCampaignModel } from '../openrouter-models';
import { AiCampaignRephraseSchema, type AiCampaignRephraseInput } from '../validation';
import { sanitizeCampaignRephraseOutput } from '../campaign-rephrase-sanitize';
import { callOpenRouter, extractOpenRouterContent } from '../openai-client';

interface Deps {
  log: Logger;
  rateLimiter: AIRateLimiter;
}

export function registerCampaignRephraseRoutes(app: FastifyInstance, { log, rateLimiter }: Deps): void {
  app.post(
    '/api/ai/campaigns/rephrase',
    { preHandler: [requireUser, validate(AiCampaignRephraseSchema)] },
    async (request) => {
      const { organizationId } = request.user!;
      const { text } = request.body as AiCampaignRephraseInput;
      const apiKey = process.env.OPENROUTER_API_KEY?.trim();
      const model = resolveOpenRouterCampaignModel();

      if (!apiKey) {
        log.warn({ message: 'Campaign rephrase: OPENROUTER_API_KEY not set' });
        throw new AppError(
          503,
          'AI rephrase is not configured. Set OPENROUTER_API_KEY in ai-service.',
          ErrorCodes.SERVICE_UNAVAILABLE,
        );
      }

      const rateCheck = await rateLimiter.check(organizationId);
      if (!rateCheck.allowed) {
        throw new AppError(429, `AI rate limit exceeded. Reset in ${rateCheck.resetInSeconds}s`, ErrorCodes.RATE_LIMITED);
      }

      try {
        const data = await callOpenRouter({
          model,
          messages: [{ role: 'user', content: text }],
        });

        const content = extractOpenRouterContent(data);
        const finishReason = data?.choices?.[0]?.finish_reason;

        if (!content) {
          log.warn({
            message: 'Campaign rephrase: OpenRouter returned empty content',
            finishReason,
            model,
          });
          throw new AppError(502, 'AI rephrase returned empty response', ErrorCodes.SERVICE_UNAVAILABLE);
        }

        const sanitizedRaw = sanitizeCampaignRephraseOutput(text, content);
        const sanitized = sanitizedRaw.length > 0 ? sanitizedRaw : content;

        await rateLimiter.increment(organizationId);
        log.info({ message: 'Campaign rephrase success', organization_id: organizationId, model });
        return { content: sanitized, model, provider: 'openrouter' };
      } catch (err) {
        if (err instanceof AppError) throw err;
        log.warn({ message: 'AI campaign rephrase error', error: err instanceof Error ? err.message : String(err) });
        throw new AppError(502, 'AI rephrase failed', ErrorCodes.SERVICE_UNAVAILABLE);
      }
    },
  );
}
