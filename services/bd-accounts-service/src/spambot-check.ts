import type { Pool } from 'pg';
import type { Logger } from '@getsale/logger';
import type { TelegramManager } from './telegram';
import { getErrorMessage } from './helpers';
import { recordBdAccountSpamRestriction, clearBdAccountSpamRestriction } from './bd-account-spam-persist';

export type SpamBotClassification = 'restricted' | 'clear' | 'unknown';

/** Heuristic classification of @SpamBot replies (EN/RU common phrases). */
export function classifySpamBotReply(text: string): SpamBotClassification {
  const t = (text || '').toLowerCase();
  if (
    /good news|free as a bird|no limits are currently applied|not limited|everything looks fine|all good|no restrictions/i.test(
      t
    ) ||
    /не ограничен|нет ограничений|всё в порядке|все в порядке|ограничения не примен/i.test(t)
  ) {
    return 'clear';
  }
  if (
    /limited|restriction|cannot write|can't send|can not send|spam activity|report spam|too many|complaint|mute|banned/i.test(
      t
    ) ||
    /ограничен|ограничения|жалоб|спам|блок|не можете писать|не можешь писать|нарушен/i.test(t)
  ) {
    return 'restricted';
  }
  return 'unknown';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface SpamBotCheckResult {
  restricted: boolean;
  classification: SpamBotClassification;
  summary: string;
  rawSnippet: string;
}

/**
 * Sends /start to @SpamBot, reads the latest reply, updates bd_accounts and restriction state.
 */
export async function performSpamBotCheck(
  pool: Pool,
  telegramManager: TelegramManager,
  accountId: string,
  _organizationId: string
): Promise<SpamBotCheckResult> {
  const nowIso = new Date().toISOString();
  let rawSnippet = '';
  let classification: SpamBotClassification = 'unknown';

  try {
    if (!telegramManager.isConnected(accountId)) {
      const msg = 'BD account is not connected';
      await pool.query(
        `UPDATE bd_accounts SET last_spambot_check_at = $2::timestamptz, last_spambot_result = $3, updated_at = NOW() WHERE id = $1`,
        [accountId, nowIso, msg]
      );
      return { restricted: false, classification: 'unknown', summary: msg, rawSnippet: '' };
    }

    await telegramManager.sendMessage(accountId, 'SpamBot', '/start');
    await sleep(4500);

    const messages = await telegramManager.getLastMessagesFromPeer(accountId, 'SpamBot', 5);
    const fromBot = messages.filter((m) => !(m as { out?: boolean }).out);
    const latest = fromBot.length > 0 ? fromBot[fromBot.length - 1] : messages[messages.length - 1];
    const text =
      typeof (latest as unknown as { message?: string })?.message === 'string'
        ? (latest as unknown as { message: string }).message
        : '';
    rawSnippet = text.slice(0, 2000);
    classification = classifySpamBotReply(text);

    const accRow = await pool.query(`SELECT spam_restricted_at FROM bd_accounts WHERE id = $1`, [accountId]);
    const wasRestricted = (accRow.rows[0] as { spam_restricted_at?: Date | null } | undefined)?.spam_restricted_at != null;

    if (classification === 'restricted') {
      await recordBdAccountSpamRestriction(pool, accountId, 'spambot_check');
      const summary = 'SpamBot indicates messaging restrictions may apply.';
      await pool.query(
        `UPDATE bd_accounts SET last_spambot_check_at = $2::timestamptz, last_spambot_result = $3, updated_at = NOW() WHERE id = $1`,
        [accountId, nowIso, summary]
      );
      return { restricted: true, classification, summary, rawSnippet };
    }

    if (classification === 'clear' && wasRestricted) {
      await clearBdAccountSpamRestriction(pool, accountId);
      const summary = 'SpamBot reports no limits; restriction cleared.';
      await pool.query(
        `UPDATE bd_accounts SET last_spambot_check_at = $2::timestamptz, last_spambot_result = $3, updated_at = NOW() WHERE id = $1`,
        [accountId, nowIso, summary]
      );
      return { restricted: false, classification, summary, rawSnippet };
    }

    const summary =
      classification === 'clear'
        ? 'SpamBot reports no limits.'
        : 'Could not confidently classify SpamBot reply; check the chat in Telegram.';
    await pool.query(
      `UPDATE bd_accounts SET last_spambot_check_at = $2::timestamptz, last_spambot_result = $3, updated_at = NOW() WHERE id = $1`,
      [accountId, nowIso, summary]
    );
    return { restricted: wasRestricted, classification, summary, rawSnippet };
  } catch (err: unknown) {
    const msg = getErrorMessage(err).slice(0, 500);
    await pool.query(
      `UPDATE bd_accounts SET last_spambot_check_at = $2::timestamptz, last_spambot_result = $3, updated_at = NOW() WHERE id = $1`,
      [accountId, nowIso, `check failed: ${msg}`]
    );
    throw err;
  }
}

export async function runSpamBotCheckAllStale(
  pool: Pool,
  telegramManager: TelegramManager,
  log: Logger,
  opts: { intervalHours: number; gapMs: number; organizationId?: string }
): Promise<void> {
  const hours = Math.max(1, opts.intervalHours);
  const orgId = opts.organizationId?.trim();
  const params: unknown[] = [hours];
  let orgClause = '';
  if (orgId) {
    params.push(orgId);
    orgClause = ` AND organization_id = $${params.length}`;
  }
  const res = await pool.query(
    `SELECT id, organization_id FROM bd_accounts
     WHERE is_active = true
       AND connection_state = 'connected'
       AND COALESCE(is_demo, false) = false
       AND (last_spambot_check_at IS NULL OR last_spambot_check_at < NOW() - ($1::int * INTERVAL '1 hour'))
       ${orgClause}
     ORDER BY last_spambot_check_at NULLS FIRST
     LIMIT 30`,
    params
  );
  const rows = res.rows as { id: string; organization_id: string }[];
  for (const row of rows) {
    if (!telegramManager.isConnected(row.id)) continue;
    try {
      await performSpamBotCheck(pool, telegramManager, row.id, row.organization_id);
    } catch (e: unknown) {
      log.warn({ message: 'spambot-check-all: account check failed', accountId: row.id, error: getErrorMessage(e) });
    }
    await sleep(opts.gapMs + Math.floor(Math.random() * 2000));
  }
}
