import { Knex } from 'knex';

/**
 * Иконка папки (emoji или ключ) для отображения в UI.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_account_sync_folders', (table) => {
    table.string('icon', 20).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_account_sync_folders', (table) => {
    table.dropColumn('icon');
  });
}
