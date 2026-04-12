import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS bd_account_warmup (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      bd_account_id uuid NOT NULL REFERENCES bd_accounts(id) ON DELETE CASCADE,
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      warmup_status varchar(20) NOT NULL DEFAULT 'pending',
      current_day integer NOT NULL DEFAULT 0,
      daily_limit_schedule jsonb NOT NULL DEFAULT '[3,5,8,10,12,14,16,18,20,20,20,20,20,20]',
      started_at timestamptz,
      completed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW(),
      CONSTRAINT uq_warmup_account UNIQUE (bd_account_id)
    );

    CREATE INDEX idx_warmup_status ON bd_account_warmup(warmup_status);
    CREATE INDEX idx_warmup_account ON bd_account_warmup(bd_account_id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS bd_account_warmup;');
}
