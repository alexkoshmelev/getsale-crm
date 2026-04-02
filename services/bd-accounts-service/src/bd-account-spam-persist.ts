import { randomUUID } from 'crypto';
import type { Pool } from 'pg';
import { EventType } from '@getsale/events';
import type { RabbitMQClient } from '@getsale/utils';

let spamPublishRabbitmq: RabbitMQClient | null = null;

export function setBdAccountSpamPublishRabbitmq(r: RabbitMQClient | null): void {
  spamPublishRabbitmq = r;
}

export type SpamRestrictionSource = 'spambot_check' | 'peer_flood_escalation' | 'manual';

const SPAM_SEND_BLOCK_HOURS = 24;

/**
 * Mark account as spam-restricted (SpamBot or PEER_FLOOD escalation).
 * Publishes BD_ACCOUNT_SPAM_RESTRICTED only on first transition to restricted.
 */
export async function recordBdAccountSpamRestriction(
  pool: Pool,
  accountId: string,
  source: SpamRestrictionSource
): Promise<{ organizationId: string; newlyRestricted: boolean }> {
  const sel = await pool.query(
    `SELECT organization_id, spam_restricted_at FROM bd_accounts WHERE id = $1`,
    [accountId]
  );
  const row = sel.rows[0] as { organization_id: string; spam_restricted_at: Date | null } | undefined;
  if (!row) {
    return { organizationId: '', newlyRestricted: false };
  }
  const wasRestricted = row.spam_restricted_at != null;
  const blockUntil = new Date(Date.now() + SPAM_SEND_BLOCK_HOURS * 3600 * 1000);

  await pool.query(
    `UPDATE bd_accounts SET
       spam_restricted_at = COALESCE(spam_restricted_at, NOW()),
       spam_restriction_source = COALESCE(spam_restriction_source, $2::varchar),
       send_blocked_until = GREATEST(COALESCE(send_blocked_until, to_timestamp(0)), $3::timestamptz),
       updated_at = NOW()
     WHERE id = $1`,
    [accountId, source, blockUntil.toISOString()]
  );

  try {
    await pool.query(
      `INSERT INTO bd_account_status (account_id, status, message)
       VALUES ($1, $2, $3)`,
      [
        accountId,
        'error',
        `Spam restriction (${source}). Campaign sends blocked until cleared or cooldown.`,
      ]
    );
  } catch {
    /* non-fatal */
  }

  const newlyRestricted = !wasRestricted;
  if (newlyRestricted) {
    const rmq = spamPublishRabbitmq;
    if (rmq) {
      try {
        await rmq.publishEvent({
          id: randomUUID(),
          type: EventType.BD_ACCOUNT_SPAM_RESTRICTED,
          timestamp: new Date(),
          organizationId: row.organization_id,
          data: { bdAccountId: accountId, source },
        } as any);
      } catch {
        /* non-fatal */
      }
    }
  }

  return { organizationId: row.organization_id, newlyRestricted };
}

/**
 * Clear spam restriction (manual user action after fixing account in Telegram).
 */
export async function clearBdAccountSpamRestriction(pool: Pool, accountId: string): Promise<void> {
  const sel = await pool.query(
    `SELECT organization_id, spam_restricted_at FROM bd_accounts WHERE id = $1`,
    [accountId]
  );
  const row = sel.rows[0] as { organization_id: string; spam_restricted_at: Date | null } | undefined;
  if (!row?.spam_restricted_at) return;

  await pool.query(
    `UPDATE bd_accounts SET
       spam_restricted_at = NULL,
       spam_restriction_source = NULL,
       peer_flood_count_1h = 0,
       peer_flood_first_at = NULL,
       send_blocked_until = NULL,
       flood_wait_until = NULL,
       flood_wait_seconds = NULL,
       flood_reason = NULL,
       updated_at = NOW()
     WHERE id = $1`,
    [accountId]
  );

  const rmq = spamPublishRabbitmq;
  if (rmq) {
    try {
      await rmq.publishEvent({
        id: randomUUID(),
        type: EventType.BD_ACCOUNT_SPAM_CLEARED,
        timestamp: new Date(),
        organizationId: row.organization_id,
        data: { bdAccountId: accountId },
      } as any);
    } catch {
      /* non-fatal */
    }
  }
}

/**
 * Increment rolling 1h PEER_FLOOD counter; escalate to spam restriction at 3+.
 */
export async function incrementPeerFloodAndMaybeEscalate(pool: Pool, accountId: string): Promise<void> {
  const upd = await pool.query(
    `UPDATE bd_accounts SET
       peer_flood_first_at = CASE
         WHEN peer_flood_first_at IS NULL OR peer_flood_first_at < NOW() - INTERVAL '1 hour' THEN NOW()
         ELSE peer_flood_first_at
       END,
       peer_flood_count_1h = CASE
         WHEN peer_flood_first_at IS NULL OR peer_flood_first_at < NOW() - INTERVAL '1 hour' THEN 1
         ELSE peer_flood_count_1h + 1
       END,
       updated_at = NOW()
     WHERE id = $1
     RETURNING peer_flood_count_1h, spam_restricted_at`,
    [accountId]
  );
  const out = upd.rows[0] as { peer_flood_count_1h: number; spam_restricted_at: Date | null } | undefined;
  if (!out || out.spam_restricted_at != null) return;
  if (Number(out.peer_flood_count_1h) >= 3) {
    await recordBdAccountSpamRestriction(pool, accountId, 'peer_flood_escalation');
  }
}
