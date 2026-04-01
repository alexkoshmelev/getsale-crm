import { Router } from 'express';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, validate } from '@getsale/service-core';
import { AIRateLimiter } from '../rate-limiter';
import {
  DEFAULT_OPENROUTER_CAMPAIGN_MODEL,
  FALLBACK_OPENROUTER_CAMPAIGN_MODELS,
} from '../openrouter-campaign-config';
import { AiCampaignRephraseSchema, type AiCampaignRephraseInput } from '../validation';
import { sanitizeCampaignRephraseOutput } from './campaign-rephrase-sanitize';

const REPHRASE_SYSTEM_PROMPT = `Ты - копирайтер-редактор.
Твоя задача: на каждый входящий текст делать вариативный рерайт, чтобы сообщение выглядело новым и уникальным, но сохраняло исходный смысл, тон и назначение.

Основная цель:
- текст не должен выглядеть как копипаст
- при быстром сравнении должно быть видно, что формулировки и структура другие
- при этом смысл, тон и intent сообщения полностью сохранены

Правила:
- сохраняй исходный смысл, факты, числа, даты, имена, ссылки, теги, @username, #хэштеги - без изменений
- не добавляй новых фактов и не убирай важные детали
- меняй структуру текста, а не только отдельные слова
- при возможности перестраивай порядок предложений
- дроби длинные предложения или объединяй короткие
- смещай акценты внутри фразы
- избегай поверхностных замен одного слова на синоним
- простая замена вроде "ищет" -> "находит" недостаточна
- используй разные речевые конструкции, чтобы текст читался по-другому, но естественно
- сохраняй стиль и тон оригинала (неформальный / деловой / разговорный)
- длина результата примерно как у оригинала (+/-20%)
- сохраняй форматирование исходного текста (переносы строк, списки, нумерацию)
- если есть код, команды или файловые пути - не изменяй их
- исправляй явные опечатки и пунктуацию, но не делай текст слишком вылизанным или шаблонным
- запрещено использовать длинный дефис
- запрещено использовать символ "—"
- если нужен разделитель, используй только "-"

Контроль качества:
- если результат слишком похож на оригинал по структуре или формулировкам - перепиши сильнее

Формат ответа:
- возвращай только переписанный текст
- никаких комментариев, объяснений или вариантов`;

const REPHRASE_TEMPERATURE = 0.7;

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

type OpenRouterChatCompletionData = {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; reasoning?: string | null };
  }>;
};

function buildOpenRouterBody(model: string, userText: string, maxTokens: number): Record<string, unknown> {
  return {
    model,
    messages: [
      { role: 'system', content: REPHRASE_SYSTEM_PROMPT },
      { role: 'user', content: userText },
    ],
    max_tokens: maxTokens,
    temperature: REPHRASE_TEMPERATURE,
    reasoning: { effort: 'none' },
    provider: { require_parameters: true },
  };
}

function modelsToTry(primary: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (m: string) => {
    const t = m.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  };
  add(primary);
  for (const fb of FALLBACK_OPENROUTER_CAMPAIGN_MODELS) {
    add(fb);
  }
  return out;
}

export function campaignRephraseRouter({ log, rateLimiter }: Deps): Router {
  const router = Router();

  router.post('/campaigns/rephrase', validate(AiCampaignRephraseSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { text } = req.body as AiCampaignRephraseInput;
    const apiKey = process.env.OPENROUTER_API_KEY?.trim();
    const primaryModel = process.env.OPENROUTER_MODEL?.trim() || DEFAULT_OPENROUTER_CAMPAIGN_MODEL;

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

    let lastEmptyFinishReason: string | undefined;
    let lastModelTried = primaryModel;

    try {
      const modelSequence = modelsToTry(primaryModel);
      let data: OpenRouterChatCompletionData | null = null;
      let content: string | undefined;

      for (let i = 0; i < modelSequence.length; i++) {
        const model = modelSequence[i]!;
        lastModelTried = model;
        const response = await fetch(OPENROUTER_API, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(buildOpenRouterBody(model, userText, maxTokens)),
          signal: controller.signal,
        });

        if (!response.ok) {
          const bodyText = await response.text().catch(() => '');
          log.warn({ message: 'AI campaign rephrase failed', httpStatus: response.status, body: bodyText, model });
          clearTimeout(timeout);
          throw new AppError(502, 'AI rephrase provider failed', ErrorCodes.SERVICE_UNAVAILABLE);
        }

        data = (await response.json()) as OpenRouterChatCompletionData;
        content = extractRephrasedText(data);
        const finishReason = data?.choices?.[0]?.finish_reason;
        if (content) break;

        lastEmptyFinishReason = finishReason;
        if (i < modelSequence.length - 1) {
          log.warn({
            message: 'Campaign rephrase: empty content, trying fallback model',
            model,
            nextModel: modelSequence[i + 1],
            finishReason,
          });
        }
      }

      clearTimeout(timeout);

      if (!content) {
        log.warn({
          message: 'Campaign rephrase: OpenRouter returned empty content after fallbacks',
          finishReason: lastEmptyFinishReason,
          hint:
            lastEmptyFinishReason === 'length'
              ? 'Model hit max_tokens (often "thinking" models use tokens for internal reasoning). Raise OPENROUTER_MAX_TOKENS or set OPENROUTER_MODEL to a non-reasoning instruct model.'
              : `Try OPENROUTER_MODEL=${DEFAULT_OPENROUTER_CAMPAIGN_MODEL} or another instruct model if using openrouter/free.`,
          lastModelTried,
          body: data,
        });
        throw new AppError(502, 'AI rephrase returned empty response', ErrorCodes.SERVICE_UNAVAILABLE);
      }

      const sanitizedRaw = sanitizeCampaignRephraseOutput(text, content);
      const sanitized = sanitizedRaw.length > 0 ? sanitizedRaw : content;

      await rateLimiter.increment(organizationId);
      log.info({ message: 'Campaign rephrase success', organizationId, model: lastModelTried });
      res.json({ content: sanitized, model: lastModelTried, provider: 'openrouter' });
    } catch (err) {
      clearTimeout(timeout);
      if (err instanceof AppError) throw err;
      log.warn({ message: 'AI campaign rephrase error', error: err instanceof Error ? err.message : String(err) });
      throw new AppError(502, 'AI rephrase failed', ErrorCodes.SERVICE_UNAVAILABLE);
    }
  }));

  return router;
}
