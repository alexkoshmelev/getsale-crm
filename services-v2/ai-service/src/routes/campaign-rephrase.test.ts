import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createTestApp } from '@getsale/test-utils-v2';
import { registerCampaignRephraseRoutes } from './campaign-rephrase';
import { DEFAULT_OPENROUTER_CAMPAIGN_PRESET } from '../openrouter-models';

const TEST_ORG_ID = '11111111-1111-4111-8111-111111111111';
const TEST_USER_ID = '22222222-2222-4222-8222-222222222222';

const authHeaders = {
  'x-user-id': TEST_USER_ID,
  'x-organization-id': TEST_ORG_ID,
  'x-user-role': 'owner',
  'content-type': 'application/json',
};

describe('Campaign Rephrase Routes (v2 Fastify)', () => {
  let inject: Awaited<ReturnType<typeof createTestApp>>['inject'];
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalEnv = process.env;

  beforeEach(async () => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.OPENROUTER_API_KEY = 'sk-test-key';
    delete process.env.OPENROUTER_MODEL;
    process.env.OPENROUTER_CAMPAIGN_MODEL = DEFAULT_OPENROUTER_CAMPAIGN_PRESET;

    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          choices: [{ message: { content: 'Rephrased message for Telegram' } }],
        }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const rateLimiter = {
      check: vi.fn().mockResolvedValue({ allowed: true, remaining: 100, limit: 200, resetInSeconds: 3600 }),
      increment: vi.fn().mockResolvedValue(undefined),
    } as any;

    const { inject: inj } = await createTestApp((app) =>
      registerCampaignRephraseRoutes(app, {
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
        rateLimiter,
      }),
    );
    inject = inj;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  describe('POST /api/ai/campaigns/rephrase', () => {
    it('returns rephrased content when OpenRouter is configured', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/ai/campaigns/rephrase',
        headers: authHeaders,
        payload: { text: 'Hello, we have a special offer for you.' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        content: expect.any(String),
        model: DEFAULT_OPENROUTER_CAMPAIGN_PRESET,
        provider: 'openrouter',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns 503 when OPENROUTER_API_KEY is not set', async () => {
      delete process.env.OPENROUTER_API_KEY;

      const res = await inject({
        method: 'POST',
        url: '/api/ai/campaigns/rephrase',
        headers: authHeaders,
        payload: { text: 'Hello' },
      });

      expect(res.statusCode).toBe(503);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 400 when text is empty', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/ai/campaigns/rephrase',
        headers: authHeaders,
        payload: { text: '' },
      });

      expect(res.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 400 when text is missing', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/ai/campaigns/rephrase',
        headers: authHeaders,
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 502 when OpenRouter returns non-ok', async () => {
      fetchMock.mockResolvedValue({
        ok: false,
        status: 500,
        text: () => Promise.resolve('upstream error'),
      } as any);

      const res = await inject({
        method: 'POST',
        url: '/api/ai/campaigns/rephrase',
        headers: authHeaders,
        payload: { text: 'Hello' },
      });

      expect(res.statusCode).toBe(502);
    });

    it('returns 502 when OpenRouter returns empty content', async () => {
      fetchMock.mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: null } }] }),
      } as any);

      const res = await inject({
        method: 'POST',
        url: '/api/ai/campaigns/rephrase',
        headers: authHeaders,
        payload: { text: 'Hello' },
      });

      expect(res.statusCode).toBe(502);
    });
  });
});
