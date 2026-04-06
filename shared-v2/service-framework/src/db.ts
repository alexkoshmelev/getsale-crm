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
  shutdown(): Promise<void>;
}

const DEFAULT_WRITE_URL =
  `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'postgres_dev'}@localhost:5433/postgres`;

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

    async shutdown(): Promise<void> {
      const promises: Promise<void>[] = [writePool.end()];
      if (readPool !== writePool) promises.push(readPool.end());
      await Promise.all(promises);
    },
  };
}
