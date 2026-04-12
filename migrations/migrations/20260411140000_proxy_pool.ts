import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE IF NOT EXISTS proxy_pool (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      host varchar(255) NOT NULL,
      port integer NOT NULL,
      username varchar(255),
      password varchar(255),
      proxy_type varchar(20) NOT NULL DEFAULT 'socks5',
      country varchar(10),
      is_active boolean NOT NULL DEFAULT true,
      assigned_account_id uuid REFERENCES bd_accounts(id) ON DELETE SET NULL,
      health_status varchar(20) NOT NULL DEFAULT 'unknown',
      last_check_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT NOW(),
      updated_at timestamptz NOT NULL DEFAULT NOW()
    );

    CREATE INDEX idx_proxy_pool_org ON proxy_pool(organization_id);
    CREATE INDEX idx_proxy_pool_assigned ON proxy_pool(assigned_account_id) WHERE assigned_account_id IS NOT NULL;
    CREATE INDEX idx_proxy_pool_available ON proxy_pool(organization_id, is_active, assigned_account_id) WHERE is_active = true AND assigned_account_id IS NULL;
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP TABLE IF EXISTS proxy_pool;');
}
