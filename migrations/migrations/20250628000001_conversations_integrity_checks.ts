import { Knex } from 'knex';

/**
 * PHASE 2.8 — Data Integrity Hardening.
 * Защита бизнес-инвариантов на уровне БД:
 * - нельзя одновременно won и lost;
 * - revenue_amount допустим только при won_at IS NOT NULL.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(
    `ALTER TABLE conversations ADD CONSTRAINT conversations_won_lost_exclusive
     CHECK (NOT (won_at IS NOT NULL AND lost_at IS NOT NULL))`
  );
  await knex.raw(
    `ALTER TABLE conversations ADD CONSTRAINT conversations_revenue_only_if_won
     CHECK (revenue_amount IS NULL OR won_at IS NOT NULL)`
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_revenue_only_if_won`);
  await knex.raw(`ALTER TABLE conversations DROP CONSTRAINT IF EXISTS conversations_won_lost_exclusive`);
}
