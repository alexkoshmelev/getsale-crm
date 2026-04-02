import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { createTestApp } from '@getsale/test-utils';
import { createLogger } from '@getsale/logger';
import { campaignRephraseRouter } from './campaign-rephrase';
import { DEFAULT_OPENROUTER_CAMPAIGN_PRESET } from '../openrouter-models';

const TEST_ORG_ID = '11111111-1111-1111-1111-111111111111';
const TEST_USER_ID = '22222222-2222-2222-2222-222222222222';

const authHeaders = {
  'x-user-id': TEST_USER_ID,
  'x-organization-id': TEST_ORG_ID,
  'x-user-role': 'owner',
  'content-type': 'application/json',
};

describe('Campaign Rephrase Router', () => {
  let app: ReturnType<typeof createTestApp>;
  let fetchMock: ReturnType<typeof vi.fn>;
  const originalEnv = process.env;

  beforeEach(() => {
    vi.clearAllMocks();
    process.env = { ...originalEnv };
    process.env.OPENROUTER_API_KEY = 'sk-test-key';
    delete process.env.OPENROUTER_MODEL;
    process.env.OPENROUTER_CAMPAIGN_MODEL = DEFAULT_OPENROUTER_CAMPAIGN_PRESET;

    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        choices: [{ message: { content: 'Rephrased message for Telegram' } }],
      }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const log = createLogger('ai-service-campaign-rephrase-test');
    const rateLimiter = {
      check: vi.fn().mockResolvedValue({ allowed: true, remaining: 100, limit: 200, resetInSeconds: 3600 }),
      increment: vi.fn().mockResolvedValue(undefined),
    } as any;
    const router = campaignRephraseRouter({ log, rateLimiter });
    app = createTestApp(router, { prefix: '/api/ai', log });
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
  });

  describe('POST /api/ai/campaigns/rephrase', () => {
    it('returns rephrased content when OpenRouter is configured', async () => {
      const res = await request(app)
        .post('/api/ai/campaigns/rephrase')
        .set(authHeaders)
        .send({ text: 'Hello, we have a special offer for you.' });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        content: 'Rephrased message for Telegram',
        model: DEFAULT_OPENROUTER_CAMPAIGN_PRESET,
        provider: 'openrouter',
      });
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const fetchOpts = fetchMock.mock.calls[0]?.[1] as { body?: string };
      const text = 'Hello, we have a special offer for you.';
      const sent = JSON.parse(fetchOpts?.body ?? '{}') as {
        messages?: { role: string; content: string }[];
        model?: string;
      };
      expect(sent.model).toBe(DEFAULT_OPENROUTER_CAMPAIGN_PRESET);
      expect(Array.isArray(sent.messages)).toBe(true);
      expect(sent.messages).toHaveLength(1);
      expect(sent.messages?.[0]).toEqual({ role: 'user', content: text });
    });

    it('returns 503 when OPENROUTER_API_KEY is not set', async () => {
      delete process.env.OPENROUTER_API_KEY;

      const res = await request(app)
        .post('/api/ai/campaigns/rephrase')
        .set(authHeaders)
        .send({ text: 'Hello' });

      expect(res.status).toBe(503);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 400 when text is empty', async () => {
      const res = await request(app)
        .post('/api/ai/campaigns/rephrase')
        .set(authHeaders)
        .send({ text: '' });

      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 400 when text is missing', async () => {
      const res = await request(app)
        .post('/api/ai/campaigns/rephrase')
        .set(authHeaders)
        .send({});

      expect(res.status).toBe(400);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns 502 when OpenRouter returns non-ok', async () => {
      vi.mocked(fetchMock).mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: () => Promise.resolve('Rate limited'),
      } as any);

      const res = await request(app)
        .post('/api/ai/campaigns/rephrase')
        .set(authHeaders)
        .send({ text: 'Hello' });

      expect(res.status).toBe(502);
    });

    it('returns 502 when OpenRouter returns empty content', async () => {
      const empty = {
        ok: true,
        json: () => Promise.resolve({ choices: [{ message: { content: null } }] }),
      } as any;
      vi.mocked(fetchMock).mockResolvedValue(empty);

      const res = await request(app)
        .post('/api/ai/campaigns/rephrase')
        .set(authHeaders)
        .send({ text: 'Hello' });

      expect(res.status).toBe(502);
      expect(fetchMock.mock.calls.length).toBe(1);
    });
  });
});
