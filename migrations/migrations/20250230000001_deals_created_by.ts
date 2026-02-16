import { Knex } from 'knex';

/**
 * Добавляем created_by_id в сделки — кто создал сделку (для фильтров и отображения на общей воронке).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('deals', (table) => {
    table.uuid('created_by_id').nullable().references('id').inTable('users').onDelete('SET NULL');
  });
  await knex('deals').whereNull('created_by_id').update('created_by_id', knex.raw('owner_id'));
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('deals', (table) => {
    table.dropColumn('created_by_id');
  });
}
