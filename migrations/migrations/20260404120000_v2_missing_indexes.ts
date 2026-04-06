import type { Knex } from 'knex';

/**
 * v2: Add missing indexes identified during scalability audit.
 * All created CONCURRENTLY to avoid locking production tables.
 */
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  // Campaign sends: lookup by participant and time
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_campaign_sends_participant
    ON campaign_sends (campaign_participant_id, sent_at DESC)
  `);

  // Contacts: org-scoped active contacts for list/search
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_contacts_org_active
    ON contacts (organization_id, created_at DESC)
    WHERE deleted_at IS NULL
  `);

  // Leads: responsible user for pipeline board
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_leads_responsible
    ON leads (responsible_id, stage_id)
    WHERE deleted_at IS NULL
  `);

  // Pipeline stages: ordering within pipeline
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_stages_pipeline_order
    ON stages (pipeline_id, order_index)
  `);

  // Conversations: org-scoped for inbox
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_conversations_org_updated
    ON conversations (organization_id, updated_at DESC)
  `);

  // BD accounts: org-scoped active accounts
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_bd_accounts_org_active
    ON bd_accounts (organization_id)
    WHERE is_active = true
  `);

  // Campaign participants: status lookup for campaign stats
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_cp_campaign_status
    ON campaign_participants (campaign_id, status)
  `);

  // Deals: pipeline stage for board view
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_deals_stage
    ON deals (stage_id, created_at DESC)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_campaign_sends_participant');
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_contacts_org_active');
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_leads_responsible');
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_stages_pipeline_order');
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_conversations_org_updated');
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_bd_accounts_org_active');
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_cp_campaign_status');
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS idx_deals_stage');
}
