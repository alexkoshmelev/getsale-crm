import OpenAI from 'openai';
import { createLogger } from '@getsale/logger';

const log = createLogger('ai-openai-client');

const OPENROUTER_CHAT_COMPLETIONS = 'https://openrouter.ai/api/v1/chat/completions';

export interface AIModels {
  draft: string;
  analyze: string;
  summarize: string;
}

export function resolveModels(): AIModels {
  return {
    draft: process.env.AI_MODEL_DRAFT || 'gpt-4o',
    analyze: process.env.AI_MODEL_ANALYZE || 'gpt-4o',
    summarize: process.env.AI_MODEL_SUMMARIZE || 'gpt-4o-mini',
  };
}

export function createOpenAIClient(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY?.trim() || '';
  const isPlaceholder = /your[_\-]?openai|placeholder|your_ope/i.test(key);
  const isConfigured = key.length > 0 && !isPlaceholder && key.startsWith('sk-');

  if (!isConfigured) {
    log.warn({ message: 'OPENAI_API_KEY not configured. OpenAI endpoints will return 503.' });
    return null;
  }

  return new OpenAI({ apiKey: key });
}

function parseOpenRouterTimeoutMs(): number {
  const n = parseInt(String(process.env.OPENROUTER_TIMEOUT_MS || '55000'), 10);
  if (Number.isNaN(n)) return 55_000;
  return Math.min(120_000, Math.max(10_000, n));
}

export interface OpenRouterMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OpenRouterOptions {
  model: string;
  messages: OpenRouterMessage[];
  temperature?: number;
  max_tokens?: number;
  reasoning?: { effort: string };
}

export interface OpenRouterResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | null; reasoning?: string | null };
  }>;
}

const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = [1500, 3000, 6000];

/**
 * Calls the OpenRouter chat completions API with timeout support and retry on 429/502/503.
 */
export async function callOpenRouter(options: OpenRouterOptions): Promise<OpenRouterResponse> {
  const apiKey = process.env.OPENROUTER_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY not set');
  }

  const { reasoning, ...rest } = options;
  const payload: Record<string, unknown> = { ...rest };
  if (reasoning && reasoning.effort !== 'none') {
    payload.reasoning = reasoning;
  }
  const bodyStr = JSON.stringify(payload);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = RETRY_DELAYS_MS[attempt - 1] ?? 6000;
      log.info({ message: 'OpenRouter retry', attempt, delay, model: rest.model });
      await new Promise((r) => setTimeout(r, delay));
    }

    const timeoutMs = parseOpenRouterTimeoutMs();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(OPENROUTER_CHAT_COMPLETIONS, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: bodyStr,
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (response.ok) {
        return (await response.json()) as OpenRouterResponse;
      }

      const errText = await response.text().catch(() => '');
      log.warn({ message: 'OpenRouter request failed', httpStatus: response.status, model: rest.model, attempt, body: errText.slice(0, 500) });
      lastError = new OpenRouterError(`OpenRouter HTTP ${response.status}: ${errText.slice(0, 200)}`, response.status);

      if (response.status === 429 || response.status === 502 || response.status === 503) {
        continue;
      }
      throw lastError;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof OpenRouterError) throw err;
      if (err instanceof Error && (err.name === 'AbortError' || err.message === 'AbortError')) {
        lastError = new Error('OpenRouter request timed out');
        continue;
      }
      throw err;
    }
  }

  throw lastError ?? new Error('OpenRouter request failed after retries');
}

export class OpenRouterError extends Error {
  constructor(message: string, public readonly httpStatus: number) {
    super(message);
    this.name = 'OpenRouterError';
  }
}

export function extractOpenRouterContent(data: OpenRouterResponse): string | undefined {
  return data?.choices?.[0]?.message?.content?.trim() || undefined;
}
