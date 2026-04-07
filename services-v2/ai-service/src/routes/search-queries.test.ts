import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestApp } from '@getsale/test-utils-v2';
import { registerSearchQueryRoutes } from './search-queries';

const TEST_ORG_ID = '11111111-1111-1111-1111-111111111111';
const TEST_USER_ID = '22222222-2222-2222-2222-222222222222';

const authHeaders = {
  'x-user-id': TEST_USER_ID,
  'x-organization-id': TEST_ORG_ID,
  'x-user-role': 'owner',
  'content-type': 'application/json',
};

describe('Search Queries Routes (v2 Fastify)', () => {
  let inject: Awaited<ReturnType<typeof createTestApp>>['inject'];

  beforeEach(async () => {
    vi.clearAllMocks();

    const openai = {
      chat: {
        completions: {
          create: vi.fn().mockResolvedValue({
            choices: [{ message: { content: 'crypto\nbitcoin news\nDeFi\nP2P exchange' } }],
          }),
        },
      },
    } as any;

    const rateLimiter = {
      check: vi.fn().mockResolvedValue({ allowed: true, remaining: 100, limit: 200, resetInSeconds: 3600 }),
      increment: vi.fn().mockResolvedValue(undefined),
    } as any;

    const models = { draft: 'gpt-4o', analyze: 'gpt-4o', summarize: 'gpt-4o-mini' };

    const { inject: inj } = await createTestApp((app) =>
      registerSearchQueryRoutes(app, {
        openai,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
        rateLimiter,
        models,
      }),
    );
    inject = inj;
  });

  describe('POST /api/ai/generate-search-queries', () => {
    it('returns generated queries for a topic', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/ai/generate-search-queries',
        headers: authHeaders,
        payload: { topic: 'crypto' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveProperty('queries');
      expect(Array.isArray(body.queries)).toBe(true);
      expect(body.queries.length).toBeGreaterThan(0);
    });

    it('returns 400 when topic is empty', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/ai/generate-search-queries',
        headers: authHeaders,
        payload: { topic: '' },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
