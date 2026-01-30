import { Knex } from 'knex';

/**
 * Контакт/лид: кастомное имя (задаёт пользователь) и username из Telegram.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('contacts', (table) => {
    table.string('display_name', 255).nullable(); // кастомное имя от пользователя (приоритет при отображении)
    table.string('username', 255).nullable();    // Telegram @username
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('contacts', (table) => {
    table.dropColumn('display_name');
    table.dropColumn('username');
  });
}
