import { Knex } from 'knex';

/**
 * AI Workspace — Conversation Intelligence.
 * Хранение результатов AI-анализа/саммари/черновиков по диалогу.
 * type: analysis | summary | draft.
 * payload_json — структурированный результат (не полный промпт).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('conversation_ai_insights', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('conversation_id').notNullable().references('id').inTable('conversations').onDelete('CASCADE');
    table.uuid('account_id').nullable().references('id').inTable('bd_accounts').onDelete('SET NULL');
    table.string('type', 50).notNullable(); // 'analysis' | 'summary' | 'draft'
    table.jsonb('payload_json').notNullable(); // structured result, no raw prompt
    table.string('model_version', 100).nullable();
    table.uuid('generated_from_message_id').nullable().references('id').inTable('messages').onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index('conversation_id');
    table.index(['conversation_id', 'type']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('conversation_ai_insights');
}
