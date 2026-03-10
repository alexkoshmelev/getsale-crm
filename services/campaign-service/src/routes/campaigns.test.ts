import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockPool, createMockRabbitMQ } from '@getsale/test-utils';
import { createLogger } from '@getsale/logger';
import { campaignsRouter } from './campaigns';

const TEST_ORG_ID = '11111111-1111-1111-1111-111111111111';
const TEST_USER_ID = '22222222-2222-2222-2222-222222222222';

const authHeaders = {
  'x-user-id': TEST_USER_ID,
  'x-organization-id': TEST_ORG_ID,
  'x-user-role': 'owner',
  'content-type': 'application/json',
};

describe('Campaigns Router', () => {
  let pool: ReturnType<typeof createMockPool>;
  let rabbitmq: ReturnType<typeof createMockRabbitMQ>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = createMockPool();
    rabbitmq = createMockRabbitMQ();
    const log = createLogger('campaign-service-test');
    const router = campaignsRouter({ pool, rabbitmq, log });
    app = createTestApp(router, { prefix: '/api/campaigns', log });
  });

  describe('GET /api/campaigns', () => {
    it('returns empty array when no campaigns', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app)
        .get('/api/campaigns')
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(0);
    });
  });

  describe('GET /api/campaigns/telegram-source-keywords', () => {
    it('returns distinct keywords for org', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [{ keyword: 'crypto' }, { keyword: 'trading' }],
        rowCount: 2,
      });

      const res = await request(app)
        .get('/api/campaigns/telegram-source-keywords')
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body).toEqual(['crypto', 'trading']);
    });

    it('returns empty array when no keywords', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app)
        .get('/api/campaigns/telegram-source-keywords')
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
    });
  });

  describe('GET /api/campaigns/telegram-source-groups', () => {
    it('returns distinct groups for org', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          { bd_account_id: 'aaa', telegram_chat_id: '-1001', telegram_chat_title: 'Group A' },
          { bd_account_id: 'aaa', telegram_chat_id: '-1002', telegram_chat_title: null },
        ],
        rowCount: 2,
      });

      const res = await request(app)
        .get('/api/campaigns/telegram-source-groups')
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([
        { bdAccountId: 'aaa', telegramChatId: '-1001', telegramChatTitle: 'Group A' },
        { bdAccountId: 'aaa', telegramChatId: '-1002', telegramChatTitle: undefined },
      ]);
    });
  });

  describe('GET /api/campaigns/contacts-for-picker', () => {
    it('returns contacts for org with optional sourceKeyword filter', async () => {
      pool.query.mockResolvedValueOnce({
        rows: [
          {
            id: 'c1',
            first_name: 'John',
            last_name: 'Doe',
            display_name: null,
            username: 'johnd',
            telegram_id: '123',
            email: null,
            phone: null,
            outreach_status: 'new',
          },
        ],
        rowCount: 1,
      });

      const res = await request(app)
        .get('/api/campaigns/contacts-for-picker?sourceKeyword=crypto&limit=100')
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
      expect(res.body[0]).toMatchObject({ id: 'c1', first_name: 'John', outreach_status: 'new' });
      expect(pool.query).toHaveBeenCalledWith(
        expect.stringContaining('contact_telegram_sources'),
        expect.any(Array)
      );
    });

    it('returns contacts filtered by sourceTelegramChatId and sourceBdAccountId', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app)
        .get('/api/campaigns/contacts-for-picker?sourceTelegramChatId=-1001&sourceBdAccountId=aaa')
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body).toEqual([]);
      const call = (pool.query as any).mock.calls[0];
      expect(call[0]).toContain('telegram_chat_id');
      expect(call[1]).toContain('-1001');
      expect(call[1]).toContain('aaa');
    });
  });
});
