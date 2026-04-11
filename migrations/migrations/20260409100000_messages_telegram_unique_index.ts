import type { Knex } from 'knex';

/**
 * Re-add the UNIQUE index on messages that was lost during the hash-partitioning
 * migration (20260405200000). Without this constraint, syncHistory inserts
 * duplicate messages because the INSERT-catch-skip-duplicates pattern has
 * no constraint violation to catch.
 *
 * organization_id is included because it is the hash partition key and must be
 * part of any unique index on a partitioned table in PostgreSQL.
 */
export async function up(knex: Knex): Promise<void> {
  const hasMessages = await knex.schema.hasTable('messages');
  if (!hasMessages) return;

  // Remove duplicate messages before creating the unique index.
  // Keeps the row with the earliest created_at for each unique combination.
  await knex.raw(`
    DELETE FROM messages m
    WHERE m.telegram_message_id IS NOT NULL
      AND m.id NOT IN (
        SELECT DISTINCT ON (bd_account_id, channel_id, telegram_message_id, organization_id) id
        FROM messages
        WHERE telegram_message_id IS NOT NULL
        ORDER BY bd_account_id, channel_id, telegram_message_id, organization_id, created_at ASC
      )
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS messages_telegram_unique
    ON messages (bd_account_id, channel_id, telegram_message_id, organization_id)
    WHERE telegram_message_id IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP INDEX IF EXISTS messages_telegram_unique`);
}
