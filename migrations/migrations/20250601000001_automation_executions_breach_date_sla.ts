import { Knex } from 'knex';

/**
 * ЭТАП 6 — SLA Automation (Design Lock).
 * breach_date DATE NULL: логический день нарушения в org TZ; для не-SLA правил NULL.
 * Partial unique: SLA — (rule_id, entity_type, entity_id, breach_date) WHERE breach_date IS NOT NULL.
 * Non-SLA: один unique на (rule_id, entity_type, entity_id) при breach_date IS NULL — пересоздаём индекс как partial.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('automation_executions', (table) => {
    table.date('breach_date').nullable();
  });

  await knex.raw('DROP INDEX IF EXISTS automation_executions_rule_entity_unique');
  await knex.raw(
    `CREATE UNIQUE INDEX automation_executions_rule_entity_unique
     ON automation_executions (rule_id, entity_type, entity_id)
     WHERE breach_date IS NULL`
  );
  await knex.raw(
    `CREATE UNIQUE INDEX automation_sla_unique
     ON automation_executions (rule_id, entity_type, entity_id, breach_date)
     WHERE breach_date IS NOT NULL`
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS automation_sla_unique');
  await knex.raw('DROP INDEX IF EXISTS automation_executions_rule_entity_unique');
  await knex.raw(
    `CREATE UNIQUE INDEX automation_executions_rule_entity_unique
     ON automation_executions (rule_id, entity_type, entity_id)`
  );
  await knex.schema.alterTable('automation_executions', (table) => {
    table.dropColumn('breach_date');
  });
}
