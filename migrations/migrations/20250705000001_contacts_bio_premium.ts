import { Knex } from 'knex';

/**
 * Контакт: био и премиум из Telegram (getFullUser).
 * phone уже есть в initial_schema.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('contacts', (table) => {
    table.text('bio').nullable();
    table.boolean('premium').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('contacts', (table) => {
    table.dropColumn('bio');
    table.dropColumn('premium');
  });
}
