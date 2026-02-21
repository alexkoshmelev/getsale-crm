import { Knex } from 'knex';

/**
 * Настройки создания лида в CRM из кампании: когда создавать (on_first_send | on_reply),
 * ответственный по умолчанию, стадия по умолчанию.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('campaigns', (table) => {
    table.jsonb('lead_creation_settings').defaultTo(null);
    // { trigger: 'on_first_send' | 'on_reply', default_stage_id?: uuid, default_responsible_id?: uuid }
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('campaigns', (table) => {
    table.dropColumn('lead_creation_settings');
  });
}
