import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_accounts', (table) => {
    table.timestamp('spam_restricted_at', { useTz: true }).nullable();
    table.string('spam_restriction_source', 32).nullable();
    table.integer('peer_flood_count_1h').notNullable().defaultTo(0);
    table.timestamp('peer_flood_first_at', { useTz: true }).nullable();
    table.timestamp('last_spambot_check_at', { useTz: true }).nullable();
    table.text('last_spambot_result').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_accounts', (table) => {
    table.dropColumn('spam_restricted_at');
    table.dropColumn('spam_restriction_source');
    table.dropColumn('peer_flood_count_1h');
    table.dropColumn('peer_flood_first_at');
    table.dropColumn('last_spambot_check_at');
    table.dropColumn('last_spambot_result');
  });
}
