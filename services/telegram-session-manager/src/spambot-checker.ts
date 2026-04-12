import { randomUUID } from 'crypto';
import { EventType, type Event } from '@getsale/events';
import { Logger } from '@getsale/logger';
import { RabbitMQClient } from '@getsale/queue';
import { Pool } from 'pg';
import { Api, TelegramClient } from 'telegram';
import { AccountRateLimiter } from './rate-limiter';

export type SpamBotClassification = 'free' | 'restricted' | 'unknown';
export type SpamBotCheckResult = SpamBotClassification | 'error';

export function classifySpamBotReplyKeyword(text: string): SpamBotClassification {
  const t = text.toLowerCase();
  if (
    t.includes('ваш аккаунт свободен') ||
    t.includes('no limits') ||
    t.includes('good news') ||
    t.includes('your account is free') ||
    t.includes('нет ограничений') ||
    t.includes('not limited') ||
    t.includes('is not limited')
  ) {
    return 'free';
  }
  if (
    t.includes('ограничен') ||
    t.includes('limited') ||
    t.includes('restrict') ||
    t.includes('spam') ||
    t.includes('ваш аккаунт ограничен') ||
    t.includes('your account is limited') ||
    t.includes('limits are applied')
  ) {
    return 'restricted';
  }
  return 'unknown';
}

export async function classifySpamBotReply(deps: {
  log: Logger;
  accountId: string;
  text: string;
}): Promise<SpamBotClassification> {
  const keywordResult = classifySpamBotReplyKeyword(deps.text);
  if (keywordResult !== 'unknown') return keywordResult;

  const aiServiceUrl = process.env.AI_SERVICE_URL || 'http://ai-service:4010';
  try {
    const resp = await fetch(`${aiServiceUrl}/api/classify-spambot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: deps.text }),
      signal: AbortSignal.timeout(5000),
    });
    if (resp.ok) {
      const body = await resp.json() as { classification?: string };
      if (body.classification === 'free' || body.classification === 'restricted') {
        return body.classification;
      }
    }
  } catch {
    deps.log.warn({ message: 'AI spambot classification failed, using keyword fallback', accountId: deps.accountId });
  }
  return keywordResult;
}

export async function doSpambotCheck(deps: {
  client: TelegramClient | null;
  pool: Pool;
  log: Logger;
  accountId: string;
  rateLimiter: AccountRateLimiter;
}): Promise<SpamBotCheckResult> {
  if (!deps.client?.connected) return 'error';

  if (deps.rateLimiter.getFloodWaitRemaining() > 0) {
    deps.log.warn({ message: 'SpamBot check skipped: FloodWait active', accountId: deps.accountId });
    return 'error';
  }

  const SPAMBOT = 'SpamBot';

  try {
    const entity = await deps.client.getInputEntity(SPAMBOT);
    await deps.client.sendMessage(entity, { message: '/start' });

    await new Promise((r) => setTimeout(r, 3000));

    const history = await deps.client.invoke(new Api.messages.GetHistory({
      peer: entity,
      offsetId: 0,
      offsetDate: 0,
      addOffset: 0,
      limit: 3,
      maxId: 0,
      minId: 0,
      hash: BigInt(0) as unknown as Api.long,
    })) as any;

    const msgs = history?.messages ?? [];
    const botReply = msgs.find((m: any) => !m.out && m.message)?.message ?? '';
    const classification = await classifySpamBotReply({ log: deps.log, accountId: deps.accountId, text: botReply });

    await deps.pool.query(
      `UPDATE bd_accounts SET last_spambot_check_at = NOW(), last_spambot_result = $1 WHERE id = $2`,
      [classification, deps.accountId],
    );

    if (classification === 'restricted') {
      await deps.pool.query(
        `UPDATE bd_accounts SET spam_restricted_at = COALESCE(spam_restricted_at, NOW()), spam_restriction_source = 'spambot_check' WHERE id = $1`,
        [deps.accountId],
      );
    }

    deps.log.info({ message: `SpamBot check completed`, accountId: deps.accountId, result: classification, rawReply: botReply.slice(0, 200) });
    return classification;
  } catch (err) {
    deps.log.warn({ message: 'SpamBot check failed', accountId: deps.accountId, error: String(err) });
    return 'error';
  }
}

export async function handleSpambotCheckWithBackoff(deps: {
  pool: Pool;
  log: Logger;
  accountId: string;
  organizationId: string;
  rabbitmq: RabbitMQClient;
  doSpambotCheck: () => Promise<SpamBotCheckResult>;
  spambotCheckInFlight: { current: boolean };
}): Promise<void> {
  if (deps.spambotCheckInFlight.current) return;
  deps.spambotCheckInFlight.current = true;
  try {
    const result = await deps.doSpambotCheck();
    if (result === 'restricted') {
      const retryRow = await deps.pool.query(
        'SELECT spam_check_retry_count FROM bd_accounts WHERE id = $1',
        [deps.accountId],
      );
      const retryCount = retryRow.rows[0]?.spam_check_retry_count ?? 0;
      const BACKOFF_SCHEDULE = [10 * 60, 30 * 60, 60 * 60, 2 * 60 * 60];
      const backoffSeconds = BACKOFF_SCHEDULE[Math.min(retryCount, BACKOFF_SCHEDULE.length - 1)]!;
      const blockedUntil = new Date(Date.now() + backoffSeconds * 1000);

      await deps.pool.query(
        `UPDATE bd_accounts
         SET send_blocked_until = $1,
             spam_check_retry_count = spam_check_retry_count + 1,
             spam_restricted_at = COALESCE(spam_restricted_at, NOW()),
             spam_restriction_source = 'auto_peer_flood'
         WHERE id = $2`,
        [blockedUntil, deps.accountId],
      );

      deps.log.info({
        message: `Account spam-blocked with backoff`,
        accountId: deps.accountId,
        backoffSeconds,
        retryCount: retryCount + 1,
        blockedUntil: blockedUntil.toISOString(),
      });

      deps.rabbitmq.publishEvent({
        id: randomUUID(),
        type: EventType.BD_ACCOUNT_SPAM_RESTRICTED,
        timestamp: new Date(),
        organizationId: deps.organizationId,
        userId: '',
        data: { bdAccountId: deps.accountId, source: 'peer_flood_escalation' },
      } as unknown as Event).catch(() => {});
    } else if (result === 'free') {
      const cooldown = new Date(Date.now() + 5 * 60 * 1000);
      await deps.pool.query(
        `UPDATE bd_accounts
         SET spam_restricted_at = NULL,
             spam_check_retry_count = 0,
             spam_restriction_source = NULL,
             send_blocked_until = GREATEST(send_blocked_until, $1)
         WHERE id = $2`,
        [cooldown, deps.accountId],
      );

      deps.rabbitmq.publishEvent({
        id: randomUUID(),
        type: EventType.BD_ACCOUNT_SPAM_CLEARED,
        timestamp: new Date(),
        organizationId: deps.organizationId,
        userId: '',
        data: { bdAccountId: deps.accountId },
      } as unknown as Event).catch(() => {});
    } else if (result === 'unknown') {
      const blockedUntil = new Date(Date.now() + 30 * 60 * 1000);
      await deps.pool.query(
        `UPDATE bd_accounts SET send_blocked_until = GREATEST(send_blocked_until, $1) WHERE id = $2`,
        [blockedUntil, deps.accountId],
      );
      deps.log.info({ message: 'SpamBot reply unrecognized, conservative 30min block', accountId: deps.accountId });
    } else if (result === 'error') {
      const blockedUntil = new Date(Date.now() + 10 * 60 * 1000);
      await deps.pool.query(
        `UPDATE bd_accounts SET send_blocked_until = $1 WHERE id = $2 AND (send_blocked_until IS NULL OR send_blocked_until < $1)`,
        [blockedUntil, deps.accountId],
      );
      deps.log.info({ message: `SpamBot check error, blocking for 10min`, accountId: deps.accountId });
    }
  } finally {
    deps.spambotCheckInFlight.current = false;
  }
}
