import { Knex } from 'knex';

/**
 * PHASE 2.5 §11г — «Создать общий чат»: явное действие менеджера.
 * shared_chat_created_at проставляется через POST /api/messaging/mark-shared-chat.
 * Используется для метрик кампании (total_converted_to_shared_chat) и статуса в таблице лидов.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversations', (table) => {
    table.timestamp('shared_chat_created_at', { useTz: true }).nullable();
  });
  await knex.raw(
    'CREATE INDEX IF NOT EXISTS conversations_campaign_shared_idx ON conversations (campaign_id) WHERE shared_chat_created_at IS NOT NULL'
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS conversations_campaign_shared_idx');
  await knex.schema.alterTable('conversations', (table) => {
    table.dropColumn('shared_chat_created_at');
  });
}
