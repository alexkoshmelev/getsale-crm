import { Knex } from 'knex';

/**
 * PHASE 2.6 — Shared Chat Intelligence + Control Layer.
 * Сохраняем Telegram channel ID созданной супергруппы, чтобы открывать из CRM и анализировать.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversations', (table) => {
    table.bigInteger('shared_chat_channel_id').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversations', (table) => {
    table.dropColumn('shared_chat_channel_id');
  });
}
