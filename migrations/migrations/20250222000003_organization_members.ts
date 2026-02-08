import { Knex } from 'knex';

/**
 * Участники организаций (мульти-воркспейс).
 * Один пользователь может состоять в нескольких организациях.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('organization_members', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.uuid('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.string('role', 50).notNullable().defaultTo('bidi');
    table.timestamp('joined_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['user_id', 'organization_id']);
    table.index('user_id');
    table.index('organization_id');
  });
  // Заполняем из текущих users.organization_id
  await knex.raw(`
    INSERT INTO organization_members (user_id, organization_id, role)
    SELECT id, organization_id, role FROM users
    ON CONFLICT (user_id, organization_id) DO NOTHING
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('organization_members');
}
