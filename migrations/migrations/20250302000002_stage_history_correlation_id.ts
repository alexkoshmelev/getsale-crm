import { Knex } from 'knex';

/**
 * ЭТАП 2 (подготовка к ЭТАПУ 4): correlation_id в stage_history.
 * Позволяет связать запись с запросом/событием: какая смена стадии породила сделку, какой consumer вызвал INSERT.
 * CRM может передавать X-Correlation-Id; consumer ЭТАПА 4 — event.id или trace-id.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('stage_history', (table) => {
    table.uuid('correlation_id').nullable();
    table.index('correlation_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('stage_history', (table) => {
    table.dropIndex('correlation_id');
    table.dropColumn('correlation_id');
  });
}
