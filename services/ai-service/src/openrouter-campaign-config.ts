/**
 * OpenRouter defaults for campaign message rephrase.
 *
 * Avoid `openrouter/free` as default: the pool may route to "thinking" models that consume the whole
 * `max_tokens` budget in `reasoning` and return `message.content: null` → 502 in campaign flow.
 *
 * Override with `OPENROUTER_MODEL` in env. See docs/DEPLOYMENT.md and docs/ARCHITECTURE_CAMPAIGN_AI.md.
 */
export const DEFAULT_OPENROUTER_CAMPAIGN_MODEL = 'google/gemma-3-27b-it:free';

/** Instruct-style free models used when the primary model returns empty content (thinking burn). */
export const FALLBACK_OPENROUTER_CAMPAIGN_MODELS = [
  'google/gemma-3-12b-it:free',
  'google/gemma-3-4b-it:free',
] as const;
