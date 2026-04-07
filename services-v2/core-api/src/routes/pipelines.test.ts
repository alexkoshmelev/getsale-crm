import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestApp, createMockDb } from '@getsale/test-utils-v2';
import { registerPipelineRoutes } from './pipelines';

const TEST_ORG_ID = '11111111-1111-1111-1111-111111111111';
const TEST_USER_ID = '22222222-2222-2222-2222-222222222222';

const authHeaders = {
  'x-user-id': TEST_USER_ID,
  'x-organization-id': TEST_ORG_ID,
  'x-user-role': 'owner',
  'content-type': 'application/json',
};

const mockPipelineCache = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  invalidatePattern: vi.fn().mockResolvedValue(undefined),
};

describe('Pipelines Routes (v2 Fastify)', () => {
  let inject: Awaited<ReturnType<typeof createTestApp>>['inject'];
  let db: ReturnType<typeof createMockDb>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();

    const { inject: inj } = await createTestApp((app) =>
      registerPipelineRoutes(app, {
        db,
        pipelineCache: mockPipelineCache as any,
      } as any),
    );
    inject = inj;
  });

  describe('GET /api/pipeline', () => {
    it('returns pipelines for org', async () => {
      db.read.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await inject({ method: 'GET', url: '/api/pipeline', headers: authHeaders });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual([]);
    });

    it('returns pipelines list', async () => {
      const mockPipelines = [{
        id: '33333333-3333-3333-3333-333333333333',
        organization_id: TEST_ORG_ID,
        name: 'Sales Pipeline',
        description: 'Main sales flow',
        is_default: true,
      }];
      db.read.query.mockResolvedValueOnce({ rows: mockPipelines, rowCount: 1 });

      const res = await inject({ method: 'GET', url: '/api/pipeline', headers: authHeaders });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveLength(1);
      expect(body[0].name).toBe('Sales Pipeline');
    });
  });

  describe('POST /api/pipeline', () => {
    it('creates pipeline with default stages', async () => {
      const created = {
        id: '44444444-4444-4444-4444-444444444444',
        organization_id: TEST_ORG_ID,
        name: 'New Pipeline',
        description: null,
        is_default: false,
      };

      db.write.query
        .mockResolvedValueOnce({ rows: [created], rowCount: 1 });
      // 8 default stage inserts
      for (let i = 0; i < 8; i++) {
        db.write.query.mockResolvedValueOnce(undefined);
      }

      const res = await inject({
        method: 'POST',
        url: '/api/pipeline',
        headers: authHeaders,
        payload: { name: 'New Pipeline' },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.name).toBe('New Pipeline');
      expect(body.id).toBe(created.id);
    });

    it('creates pipeline with custom name and description', async () => {
      const created = {
        id: '55555555-5555-5555-5555-555555555555',
        organization_id: TEST_ORG_ID,
        name: 'Custom Pipeline',
        description: 'For testing',
        is_default: true,
      };

      db.write.query
        .mockResolvedValueOnce(undefined) // UPDATE is_default
        .mockResolvedValueOnce({ rows: [created], rowCount: 1 }); // INSERT pipeline
      for (let i = 0; i < 8; i++) {
        db.write.query.mockResolvedValueOnce(undefined);
      }

      const res = await inject({
        method: 'POST',
        url: '/api/pipeline',
        headers: authHeaders,
        payload: { name: 'Custom Pipeline', description: 'For testing', isDefault: true },
      });

      expect(res.statusCode).toBe(201);
      const body = JSON.parse(res.body);
      expect(body.name).toBe('Custom Pipeline');
      expect(body.description).toBe('For testing');
      expect(body.is_default).toBe(true);
    });
  });

  describe('DELETE /api/pipeline/:id', () => {
    it('returns 404 when pipeline not found', async () => {
      db.read.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await inject({
        method: 'DELETE',
        url: '/api/pipeline/44444444-4444-4444-4444-444444444444',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(404);
    });

    it('deletes a pipeline', async () => {
      db.read.query.mockResolvedValueOnce({ rows: [{ id: '44444444-4444-4444-4444-444444444444' }], rowCount: 1 });
      db.write.query
        .mockResolvedValueOnce(undefined) // DELETE leads
        .mockResolvedValueOnce(undefined) // DELETE stages
        .mockResolvedValueOnce(undefined); // DELETE pipelines

      const res = await inject({
        method: 'DELETE',
        url: '/api/pipeline/44444444-4444-4444-4444-444444444444',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(204);
    });
  });
});
