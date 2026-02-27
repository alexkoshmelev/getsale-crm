import { Knex } from 'knex';

/**
 * ЭТАП 7 — Lead Activity Log (CRM domain).
 * Таймлайн карточки лида: lead_created, stage_changed, deal_created, campaign_reply_received (и при необходимости sla_breach).
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('lead_activity_log', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('lead_id').notNullable().references('id').inTable('leads').onDelete('CASCADE');
    table.string('type', 50).notNullable();
    table.jsonb('metadata').defaultTo('{}');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.uuid('correlation_id').nullable();

    table.index('lead_id');
    table.index(['lead_id', 'created_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('lead_activity_log');
}
