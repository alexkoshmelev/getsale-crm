import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE campaign_templates
    ADD COLUMN IF NOT EXISTS media_url text,
    ADD COLUMN IF NOT EXISTS media_type varchar(30),
    ADD COLUMN IF NOT EXISTS media_metadata jsonb DEFAULT '{}';
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE campaign_templates
    DROP COLUMN IF EXISTS media_url,
    DROP COLUMN IF EXISTS media_type,
    DROP COLUMN IF EXISTS media_metadata;
  `);
}
