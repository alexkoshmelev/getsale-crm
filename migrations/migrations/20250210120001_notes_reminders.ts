import { Knex } from 'knex';

/**
 * Заметки и напоминания к контакту/сделке.
 * entity_type: 'contact' | 'deal', entity_id: uuid контакта или сделки.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('notes', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.string('entity_type', 20).notNullable(); // 'contact' | 'deal'
    table.uuid('entity_id').notNullable();
    table.text('content').notNullable();
    table.uuid('user_id').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.index(['organization_id', 'entity_type', 'entity_id']);
  });

  await knex.schema.createTable('reminders', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.string('entity_type', 20).notNullable(); // 'contact' | 'deal'
    table.uuid('entity_id').notNullable();
    table.timestamp('remind_at').notNullable();
    table.string('title', 500);
    table.boolean('done').notNullable().defaultTo(false);
    table.uuid('user_id').references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.index(['organization_id', 'entity_type', 'entity_id']);
    table.index(['organization_id', 'remind_at', 'done']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('reminders');
  await knex.schema.dropTableIfExists('notes');
}
