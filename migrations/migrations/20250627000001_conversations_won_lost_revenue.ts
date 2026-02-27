import { Knex } from 'knex';

/**
 * PHASE 2.7 — Won + Revenue. Финал воронки: Sent → Read → Replied → Shared → Won | Lost.
 * won_at / revenue_amount — закрытие сделки; lost_at / loss_reason — потеря. Оба исхода для аналитики.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversations', (table) => {
    table.timestamp('won_at', { useTz: true }).nullable();
    table.decimal('revenue_amount', 12, 2).nullable();
    table.timestamp('lost_at', { useTz: true }).nullable();
    table.text('loss_reason').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('conversations', (table) => {
    table.dropColumn('won_at');
    table.dropColumn('revenue_amount');
    table.dropColumn('lost_at');
    table.dropColumn('loss_reason');
  });
}
