import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_accounts', (table) => {
    table.string('connection_state', 32).notNullable().defaultTo('disconnected');
    table.text('disconnect_reason').nullable();
    table.string('last_error_code', 128).nullable();
    table.timestamp('last_error_at').nullable();
  });

  await knex.raw(`
    UPDATE bd_accounts
    SET connection_state = CASE WHEN is_active = true THEN 'connected' ELSE 'disconnected' END
    WHERE connection_state IS NULL OR connection_state = ''
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_accounts', (table) => {
    table.dropColumn('connection_state');
    table.dropColumn('disconnect_reason');
    table.dropColumn('last_error_code');
    table.dropColumn('last_error_at');
  });
}

