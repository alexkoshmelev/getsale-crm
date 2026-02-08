import { Knex } from 'knex';

/**
 * Реакции на сообщения (лайк и т.д.).
 * reactions — JSONB, формат { "👍": 2, "❤️": 1 } (emoji -> количество).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('messages', (table) => {
    table.jsonb('reactions').nullable().defaultTo(knex.raw("'{}'"));
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('messages', (table) => {
    table.dropColumn('reactions');
  });
}
