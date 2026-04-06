import type { Knex } from 'knex';

const PARTITION_COUNT = 16;

/**
 * v2: Hash-partition the messages table by organization_id (16 partitions).
 *
 * Messages is the hottest table (~10K RPS). Hash partitioning by org spreads
 * I/O evenly across partitions and lets per-org queries hit a single partition.
 *
 * NOTE: This migration must run during a maintenance window because it
 * rewrites the entire table. For zero-downtime, use logical replication instead.
 */
export async function up(knex: Knex): Promise<void> {
  const hasMessages = await knex.schema.hasTable('messages');
  if (!hasMessages) return;

  const [{ relkind }] = (
    await knex.raw(`SELECT relkind FROM pg_class WHERE relname = 'messages'`)
  ).rows;

  if (relkind === 'p') {
    const partStrategy = (
      await knex.raw(`SELECT partstrat FROM pg_partitioned_table WHERE partrelid = 'messages'::regclass`)
    ).rows;
    if (partStrategy.length > 0 && partStrategy[0].partstrat === 'h') {
      return; // already hash-partitioned — idempotent
    }
    // Range-partitioned by a previous migration — collapse first, then re-partition as hash
    await knex.raw(`CREATE TABLE messages_collapsed (LIKE messages INCLUDING ALL)`);
    await knex.raw(`INSERT INTO messages_collapsed SELECT * FROM messages`);
    await knex.raw(`DROP TABLE messages CASCADE`);
    await knex.raw(`ALTER TABLE messages_collapsed RENAME TO messages_old`);
    // Fall through to re-partition as hash below
  }

  await knex.raw(`ALTER TABLE messages RENAME TO messages_old`);

  // Recreate as hash-partitioned table, copying column definitions from the
  // original. INCLUDING DEFAULTS preserves DEFAULT expressions; we deliberately
  // skip INCLUDING CONSTRAINTS/INDEXES because PK/UNIQUE must include the
  // partition key and indexes are recreated below.
  await knex.raw(`
    CREATE TABLE messages (
      LIKE messages_old
        INCLUDING DEFAULTS
        INCLUDING GENERATED
        INCLUDING IDENTITY
        INCLUDING COMMENTS
    ) PARTITION BY HASH (organization_id)
  `);

  // PK must include the partition key for hash-partitioned tables.
  await knex.raw(`
    ALTER TABLE messages ADD PRIMARY KEY (id, organization_id)
  `);

  // Create 16 hash partitions.
  for (let i = 0; i < PARTITION_COUNT; i++) {
    await knex.raw(`
      CREATE TABLE messages_p${i}
        PARTITION OF messages
        FOR VALUES WITH (MODULUS ${PARTITION_COUNT}, REMAINDER ${i})
    `);
  }

  // Indexes (created on the parent; Postgres propagates to each partition).
  await knex.raw(`
    CREATE INDEX idx_messages_org_created
      ON messages (organization_id, created_at DESC)
  `);
  await knex.raw(`
    CREATE INDEX idx_messages_channel
      ON messages (channel_id, bd_account_id, created_at DESC)
  `);
  await knex.raw(`
    CREATE INDEX idx_messages_contact
      ON messages (contact_id, created_at DESC)
  `);
  await knex.raw(`
    CREATE INDEX idx_messages_telegram_msg
      ON messages (bd_account_id, telegram_message_id)
  `);

  // Migrate existing data.
  await knex.raw(`INSERT INTO messages SELECT * FROM messages_old`);

  // Drop the original table. CASCADE removes leftover FK constraints that
  // pointed at messages_old; the partitioned table logically replaces them.
  await knex.raw(`DROP TABLE messages_old CASCADE`);
}

/**
 * Reverse the hash partitioning — collapse back into a regular table.
 *
 * WARNING: This copies the entire messages table and is destructive to
 * partition-level data locality. Run during a maintenance window.
 */
export async function down(knex: Knex): Promise<void> {
  const hasMessages = await knex.schema.hasTable('messages');
  if (!hasMessages) return;

  const [{ relkind }] = (
    await knex.raw(`SELECT relkind FROM pg_class WHERE relname = 'messages'`)
  ).rows;

  if (relkind !== 'p') {
    // Not partitioned — nothing to reverse.
    return;
  }

  await knex.raw(`ALTER TABLE messages RENAME TO messages_partitioned`);

  await knex.raw(`
    CREATE TABLE messages (
      LIKE messages_partitioned
        INCLUDING DEFAULTS
        INCLUDING GENERATED
        INCLUDING IDENTITY
        INCLUDING COMMENTS
    )
  `);

  await knex.raw(`
    ALTER TABLE messages ADD PRIMARY KEY (id)
  `);

  await knex.raw(`INSERT INTO messages SELECT * FROM messages_partitioned`);
  await knex.raw(`DROP TABLE messages_partitioned CASCADE`);

  // Re-add basic indexes for the unpartitioned layout.
  await knex.raw(`CREATE INDEX idx_messages_org_created ON messages (organization_id, created_at DESC)`);
  await knex.raw(`CREATE INDEX idx_messages_contact ON messages (contact_id, created_at DESC)`);
  await knex.raw(`CREATE INDEX idx_messages_channel ON messages (channel_id, bd_account_id, created_at DESC)`);
  await knex.raw(`CREATE INDEX idx_messages_telegram_msg ON messages (bd_account_id, telegram_message_id)`);
}
