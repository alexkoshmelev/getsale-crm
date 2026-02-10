import { Knex } from 'knex';

/**
 * Реакции, поставленные нашим аккаунтом (bd_account) на сообщение.
 * Telegram допускает до 3 реакций на сообщение; при отправке в API передаётся полный список.
 * our_reactions — JSONB массив строк, например ["❤️", "👍"], макс. 3 элемента.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('messages', (table) => {
    table.jsonb('our_reactions').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('messages', (table) => {
    table.dropColumn('our_reactions');
  });
}
