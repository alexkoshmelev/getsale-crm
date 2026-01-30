import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_accounts', (table) => {
    table.uuid('created_by_user_id').nullable(); // владелец аккаунта (кто подключил); для workspace — только он может управлять
    table.index('created_by_user_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_accounts', (table) => {
    table.dropColumn('created_by_user_id');
  });
}
