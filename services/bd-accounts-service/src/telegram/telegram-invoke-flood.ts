import type { Pool } from 'pg';
import { getErrorMessage, getErrorCode, getRetryAfterSeconds } from '../helpers';
import { recordBdAccountTelegramFlood, clearBdAccountTelegramFlood } from '../bd-account-flood-persist';
import type { StructuredLog } from './types';

export type TelegramFloodPersistInput = { pool: Pool; deferRetry?: boolean };

/**
 * Default pool for persisting FloodWait to `bd_accounts` when call sites omit `floodPersist`.
 * Set once from TelegramManager so sync/search/participants paths persist without threading pool everywhere.
 */
let defaultFloodPersistPool: Pool | null = null;

export function setTelegramFloodPersistPool(pool: Pool | null): void {
  defaultFloodPersistPool = pool;
}

function resolveFloodPool(explicit?: TelegramFloodPersistInput): Pool | undefined {
  return explicit?.pool ?? defaultFloodPersistPool ?? undefined;
}

export function isInvokeFloodWait(err: unknown): boolean {
  const c = getErrorCode(err);
  if (c === 'FLOOD_WAIT' || c === 'FLOOD') return true;
  const m = getErrorMessage(err);
  return /FLOOD_WAIT|FloodWait|A wait of \d+ second/i.test(m);
}

function floodWaitCapSeconds(): number {
  const raw = process.env.TELEGRAM_FLOOD_WAIT_CAP_SECONDS;
  const n = raw != null && raw.trim() !== '' ? parseInt(raw, 10) : 600;
  if (!Number.isFinite(n) || n < 1) return 600;
  return Math.min(n, 86400);
}

/**
 * On `FLOOD_WAIT` from `client.invoke`: sleep for Telegram's `seconds`, then one retry.
 * Optional `deferRetry: true`: persist and rethrow immediately (no in-process sleep).
 * On success, clears stored flood markers when a pool is available.
 */
export async function telegramInvokeWithFloodRetry<T>(
  log: StructuredLog,
  accountId: string,
  op: string,
  run: () => Promise<T>,
  floodPersist?: TelegramFloodPersistInput | null
): Promise<T> {
  const pool = resolveFloodPool(floodPersist ?? undefined);
  const deferRetry = floodPersist?.deferRetry === true;
  try {
    const out = await run();
    if (pool) await clearBdAccountTelegramFlood(pool, accountId);
    return out;
  } catch (e: unknown) {
    if (!isInvokeFloodWait(e)) throw e;
    if (deferRetry && pool) {
      await recordBdAccountTelegramFlood(pool, accountId, op, e);
      log.warn({
        message: `${op}: FLOOD_WAIT on invoke — defer (no sleep); caller will retry`,
        accountId,
        error: getErrorMessage(e),
      });
      throw e;
    }
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
    if (pool) await recordBdAccountTelegramFlood(pool, accountId, op, e);
    await new Promise((r) => setTimeout(r, waitMs));
    try {
      const out = await run();
      if (pool) await clearBdAccountTelegramFlood(pool, accountId);
      return out;
    } catch (e2: unknown) {
      if (isInvokeFloodWait(e2) && pool) {
        await recordBdAccountTelegramFlood(pool, accountId, `${op}(retry)`, e2);
      }
      throw e2;
    }
  }
}
