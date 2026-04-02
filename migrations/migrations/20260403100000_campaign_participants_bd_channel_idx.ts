import type { Knex } from 'knex';

/**
 * Partial index on campaign_participants(bd_account_id, channel_id) for the
 * mergeOutboundSendSyncRow UPDATE that was causing sequential scans and lock contention.
 */
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_campaign_participants_bd_channel
    ON campaign_participants (bd_account_id, channel_id)
    WHERE status IN ('pending', 'sent')
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_campaign_participants_bd_channel');
}
