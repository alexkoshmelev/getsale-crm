import type { Pool } from 'pg';
import { getErrorMessage, getErrorCode, getRetryAfterSeconds } from '../helpers';
import type { StructuredLog } from './types';

export function isInvokeFloodWait(err: unknown): boolean {
  const c = getErrorCode(err);
  if (c === 'FLOOD_WAIT' || c === 'FLOOD') return true;
  const m = getErrorMessage(err);
  return /FLOOD_WAIT|FloodWait|A wait of \d+ second/i.test(m);
}

/**
 * Upper bound for how long we block the worker waiting for Telegram (Telegram may ask for very long waits).
 * Full requested seconds are used up to this cap; see `TELEGRAM_FLOOD_WAIT_CAP_SECONDS` in DEPLOYMENT.md.
 */
function floodWaitCapSeconds(): number {
  const raw = process.env.TELEGRAM_FLOOD_WAIT_CAP_SECONDS;
  const n = raw != null && raw.trim() !== '' ? parseInt(raw, 10) : 600;
  if (!Number.isFinite(n) || n < 1) return 600;
  return Math.min(n, 86400);
}

async function persistFloodWait(pool: Pool, accountId: string, sleepSeconds: number, requestedSeconds: number | null): Promise<void> {
  await pool.query(
    `UPDATE bd_accounts
     SET flood_wait_until = NOW() + ($1::int * INTERVAL '1 second'),
         flood_wait_seconds = $2,
         updated_at = NOW()
     WHERE id = $3`,
    [sleepSeconds, requestedSeconds ?? sleepSeconds, accountId]
  );
}

async function clearFloodWait(pool: Pool, accountId: string): Promise<void> {
  await pool.query(
    `UPDATE bd_accounts SET flood_wait_until = NULL, flood_wait_seconds = NULL, updated_at = NOW() WHERE id = $1`,
    [accountId]
  );
}

/**
 * On `FLOOD_WAIT` from `client.invoke`: sleep for **Telegram’s** `seconds` (GramJS FloodWaitError / MTProto),
 * then **one** retry. Immediate retry without waiting would fail again — we always sleep first.
 * If the requested wait exceeds the cap, we sleep only `cap` seconds; the retry may still hit FLOOD (caller
 * may rotate BD or surface error).
 *
 * When `pool` is passed, persists `flood_wait_until` / `flood_wait_seconds` on `bd_accounts` during wait and clears after success.
 */
export async function telegramInvokeWithFloodRetry<T>(
  log: StructuredLog,
  accountId: string,
  op: string,
  run: () => Promise<T>,
  pool?: Pool | null
): Promise<T> {
  try {
    return await run();
  } catch (e: unknown) {
    if (!isInvokeFloodWait(e)) throw e;
    const requestedSec = getRetryAfterSeconds(e);
    const capSec = floodWaitCapSeconds();
    const waitSec = Math.min(Math.max(requestedSec ?? 10, 1), capSec);
    const waitMs = waitSec * 1000;
    log.warn({
      message: `${op}: FLOOD_WAIT on invoke — sleep ${waitSec}s (telegramSeconds=${requestedSec ?? 'default'}, cap=${capSec}s) then one retry`,
      accountId,
      waitMs,
      error: getErrorMessage(e),
    });
    if (pool) {
      try {
        await persistFloodWait(pool, accountId, waitSec, requestedSec ?? null);
      } catch (persistErr) {
        log.warn({ message: 'persistFloodWait failed', accountId, error: String(persistErr) });
      }
    }
    await new Promise((r) => setTimeout(r, waitMs));
    const out = await run();
    if (pool) {
      try {
        await clearFloodWait(pool, accountId);
      } catch (clearErr) {
        log.warn({ message: 'clearFloodWait failed', accountId, error: String(clearErr) });
      }
    }
    return out;
  }
}
