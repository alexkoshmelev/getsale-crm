import { Knex } from 'knex';

/**
 * ЭТАП 4 (доработка):
 * 1) trigger_event_id — хранить event.id для разбора «какой event вызвал эту сделку».
 * 2) Упростить идемпотентность: entity_type/entity_id NOT NULL, обычный UNIQUE без partial.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('automation_executions', (table) => {
    table.uuid('trigger_event_id').nullable();
  });
  await knex.schema.alterTable('automation_executions', (table) => {
    table.index('trigger_event_id');
  });

  // Существующие строки без entity_*: помечаем как legacy (id уникален, пара rule_id+entity уникальна)
  await knex.raw(
    `UPDATE automation_executions 
     SET entity_type = 'legacy', entity_id = id 
     WHERE entity_type IS NULL OR entity_id IS NULL`
  );
  await knex.raw(`ALTER TABLE automation_executions ALTER COLUMN entity_type SET NOT NULL`);
  await knex.raw(`ALTER TABLE automation_executions ALTER COLUMN entity_id SET NOT NULL`);

  await knex.raw('DROP INDEX IF EXISTS automation_executions_rule_entity_unique');
  await knex.raw(
    `CREATE UNIQUE INDEX automation_executions_rule_entity_unique 
     ON automation_executions (rule_id, entity_type, entity_id)`
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS automation_executions_rule_entity_unique');
  await knex.raw(
    `CREATE UNIQUE INDEX automation_executions_rule_entity_unique 
     ON automation_executions (rule_id, entity_type, entity_id) 
     WHERE entity_type IS NOT NULL AND entity_id IS NOT NULL`
  );
  await knex.raw(`ALTER TABLE automation_executions ALTER COLUMN entity_type DROP NOT NULL`);
  await knex.raw(`ALTER TABLE automation_executions ALTER COLUMN entity_id DROP NOT NULL`);
  await knex.schema.alterTable('automation_executions', (table) => {
    table.dropIndex('trigger_event_id');
    table.dropColumn('trigger_event_id');
  });
}
