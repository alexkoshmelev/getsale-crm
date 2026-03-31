import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('campaign_sequences', (table) => {
    table.boolean('is_hidden').notNullable().defaultTo(false);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('campaign_sequences', (table) => {
    table.dropColumn('is_hidden');
  });
}
