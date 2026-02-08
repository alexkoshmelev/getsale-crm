import { Knex } from 'knex';

/**
 * Добавляем is_user_created в bd_account_sync_folders:
 * false — папка из синхронизации с Telegram (getDialogFilters);
 * true — создана пользователем в CRM.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_account_sync_folders', (table) => {
    table.boolean('is_user_created').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_account_sync_folders', (table) => {
    table.dropColumn('is_user_created');
  });
}
