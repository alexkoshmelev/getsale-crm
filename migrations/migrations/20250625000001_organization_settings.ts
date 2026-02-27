import { Knex } from 'knex';

/**
 * Organization-level key-value settings (e.g. shared_chat title template and extra usernames).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('organization_settings', (table) => {
    table.uuid('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.string('key', 128).notNullable();
    table.jsonb('value').notNullable().defaultTo('{}');
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.primary(['organization_id', 'key']);
  });
  await knex.schema.alterTable('organization_settings', (table) => {
    table.index('organization_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('organization_settings');
}
