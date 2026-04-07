import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestApp, createMockDb, createMockRabbitMQ } from '@getsale/test-utils-v2';
import { registerContactRoutes } from './contacts';

const TEST_ORG_ID = '11111111-1111-1111-1111-111111111111';
const TEST_USER_ID = '22222222-2222-2222-2222-222222222222';

const authHeaders = {
  'x-user-id': TEST_USER_ID,
  'x-organization-id': TEST_ORG_ID,
  'x-user-role': 'owner',
  'content-type': 'application/json',
};

const mockContactsCache = {
  get: vi.fn().mockResolvedValue(null),
  set: vi.fn().mockResolvedValue(undefined),
  invalidatePattern: vi.fn().mockResolvedValue(undefined),
};

describe('Contacts Routes (v2 Fastify)', () => {
  let inject: Awaited<ReturnType<typeof createTestApp>>['inject'];
  let db: ReturnType<typeof createMockDb>;
  let rabbitmq: ReturnType<typeof createMockRabbitMQ>;

  beforeEach(async () => {
    vi.clearAllMocks();
    db = createMockDb();
    rabbitmq = createMockRabbitMQ();

    const { inject: inj } = await createTestApp((app) =>
      registerContactRoutes(app, {
        db,
        rabbitmq,
        log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any,
        contactsCache: mockContactsCache as any,
      } as any),
    );
    inject = inj;
  });

  describe('GET /api/crm/contacts/:id', () => {
    it('returns contact with telegramGroups when present', async () => {
      const contactId = '33333333-3333-3333-3333-333333333333';
      const contactRow = {
        id: contactId,
        organization_id: TEST_ORG_ID,
        first_name: 'John',
        last_name: 'Doe',
        company_name: 'Acme',
      };

      db.read.query
        .mockResolvedValueOnce({ rows: [contactRow], rowCount: 1 })
        .mockResolvedValueOnce({
          rows: [
            { telegram_chat_id: '-100123', telegram_chat_title: 'Group A' },
            { telegram_chat_id: '-100456', telegram_chat_title: null },
          ],
          rowCount: 2,
        });

      const res = await inject({
        method: 'GET',
        url: `/api/crm/contacts/${contactId}`,
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.id).toBe(contactId);
      expect(body.first_name).toBe('John');
      expect(body.companyName).toBe('Acme');
      expect(body.telegramGroups).toHaveLength(2);
      expect(body.telegramGroups[0]).toEqual({ telegram_chat_id: '-100123', telegram_chat_title: 'Group A' });
      expect(body.telegramGroups[1].telegram_chat_id).toBe('-100456');
    });

    it('returns 404 when contact not found', async () => {
      db.read.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await inject({
        method: 'GET',
        url: '/api/crm/contacts/33333333-3333-3333-3333-333333333333',
        headers: authHeaders,
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('not found');
    });
  });

  describe('POST /api/crm/contacts/import-from-telegram-group', () => {
    it('returns 404 when BD account not in org', async () => {
      db.read.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await inject({
        method: 'POST',
        url: '/api/crm/contacts/import-from-telegram-group',
        headers: authHeaders,
        payload: {
          bdAccountId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          telegramChatId: '-100123',
          telegramChatTitle: 'Test Group',
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('not found');
    });

    it('returns queued status when BD account is valid', async () => {
      db.read.query.mockResolvedValueOnce({ rows: [{ id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' }], rowCount: 1 });

      const res = await inject({
        method: 'POST',
        url: '/api/crm/contacts/import-from-telegram-group',
        headers: authHeaders,
        payload: {
          bdAccountId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          telegramChatId: '-100123',
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.status).toBe('queued');
      expect(body.taskId).toBeDefined();
    });
  });
});
