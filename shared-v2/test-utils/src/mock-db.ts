import { vi } from 'vitest';
import type { DatabasePools } from '@getsale/service-framework';
import { createMockPool, type MockPool } from './mock-pool';

export type MockDatabasePools = DatabasePools & {
  write: MockPool;
  read: MockPool;
};

/**
 * Creates a mock DatabasePools that mirrors the v2 db interface (write/read pools + withOrgContext).
 * Both `read` and `write` share the same mock pool by default so mock setups work transparently.
 */
export function createMockDb(): MockDatabasePools {
  const pool = createMockPool();

  const db: MockDatabasePools = {
    write: pool,
    read: pool,

    withOrgContext: vi.fn(async (_target, _orgId, fn) => {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    }) as unknown as DatabasePools['withOrgContext'],

    withOrgContextLight: vi.fn(async (_orgId, fn) => {
      const client = await pool.connect();
      try {
        return await fn(client);
      } finally {
        client.release();
      }
    }) as unknown as DatabasePools['withOrgContextLight'],

    shutdown: vi.fn(async () => {}),
  };

  return db;
}
