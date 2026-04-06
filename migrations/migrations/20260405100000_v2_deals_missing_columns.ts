import { Knex } from 'knex';

/**
 * v2: Add missing columns for v2 backend parity.
 * deals: deleted_at (soft delete), description
 * companies: website
 */
export async function up(knex: Knex): Promise<void> {
  const hasDealsDeletedAt = await knex.schema.hasColumn('deals', 'deleted_at');
  if (!hasDealsDeletedAt) {
    await knex.schema.alterTable('deals', (table) => {
      table.timestamp('deleted_at').nullable();
    });
  }
  const hasDealsDescription = await knex.schema.hasColumn('deals', 'description');
  if (!hasDealsDescription) {
    await knex.schema.alterTable('deals', (table) => {
      table.text('description').nullable();
    });
  }
  const hasCompaniesWebsite = await knex.schema.hasColumn('companies', 'website');
  if (!hasCompaniesWebsite) {
    await knex.schema.alterTable('companies', (table) => {
      table.string('website', 500).nullable();
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('deals', (table) => {
    table.dropColumn('deleted_at');
    table.dropColumn('description');
  });
  await knex.schema.alterTable('companies', (table) => {
    table.dropColumn('website');
  });
}
