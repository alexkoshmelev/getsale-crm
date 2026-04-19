import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestApp, createMockDb, createMockRabbitMQ } from '@getsale/test-utils';
import { registerCompanyRoutes } from './companies';

const TEST_ORG_ID = '11111111-1111-4111-8111-111111111111';
const TEST_USER_ID = '22222222-2222-4222-8222-222222222222';

const authHeaders = {
  'x-user-id': TEST_USER_ID,
  'x-organization-id': TEST_ORG_ID,
  'x-user-role': 'owner',
};

const jsonAuthHeaders = { ...authHeaders, 'content-type': 'application/json' };

describe('Companies Routes (Fastify)', () => {
  let inject: Awaited<ReturnType<typeof createTestApp>>['inject'];
  let db: ReturnType<typeof createMockDb>;
  let rabbitmq: ReturnType<typeof createMockRabbitMQ>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    rabbitmq = createMockRabbitMQ();

    const { inject: inj } = await createTestApp((app) =>
      registerCompanyRoutes(app, { db, rabbitmq, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any } as any),
    );
    inject = inj;
  });

  describe('GET /api/crm/companies', () => {
    it('returns companies for org', async () => {
      db.read.query
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [{ count: '0' }], rowCount: 1 });

      const res = await inject({ method: 'GET', url: '/api/crm/companies', headers: authHeaders });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({ items: [], pagination: { page: 1, total: 0 } });
    });

    it('returns paginated companies', async () => {
      const mockCompanies = [{
        id: '33333333-3333-4333-a333-333333333333',
        organization_id: TEST_ORG_ID,
        name: 'Acme Corp',
        industry: 'Tech',
      }];

      db.read.query
        .mockResolvedValueOnce({ rows: mockCompanies, rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 });

      const res = await inject({
        method: 'GET',
        url: '/api/crm/companies?page=1&limit=10',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].name).toBe('Acme Corp');
      expect(body.pagination).toMatchObject({ page: 1, limit: 10, total: 1, totalPages: 1 });
    });
  });

  describe('POST /api/crm/companies', () => {
    it('creates a company', async () => {
      const created = {
        id: '44444444-4444-4444-8444-444444444444',
        organization_id: TEST_ORG_ID,
        name: 'New Company',
        industry: 'Retail',
      };
      db.write.query.mockResolvedValueOnce({ rows: [created], rowCount: 1 });

      const res = await inject({
        method: 'POST',
        url: '/api/crm/companies',
        headers: jsonAuthHeaders,
        payload: { name: 'New Company', industry: 'Retail' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.name).toBe('New Company');
      expect(body.industry).toBe('Retail');
      expect(rabbitmq.getPublishedEvents()).toHaveLength(1);
      expect(rabbitmq.getPublishedEvents()[0].event.type).toBe('company.created');
    });
  });

  describe('PUT /api/crm/companies/:id', () => {
    it('updates a company', async () => {
      const companyId = '55555555-5555-4555-a555-555555555555';
      const existing = { id: companyId, organization_id: TEST_ORG_ID, name: 'Old Name', industry: 'Tech' };
      const updated = { ...existing, name: 'Updated Name' };

      db.read.query.mockResolvedValueOnce({ rows: [existing], rowCount: 1 });
      db.write.query.mockResolvedValueOnce({ rows: [updated], rowCount: 1 });

      const res = await inject({
        method: 'PUT',
        url: `/api/crm/companies/${companyId}`,
        headers: jsonAuthHeaders,
        payload: { name: 'Updated Name' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.name).toBe('Updated Name');
      expect(rabbitmq.getPublishedEvents()).toHaveLength(1);
    });

    it('returns 404 when company not found', async () => {
      db.read.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await inject({
        method: 'PUT',
        url: '/api/crm/companies/55555555-5555-4555-a555-555555555555',
        headers: jsonAuthHeaders,
        payload: { name: 'Updated' },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/not found/i);
    });
  });

  describe('DELETE /api/crm/companies/:id', () => {
    it('deletes a company', async () => {
      const companyId = '66666666-6666-4666-a666-666666666666';
      let q = 0;
      db.read.query.mockImplementation(async () => {
        q += 1;
        if (q === 1) return { rows: [{ id: companyId }], rowCount: 1 };
        if (q === 2) return { rows: [{ c: 0 }], rowCount: 1 };
        if (q === 3) return { rows: [], rowCount: 0 };
        return { rows: [], rowCount: 0 };
      });

      const res = await inject({
        method: 'DELETE',
        url: `/api/crm/companies/${companyId}`,
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(204);
    });

    it('returns 404 when company not found', async () => {
      db.read.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await inject({
        method: 'DELETE',
        url: '/api/crm/companies/66666666-6666-4666-a666-666666666666',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(404);
    });

    it('returns 409 when company has deals', async () => {
      const companyId = '66666666-6666-4666-a666-666666666666';
      let q = 0;
      db.read.query.mockImplementation(async () => {
        q += 1;
        if (q === 1) return { rows: [{ id: companyId }], rowCount: 1 };
        if (q === 2) return { rows: [{ c: 3 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      });

      const res = await inject({
        method: 'DELETE',
        url: `/api/crm/companies/${companyId}`,
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(409);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('deals');
    });
  });
});
