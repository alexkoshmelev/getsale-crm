import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestApp, createMockDb, createMockRabbitMQ } from '@getsale/test-utils-v2';
import { registerDealRoutes } from './deals';

const TEST_ORG_ID = '11111111-1111-1111-1111-111111111111';
const TEST_USER_ID = '22222222-2222-2222-2222-222222222222';
const PIPELINE_ID = '33333333-3333-3333-3333-333333333333';
const STAGE_ID = '44444444-4444-4444-4444-444444444444';
const COMPANY_ID = '55555555-5555-5555-5555-555555555555';

const authHeaders = {
  'x-user-id': TEST_USER_ID,
  'x-organization-id': TEST_ORG_ID,
  'x-user-role': 'owner',
  'content-type': 'application/json',
};

describe('Deals Routes (v2 Fastify)', () => {
  let inject: Awaited<ReturnType<typeof createTestApp>>['inject'];
  let db: ReturnType<typeof createMockDb>;
  let rabbitmq: ReturnType<typeof createMockRabbitMQ>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    rabbitmq = createMockRabbitMQ();

    const { inject: inj } = await createTestApp((app) =>
      registerDealRoutes(app, { db, rabbitmq, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any } as any),
    );
    inject = inj;
  });

  describe('GET /api/crm/deals', () => {
    it('returns deals list with pagination', async () => {
      db.read.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

      const res = await inject({ method: 'GET', url: '/api/crm/deals', headers: authHeaders });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ items: [], pagination: { page: 1, total: 0 } });
    });

    it('returns paginated deals', async () => {
      const mockDeals = [{
        id: '66666666-6666-6666-6666-666666666666',
        organization_id: TEST_ORG_ID,
        title: 'Deal One',
        pipeline_id: PIPELINE_ID,
        stage_id: STAGE_ID,
        value: 1000,
        company_name: 'Acme',
        pipeline_name: 'Sales',
        stage_name: 'Proposal',
      }];

      db.read.query
        .mockResolvedValueOnce({ rows: mockDeals, rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });

      const res = await inject({
        method: 'GET',
        url: '/api/crm/deals?page=1&limit=10',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].title).toBe('Deal One');
      expect(body.pagination).toMatchObject({ page: 1, limit: 10, total: 1, totalPages: 1 });
    });
  });

  describe('GET /api/crm/deals/:id', () => {
    it('returns deal by id', async () => {
      const dealId = '77777777-7777-7777-7777-777777777777';
      const row = {
        id: dealId,
        organization_id: TEST_ORG_ID,
        title: 'Single Deal',
        pipeline_id: PIPELINE_ID,
        stage_id: STAGE_ID,
        company_name: 'Acme',
        pipeline_name: 'Sales',
        stage_name: 'Won',
      };
      db.read.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

      const res = await inject({
        method: 'GET',
        url: `/api/crm/deals/${dealId}`,
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.title).toBe('Single Deal');
    });

    it('returns 404 when deal not found', async () => {
      db.read.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await inject({
        method: 'GET',
        url: '/api/crm/deals/77777777-7777-7777-7777-777777777777',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('not found');
    });
  });

  describe('POST /api/crm/deals', () => {
    it('creates a deal with pipeline', async () => {
      const created = {
        id: '88888888-8888-8888-8888-888888888888',
        organization_id: TEST_ORG_ID,
        company_id: null,
        pipeline_id: PIPELINE_ID,
        stage_id: STAGE_ID,
        title: 'New Deal',
        value: 5000,
        currency: 'USD',
      };

      db.read.query
        .mockResolvedValueOnce({ rows: [{ id: STAGE_ID }], rowCount: 1 });
      db.write.query
        .mockResolvedValueOnce({ rows: [created], rowCount: 1 });

      const res = await inject({
        method: 'POST',
        url: '/api/crm/deals',
        headers: authHeaders,
        payload: { title: 'New Deal', pipelineId: PIPELINE_ID, value: 5000, currency: 'USD' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.title).toBe('New Deal');
      expect(body.value).toBe(5000);
      expect(rabbitmq.getPublishedEvents()).toHaveLength(1);
      expect(rabbitmq.getPublishedEvents()[0].event.type).toBe('deal.created');
    });

    it('returns 400 when title missing', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/crm/deals',
        headers: authHeaders,
        payload: { pipelineId: PIPELINE_ID, companyId: COMPANY_ID },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when pipeline has no stages', async () => {
      db.read.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await inject({
        method: 'POST',
        url: '/api/crm/deals',
        headers: authHeaders,
        payload: { title: 'Deal', pipelineId: PIPELINE_ID },
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('PUT /api/crm/deals/:id', () => {
    it('updates a deal', async () => {
      const dealId = '99999999-9999-9999-9999-999999999999';
      const existing = {
        id: dealId,
        organization_id: TEST_ORG_ID,
        title: 'Old Title',
        value: 100,
        currency: 'USD',
        contact_id: null,
        owner_id: TEST_USER_ID,
        company_id: null,
        description: null,
        probability: null,
        expected_close_date: null,
        comments: null,
      };
      const updated = { ...existing, title: 'Updated Title' };

      db.read.query.mockResolvedValueOnce({ rows: [existing], rowCount: 1 });
      db.write.query.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

      const res = await inject({
        method: 'PUT',
        url: `/api/crm/deals/${dealId}`,
        headers: authHeaders,
        payload: { title: 'Updated Title' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.title).toBe('Updated Title');
      expect(rabbitmq.getPublishedEvents()).toHaveLength(1);
    });

    it('returns 404 when deal not found', async () => {
      db.read.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await inject({
        method: 'PUT',
        url: '/api/crm/deals/99999999-9999-9999-9999-999999999999',
        headers: authHeaders,
        payload: { title: 'Updated' },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('not found');
    });
  });

  describe('PATCH /api/crm/deals/:id/stage', () => {
    it('updates deal stage', async () => {
      const dealId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
      const newStageId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
      const deal = {
        id: dealId,
        organization_id: TEST_ORG_ID,
        pipeline_id: PIPELINE_ID,
        stage_id: STAGE_ID,
        history: [],
      };

      db.write.query
        .mockResolvedValueOnce({ rows: [deal], rowCount: 1 })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      const res = await inject({
        method: 'PATCH',
        url: `/api/crm/deals/${dealId}/stage`,
        headers: authHeaders,
        payload: { stageId: newStageId },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({ success: true });
      expect(rabbitmq.getPublishedEvents()).toHaveLength(1);
    });

    it('returns 404 when deal not found', async () => {
      db.write.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await inject({
        method: 'PATCH',
        url: '/api/crm/deals/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/stage',
        headers: authHeaders,
        payload: { stageId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('not found');
    });
  });

  describe('DELETE /api/crm/deals/:id', () => {
    it('deletes a deal', async () => {
      const dealId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
      db.read.query.mockResolvedValueOnce({ rows: [{ 1: 1 }], rowCount: 1 });
      db.write.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      const res = await inject({
        method: 'DELETE',
        url: `/api/crm/deals/${dealId}`,
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(204);
    });

    it('returns 404 when deal not found', async () => {
      db.read.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await inject({
        method: 'DELETE',
        url: '/api/crm/deals/dddddddd-dddd-dddd-dddd-dddddddddddd',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('not found');
    });
  });
});
