import { Knex } from 'knex';

/**
 * Лиды = контакты в воронке. Один контакт в одной воронке может быть только в одной стадии.
 * При добавлении контакта в воронку создаётся запись в leads; при перетаскивании карточки обновляется stage_id.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('leads', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations');
    table.uuid('contact_id').notNullable().references('id').inTable('contacts').onDelete('CASCADE');
    table.uuid('pipeline_id').notNullable().references('id').inTable('pipelines').onDelete('CASCADE');
    table.uuid('stage_id').notNullable().references('id').inTable('stages').onDelete('CASCADE');
    table.integer('order_index').notNullable().defaultTo(0);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['organization_id', 'contact_id', 'pipeline_id']);
    table.index('organization_id');
    table.index('pipeline_id');
    table.index('stage_id');
    table.index('contact_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('leads');
}
