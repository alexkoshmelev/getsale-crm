import { Knex } from 'knex';

/**
 * Аудит критических действий в организации.
 * organization_id, user_id, action, resource_type, resource_id, old_value, new_value, ip, created_at.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('audit_logs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('action', 100).notNullable();
    table.string('resource_type', 50).nullable();
    table.string('resource_id', 255).nullable();
    table.jsonb('old_value').nullable();
    table.jsonb('new_value').nullable();
    table.string('ip', 45).nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index('organization_id');
    table.index(['organization_id', 'created_at']);
    table.index('action');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('audit_logs');
}
