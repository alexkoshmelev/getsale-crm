import { Knex } from 'knex';

/**
 * Добавляем folder_id в bd_account_sync_chats — из какой папки попал чат (для отображения по папкам).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_account_sync_chats', (table) => {
    table.integer('folder_id').nullable(); // Telegram folder id (0, 1, 2+)
    table.index(['bd_account_id', 'folder_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_account_sync_chats', (table) => {
    table.dropIndex(['bd_account_id', 'folder_id']);
    table.dropColumn('folder_id');
  });
}
