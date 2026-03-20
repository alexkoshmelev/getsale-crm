import type { HttpClientOptions } from './http-client';

function envInt(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (raw === undefined || raw === '') return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Shared defaults for ServiceHttpClient between microservices (phase B1).
 * Override per-client after spread (e.g. longer timeout for AI or CRM → bd-accounts).
 *
 * Env (optional):
 * - SERVICE_HTTP_TIMEOUT_MS (default 10000)
 * - SERVICE_HTTP_RETRIES (default 2)
 * - SERVICE_HTTP_RETRY_DELAY_MS (default 500)
 * - SERVICE_HTTP_CB_THRESHOLD (default 5)
 * - SERVICE_HTTP_CB_RESET_MS (default 30000)
 */
export function interServiceHttpDefaults(): Pick<
  HttpClientOptions,
  'timeoutMs' | 'retries' | 'retryDelayMs' | 'circuitBreakerThreshold' | 'circuitBreakerResetMs'
> {
  return {
    timeoutMs: envInt('SERVICE_HTTP_TIMEOUT_MS', 10_000),
    retries: envInt('SERVICE_HTTP_RETRIES', 2),
    retryDelayMs: envInt('SERVICE_HTTP_RETRY_DELAY_MS', 500),
    circuitBreakerThreshold: envInt('SERVICE_HTTP_CB_THRESHOLD', 5),
    circuitBreakerResetMs: envInt('SERVICE_HTTP_CB_RESET_MS', 30_000),
  };
}
