import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockPool, createMockRabbitMQ } from '@getsale/test-utils';
import { createLogger } from '@getsale/logger';
import { dealsRouter } from './deals';

const TEST_ORG_ID = '11111111-1111-1111-1111-111111111111';
const TEST_USER_ID = '22222222-2222-2222-2222-222222222222';
const PIPELINE_ID = '33333333-3333-3333-3333-333333333333';
const STAGE_ID = '44444444-4444-4444-4444-444444444444';
const COMPANY_ID = '55555555-5555-5555-5555-555555555555';
const LEAD_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const CONTACT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CONVERTED_STAGE_ID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

const authHeaders = {
  'x-user-id': TEST_USER_ID,
  'x-organization-id': TEST_ORG_ID,
  'x-user-role': 'owner',
  'content-type': 'application/json',
};

const mockCounter = () => ({ inc: vi.fn() });

describe('Deals Router', () => {
  let pool: ReturnType<typeof createMockPool>;
  let rabbitmq: ReturnType<typeof createMockRabbitMQ>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = createMockPool();
    rabbitmq = createMockRabbitMQ();
    const log = createLogger('crm-service-test');
    const router = dealsRouter({
      pool,
      rabbitmq,
      log,
      dealCreatedTotal: mockCounter() as never,
      dealStageChangedTotal: mockCounter() as never,
    });
    app = createTestApp(router, { prefix: '/api/crm/deals', log });
  });

  describe('GET /api/crm/deals', () => {
    it('returns deals list with pagination', async () => {
      pool.query.mockImplementationOnce(async () => ({ rows: [{ total: 0 }], rowCount: 1 }));
      pool.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

      const res = await request(app)
        .get('/api/crm/deals')
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        items: [],
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      });
    });

    it('returns paginated deals', async () => {
      const mockDeals = [
        {
          id: '66666666-6666-6666-6666-666666666666',
          organization_id: TEST_ORG_ID,
          title: 'Deal One',
          pipeline_id: PIPELINE_ID,
          stage_id: STAGE_ID,
          value: 1000,
          company_name: 'Acme',
          pipeline_name: 'Sales',
          stage_name: 'Proposal',
        },
      ];
      pool.query.mockImplementationOnce(async () => ({ rows: [{ total: 1 }], rowCount: 1 }));
      pool.query.mockImplementationOnce(async () => ({ rows: mockDeals, rowCount: 1 }));

      const res = await request(app)
        .get('/api/crm/deals?page=1&limit=10')
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(1);
      expect(res.body.items[0].title).toBe('Deal One');
      expect(res.body.pagination).toMatchObject({ page: 1, limit: 10, total: 1, totalPages: 1 });
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
      pool.query.mockResolvedValueOnce({ rows: [row], rowCount: 1 });

      const res = await request(app)
        .get(`/api/crm/deals/${dealId}`)
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Single Deal');
    });

    it('returns 404 when deal not found', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app)
        .get('/api/crm/deals/77777777-7777-7777-7777-777777777777')
        .set(authHeaders);

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });
  });

  describe('POST /api/crm/deals', () => {
    it('creates a deal with pipeline and company', async () => {
      const created = {
        id: '88888888-8888-8888-8888-888888888888',
        organization_id: TEST_ORG_ID,
        company_id: COMPANY_ID,
        pipeline_id: PIPELINE_ID,
        stage_id: STAGE_ID,
        title: 'New Deal',
        value: 5000,
        currency: 'USD',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      pool.query
        .mockResolvedValueOnce({ rows: [{ 1: 1 }], rowCount: 1 }) // company check
        .mockResolvedValueOnce({ rows: [{ 1: 1 }], rowCount: 1 }) // pipeline check
        .mockResolvedValueOnce({ rows: [{ id: STAGE_ID }], rowCount: 1 }) // getFirstStageId
        .mockResolvedValueOnce({ rows: [created], rowCount: 1 }); // INSERT deal

      const res = await request(app)
        .post('/api/crm/deals')
        .set(authHeaders)
        .send({
          title: 'New Deal',
          pipelineId: PIPELINE_ID,
          companyId: COMPANY_ID,
          value: 5000,
          currency: 'USD',
        });

      expect(res.status).toBe(201);
      expect(res.body.title).toBe('New Deal');
      expect(res.body.value).toBe(5000);
      expect(rabbitmq.getPublishedEvents()).toHaveLength(1);
      expect(rabbitmq.getPublishedEvents()[0].event.type).toBe('deal.created');
    });

    it('returns 400 when pipelineId missing', async () => {
      const res = await request(app)
        .post('/api/crm/deals')
        .set(authHeaders)
        .send({
          title: 'No Pipeline',
          companyId: COMPANY_ID,
        });

      expect(res.status).toBe(400);
    });

    it('returns 400 when title missing', async () => {
      const res = await request(app)
        .post('/api/crm/deals')
        .set(authHeaders)
        .send({
          pipelineId: PIPELINE_ID,
          companyId: COMPANY_ID,
        });

      expect(res.status).toBe(400);
    });

    it('returns 400 when pipeline not found', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ 1: 1 }], rowCount: 1 }) // company check
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // pipeline check

      const res = await request(app)
        .post('/api/crm/deals')
        .set(authHeaders)
        .send({
          title: 'Deal',
          pipelineId: '00000000-0000-0000-0000-000000000000',
          companyId: COMPANY_ID,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/pipeline|not found|access denied/i);
    });

    it('returns 400 when pipeline has no stages', async () => {
      pool.query
        .mockResolvedValueOnce({ rows: [{ 1: 1 }], rowCount: 1 }) // company check
        .mockResolvedValueOnce({ rows: [{ 1: 1 }], rowCount: 1 }) // pipeline check
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }); // getFirstStageId returns no stage

      const res = await request(app)
        .post('/api/crm/deals')
        .set(authHeaders)
        .send({
          title: 'Deal',
          pipelineId: PIPELINE_ID,
          companyId: COMPANY_ID,
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/stage|pipeline/i);
    });

    it('creates a deal from lead (leadId)', async () => {
      const lead = {
        id: LEAD_ID,
        contact_id: CONTACT_ID,
        pipeline_id: PIPELINE_ID,
        stage_id: STAGE_ID,
      };
      const createdDeal = {
        id: '88888888-8888-8888-8888-888888888888',
        organization_id: TEST_ORG_ID,
        company_id: null,
        contact_id: CONTACT_ID,
        pipeline_id: PIPELINE_ID,
        stage_id: STAGE_ID,
        lead_id: LEAD_ID,
        title: 'Deal From Lead',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      pool.query
        .mockResolvedValueOnce({ rows: [lead], rowCount: 1 }) // SELECT lead
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // existing deal check
        .mockResolvedValueOnce({ rows: [{ id: CONVERTED_STAGE_ID }], rowCount: 1 }) // Converted stage
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT company_id FROM contacts (no company)
        .mockResolvedValueOnce({ rows: [{ id: STAGE_ID }], rowCount: 1 }) // getFirstStageId
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [createdDeal], rowCount: 1 }) // INSERT deal
        .mockResolvedValueOnce(undefined) // UPDATE leads
        .mockResolvedValueOnce(undefined) // INSERT stage_history
        .mockResolvedValueOnce(undefined); // COMMIT

      const res = await request(app)
        .post('/api/crm/deals')
        .set(authHeaders)
        .send({
          title: 'Deal From Lead',
          leadId: LEAD_ID,
        });

      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Deal From Lead');
      expect(res.body.leadId).toBe(LEAD_ID);
      expect(rabbitmq.getPublishedEvents().length).toBeGreaterThanOrEqual(1);
      expect(rabbitmq.getPublishedEvents().some((e) => e.event.type === 'deal.created')).toBe(true);
    });

    it('creates a deal with contactId only (resolves company from contact)', async () => {
      const CONTACT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
      const created = {
        id: '88888888-8888-8888-8888-888888888888',
        organization_id: TEST_ORG_ID,
        company_id: COMPANY_ID,
        contact_id: CONTACT_ID,
        pipeline_id: PIPELINE_ID,
        stage_id: STAGE_ID,
        title: 'Contact Deal',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      pool.query
        .mockResolvedValueOnce({ rows: [{ company_id: COMPANY_ID }], rowCount: 1 }) // SELECT company_id FROM contacts
        .mockResolvedValueOnce({ rows: [{ 1: 1 }], rowCount: 1 }) // pipeline check
        .mockResolvedValueOnce({ rows: [{ id: STAGE_ID }], rowCount: 1 }) // getFirstStageId
        .mockResolvedValueOnce({ rows: [{ 1: 1 }], rowCount: 1 }) // contact check
        .mockResolvedValueOnce({ rows: [created], rowCount: 1 }); // INSERT

      const res = await request(app)
        .post('/api/crm/deals')
        .set(authHeaders)
        .send({
          title: 'Contact Deal',
          pipelineId: PIPELINE_ID,
          contactId: CONTACT_ID,
        });

      expect(res.status).toBe(201);
      expect(res.body.title).toBe('Contact Deal');
      expect(res.body.contact_id).toBe(CONTACT_ID);
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
        probability: null,
        expected_close_date: null,
        comments: null,
      };
      const updated = { ...existing, title: 'Updated Title', updated_at: new Date().toISOString() };
      pool.query
        .mockResolvedValueOnce({ rows: [existing], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

      const res = await request(app)
        .put(`/api/crm/deals/${dealId}`)
        .set(authHeaders)
        .send({ title: 'Updated Title' });

      expect(res.status).toBe(200);
      expect(res.body.title).toBe('Updated Title');
      expect(rabbitmq.getPublishedEvents()).toHaveLength(1);
    });

    it('returns 404 when deal not found', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app)
        .put('/api/crm/deals/99999999-9999-9999-9999-999999999999')
        .set(authHeaders)
        .send({ title: 'Updated' });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
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
      pool.query
        .mockResolvedValueOnce({ rows: [deal], rowCount: 1 }) // get deal
        .mockResolvedValueOnce({ rows: [{ 1: 1 }], rowCount: 1 }) // ensureStageInPipeline
        .mockResolvedValueOnce(undefined) // UPDATE deals
        .mockResolvedValueOnce(undefined); // INSERT stage_history

      const res = await request(app)
        .patch(`/api/crm/deals/${dealId}/stage`)
        .set(authHeaders)
        .send({ stageId: newStageId });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ success: true });
      expect(rabbitmq.getPublishedEvents()).toHaveLength(1);
    });

    it('returns 404 when deal not found', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app)
        .patch('/api/crm/deals/aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/stage')
        .set(authHeaders)
        .send({ stageId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });
  });

  describe('DELETE /api/crm/deals/:id', () => {
    it('deletes a deal', async () => {
      const dealId = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
      pool.query
        .mockResolvedValueOnce({ rows: [{ 1: 1 }], rowCount: 1 }) // existing check
        .mockResolvedValueOnce(undefined) // DELETE stage_history
        .mockResolvedValueOnce(undefined); // DELETE deals

      const res = await request(app)
        .delete(`/api/crm/deals/${dealId}`)
        .set(authHeaders);

      expect(res.status).toBe(204);
    });

    it('returns 404 when deal not found', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app)
        .delete('/api/crm/deals/dddddddd-dddd-dddd-dddd-dddddddddddd')
        .set(authHeaders);

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });
  });
});
