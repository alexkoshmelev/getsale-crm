import { Knex } from 'knex';

/**
 * Расширение полей сделки по аналогии с Bitrix24 (crm.deal.fields):
 * - probability: вероятность закрытия 0–100%
 * - expected_close_date: планируемая дата закрытия
 * - comments: комментарий к сделке
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('deals', (table) => {
    table.integer('probability').nullable(); // 0–100
    table.date('expected_close_date').nullable();
    table.text('comments').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('deals', (table) => {
    table.dropColumn('probability');
    table.dropColumn('expected_close_date');
    table.dropColumn('comments');
  });
}
