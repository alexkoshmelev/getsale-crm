import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createTestApp } from '@getsale/test-utils';
import { createLogger } from '@getsale/logger';
import { searchQueriesRouter } from './search-queries';

const TEST_ORG_ID = '11111111-1111-1111-1111-111111111111';
const TEST_USER_ID = '22222222-2222-2222-2222-222222222222';

const authHeaders = {
  'x-user-id': TEST_USER_ID,
  'x-organization-id': TEST_ORG_ID,
  'x-user-role': 'owner',
  'content-type': 'application/json',
};

describe('Search Queries Router', () => {
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    const log = createLogger('ai-service-search-queries-test');
    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: 'crypto\nbitcoin news\nDeFi\nP2P exchange' } }],
          }),
        },
      },
    } as any;
    const redis = { get: vi.fn().mockResolvedValue(0), set: vi.fn().mockResolvedValue(undefined), incr: vi.fn().mockResolvedValue(1) } as any;
    const rabbitmq = {} as any;
    const rateLimiter = {
      check: vi.fn().mockResolvedValue({ allowed: true, remaining: 100, limit: 200, resetInSeconds: 3600 }),
      increment: vi.fn().mockResolvedValue(undefined),
    } as any;
    const models = { draft: 'gpt-4o', analyze: 'gpt-4o', summarize: 'gpt-4o-mini' };
    const router = searchQueriesRouter({ openai, redis, rabbitmq, log, rateLimiter, models });
    app = createTestApp(router, { prefix: '/api/ai', log });
  });

  describe('POST /api/ai/generate-search-queries', () => {
    it('returns generated queries for a topic', async () => {
      const res = await request(app)
        .post('/api/ai/generate-search-queries')
        .set(authHeaders)
        .send({ topic: 'crypto' });

      expect(res.status).toBe(200);
      expect(res.body).toHaveProperty('queries');
      expect(Array.isArray(res.body.queries)).toBe(true);
      expect(res.body.queries.length).toBeGreaterThan(0);
    });

    it('returns 400 when topic is empty', async () => {
      const res = await request(app)
        .post('/api/ai/generate-search-queries')
        .set(authHeaders)
        .send({ topic: '' });

      expect(res.status).toBe(400);
    });
  });
});
