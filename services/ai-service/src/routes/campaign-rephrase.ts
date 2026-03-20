import { Router } from 'express';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, validate } from '@getsale/service-core';
import { AIRateLimiter } from '../rate-limiter';
import { DEFAULT_OPENROUTER_CAMPAIGN_MODEL } from '../openrouter-campaign-config';
import { AiCampaignRephraseSchema, type AiCampaignRephraseInput } from '../validation';

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

function parseOpenRouterMaxTokens(): number {
  const n = parseInt(String(process.env.OPENROUTER_MAX_TOKENS || '2048'), 10);
  if (Number.isNaN(n)) return 2048;
  return Math.min(8192, Math.max(256, n));
}

/** OpenRouter may return content:null when "thinking" models burn the whole budget on reasoning. */
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

export function campaignRephraseRouter({ log, rateLimiter }: Deps): Router {
  const router = Router();

  router.post('/campaigns/rephrase', validate(AiCampaignRephraseSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { text } = req.body as AiCampaignRephraseInput;
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    const model = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_CAMPAIGN_MODEL;

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

    const userText =
      'Rephrase the following message for a personal Telegram DM. Use different wording and sentence structure so it feels unique. Keep the same meaning and a natural tone. Reply with ONLY the rephrased message text (same language as the input). No preamble, no quotes, no explanation.\n\n'
      + text;

    const maxTokens = parseOpenRouterMaxTokens();
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
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content:
                'You write short Telegram DM text. Output only the final message body — never chain-of-thought, never "Okay let me", never meta commentary.',
            },
            { role: 'user', content: userText },
          ],
          max_tokens: maxTokens,
          temperature: 0.85,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        log.warn({ message: 'AI campaign rephrase failed', httpStatus: response.status, body });
        throw new AppError(502, 'AI rephrase provider failed', ErrorCodes.SERVICE_UNAVAILABLE);
      }

      const data = (await response.json()) as {
        choices?: Array<{
          finish_reason?: string;
          message?: { content?: string | null; reasoning?: string | null };
        }>;
      };
      const content = extractRephrasedText(data);
      const finishReason = data?.choices?.[0]?.finish_reason;
      if (!content) {
        log.warn({
          message: 'Campaign rephrase: OpenRouter returned empty content',
          finishReason,
          hint:
            finishReason === 'length'
              ? 'Model hit max_tokens (often "thinking" models use tokens for internal reasoning). Raise OPENROUTER_MAX_TOKENS or set OPENROUTER_MODEL to a non-reasoning instruct model.'
              : `Try OPENROUTER_MODEL=${DEFAULT_OPENROUTER_CAMPAIGN_MODEL} or another instruct model if using openrouter/free.`,
          body: data,
        });
        throw new AppError(502, 'AI rephrase returned empty response', ErrorCodes.SERVICE_UNAVAILABLE);
      }

      await rateLimiter.increment(organizationId);
      log.info({ message: 'Campaign rephrase success', organizationId, model });
      res.json({ content, model, provider: 'openrouter' });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof AppError) throw err;
      log.warn({ message: 'AI campaign rephrase error', error: err instanceof Error ? err.message : String(err) });
      throw new AppError(502, 'AI rephrase failed', ErrorCodes.SERVICE_UNAVAILABLE);
    }
  }));

  return router;
}

