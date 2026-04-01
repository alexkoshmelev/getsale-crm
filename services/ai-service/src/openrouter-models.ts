/**
 * Per-feature OpenRouter model selection.
 * Legacy: `OPENROUTER_MODEL` applies only when the feature-specific env is empty.
 * https://openrouter.ai/docs — presets: `model`: `@preset/<name>`.
 */

export const DEFAULT_OPENROUTER_CAMPAIGN_PRESET = '@preset/copyright';

/** Instruct free model; more stable than `openrouter/free` for short replies (fewer empty `content` from reasoning). */
export const DEFAULT_OPENROUTER_AUTO_RESPOND_MODEL = 'google/gemma-3-27b-it:free';

function trimEnv(key: string): string | undefined {
  const v = process.env[key]?.trim();
  return v || undefined;
}

function legacyOpenRouterModel(): string | undefined {
  return trimEnv('OPENROUTER_MODEL');
}

export function resolveOpenRouterCampaignModel(): string {
  return trimEnv('OPENROUTER_CAMPAIGN_MODEL') || legacyOpenRouterModel() || DEFAULT_OPENROUTER_CAMPAIGN_PRESET;
}

export function resolveOpenRouterAutoRespondModel(): string {
  return trimEnv('OPENROUTER_AUTO_RESPOND_MODEL') || legacyOpenRouterModel() || DEFAULT_OPENROUTER_AUTO_RESPOND_MODEL;
}

/** If set (including via legacy `OPENROUTER_MODEL`), chat summarize uses OpenRouter instead of OpenAI. */
export function resolveOpenRouterChatSummarizeModel(): string | undefined {
  return trimEnv('OPENROUTER_CHAT_SUMMARIZE_MODEL') || legacyOpenRouterModel() || undefined;
}
