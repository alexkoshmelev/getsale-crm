import { Knex } from 'knex';

/**
 * PHASE 2.3 — папка «Новые лиды» (§11в).
 * «Новый лид» = lead_id != null AND first_manager_reply_at IS NULL.
 * Проставляется при первом исходящем сообщении менеджера в conversation.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversations', (table) => {
    table.timestamp('first_manager_reply_at', { useTz: true }).nullable();
  });
  await knex.raw('CREATE INDEX IF NOT EXISTS conversations_first_manager_reply_at_idx ON conversations (organization_id) WHERE first_manager_reply_at IS NULL');
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS conversations_first_manager_reply_at_idx');
  await knex.schema.alterTable('conversations', (table) => {
    table.dropColumn('first_manager_reply_at');
  });
}
