import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_account_sync_chats', (table) => {
    table.boolean('history_exhausted').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_account_sync_chats', (table) => {
    table.dropColumn('history_exhausted');
  });
}
