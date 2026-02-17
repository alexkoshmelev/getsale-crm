import { Knex } from 'knex';

/**
 * Демо-аккаунты: только данные в БД, без подключения к Telegram.
 * Используются для показа продукта заказчикам (чат/сообщения видны, отправка отключена).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_accounts', (table) => {
    table.boolean('is_demo').notNullable().defaultTo(false);
    table.index('is_demo');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_accounts', (table) => {
    table.dropIndex('is_demo');
    table.dropColumn('is_demo');
  });
}
