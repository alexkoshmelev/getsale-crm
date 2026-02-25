import { Knex } from 'knex';

/**
 * ЭТАП 3: связь Lead → Deal.
 * deals.lead_id (nullable FK → leads), partial unique index — один лид не более одной сделки.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('deals', (table) => {
    table.uuid('lead_id').nullable().references('id').inTable('leads').onDelete('SET NULL');
    table.index('lead_id');
  });
  await knex.raw(
    'CREATE UNIQUE INDEX deals_lead_id_unique ON deals (lead_id) WHERE lead_id IS NOT NULL'
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS deals_lead_id_unique');
  await knex.schema.alterTable('deals', (table) => {
    table.dropIndex('lead_id');
    table.dropColumn('lead_id');
  });
}
