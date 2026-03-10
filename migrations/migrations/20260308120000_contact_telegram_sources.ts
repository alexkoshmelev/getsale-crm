import { Knex } from 'knex';

/**
 * Contact Discovery: link contact to Telegram group/source (for filtering in campaigns and contact card).
 * Owner: crm-service (writes + contact card read). campaign-service reads for audience filters only.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('contact_telegram_sources', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.uuid('contact_id').notNullable().references('id').inTable('contacts').onDelete('CASCADE');
    table.uuid('bd_account_id').notNullable().references('id').inTable('bd_accounts').onDelete('CASCADE');
    table.string('telegram_chat_id', 64).notNullable();
    table.string('telegram_chat_title', 512);
    table.string('search_keyword', 256);
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    table.unique(['organization_id', 'contact_id', 'bd_account_id', 'telegram_chat_id']);
    table.index('organization_id');
    table.index(['organization_id', 'telegram_chat_id']);
    table.index(['organization_id', 'search_keyword']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('contact_telegram_sources');
}
