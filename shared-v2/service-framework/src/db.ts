import { Pool, PoolClient, PoolConfig } from 'pg';
import { Logger } from '@getsale/logger';

export interface DbConfig {
  writeUrl: string;
  readUrl?: string;
  poolMax?: number;
  idleTimeoutMs?: number;
  connectionTimeoutMs?: number;
  extra?: Partial<PoolConfig>;
}

export interface DatabasePools {
  write: Pool;
  read: Pool;
  withOrgContext<T>(
    target: 'write' | 'read',
    organizationId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T>;
  /**
   * Read-only org context without BEGIN/COMMIT: sets `app.current_org_id` at session scope
   * for the checkout, then resets it before returning the client to the pool.
   */
  withOrgContextLight<T>(
    organizationId: string,
    fn: (client: PoolClient) => Promise<T>,
  ): Promise<T>;
  shutdown(): Promise<void>;
}

const DEFAULT_WRITE_URL =
  `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'postgres_dev'}@localhost:5433/postgres`;

/**
 * Creates write/read connection pools for Postgres.
 *
 * **Pool size**: Default `max` is 10 per pool (override with `DATABASE_POOL_MAX` or `config.poolMax`).
 * For high throughput (e.g. ~10K RPS), size pools so **`(service instances × pool max)` stays below
 * Postgres `max_connections`**, leaving headroom for admin and other clients.
 *
 * **PgBouncer**: When connections go through a pooler, each app-side pool can often be larger
 * because PgBouncer multiplexes many clients onto fewer server connections; still respect
 * PgBouncer and Postgres limits (`default_pool_size`, `max_client_conn`, etc.).
 *
 * **Read replicas**: Set `DATABASE_READ_URL` (or `config.readUrl`) so `read` and read-scoped helpers
 * use a dedicated replica pool; otherwise reads share the primary pool.
 */
export function createDatabasePools(log: Logger, config?: Partial<DbConfig>): DatabasePools {
  const writeUrl = config?.writeUrl || process.env.DATABASE_URL || DEFAULT_WRITE_URL;
  // DATABASE_READ_URL enables transparent read-replica routing; when set, all
  // read-targeted queries go to the replica pool instead of the write pool.
  const readUrl = config?.readUrl || process.env.DATABASE_READ_URL || '';
  const poolMax = config?.poolMax
    ?? (process.env.DATABASE_POOL_MAX ? parseInt(process.env.DATABASE_POOL_MAX, 10) : 10);
  const idleTimeoutMs = config?.idleTimeoutMs
    ?? (process.env.DATABASE_POOL_IDLE_TIMEOUT_MS ? parseInt(process.env.DATABASE_POOL_IDLE_TIMEOUT_MS, 10) : 30_000);
  const connectionTimeoutMs = config?.connectionTimeoutMs
    ?? (process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS ? parseInt(process.env.DATABASE_POOL_CONNECTION_TIMEOUT_MS, 10) : 5_000);

  const basePoolConfig: PoolConfig = {
    max: poolMax,
    idleTimeoutMillis: idleTimeoutMs,
    connectionTimeoutMillis: connectionTimeoutMs,
    ...config?.extra,
  };

  const writePool = new Pool({ ...basePoolConfig, connectionString: writeUrl });
  writePool.on('error', (err) => {
    log.error({ message: 'DB write pool idle client error', error: String(err) });
  });

  let readPool: Pool;
  if (readUrl) {
    readPool = new Pool({ ...basePoolConfig, connectionString: readUrl });
    readPool.on('error', (err) => {
      log.error({ message: 'DB read pool idle client error', error: String(err) });
    });
    log.info({ message: 'DB read replica pool created', read_url: readUrl.replace(/:[^@]+@/, ':***@') });
  } else {
    readPool = writePool;
  }

  return {
    write: writePool,
    read: readPool,

    async withOrgContext<T>(
      target: 'write' | 'read',
      organizationId: string,
      fn: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
      const pool = target === 'read' ? readPool : writePool;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_org_id', $1, true)", [organizationId]);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    },

    async withOrgContextLight<T>(
      organizationId: string,
      fn: (client: PoolClient) => Promise<T>,
    ): Promise<T> {
      const client = await readPool.connect();
      try {
        await client.query(
          "SELECT set_config('app.current_org_id', $1, false)",
          [organizationId],
        );
        return await fn(client);
      } finally {
        await client
          .query("SELECT set_config('app.current_org_id', NULL, false)")
          .catch(() => {});
        client.release();
      }
    },

    async shutdown(): Promise<void> {
      const promises: Promise<void>[] = [writePool.end()];
      if (readPool !== writePool) promises.push(readPool.end());
      await Promise.all(promises);
    },
  };
}
