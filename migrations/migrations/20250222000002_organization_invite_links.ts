import { Knex } from 'knex';

/**
 * Ссылки-приглашения в организацию (воркспейс).
 * organization_id, token, role, expires_at, created_by.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('organization_invite_links', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.string('token', 64).notNullable().unique();
    table.string('role', 50).notNullable().defaultTo('bidi');
    table.timestamp('expires_at').notNullable();
    table.uuid('created_by').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index('token');
    table.index('organization_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('organization_invite_links');
}
