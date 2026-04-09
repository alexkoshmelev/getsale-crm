import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('campaign_participants', (table) => {
    table.timestamp('replied_at', { useTz: true }).nullable();
    table.timestamp('failed_at', { useTz: true }).nullable();
    table.text('last_error').nullable();
  });

  await knex.schema.alterTable('campaign_sends', (table) => {
    table.timestamp('read_at', { useTz: true }).nullable();
  });

  await knex.schema.alterTable('bd_accounts', (table) => {
    table.integer('spam_check_retry_count').notNullable().defaultTo(0);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('campaign_participants', (table) => {
    table.dropColumn('replied_at');
    table.dropColumn('failed_at');
    table.dropColumn('last_error');
  });

  await knex.schema.alterTable('campaign_sends', (table) => {
    table.dropColumn('read_at');
  });

  await knex.schema.alterTable('bd_accounts', (table) => {
    table.dropColumn('spam_check_retry_count');
  });
}
