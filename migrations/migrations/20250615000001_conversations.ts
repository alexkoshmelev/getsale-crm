import { Knex } from 'knex';

/**
 * ЭТАП 7 — Conversation (Messaging domain).
 * Один бизнес-диалог = один контекст (чат + lead_id, campaign_id, became_lead_at).
 * Создаётся только при первом сообщении. Не дублирует Telegram chat — тонкий слой над channel_id.
 * last_viewed_at — для папки «Новые лиды» (is_new = became_lead_at > last_viewed_at или last_viewed_at IS NULL).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('conversations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.uuid('bd_account_id').references('id').inTable('bd_accounts').onDelete('SET NULL');
    table.string('channel', 50).notNullable();
    table.string('channel_id', 255).notNullable();
    table.uuid('contact_id').references('id').inTable('contacts').onDelete('SET NULL');
    table.uuid('lead_id').references('id').inTable('leads').onDelete('SET NULL');
    table.uuid('campaign_id').references('id').inTable('campaigns').onDelete('SET NULL');
    table.timestamp('became_lead_at', { useTz: true }).nullable();
    table.timestamp('last_viewed_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['organization_id', 'bd_account_id', 'channel', 'channel_id']);
    table.index('organization_id');
    table.index('bd_account_id');
    table.index('contact_id');
    table.index('lead_id');
    table.index('campaign_id');
    table.index('last_viewed_at');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('conversations');
}
