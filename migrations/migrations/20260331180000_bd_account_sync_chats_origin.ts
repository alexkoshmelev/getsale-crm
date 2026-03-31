import type { Knex } from 'knex';

/**
 * Origin of a row in bd_account_sync_chats:
 * - sync_selection: from user sync UI (can be replaced on next full sync save)
 * - outbound_send: added when sending a DM/file; preserved when user re-saves sync list
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_account_sync_chats', (table) => {
    table.string('sync_list_origin', 32).notNullable().defaultTo('sync_selection');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_account_sync_chats', (table) => {
    table.dropColumn('sync_list_origin');
  });
}
