import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('campaign_sequences', (table) => {
    table.integer('delay_minutes').notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('campaign_sequences', (table) => {
    table.dropColumn('delay_minutes');
  });
}
