import { Knex } from 'knex';

/**
 * Store access_hash for channel/supergroup chats so we can build InputPeerChannel
 * without relying on session cache (fixes PEER_ID_INVALID when sending to newly created shared chat).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_account_sync_chats', (table) => {
    table.bigInteger('access_hash').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_account_sync_chats', (table) => {
    table.dropColumn('access_hash');
  });
}
