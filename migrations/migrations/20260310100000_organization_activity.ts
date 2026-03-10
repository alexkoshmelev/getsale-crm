import { Knex } from 'knex';

/**
 * Organization activity feed for dashboard "Recent activity".
 * Written only by activity-service (consumer of RabbitMQ events).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('organization_activity', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('action_type', 100).notNullable();
    table.string('entity_type', 50).nullable();
    table.string('entity_id', 255).nullable();
    table.jsonb('metadata').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['organization_id', 'created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('organization_activity');
}
