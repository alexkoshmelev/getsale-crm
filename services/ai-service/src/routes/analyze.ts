import { Router } from 'express';
import OpenAI from 'openai';
import { RedisClient } from '@getsale/utils';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes } from '@getsale/service-core';
import { ANALYZE_SYSTEM, SUMMARIZE_SYSTEM, PROMPT_VERSION } from '../prompts';
import { AIRateLimiter } from '../rate-limiter';
import { resolveOpenRouterChatSummarizeModel } from '../openrouter-models';

const OPENROUTER_CHAT_COMPLETIONS = 'https://openrouter.ai/api/v1/chat/completions';

interface Deps {
  openai: OpenAI | null;
  redis: RedisClient;
  log: Logger;
  rateLimiter: AIRateLimiter;
  models: { draft: string; analyze: string; summarize: string };
}

export function analyzeRouter({ openai, redis, log, rateLimiter, models }: Deps): Router {
  const router = Router();

  router.post('/conversations/analyze', asyncHandler(async (req, res) => {
    if (!openai) throw new AppError(503, 'AI service not configured', ErrorCodes.SERVICE_UNAVAILABLE);

    const { organizationId } = req.user;
    const { messages: rawMessages } = req.body as {
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
      model: models.analyze, prompt_version: PROMPT_VERSION,
    });

    res.json(payload);
  }));

  router.post('/chat/summarize', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { messages } = req.body as { messages?: Array<{ content?: string; role?: string }> };

    const texts = (Array.isArray(messages) ? messages : [])
      .map((m) => (typeof m.content === 'string' ? m.content.trim() : ''))
      .filter(Boolean)
      .slice(-50);

    if (texts.length === 0) return res.json({ summary: '', empty: true });

    const rateCheck = await rateLimiter.check(organizationId);
    if (!rateCheck.allowed) {
      throw new AppError(429, `AI rate limit exceeded. Reset in ${rateCheck.resetInSeconds}s`, ErrorCodes.RATE_LIMITED);
    }

    const conversation = texts.join('\n');
    const orSummarizeModel = resolveOpenRouterChatSummarizeModel();
    const orKey = process.env.OPENROUTER_API_KEY?.trim();

    if (orSummarizeModel) {
      if (!orKey) {
        throw new AppError(
          503,
          'Chat summarize is configured for OpenRouter but OPENROUTER_API_KEY is not set in ai-service.',
          ErrorCodes.SERVICE_UNAVAILABLE
        );
      }

      const timeoutRaw = parseInt(String(process.env.OPENROUTER_TIMEOUT_MS || '55000'), 10);
      const timeoutMs = Number.isNaN(timeoutRaw) ? 55_000 : Math.min(120_000, Math.max(10_000, timeoutRaw));
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await fetch(OPENROUTER_CHAT_COMPLETIONS, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${orKey}`,
          },
          body: JSON.stringify({
            model: orSummarizeModel,
            messages: [
              { role: 'system', content: SUMMARIZE_SYSTEM },
              { role: 'user', content: conversation.slice(-8000) },
            ],
            temperature: 0.3,
            max_tokens: 300,
            reasoning: { effort: 'none' },
          }),
          signal: controller.signal,
        });
        clearTimeout(timer);

        if (!response.ok) {
          const errText = await response.text().catch(() => '');
          log.warn({ message: 'OpenRouter chat summarize failed', httpStatus: response.status, body: errText.slice(0, 500) });
          throw new AppError(502, 'AI summarize provider failed', ErrorCodes.SERVICE_UNAVAILABLE);
        }

        const data = (await response.json()) as { choices?: Array<{ message?: { content?: string | null } }> };
        const summary = data?.choices?.[0]?.message?.content?.trim() || '';
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
        return res.json({ summary });
      } catch (err: unknown) {
        clearTimeout(timer);
        if (err instanceof AppError) throw err;
        const msg = err instanceof Error ? err.message : String(err);
        if (msg === 'AbortError' || (err as Error)?.name === 'AbortError') {
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

    res.json({ summary });
  }));

  return router;
}
