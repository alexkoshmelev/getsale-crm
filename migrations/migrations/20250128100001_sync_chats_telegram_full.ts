import { Knex } from 'knex';

/**
 * Расширяем bd_account_sync_chats: храним полный снимок диалога из Telegram
 * (unread, last_message, photo, username и т.д.)
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_account_sync_chats', (table) => {
    table.integer('telegram_unread_count').defaultTo(0);
    table.timestamp('telegram_last_message_at', { useTz: true }).nullable();
    table.text('telegram_last_message_preview').nullable();
    // Полный снимок данных диалога из Telegram (username, photo, draft и т.д.)
    table.jsonb('telegram_dialog_payload').nullable();
    table.timestamp('last_synced_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_account_sync_chats', (table) => {
    table.dropColumn('telegram_unread_count');
    table.dropColumn('telegram_last_message_at');
    table.dropColumn('telegram_last_message_preview');
    table.dropColumn('telegram_dialog_payload');
    table.dropColumn('last_synced_at');
  });
}
