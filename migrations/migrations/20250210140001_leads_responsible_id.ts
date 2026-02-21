import { Knex } from 'knex';

/** Ответственный за лида (владелец в воронке). Опционально при создании лида из кампании. */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('leads', (table) => {
    table.uuid('responsible_id').nullable().references('id').inTable('users').onDelete('SET NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('leads', (table) => {
    table.dropColumn('responsible_id');
  });
}
