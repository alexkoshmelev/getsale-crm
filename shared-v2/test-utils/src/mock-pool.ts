import { vi } from 'vitest';
import type { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

export interface MockQueryResult<T extends QueryResultRow = QueryResultRow> {
  rows: T[];
  rowCount: number | null;
  command?: string;
  oid?: number;
  fields?: Array<{ name: string; tableID: number; columnID: number; dataTypeID: number }>;
}

export type MockPool = Pool & {
  query: ReturnType<typeof vi.fn>;
  getQueries: () => Array<{ text: string; values?: unknown[] }>;
  setQueryResult: (result: MockQueryResult<QueryResultRow>) => void;
};

export function createMockPool<T extends QueryResultRow = QueryResultRow>(
  defaultResult: MockQueryResult<T> = { rows: [], rowCount: 0 },
): MockPool {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  let currentResult: MockQueryResult<QueryResultRow> = defaultResult;

  const queryFn = vi.fn(async (text: string, values?: unknown[]): Promise<QueryResult> => {
    queries.push({ text, values });
    return currentResult as QueryResult;
  });

  const pool = {
    query: queryFn,
    connect: vi.fn(async (): Promise<PoolClient> => {
      const client = {
        query: queryFn,
        release: vi.fn(),
      } as unknown as PoolClient;
      return client;
    }),
    end: vi.fn(),
    on: vi.fn(),
    getQueries: () => [...queries],
    setQueryResult: (result: MockQueryResult<QueryResultRow>) => {
      currentResult = result;
    },
  } as unknown as MockPool;

  return pool;
}
