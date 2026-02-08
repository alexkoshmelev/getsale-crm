import { Knex } from 'knex';

/**
 * Закреплённые чаты пользователя (как в Telegram).
 * Один пользователь может закрепить чаты по каждому BD-аккаунту; порядок задаётся order_index.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('user_chat_pins', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.uuid('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.uuid('bd_account_id').notNullable().references('id').inTable('bd_accounts').onDelete('CASCADE');
    table.string('channel_id', 255).notNullable(); // telegram_chat_id
    table.integer('order_index').notNullable().defaultTo(0);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['user_id', 'organization_id', 'bd_account_id', 'channel_id']);
    table.index(['user_id', 'organization_id', 'bd_account_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('user_chat_pins');
}
