import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Chats/folders selected for sync per BD account (filter: only these are synced and shown)
  await knex.schema.createTable('bd_account_sync_chats', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('bd_account_id').notNullable().references('id').inTable('bd_accounts').onDelete('CASCADE');
    table.string('telegram_chat_id', 255).notNullable(); // peer id as string (user id, chat id, -100xxx for channels)
    table.string('title', 500); // display name from Telegram
    table.string('peer_type', 50).notNullable(); // user, chat, channel
    table.boolean('is_folder').notNullable().defaultTo(false); // if true, we sync all chats inside (future)
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['bd_account_id', 'telegram_chat_id']);
    table.index('bd_account_id');
  });

  // Sync status and progress for initial history sync
  await knex.schema.alterTable('bd_accounts', (table) => {
    table.string('sync_status', 50).defaultTo('idle'); // idle | syncing | completed | error
    table.text('sync_error');
    table.integer('sync_progress_total').defaultTo(0); // total chats to sync
    table.integer('sync_progress_done').defaultTo(0); // chats synced
    table.timestamp('sync_started_at');
    table.timestamp('sync_completed_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('bd_accounts', (table) => {
    table.dropColumn('sync_status');
    table.dropColumn('sync_error');
    table.dropColumn('sync_progress_total');
    table.dropColumn('sync_progress_done');
    table.dropColumn('sync_started_at');
    table.dropColumn('sync_completed_at');
  });
  await knex.schema.dropTableIfExists('bd_account_sync_chats');
}
