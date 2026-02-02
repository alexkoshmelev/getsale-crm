import { Knex } from 'knex';

/**
 * Связь сделки с чатом: сделка может быть создана из чата (чат + сумма).
 * bd_account_id + channel + channel_id однозначно идентифицируют чат.
 * company_id делаем nullable — минимальная сделка «из чата»: чат + сумма.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('deals', (table) => {
    table.uuid('bd_account_id').nullable().references('id').inTable('bd_accounts').onDelete('SET NULL');
    table.string('channel', 50).nullable(); // e.g. telegram
    table.string('channel_id', 255).nullable(); // peer id in messenger
    table.index(['bd_account_id', 'channel', 'channel_id']);
  });
  await knex.schema.alterTable('deals', (table) => {
    table.uuid('company_id').nullable().alter();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('deals', (table) => {
    table.uuid('company_id').notNullable().alter();
  });
  await knex.schema.alterTable('deals', (table) => {
    table.dropIndex(['bd_account_id', 'channel', 'channel_id']);
    table.dropColumn('bd_account_id');
    table.dropColumn('channel');
    table.dropColumn('channel_id');
  });
}
