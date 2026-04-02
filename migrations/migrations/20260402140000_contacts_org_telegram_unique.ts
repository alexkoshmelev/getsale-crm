import type { Knex } from 'knex';

/**
 * Deduplicate contacts with the same (organization_id, telegram_id), then add a partial unique index.
 * Keeps the row with the latest updated_at (then smallest id).
 */
const MAPPING_CTE = `
    WITH ranked AS (
      SELECT
        id,
        organization_id,
        trim(telegram_id) AS tg,
        ROW_NUMBER() OVER (
          PARTITION BY organization_id, trim(telegram_id)
          ORDER BY updated_at DESC NULLS LAST, id
        ) AS rn
      FROM contacts
      WHERE telegram_id IS NOT NULL AND trim(telegram_id) <> ''
    ),
    mapping AS (
      SELECT r1.id AS loser_id, r2.id AS winner_id
      FROM ranked r1
      JOIN ranked r2 ON r1.organization_id = r2.organization_id AND r1.tg = r2.tg AND r2.rn = 1
      WHERE r1.rn > 1
    )`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ${MAPPING_CTE}
    DELETE FROM campaign_participants cp
    USING mapping m
    WHERE cp.contact_id = m.loser_id
      AND EXISTS (
        SELECT 1 FROM campaign_participants cp2
        WHERE cp2.campaign_id = cp.campaign_id AND cp2.contact_id = m.winner_id
      )
  `);

  await knex.raw(`
    ${MAPPING_CTE}
    DELETE FROM leads l
    USING mapping m
    WHERE l.contact_id = m.loser_id
      AND EXISTS (
        SELECT 1 FROM leads l2
        WHERE l2.organization_id = l.organization_id
          AND l2.pipeline_id = l.pipeline_id
          AND l2.contact_id = m.winner_id
      )
  `);

  await knex.raw(`
    ${MAPPING_CTE}
    DELETE FROM contact_telegram_sources cts
    USING mapping m
    WHERE cts.contact_id = m.loser_id
      AND EXISTS (
        SELECT 1 FROM contact_telegram_sources cts2
        WHERE cts2.organization_id = cts.organization_id
          AND cts2.bd_account_id = cts.bd_account_id
          AND cts2.telegram_chat_id = cts.telegram_chat_id
          AND cts2.contact_id = m.winner_id
      )
  `);

  await knex.raw(`
    ${MAPPING_CTE}
    DELETE FROM conversations conv
    USING mapping m
    WHERE conv.contact_id = m.loser_id
      AND EXISTS (
        SELECT 1 FROM conversations conv2
        WHERE conv2.organization_id = conv.organization_id
          AND conv2.bd_account_id IS NOT DISTINCT FROM conv.bd_account_id
          AND conv2.channel = conv.channel
          AND conv2.channel_id = conv.channel_id
          AND conv2.contact_id = m.winner_id
      )
  `);

  await knex.raw(`
    WITH ranked AS (
      SELECT
        id,
        organization_id,
        trim(telegram_id) AS tg,
        ROW_NUMBER() OVER (
          PARTITION BY organization_id, trim(telegram_id)
          ORDER BY updated_at DESC NULLS LAST, id
        ) AS rn
      FROM contacts
      WHERE telegram_id IS NOT NULL AND trim(telegram_id) <> ''
    ),
    mapping AS (
      SELECT r1.id AS loser_id, r2.id AS winner_id
      FROM ranked r1
      JOIN ranked r2 ON r1.organization_id = r2.organization_id AND r1.tg = r2.tg AND r2.rn = 1
      WHERE r1.rn > 1
    )
    UPDATE messages m SET contact_id = mapping.winner_id
    FROM mapping WHERE m.contact_id = mapping.loser_id
  `);

  await knex.raw(`
    WITH ranked AS (
      SELECT
        id,
        organization_id,
        trim(telegram_id) AS tg,
        ROW_NUMBER() OVER (
          PARTITION BY organization_id, trim(telegram_id)
          ORDER BY updated_at DESC NULLS LAST, id
        ) AS rn
      FROM contacts
      WHERE telegram_id IS NOT NULL AND trim(telegram_id) <> ''
    ),
    mapping AS (
      SELECT r1.id AS loser_id, r2.id AS winner_id
      FROM ranked r1
      JOIN ranked r2 ON r1.organization_id = r2.organization_id AND r1.tg = r2.tg AND r2.rn = 1
      WHERE r1.rn > 1
    )
    UPDATE campaign_participants cp SET contact_id = mapping.winner_id
    FROM mapping WHERE cp.contact_id = mapping.loser_id
  `);

  await knex.raw(`
    WITH ranked AS (
      SELECT
        id,
        organization_id,
        trim(telegram_id) AS tg,
        ROW_NUMBER() OVER (
          PARTITION BY organization_id, trim(telegram_id)
          ORDER BY updated_at DESC NULLS LAST, id
        ) AS rn
      FROM contacts
      WHERE telegram_id IS NOT NULL AND trim(telegram_id) <> ''
    ),
    mapping AS (
      SELECT r1.id AS loser_id, r2.id AS winner_id
      FROM ranked r1
      JOIN ranked r2 ON r1.organization_id = r2.organization_id AND r1.tg = r2.tg AND r2.rn = 1
      WHERE r1.rn > 1
    )
    UPDATE conversations c SET contact_id = mapping.winner_id
    FROM mapping WHERE c.contact_id = mapping.loser_id
  `);

  await knex.raw(`
    WITH ranked AS (
      SELECT
        id,
        organization_id,
        trim(telegram_id) AS tg,
        ROW_NUMBER() OVER (
          PARTITION BY organization_id, trim(telegram_id)
          ORDER BY updated_at DESC NULLS LAST, id
        ) AS rn
      FROM contacts
      WHERE telegram_id IS NOT NULL AND trim(telegram_id) <> ''
    ),
    mapping AS (
      SELECT r1.id AS loser_id, r2.id AS winner_id
      FROM ranked r1
      JOIN ranked r2 ON r1.organization_id = r2.organization_id AND r1.tg = r2.tg AND r2.rn = 1
      WHERE r1.rn > 1
    )
    UPDATE leads l SET contact_id = mapping.winner_id
    FROM mapping WHERE l.contact_id = mapping.loser_id
  `);

  await knex.raw(`
    WITH ranked AS (
      SELECT
        id,
        organization_id,
        trim(telegram_id) AS tg,
        ROW_NUMBER() OVER (
          PARTITION BY organization_id, trim(telegram_id)
          ORDER BY updated_at DESC NULLS LAST, id
        ) AS rn
      FROM contacts
      WHERE telegram_id IS NOT NULL AND trim(telegram_id) <> ''
    ),
    mapping AS (
      SELECT r1.id AS loser_id, r2.id AS winner_id
      FROM ranked r1
      JOIN ranked r2 ON r1.organization_id = r2.organization_id AND r1.tg = r2.tg AND r2.rn = 1
      WHERE r1.rn > 1
    )
    UPDATE contact_telegram_sources cts SET contact_id = mapping.winner_id
    FROM mapping WHERE cts.contact_id = mapping.loser_id
  `);

  await knex.raw(`
    WITH ranked AS (
      SELECT
        id,
        organization_id,
        trim(telegram_id) AS tg,
        ROW_NUMBER() OVER (
          PARTITION BY organization_id, trim(telegram_id)
          ORDER BY updated_at DESC NULLS LAST, id
        ) AS rn
      FROM contacts
      WHERE telegram_id IS NOT NULL AND trim(telegram_id) <> ''
    ),
    mapping AS (
      SELECT r1.id AS loser_id, r2.id AS winner_id
      FROM ranked r1
      JOIN ranked r2 ON r1.organization_id = r2.organization_id AND r1.tg = r2.tg AND r2.rn = 1
      WHERE r1.rn > 1
    )
    UPDATE deals d SET contact_id = mapping.winner_id
    FROM mapping WHERE d.contact_id = mapping.loser_id
  `);

  await knex.raw(`
    DELETE FROM contacts c
    USING (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY organization_id, trim(telegram_id)
          ORDER BY updated_at DESC NULLS LAST, id
        ) AS rn
      FROM contacts
      WHERE telegram_id IS NOT NULL AND trim(telegram_id) <> ''
    ) r
    WHERE c.id = r.id AND r.rn > 1
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_org_telegram_id_unique
    ON contacts (organization_id, telegram_id)
    WHERE telegram_id IS NOT NULL AND trim(telegram_id) <> ''
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS idx_contacts_org_telegram_id_unique`);
}
