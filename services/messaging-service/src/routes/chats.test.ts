import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockPool } from '@getsale/test-utils';
import { createLogger } from '@getsale/logger';
import { chatsRouter } from './chats';

const TEST_ORG_ID = '11111111-1111-1111-1111-111111111111';
const TEST_USER_ID = '22222222-2222-2222-2222-222222222222';

const authHeaders = {
  'x-user-id': TEST_USER_ID,
  'x-organization-id': TEST_ORG_ID,
  'x-user-role': 'owner',
  'content-type': 'application/json',
};

describe('Chats Router', () => {
  let pool: ReturnType<typeof createMockPool>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = createMockPool();
    const log = createLogger('messaging-service-test');
    const router = chatsRouter({ pool, log });
    app = createTestApp(router, { prefix: '/api/messaging', log });
  });

  describe('GET /api/messaging/chats', () => {
    it('returns empty array when no chats and bdAccountId provided', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app)
        .get('/api/messaging/chats')
        .query({ channel: 'telegram', bdAccountId: 'bd-account-1' })
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(0);
    });

  });

  describe('GET /api/messaging/pinned-chats', () => {
    it('returns empty array when no pinned chats', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app)
        .get('/api/messaging/pinned-chats')
        .query({ bdAccountId: 'bd-account-1' })
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(0);
    });
  });
});
