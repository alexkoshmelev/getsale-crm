import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import type { Counter } from 'prom-client';
import { createTestApp, createMockPool, createMockRabbitMQ } from '@getsale/test-utils';
import { createLogger } from '@getsale/logger';
import type { TelegramManager } from '../telegram';
import { accountsRouter } from './accounts';

const TEST_ORG_ID = '11111111-1111-1111-1111-111111111111';
const TEST_USER_ID = '22222222-2222-2222-2222-222222222222';

const authHeaders = {
  'x-user-id': TEST_USER_ID,
  'x-organization-id': TEST_ORG_ID,
  'x-user-role': 'owner',
};

describe('GET /api/bd-accounts/health-summary', () => {
  let pool: ReturnType<typeof createMockPool>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = createMockPool();
    pool.query.mockImplementation(async (sql: string) => {
      if (sql.includes('warming_groups')) {
        throw new Error('no such table');
      }
      if (sql.includes('FROM campaigns') && sql.includes('GROUP BY')) {
        return {
          rows: [
            { status: 'active', c: 2 },
            { status: 'draft', c: 1 },
          ],
          rowCount: 2,
        };
      }
      if (sql.includes('FROM bd_accounts a') && sql.includes('LIMIT 50') && sql.includes('last_status_message')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('COUNT(*)::int AS c FROM bd_accounts') && sql.includes('flood_wait_until')) {
        return { rows: [{ c: 0 }], rowCount: 1 };
      }
      if (sql.includes('COUNT(*)::int AS c FROM bd_accounts') && sql.includes('spam_restricted_at')) {
        return { rows: [{ c: 0 }], rowCount: 1 };
      }
      if (sql.includes('max_dm_per_day')) {
        return { rows: [{ c: 3 }], rowCount: 1 };
      }
      return { rows: [{ c: 0 }], rowCount: 1 };
    });

    const log = createLogger('bd-accounts-health-test');
    const messagingOrphanFallbackTotal = { inc: vi.fn() } as unknown as Counter;
    const router = accountsRouter({
      pool,
      rabbitmq: createMockRabbitMQ(),
      log,
      telegramManager: { isConnected: () => false } as unknown as TelegramManager,
      messagingClient: { post: vi.fn(), get: vi.fn() } as never,
      messagingOrphanFallbackTotal,
    });
    app = createTestApp(router, { prefix: '/api/bd-accounts', log });
  });

  it('returns aggregated health payload', async () => {
    const res = await request(app).get('/api/bd-accounts/health-summary').set(authHeaders);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      floodActiveCount: 0,
      spamRestrictedCount: 0,
      limitsConfiguredCount: 3,
      warmingRunningGroups: 0,
      campaigns: {
        active: 2,
        draft: 1,
        paused: 0,
        completed: 0,
      },
      riskAccounts: [],
    });
    expect(res.body.generatedAt).toBeDefined();
  });
});
