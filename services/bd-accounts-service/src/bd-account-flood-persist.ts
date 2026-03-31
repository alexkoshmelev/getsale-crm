import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { EventType } from '@getsale/events';
import type { RabbitMQClient } from '@getsale/utils';
import { getErrorMessage, getRetryAfterSeconds } from './helpers';

let floodPublishRabbitmq: RabbitMQClient | null = null;

/** Wire RabbitMQ from service bootstrap so flood clear can notify campaign-service. */
export function setBdAccountFloodPublishRabbitmq(r: RabbitMQClient | null): void {
  floodPublishRabbitmq = r;
}

const REASON_MAX = 900;

function floodWaitCapSeconds(): number {
  const raw = process.env.TELEGRAM_FLOOD_WAIT_CAP_SECONDS;
  const n = raw != null && raw.trim() !== '' ? parseInt(raw, 10) : 600;
  if (!Number.isFinite(n) || n < 1) return 600;
  return Math.min(n, 86400);
}

/**
 * Record FLOOD_WAIT on bd_accounts for UI (invoke paths that pass pool into flood retry).
 * Uses flood_wait_until / flood_wait_seconds (canonical) plus flood_reason / flood_last_at.
 */
export async function recordBdAccountTelegramFlood(
  pool: Pool,
  accountId: string,
  op: string,
  err: unknown
): Promise<void> {
  const requestedSec = getRetryAfterSeconds(err);
  const capSec = floodWaitCapSeconds();
  const waitSec = Math.min(Math.max(requestedSec ?? 10, 1), capSec);
  const until = new Date(Date.now() + waitSec * 1000);
  const msg = getErrorMessage(err);
  const reason = `${op}: ${msg}`.slice(0, REASON_MAX);
  try {
    await pool.query(
      `UPDATE bd_accounts SET
        flood_wait_until = $1,
        flood_wait_seconds = $2,
        flood_reason = $3,
        flood_last_at = NOW(),
        updated_at = NOW()
       WHERE id = $4`,
      [until.toISOString(), requestedSec ?? waitSec, reason, accountId]
    );
  } catch {
    /* non-fatal */
  }
}

/** Clear flood markers after a successful GramJS invoke (same account). */
export async function clearBdAccountTelegramFlood(pool: Pool, accountId: string): Promise<void> {
  try {
    const result = await pool.query(
      `UPDATE bd_accounts SET
        flood_wait_until = NULL,
        flood_wait_seconds = NULL,
        flood_reason = NULL,
        updated_at = NOW()
       WHERE id = $1 AND (flood_wait_until IS NOT NULL OR flood_reason IS NOT NULL)
       RETURNING id, organization_id`,
      [accountId]
    );
    if (result.rows.length === 0) return;
    const orgId = (result.rows[0] as { organization_id: string }).organization_id;
    const rmq = floodPublishRabbitmq;
    if (rmq) {
      try {
        await rmq.publishEvent({
          id: randomUUID(),
          type: EventType.BD_ACCOUNT_FLOOD_CLEARED,
          timestamp: new Date(),
          organizationId: orgId,
          data: { bdAccountId: accountId },
        });
      } catch {
        /* non-fatal */
      }
    }
  } catch {
    /* non-fatal */
  }
}
