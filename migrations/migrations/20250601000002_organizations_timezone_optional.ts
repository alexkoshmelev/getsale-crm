import { Knex } from 'knex';

/**
 * ЭТАП 6 (опционально): часовой пояс организации для SLA.
 * breach_date считается в org timezone; при отсутствии — UTC.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('organizations', (table) => {
    table.string('timezone', 50).defaultTo('UTC');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('organizations', (table) => {
    table.dropColumn('timezone');
  });
}
