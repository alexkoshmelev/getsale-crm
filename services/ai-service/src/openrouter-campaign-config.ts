/**
 * OpenRouter defaults for campaign message rephrase.
 *
 * Primary default: `openai/gpt-5-mini`. Fallbacks are free instruct Gemma models if the primary returns
 * empty content. Avoid using `openrouter/free` as the *primary* model: the pool may route to
 * "thinking" models that burn `max_tokens` on `reasoning` and return `message.content: null` → 502.
 *
 * Override with `OPENROUTER_MODEL` in env. See docs/DEPLOYMENT.md and docs/ARCHITECTURE_CAMPAIGN_AI.md.
 */
export const DEFAULT_OPENROUTER_CAMPAIGN_MODEL = 'openai/gpt-5-mini';

/** Instruct-style free models used when the primary model returns empty content (thinking burn). */
export const FALLBACK_OPENROUTER_CAMPAIGN_MODELS = [
  'google/gemma-3-12b-it:free',
  'google/gemma-3-4b-it:free',
] as const;
