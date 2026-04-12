import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE campaign_templates
    ADD COLUMN IF NOT EXISTS variant_group uuid,
    ADD COLUMN IF NOT EXISTS variant_weight integer NOT NULL DEFAULT 100;

    CREATE INDEX IF NOT EXISTS idx_templates_variant_group ON campaign_templates(variant_group) WHERE variant_group IS NOT NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`
    DROP INDEX IF EXISTS idx_templates_variant_group;
    ALTER TABLE campaign_templates
    DROP COLUMN IF EXISTS variant_weight,
    DROP COLUMN IF EXISTS variant_group;
  `);
}
