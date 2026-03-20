import { beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import { createLogger } from '@getsale/logger';
import { createMockPool, createTestApp } from '@getsale/test-utils';
import { Router } from 'express';
import { registerSendRoutes } from './messages-send';

const TEST_ORG_ID = '11111111-1111-1111-1111-111111111111';
const TEST_USER_ID = '22222222-2222-2222-2222-222222222222';
const TEST_CONTACT_ID = '33333333-3333-3333-3333-333333333333';
const TEST_BD_ACCOUNT_ID = '44444444-4444-4444-4444-444444444444';

describe('messages-send campaign username fallback', () => {
  let pool: ReturnType<typeof createMockPool>;
  let app: ReturnType<typeof createTestApp>;
  let postMock: ReturnType<typeof vi.fn>;
  let insertedMessage: Record<string, unknown> | null;

  beforeEach(() => {
    vi.clearAllMocks();
    insertedMessage = null;
    pool = createMockPool();
    postMock = vi.fn();
    const log = createLogger('messaging-service-test');
    const rabbitmq = { publishEvent: vi.fn().mockResolvedValue(undefined) } as any;
    const bdAccountsClient = { post: postMock } as any;

    pool.query.mockImplementation(async (sql: string, params?: any[]) => {
      if (sql.includes('SELECT id, organization_id, telegram_id, first_name, last_name, username FROM contacts')) {
        return { rows: [{ id: TEST_CONTACT_ID, organization_id: TEST_ORG_ID, telegram_id: '123456789', username: 'john_user' }], rowCount: 1 };
      }
      if (sql.includes("metadata->>'idempotencyKey'")) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO conversations')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('UPDATE conversations c SET lead_id')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO messages')) {
        insertedMessage = {
          id: 'msg-1',
          organization_id: params?.[0],
          bd_account_id: params?.[1],
          channel: params?.[2],
          channel_id: params?.[3],
          content: params?.[6],
          telegram_message_id: params?.[11],
          created_at: new Date().toISOString(),
        };
        return { rows: [insertedMessage], rowCount: 1 };
      }
      if (sql.includes('SELECT * FROM messages WHERE id = $1')) {
        return { rows: [insertedMessage], rowCount: insertedMessage ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    });

    postMock
      .mockRejectedValueOnce(new Error('User or chat not found'))
      .mockResolvedValueOnce({ messageId: '999', date: 1_710_000_000 });

    const router = Router();
    registerSendRoutes(router, { pool, rabbitmq, log, bdAccountsClient });
    app = createTestApp(router, { prefix: '/api/messaging', log });
  });

  it('retries campaign send once with contact username when entity is not found', async () => {
    const res = await request(app)
      .post('/api/messaging/send')
      .set('x-user-id', TEST_USER_ID)
      .set('x-organization-id', TEST_ORG_ID)
      .set('x-user-role', 'owner')
      .send({
        contactId: TEST_CONTACT_ID,
        channel: 'telegram',
        channelId: '123456789',
        content: 'Hello',
        bdAccountId: TEST_BD_ACCOUNT_ID,
        source: 'campaign',
        idempotencyKey: 'idem-1',
      });

    expect(res.status).toBe(200);
    expect(postMock).toHaveBeenCalledTimes(2);
    expect(postMock.mock.calls[0]?.[1]?.chatId).toBe('123456789');
    expect(postMock.mock.calls[1]?.[1]?.chatId).toBe('john_user');
    expect(res.body.channel_id).toBe('john_user');
  });
});

