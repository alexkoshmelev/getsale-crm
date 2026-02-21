import { Knex } from 'knex';

/**
 * Campaign Service: кампании холодного аутрича.
 * campaigns, campaign_templates, campaign_sequences, campaign_participants, campaign_sends.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('campaigns', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.uuid('company_id').references('id').inTable('companies');
    table.uuid('pipeline_id').references('id').inTable('pipelines');
    table.string('name', 255).notNullable();
    table.string('status', 50).notNullable().defaultTo('draft'); // draft | active | paused | completed
    table.jsonb('target_audience').defaultTo('{}'); // { filters: {}, limit?: number }
    table.jsonb('schedule').defaultTo(null); // { timezone, workingHours: { start, end }, daysOfWeek }
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.index('organization_id');
    table.index('status');
  });

  await knex.schema.createTable('campaign_templates', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('organization_id').notNullable().references('id').inTable('organizations').onDelete('CASCADE');
    table.uuid('campaign_id').references('id').inTable('campaigns').onDelete('CASCADE'); // null = глобальный шаблон организации
    table.string('name', 255).notNullable();
    table.string('channel', 50).notNullable(); // telegram | email | sms
    table.text('content').notNullable();
    table.jsonb('conditions').defaultTo('{}');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.index('organization_id');
    table.index('campaign_id');
  });

  await knex.schema.createTable('campaign_sequences', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('campaign_id').notNullable().references('id').inTable('campaigns').onDelete('CASCADE');
    table.integer('order_index').notNullable();
    table.uuid('template_id').notNullable().references('id').inTable('campaign_templates').onDelete('RESTRICT');
    table.integer('delay_hours').notNullable().defaultTo(24);
    table.jsonb('conditions').defaultTo('{}');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.index('campaign_id');
  });

  await knex.schema.createTable('campaign_participants', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('campaign_id').notNullable().references('id').inTable('campaigns').onDelete('CASCADE');
    table.uuid('contact_id').notNullable().references('id').inTable('contacts').onDelete('CASCADE');
    table.uuid('bd_account_id').references('id').inTable('bd_accounts').onDelete('SET NULL');
    table.string('channel_id', 100); // telegram chat id
    table.string('status', 50).notNullable().defaultTo('pending'); // pending | sent | delivered | replied | bounced | stopped
    table.integer('current_step').notNullable().defaultTo(0);
    table.timestamp('next_send_at');
    table.jsonb('metadata').defaultTo('{}');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['campaign_id', 'contact_id']);
    table.index('campaign_id');
    table.index(['campaign_id', 'next_send_at']);
  });

  await knex.schema.createTable('campaign_sends', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('campaign_participant_id').notNullable().references('id').inTable('campaign_participants').onDelete('CASCADE');
    table.integer('sequence_step').notNullable();
    table.uuid('message_id').references('id').inTable('messages').onDelete('SET NULL');
    table.timestamp('sent_at').notNullable().defaultTo(knex.fn.now());
    table.string('status', 50).notNullable().defaultTo('sent'); // sent | delivered | failed
    table.jsonb('metadata').defaultTo('{}');
    table.index('campaign_participant_id');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('campaign_sends');
  await knex.schema.dropTableIfExists('campaign_participants');
  await knex.schema.dropTableIfExists('campaign_sequences');
  await knex.schema.dropTableIfExists('campaign_templates');
  await knex.schema.dropTableIfExists('campaigns');
}
