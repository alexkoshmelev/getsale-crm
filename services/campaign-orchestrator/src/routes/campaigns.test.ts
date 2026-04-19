import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestApp, createMockDb, createMockRabbitMQ } from '@getsale/test-utils';
import { registerCampaignRoutes } from './campaigns';

const TEST_ORG_ID = '11111111-1111-4111-8111-111111111111';
const TEST_USER_ID = '22222222-2222-4222-8222-222222222222';

const authHeaders = {
  'x-user-id': TEST_USER_ID,
  'x-organization-id': TEST_ORG_ID,
  'x-user-role': 'owner',
};

const jsonAuthHeaders = { ...authHeaders, 'content-type': 'application/json' };

const mockScheduler = {
  scheduleCampaign: vi.fn().mockResolvedValue(0),
  cancelCampaign: vi.fn().mockResolvedValue(undefined),
  getCampaignStats: vi.fn().mockResolvedValue({}),
};

describe('Campaigns Routes (Fastify)', () => {
  let inject: Awaited<ReturnType<typeof createTestApp>>['inject'];
  let db: ReturnType<typeof createMockDb>;
  let rabbitmq: ReturnType<typeof createMockRabbitMQ>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    rabbitmq = createMockRabbitMQ();

    const { inject: inj } = await createTestApp((app) =>
      registerCampaignRoutes(app, {
        db,
        rabbitmq,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
        scheduler: mockScheduler as any,
      }),
    );
    inject = inj;
  });

  describe('GET /api/campaigns', () => {
    it('returns empty array when no campaigns', async () => {
      db.read.query
        .mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ total: 0 }], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await inject({ method: 'GET', url: '/api/campaigns', headers: authHeaders });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ data: [], total: 0, page: 1, limit: 20 });
    });
  });

  describe('POST /api/campaigns', () => {
    it('creates a campaign', async () => {
      const created = {
        id: '33333333-3333-4333-a333-333333333333',
        organization_id: TEST_ORG_ID,
        name: 'Test Campaign',
        status: 'draft',
      };

      (db.withOrgContext as any).mockImplementation(async (_target: string, _orgId: string, fn: any) => {
        const client = await db.write.connect();
        try {
          return await fn(client);
        } finally {
          client.release();
        }
      });

      db.write.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [created], rowCount: 1 });

      const res = await inject({
        method: 'POST',
        url: '/api/campaigns',
        headers: jsonAuthHeaders,
        payload: { name: 'Test Campaign' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.name).toBe('Test Campaign');
      expect(body.status).toBe('draft');
    });
  });

  describe('DELETE /api/campaigns/:id', () => {
    it('returns 404 when campaign not found', async () => {
      db.read.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await inject({
        method: 'DELETE',
        url: '/api/campaigns/33333333-3333-4333-a333-333333333333',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when trying to delete active campaign', async () => {
      db.read.query.mockResolvedValueOnce({
        rows: [{ status: 'active', created_by_user_id: TEST_USER_ID }],
        rowCount: 1,
      });

      const res = await inject({
        method: 'DELETE',
        url: '/api/campaigns/33333333-3333-4333-a333-333333333333',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('active');
    });

    it('deletes a draft campaign', async () => {
      db.read.query
        .mockResolvedValueOnce({
          rows: [{ status: 'draft', created_by_user_id: TEST_USER_ID }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [], rowCount: 0 });

      (db.withOrgContext as any).mockImplementation(async (_target: string, _orgId: string, fn: any) => {
        const client = await db.write.connect();
        try {
          return await fn(client);
        } finally {
          client.release();
        }
      });

      const res = await inject({
        method: 'DELETE',
        url: '/api/campaigns/33333333-3333-4333-a333-333333333333',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(204);
    });
  });

  describe('POST /api/campaigns/:id/pause', () => {
    it('returns 404 when campaign not found', async () => {
      db.read.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await inject({
        method: 'POST',
        url: '/api/campaigns/33333333-3333-4333-a333-333333333333/pause',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 400 when campaign is not active', async () => {
      db.read.query.mockResolvedValueOnce({
        rows: [{ status: 'draft' }],
        rowCount: 1,
      });

      const res = await inject({
        method: 'POST',
        url: '/api/campaigns/33333333-3333-4333-a333-333333333333/pause',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
