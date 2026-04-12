import type { StructuredLog } from './types';

function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err != null && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

function getErrorCode(err: unknown): string | undefined {
  if (err != null && typeof err === 'object' && 'code' in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}

export function isFloodWaitError(err: unknown): boolean {
  const c = getErrorCode(err);
  if (c === 'FLOOD_WAIT' || c === 'FLOOD') return true;
  const m = getErrorMessage(err);
  return /FLOOD_WAIT|FloodWait|A wait of \d+ second/i.test(m);
}

export function getFloodWaitSeconds(err: unknown): number {
  if (err != null && typeof err === 'object' && 'seconds' in err) {
    const s = (err as { seconds: unknown }).seconds;
    if (typeof s === 'number' && s >= 0 && s <= 86400 * 7) return Math.ceil(s);
  }
  const msg = getErrorMessage(err);
  const match = typeof msg === 'string' ? msg.match(/wait of (\d+) seconds?/i) : null;
  if (match) {
    const n = parseInt(match[1], 10);
    if (!Number.isNaN(n) && n >= 0 && n <= 86400 * 7) return n;
  }
  return 10;
}

function floodWaitCapSeconds(): number {
  const raw = process.env.TELEGRAM_FLOOD_WAIT_CAP_SECONDS;
  const n = raw != null && raw.trim() !== '' ? parseInt(raw, 10) : 600;
  if (!Number.isFinite(n) || n < 1) return 600;
  return Math.min(n, 86400);
}

export interface FloodRetryOptions {
  onFlood?: (accountId: string, op: string, seconds: number) => Promise<void>;
}

/**
 * Wraps a Telegram client.invoke call with flood-wait handling.
 * On FLOOD_WAIT: calls optional onFlood callback, sleeps, then retries once.
 */
export async function telegramInvokeWithFloodRetry<T>(
  log: StructuredLog,
  accountId: string,
  op: string,
  run: () => Promise<T>,
  opts?: FloodRetryOptions,
): Promise<T> {
  try {
    const t0 = Date.now();
    const out = await run();
    const durationMs = Date.now() - t0;
    if (durationMs > 5000) {
      log.warn({ message: 'invoke_slow_success', op, accountId, duration_ms: durationMs });
    }
    return out;
  } catch (e: unknown) {
    if (!isFloodWaitError(e)) throw e;

    const requestedSec = getFloodWaitSeconds(e);
    const capSec = floodWaitCapSeconds();
    const waitSec = Math.min(Math.max(requestedSec, 1), capSec);
    const waitMs = waitSec * 1000;

    log.warn({
      message: `${op}: FLOOD_WAIT — sleep ${waitSec}s (requested=${requestedSec}, cap=${capSec}s) then one retry`,
      accountId,
      waitMs,
      error: getErrorMessage(e),
    });

    if (opts?.onFlood) {
      await opts.onFlood(accountId, op, waitSec);
    }

    await new Promise((r) => setTimeout(r, waitMs));

    return await run();
  }
}
