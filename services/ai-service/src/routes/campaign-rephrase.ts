import { Router } from 'express';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, validate } from '@getsale/service-core';
import { AIRateLimiter } from '../rate-limiter';
import { DEFAULT_OPENROUTER_CAMPAIGN_MODEL } from '../openrouter-campaign-config';
import { AiCampaignRephraseSchema, type AiCampaignRephraseInput } from '../validation';
import { sanitizeCampaignRephraseOutput } from './campaign-rephrase-sanitize';

const REPHRASE_SYSTEM_PROMPT = `You rewrite Telegram DM messages for outreach. Follow STRICTLY:

1. Keep EXACTLY the same paragraph structure: same number of blocks separated by blank lines (use \\n\\n between paragraphs only, no single \\n for a new paragraph unless the original had it inside a block).
2. Use ONLY short ASCII hyphens (-). NEVER use em-dasses (—), en-dashes (–), or double hyphens (--) where a single hyphen would read naturally; prefer comma or period instead of long dashes.
3. Preserve emoji: same emojis in the same order and approximate positions (do not add or remove emojis).
4. Change wording, sentence order where natural, and phrasing so the text is unique, but keep the same meaning, intent, and tone.
5. Output ONLY the final message body — no quotes, no preamble, no labels like "Here is", no meta commentary.
6. Keep the same language as the input (do not translate).`;


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
      'Rephrase the message below for a personal Telegram DM. Preserve paragraph breaks exactly as in the input (count of \\n\\n-separated blocks must match).\n\n---\n'
      + text
      + '\n---';

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
            { role: 'system', content: REPHRASE_SYSTEM_PROMPT },
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

