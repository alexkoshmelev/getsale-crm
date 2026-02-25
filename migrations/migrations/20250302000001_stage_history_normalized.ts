import { Knex } from 'knex';

/**
 * ЭТАП 2: stage_history — чистый старт.
 * Старые данные не сохраняем: DROP + CREATE в финальной форме.
 * entity_type NOT NULL, entity_id NOT NULL, source NOT NULL, индексы.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('stage_history');

  await knex.schema.createTable('stage_history', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.string('entity_type', 20).notNullable(); // 'lead' | 'deal'
    table.uuid('entity_id').notNullable();
    table.uuid('pipeline_id').notNullable().references('id').inTable('pipelines').onDelete('CASCADE');
    table.uuid('from_stage_id').references('id').inTable('stages').onDelete('SET NULL');
    table.uuid('to_stage_id').notNullable().references('id').inTable('stages').onDelete('CASCADE');
    table.uuid('changed_by').references('id').inTable('users').onDelete('SET NULL');
    table.text('reason');
    table.string('source', 20).notNullable(); // 'manual' | 'system' | 'automation'
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.index(['entity_type', 'entity_id']);
    table.index(['pipeline_id', 'created_at']);
    table.index('organization_id');
  });

  await knex.raw(
    "ALTER TABLE stage_history ADD CONSTRAINT stage_history_entity_type_check CHECK (entity_type IN ('lead', 'deal'))"
  );
  await knex.raw(
    "ALTER TABLE stage_history ADD CONSTRAINT stage_history_source_check CHECK (source IN ('manual', 'system', 'automation'))"
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('stage_history');

  // Восстановить старую схему (как в initial_schema) для отката
  await knex.schema.createTable('stage_history', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('client_id').notNullable();
    table.uuid('deal_id').references('id').inTable('deals');
    table.uuid('from_stage_id').references('id').inTable('stages');
    table.uuid('to_stage_id').notNullable().references('id').inTable('stages');
    table.uuid('moved_by').references('id').inTable('users');
    table.timestamp('moved_at').notNullable().defaultTo(knex.fn.now());
    table.boolean('auto_moved').notNullable().defaultTo(false);
    table.text('reason');
    table.index('client_id');
    table.index('deal_id');
  });
}
