import { FastifyInstance } from 'fastify';
import OpenAI from 'openai';
import { RedisClient } from '@getsale/cache';
import { Logger } from '@getsale/logger';
import { requireUser, AppError, ErrorCodes } from '@getsale/service-framework';
import { ANALYZE_SYSTEM, SUMMARIZE_SYSTEM, PROMPT_VERSION } from '../prompts';
import { AIRateLimiter } from '../rate-limiter';
import { resolveOpenRouterChatSummarizeModel } from '../openrouter-models';
import { callOpenRouter, extractOpenRouterContent } from '../openai-client';
import type { AIModels } from '../openai-client';

interface Deps {
  openai: OpenAI | null;
  redis: RedisClient;
  log: Logger;
  rateLimiter: AIRateLimiter;
  models: AIModels;
}

export function registerAnalyzeRoutes(app: FastifyInstance, deps: Deps): void {
  const { openai, log, rateLimiter, models } = deps;

  app.post(
    '/api/ai/conversations/analyze',
    { preHandler: [requireUser] },
    async (request) => {
      if (!openai) throw new AppError(503, 'AI service not configured', ErrorCodes.SERVICE_UNAVAILABLE);

      const { organizationId } = request.user!;
      const { messages: rawMessages } = request.body as {
        messages?: Array<{ content?: string; direction?: string; created_at?: string }>;
      };

      const list = Array.isArray(rawMessages) ? rawMessages : [];
      const messages = list
        .map((m) => ({
          content: typeof m.content === 'string' ? m.content.trim() : '',
          direction: typeof m.direction === 'string' ? m.direction : 'inbound',
          created_at: typeof m.created_at === 'string' ? m.created_at : '',
        }))
        .filter((m) => m.content.length > 0)
        .slice(-200);

      if (messages.length === 0) {
        throw new AppError(400, 'No messages to analyze', ErrorCodes.BAD_REQUEST);
      }

      const rateCheck = await rateLimiter.check(organizationId);
      if (!rateCheck.allowed) {
        throw new AppError(429, `AI rate limit exceeded. Reset in ${rateCheck.resetInSeconds}s`, ErrorCodes.RATE_LIMITED);
      }

      const conversationText = messages
        .map((m) => `[${m.direction} ${m.created_at}]: ${m.content.slice(0, 500)}`)
        .join('\n');

      const completion = await openai.chat.completions.create({
        model: models.analyze,
        messages: [
          { role: 'system', content: ANALYZE_SYSTEM },
          { role: 'user', content: conversationText.slice(-12000) },
        ],
        temperature: 0.4,
        max_tokens: 800,
        response_format: { type: 'json_object' },
      });

      await rateLimiter.increment(organizationId);

      const raw = completion.choices[0].message.content?.trim() || '{}';
      let payload: Record<string, unknown>;
      try {
        payload = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        payload = { project_summary: raw, risk_zone: 'yellow', recommendations: [], draft_message: '' };
      }

      if (!payload.recommendations || !Array.isArray(payload.recommendations)) {
        payload.recommendations = [];
      }

      log.info({
        message: 'Conversation analyzed',
        organization_id: organizationId,
        model: models.analyze,
        prompt_version: PROMPT_VERSION,
      });

      return payload;
    },
  );

  app.post(
    '/api/ai/chat/summarize',
    { preHandler: [requireUser] },
    async (request, reply) => {
      const { organizationId } = request.user!;
      const { messages } = request.body as { messages?: Array<{ content?: string; role?: string }> };

      const texts = (Array.isArray(messages) ? messages : [])
        .map((m) => (typeof m.content === 'string' ? m.content.trim() : ''))
        .filter(Boolean)
        .slice(-50);

      if (texts.length === 0) return { summary: '', empty: true };

      const rateCheck = await rateLimiter.check(organizationId);
      if (!rateCheck.allowed) {
        throw new AppError(429, `AI rate limit exceeded. Reset in ${rateCheck.resetInSeconds}s`, ErrorCodes.RATE_LIMITED);
      }

      const conversation = texts.join('\n');
      const orSummarizeModel = resolveOpenRouterChatSummarizeModel();

      if (orSummarizeModel) {
        const orKey = process.env.OPENROUTER_API_KEY?.trim();
        if (!orKey) {
          throw new AppError(
            503,
            'Chat summarize is configured for OpenRouter but OPENROUTER_API_KEY is not set.',
            ErrorCodes.SERVICE_UNAVAILABLE,
          );
        }

        try {
          const data = await callOpenRouter({
            model: orSummarizeModel,
            messages: [
              { role: 'system', content: SUMMARIZE_SYSTEM },
              { role: 'user', content: conversation.slice(-8000) },
            ],
            temperature: 0.3,
            max_tokens: 300,
            reasoning: { effort: 'none' },
          });

          const summary = extractOpenRouterContent(data);
          if (!summary) {
            throw new AppError(502, 'Empty summarize response', ErrorCodes.SERVICE_UNAVAILABLE);
          }

          await rateLimiter.increment(organizationId);
          log.info({
            message: 'Chat summarized',
            organization_id: organizationId,
            model: orSummarizeModel,
            provider: 'openrouter',
            prompt_version: PROMPT_VERSION,
          });
          return { summary };
        } catch (err: unknown) {
          if (err instanceof AppError) throw err;
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes('timed out')) {
            throw new AppError(504, 'AI summarize timed out', ErrorCodes.SERVICE_UNAVAILABLE);
          }
          log.warn({ message: 'Chat summarize OpenRouter error', error: msg });
          throw new AppError(502, 'AI summarize failed', ErrorCodes.SERVICE_UNAVAILABLE);
        }
      }

      if (!openai) throw new AppError(503, 'AI service not configured', ErrorCodes.SERVICE_UNAVAILABLE);

      const completion = await openai.chat.completions.create({
        model: models.summarize,
        messages: [
          { role: 'system', content: SUMMARIZE_SYSTEM },
          { role: 'user', content: conversation.slice(-8000) },
        ],
        temperature: 0.3,
        max_tokens: 300,
      });

      await rateLimiter.increment(organizationId);
      const summary = completion.choices[0].message.content?.trim() || '';

      log.info({
        message: 'Chat summarized',
        organization_id: organizationId,
        model: models.summarize,
        provider: 'openai',
        prompt_version: PROMPT_VERSION,
      });

      return { summary };
    },
  );
}
