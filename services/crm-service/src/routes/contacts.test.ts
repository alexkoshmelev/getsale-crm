import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { createTestApp, createMockPool, createMockRabbitMQ } from '@getsale/test-utils';
import { createLogger } from '@getsale/logger';
import { contactsRouter } from './contacts';

const TEST_ORG_ID = '11111111-1111-1111-1111-111111111111';
const TEST_USER_ID = '22222222-2222-2222-2222-222222222222';
const TEST_BD_ACCOUNT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const authHeaders = {
  'x-user-id': TEST_USER_ID,
  'x-organization-id': TEST_ORG_ID,
  'x-user-role': 'owner',
  'content-type': 'application/json',
};

describe('Contacts Router', () => {
  let pool: ReturnType<typeof createMockPool>;
  let rabbitmq: ReturnType<typeof createMockRabbitMQ>;
  let app: ReturnType<typeof createTestApp>;

  beforeEach(() => {
    vi.clearAllMocks();
    pool = createMockPool();
    rabbitmq = createMockRabbitMQ();
    const log = createLogger('crm-service-contacts-test');
    const router = contactsRouter({ pool, rabbitmq, log });
    app = createTestApp(router, { prefix: '/api/crm/contacts', log });
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
      pool.query.mockImplementationOnce(async () => ({
        rows: [contactRow],
        rowCount: 1,
      }));
      pool.query.mockImplementationOnce(async () => ({
        rows: [
          { telegram_chat_id: '-100123', telegram_chat_title: 'Group A' },
          { telegram_chat_id: '-100456', telegram_chat_title: null },
        ],
        rowCount: 2,
      }));

      const res = await request(app)
        .get(`/api/crm/contacts/${contactId}`)
        .set(authHeaders);

      expect(res.status).toBe(200);
      expect(res.body.id).toBe(contactId);
      expect(res.body.first_name).toBe('John');
      expect(res.body.companyName).toBe('Acme');
      expect(res.body.telegramGroups).toHaveLength(2);
      expect(res.body.telegramGroups[0]).toEqual({ telegram_chat_id: '-100123', telegram_chat_title: 'Group A' });
      expect(res.body.telegramGroups[1].telegram_chat_id).toBe('-100456');
      expect(res.body.telegramGroups[1].telegram_chat_title).toBeUndefined();
    });

    it('returns 404 when contact not found', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app)
        .get('/api/crm/contacts/33333333-3333-3333-3333-333333333333')
        .set(authHeaders);

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('not found');
    });
  });

  describe('POST /api/crm/contacts/import-from-telegram-group', () => {
    it('returns 503 when bdAccountsClient not configured', async () => {
      const res = await request(app)
        .post('/api/crm/contacts/import-from-telegram-group')
        .set(authHeaders)
        .send({
          bdAccountId: TEST_BD_ACCOUNT_ID,
          telegramChatId: '-100123',
        });

      expect(res.status).toBe(503);
      expect(res.body.error).toContain('not configured');
    });

    it('returns 400 when body is invalid', async () => {
      const log = createLogger('crm-service-contacts-test');
      const router = contactsRouter({
        pool,
        rabbitmq,
        log,
        bdAccountsClient: { request: vi.fn() } as any,
      });
      const appWithClient = createTestApp(router, { prefix: '/api/crm/contacts', log });

      const res = await request(appWithClient)
        .post('/api/crm/contacts/import-from-telegram-group')
        .set(authHeaders)
        .send({});

      expect(res.status).toBe(400);
    });

    it('returns 404 when BD account not in org', async () => {
      const bdAccountsClient = { request: vi.fn() } as any;
      const log = createLogger('crm-service-contacts-test');
      const router = contactsRouter({ pool, rabbitmq, log, bdAccountsClient });
      const appWithClient = createTestApp(router, { prefix: '/api/crm/contacts', log });

      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(appWithClient)
        .post('/api/crm/contacts/import-from-telegram-group')
        .set(authHeaders)
        .send({
          bdAccountId: TEST_BD_ACCOUNT_ID,
          telegramChatId: '-100123',
          telegramChatTitle: 'Test Group',
        });

      expect(res.status).toBe(404);
      expect(res.body.error).toContain('BD account');
      expect(bdAccountsClient.request).not.toHaveBeenCalled();
    });

    it('imports participants and returns contactIds, created, matched', async () => {
      const bdAccountsClient = {
        request: vi.fn().mockResolvedValue({
          users: [
            { telegram_id: '111', first_name: 'Alice', last_name: 'A', username: 'alice' },
            { telegram_id: '222', first_name: 'Bob', last_name: null, username: null },
          ],
          nextOffset: null,
        }),
      } as any;
      const log = createLogger('crm-service-contacts-test');
      const router = contactsRouter({ pool, rabbitmq, log, bdAccountsClient });
      const appWithClient = createTestApp(router, { prefix: '/api/crm/contacts', log });

      pool.query.mockImplementationOnce(async () => ({ rows: [{ id: TEST_BD_ACCOUNT_ID }], rowCount: 1 }));
      pool.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));
      pool.query.mockImplementationOnce(async () => ({
        rows: [
          { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaa1111', telegram_id: '111' },
          { id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbb2222', telegram_id: '222' },
        ],
        rowCount: 2,
      }));
      pool.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

      const res = await request(appWithClient)
        .post('/api/crm/contacts/import-from-telegram-group')
        .set(authHeaders)
        .send({
          bdAccountId: TEST_BD_ACCOUNT_ID,
          telegramChatId: '-100123',
          telegramChatTitle: 'Test Group',
          searchKeyword: 'crypto',
        });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        contactIds: expect.any(Array),
        created: 2,
        matched: 0,
      });
      expect(res.body.contactIds).toHaveLength(2);
      expect(bdAccountsClient.request).toHaveBeenCalledWith(
        expect.stringContaining('/participants'),
        expect.any(Object)
      );
    });

    it('sends excludeAdmins and leaveAfter and calls leave after import', async () => {
      const bdAccountsClient = {
        request: vi.fn()
          .mockResolvedValueOnce({ users: [{ telegram_id: '111', first_name: 'A', last_name: null, username: null }], nextOffset: null })
          .mockResolvedValueOnce(undefined),
      } as any;
      const log = createLogger('crm-service-contacts-test');
      const router = contactsRouter({ pool, rabbitmq, log, bdAccountsClient });
      const appWithClient = createTestApp(router, { prefix: '/api/crm/contacts', log });

      pool.query.mockImplementationOnce(async () => ({ rows: [{ id: TEST_BD_ACCOUNT_ID }], rowCount: 1 }));
      pool.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));
      pool.query.mockImplementationOnce(async () => ({
        rows: [{ id: 'cccccccc-cccc-cccc-cccc-cccccccc1111', telegram_id: '111' }],
        rowCount: 1,
      }));
      pool.query.mockImplementationOnce(async () => ({ rows: [], rowCount: 0 }));

      const res = await request(appWithClient)
        .post('/api/crm/contacts/import-from-telegram-group')
        .set(authHeaders)
        .send({
          bdAccountId: TEST_BD_ACCOUNT_ID,
          telegramChatId: '-100123',
          telegramChatTitle: 'Test',
          excludeAdmins: true,
          leaveAfter: true,
        });

      expect(res.status).toBe(200);
      expect(res.body.created).toBe(1);
      const participantCall = (bdAccountsClient.request as any).mock.calls.find((c: any) => String(c[0]).includes('/participants'));
      expect(participantCall[0]).toContain('excludeAdmins=true');
      const leaveCall = (bdAccountsClient.request as any).mock.calls.find((c: any) => String(c[0]).includes('/leave'));
      expect(leaveCall).toBeDefined();
    });
  });
});
