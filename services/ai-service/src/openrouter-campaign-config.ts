/**
 * OpenRouter — campaign message rephrase uses a saved preset (prompt/model in OpenRouter).
 * https://openrouter.ai/docs — `model`: `@preset/<name>`.
 *
 * Override: `OPENROUTER_MODEL=@preset/copyright` (or another preset id).
 */
export const DEFAULT_OPENROUTER_CAMPAIGN_PRESET = '@preset/copyright';

/** Default for non-preset OpenRouter routes (e.g. auto-respond) when `OPENROUTER_MODEL` is unset. */
export const DEFAULT_OPENROUTER_CAMPAIGN_MODEL = 'openai/gpt-5-mini';
