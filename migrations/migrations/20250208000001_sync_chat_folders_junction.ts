import { Knex } from 'knex';

/**
 * Чат может быть в нескольких папках (как в Telegram).
 * Таблица связи: bd_account_sync_chat_folders (bd_account_id, telegram_chat_id, folder_id).
 * sync_chats.folder_id остаётся как «основная» папка для совместимости и сортировки.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('bd_account_sync_chat_folders', (table) => {
    table.uuid('bd_account_id').notNullable().references('id').inTable('bd_accounts').onDelete('CASCADE');
    table.string('telegram_chat_id', 64).notNullable();
    table.integer('folder_id').notNullable();
    table.primary(['bd_account_id', 'telegram_chat_id', 'folder_id']);
    table.index(['bd_account_id', 'folder_id']);
  });

  await knex.raw(`
    INSERT INTO bd_account_sync_chat_folders (bd_account_id, telegram_chat_id, folder_id)
    SELECT bd_account_id, telegram_chat_id, folder_id
    FROM bd_account_sync_chats
    WHERE folder_id IS NOT NULL
    ON CONFLICT (bd_account_id, telegram_chat_id, folder_id) DO NOTHING
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('bd_account_sync_chat_folders');
}
