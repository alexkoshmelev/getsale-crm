import { Knex } from 'knex';

/**
 * Инвайт-ссылка на общий чат (формат t.me/+XXX).
 * Сохраняется при создании группы через Telegram API (ExportChatInvite); по ней можно открыть чат.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversations', (table) => {
    table.text('shared_chat_invite_link').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversations', (table) => {
    table.dropColumn('shared_chat_invite_link');
  });
}
