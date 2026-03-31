import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_accounts', (table) => {
    table.timestamp('flood_wait_until', { useTz: true }).nullable();
    table.integer('flood_wait_seconds').nullable();

    table.string('timezone', 64).nullable();
    table.string('working_hours_start', 5).nullable();
    table.string('working_hours_end', 5).nullable();
    table.specificType('working_days', 'integer[]').nullable();

    table.boolean('auto_responder_enabled').notNullable().defaultTo(false);
    table.text('auto_responder_system_prompt').nullable();
    table.integer('auto_responder_history_count').notNullable().defaultTo(25);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_accounts', (table) => {
    table.dropColumn('flood_wait_until');
    table.dropColumn('flood_wait_seconds');
    table.dropColumn('timezone');
    table.dropColumn('working_hours_start');
    table.dropColumn('working_hours_end');
    table.dropColumn('working_days');
    table.dropColumn('auto_responder_enabled');
    table.dropColumn('auto_responder_system_prompt');
    table.dropColumn('auto_responder_history_count');
  });
}
