import { Knex } from 'knex';

/**
 * ЭТАП 4: automation_executions — идемпотентность по (rule_id, entity_type, entity_id).
 * Добавляем колонки для lead→deal сценария; UNIQUE предотвращает повторную обработку при redelivery.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('automation_executions', (table) => {
    table.uuid('organization_id').nullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.string('entity_type', 20).nullable(); // 'lead'
    table.uuid('entity_id').nullable();
    table.uuid('deal_id').nullable();
    table.uuid('correlation_id').nullable();
    table.timestamp('created_at').nullable().defaultTo(knex.fn.now());
  });

  await knex.raw(
    `UPDATE automation_executions SET created_at = executed_at WHERE created_at IS NULL`
  );
  await knex.raw(
    `ALTER TABLE automation_executions ALTER COLUMN created_at SET NOT NULL`
  );

  // Уникальность: одна пара (rule_id, entity_type, entity_id) — один execution (для lead один раз на правило)
  await knex.raw(
    `CREATE UNIQUE INDEX automation_executions_rule_entity_unique
     ON automation_executions (rule_id, entity_type, entity_id)
     WHERE entity_type IS NOT NULL AND entity_id IS NOT NULL`
  );
  await knex.schema.alterTable('automation_executions', (table) => {
    table.index('organization_id');
    table.index('correlation_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS automation_executions_rule_entity_unique');
  await knex.schema.alterTable('automation_executions', (table) => {
    table.dropIndex('organization_id');
    table.dropIndex('correlation_id');
    table.dropColumn('organization_id');
    table.dropColumn('entity_type');
    table.dropColumn('entity_id');
    table.dropColumn('deal_id');
    table.dropColumn('correlation_id');
    table.dropColumn('created_at');
  });
}
