import type { Knex } from 'knex';

/**
 * v2: Partition the activity_log table by created_at (monthly range).
 */
export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('activity_log');
  if (!hasTable) return;

  await knex.raw(`
    ALTER TABLE activity_log RENAME TO activity_log_old;

    CREATE TABLE activity_log (
      LIKE activity_log_old INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING IDENTITY INCLUDING COMMENTS
    ) PARTITION BY RANGE (created_at);

    -- Recreate primary key to include the partition column
    ALTER TABLE activity_log ADD PRIMARY KEY (id, created_at);

    -- Copy non-PK, non-UNIQUE indexes from the old table
    DO $$
    DECLARE
      idx RECORD;
      idx_def TEXT;
    BEGIN
      FOR idx IN
        SELECT indexname, indexdef FROM pg_indexes
        WHERE tablename = 'activity_log_old'
          AND indexname NOT LIKE '%_pkey'
          AND indexdef NOT LIKE '%UNIQUE%'
      LOOP
        idx_def := REPLACE(idx.indexdef, 'activity_log_old', 'activity_log');
        idx_def := REPLACE(idx_def, idx.indexname, idx.indexname || '_v2');
        BEGIN
          EXECUTE idx_def;
        EXCEPTION WHEN duplicate_table THEN NULL;
        END;
      END LOOP;
    END $$;

    DO $$
    DECLARE
      start_date DATE := DATE_TRUNC('month', NOW() - INTERVAL '6 months');
      end_date DATE;
      partition_name TEXT;
    BEGIN
      FOR i IN 0..18 LOOP
        end_date := start_date + INTERVAL '1 month';
        partition_name := 'activity_log_' || TO_CHAR(start_date, 'YYYY_MM');
        EXECUTE format(
          'CREATE TABLE IF NOT EXISTS %I PARTITION OF activity_log FOR VALUES FROM (%L) TO (%L)',
          partition_name, start_date, end_date
        );
        start_date := end_date;
      END LOOP;
    END $$;

    CREATE TABLE IF NOT EXISTS activity_log_default PARTITION OF activity_log DEFAULT;

    INSERT INTO activity_log SELECT * FROM activity_log_old;
    DROP TABLE activity_log_old CASCADE;
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Reverting partitioning is destructive; no-op for safety
}
