import { Knex } from 'knex';

/**
 * Добавляет trigger_type в campaign_sequences: когда выполнять следующий шаг —
 * по задержке (delay) или сразу после ответа контакта (after_reply).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('campaign_sequences', (table) => {
    table.string('trigger_type', 20).notNullable().defaultTo('delay'); // delay | after_reply
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('campaign_sequences', (table) => {
    table.dropColumn('trigger_type');
  });
}
