import { Counter } from 'prom-client';

/** Incremented when DELETE bd-account orphans messages via local SQL because messaging internal API failed. */
export const messagingOrphanFallbackTotal = new Counter({
  name: 'bd_accounts_messaging_orphan_fallback_total',
  help: 'Local orphan of messages after messaging POST /internal/messages/orphan-by-bd-account failed',
  registers: [],
});

/**
 * A3: direct SQL to messages/conversations because MessageDb has no messaging HTTP client (tests / misconfig).
 * Normal deploy: client always set in index.ts — counter should stay 0.
 */
export const messageDbSqlBypassTotal = new Counter({
  name: 'bd_accounts_message_db_sql_bypass_total',
  help: 'MessageDb wrote to messages/conversations via local SQL (no messagingService client)',
  labelNames: ['operation'],
  registers: [],
});
