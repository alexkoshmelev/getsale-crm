import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('contact_discovery_tasks', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable();
    table.string('name').notNullable();
    table.string('type').notNullable(); // 'search' | 'parse'
    table.string('status').notNullable().defaultTo('pending'); // 'pending', 'running', 'paused', 'completed', 'failed', 'stopped'
    table.integer('progress').notNullable().defaultTo(0);
    table.integer('total').notNullable().defaultTo(0);
    table.jsonb('params').notNullable().defaultTo('{}');
    table.jsonb('results').notNullable().defaultTo('{}');
    table.timestamps(true, true);

    table.index('organization_id');
    table.index('status');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('contact_discovery_tasks');
}


