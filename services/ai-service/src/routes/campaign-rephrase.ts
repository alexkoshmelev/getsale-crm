import { Router } from 'express';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, validate } from '@getsale/service-core';
import { AIRateLimiter } from '../rate-limiter';
import { DEFAULT_OPENROUTER_CAMPAIGN_PRESET } from '../openrouter-campaign-config';
import { AiCampaignRephraseSchema, type AiCampaignRephraseInput } from '../validation';
import { sanitizeCampaignRephraseOutput } from './campaign-rephrase-sanitize';

interface Deps {
  log: Logger;
  rateLimiter: AIRateLimiter;
}

const OPENROUTER_API = 'https://openrouter.ai/api/v1/chat/completions';

function parseOpenRouterTimeoutMs(): number {
  const n = parseInt(String(process.env.OPENROUTER_TIMEOUT_MS || '55000'), 10);
  if (Number.isNaN(n)) return 55_000;
  return Math.min(120_000, Math.max(10_000, n));
}

function parseOpenRouterMaxTokensCap(): number {
  const n = parseInt(String(process.env.OPENROUTER_MAX_TOKENS || '512'), 10);
  if (Number.isNaN(n)) return 512;
  return Math.min(8192, Math.max(256, n));
}

/** Tight ceiling for short DMs: 2x rough token estimate, floor 128, capped by env. */
export function computeRephraseMaxTokens(text: string): number {
  const cap = parseOpenRouterMaxTokensCap();
  const inputTokenEstimate = Math.ceil(text.length / 3);
  const scaled = Math.max(128, inputTokenEstimate * 2);
  return Math.min(cap, scaled);
}

function extractRephrasedText(data: {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; reasoning?: string | null };
  }>;
}): string | undefined {
  const msg = data?.choices?.[0]?.message;
  const c = msg?.content?.trim();
  if (c) return c;
  return undefined;
}

type OpenRouterChatCompletionData = {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; reasoning?: string | null };
  }>;
};

/** Preset carries system instructions in OpenRouter; only user message = campaign text to rewrite. */
function buildOpenRouterPresetBody(model: string, userText: string, maxTokens: number): Record<string, unknown> {
  return {
    model,
    messages: [{ role: 'user', content: userText }],
    max_tokens: maxTokens,
  };
}

export function campaignRephraseRouter({ log, rateLimiter }: Deps): Router {
  const router = Router();

  router.post('/campaigns/rephrase', validate(AiCampaignRephraseSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { text } = req.body as AiCampaignRephraseInput;
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    const model = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_CAMPAIGN_PRESET;

    if (!apiKey) {
      log.warn({ message: 'Campaign rephrase: OPENROUTER_API_KEY not set in ai-service' });
      throw new AppError(
        503,
        'AI rephrase is not configured. Set OPENROUTER_API_KEY in ai-service.',
        ErrorCodes.SERVICE_UNAVAILABLE
      );
    }

    const rateCheck = await rateLimiter.check(organizationId);
    if (!rateCheck.allowed) {
      throw new AppError(429, `AI rate limit exceeded. Reset in ${rateCheck.resetInSeconds}s`, ErrorCodes.RATE_LIMITED);
    }

    const userText = text;
    const maxTokens = computeRephraseMaxTokens(text);
    const openRouterTimeoutMs = parseOpenRouterTimeoutMs();

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), openRouterTimeoutMs);

    try {
      const response = await fetch(OPENROUTER_API, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(buildOpenRouterPresetBody(model, userText, maxTokens)),
        signal: controller.signal,
      });

      if (!response.ok) {
        const bodyText = await response.text().catch(() => '');
        log.warn({ message: 'AI campaign rephrase failed', httpStatus: response.status, body: bodyText, model });
        clearTimeout(timeout);
        throw new AppError(502, 'AI rephrase provider failed', ErrorCodes.SERVICE_UNAVAILABLE);
      }

      const data = (await response.json()) as OpenRouterChatCompletionData;
      clearTimeout(timeout);

      const content = extractRephrasedText(data);
      const finishReason = data?.choices?.[0]?.finish_reason;

      if (!content) {
        log.warn({
          message: 'Campaign rephrase: OpenRouter returned empty content',
          finishReason,
          hint:
            finishReason === 'length'
              ? 'Raise OPENROUTER_MAX_TOKENS or adjust the preset in OpenRouter.'
              : `Check preset and OPENROUTER_MODEL (default ${DEFAULT_OPENROUTER_CAMPAIGN_PRESET}).`,
          model,
          body: data,
        });
        throw new AppError(502, 'AI rephrase returned empty response', ErrorCodes.SERVICE_UNAVAILABLE);
      }

      const sanitizedRaw = sanitizeCampaignRephraseOutput(text, content);
      const sanitized = sanitizedRaw.length > 0 ? sanitizedRaw : content;

      await rateLimiter.increment(organizationId);
      log.info({ message: 'Campaign rephrase success', organizationId, model });
      res.json({ content: sanitized, model, provider: 'openrouter' });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof AppError) throw err;
      log.warn({ message: 'AI campaign rephrase error', error: err instanceof Error ? err.message : String(err) });
      throw new AppError(502, 'AI rephrase failed', ErrorCodes.SERVICE_UNAVAILABLE);
    }
  }));

  return router;
}
