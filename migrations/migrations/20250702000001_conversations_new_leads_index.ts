import { Knex } from 'knex';

/**
 * Partial index for GET /api/messaging/new-leads (audit P2).
 * Query: WHERE organization_id = $1 AND lead_id IS NOT NULL AND first_manager_reply_at IS NULL ORDER BY became_lead_at DESC.
 * Speeds up the "new leads" folder when conversations table grows.
 */
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_new_leads
    ON conversations (organization_id, became_lead_at DESC NULLS LAST)
    WHERE lead_id IS NOT NULL AND first_manager_reply_at IS NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_conversations_new_leads');
}
