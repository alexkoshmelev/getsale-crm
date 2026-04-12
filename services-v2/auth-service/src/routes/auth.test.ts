import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import bcrypt from 'bcryptjs';
import { createTestApp, createMockPool, createMockRabbitMQ, createMockRedis } from '@getsale/test-utils-v2';
import { signAccessToken, signRefreshToken, hashRefreshToken } from '../helpers';
import { AUTH_COOKIE_ACCESS, AUTH_COOKIE_REFRESH } from '../cookies';
import { registerAuthRoutes } from './auth';

const TEST_ORG_ID = '11111111-1111-4111-8111-111111111111';
const TEST_USER_ID = '22222222-2222-4222-8222-222222222222';

describe('Auth Router (v2 Fastify)', () => {
  let inject: Awaited<ReturnType<typeof createTestApp>>['inject'];
  let pool: ReturnType<typeof createMockPool>;
  let rabbitmq: ReturnType<typeof createMockRabbitMQ>;
  let redis: ReturnType<typeof createMockRedis>;

  beforeEach(async () => {
    vi.clearAllMocks();
    pool = createMockPool();
    rabbitmq = createMockRabbitMQ();
    redis = createMockRedis();

    const { inject: inj } = await createTestApp(
      (app) => registerAuthRoutes(app, { pool, rabbitmq, log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any, redis: redis as any }),
      { cookieParser: true },
    );
    inject = inj;
  });

  describe('POST /api/auth/signup', () => {
    it('returns 400 when email and password are missing', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/auth/signup',
        headers: { 'content-type': 'application/json' },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/validation/i);
    });

    it('returns 400 when email is invalid', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/auth/signup',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'not-an-email', password: 'password123' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 400 when password is too short', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/auth/signup',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'user@example.com', password: 'short' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 200 and sets auth cookies on successful signup', async () => {
      const org = { id: TEST_ORG_ID, name: 'Test Org' };
      const user = { id: TEST_USER_ID, email: 'new@example.com', organization_id: TEST_ORG_ID, role: 'owner' };

      pool.query
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({ rows: [], rowCount: 0 })
        .mockResolvedValueOnce({ rows: [org], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [user], rowCount: 1 })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      const res = await inject({
        method: 'POST',
        url: '/api/auth/signup',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'new@example.com', password: 'Password123' },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.user).toMatchObject({ email: 'new@example.com', id: TEST_USER_ID });
      const cookies = res.headers['set-cookie'];
      expect(cookies).toBeDefined();
      const cookieArr = Array.isArray(cookies) ? cookies : [cookies];
      expect(cookieArr.some((c) => c?.includes('access_token') || c?.includes('refresh_token'))).toBe(true);
    });
  });

  describe('POST /api/auth/signin', () => {
    it('returns 400 when email is missing', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/auth/signin',
        headers: { 'content-type': 'application/json' },
        payload: { password: 'password123' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('returns 200 and sets auth cookies on successful signin', async () => {
      const password = 'signinpass123';
      const passwordHash = bcrypt.hashSync(password, 10);
      const user = {
        id: TEST_USER_ID,
        email: 'signed@example.com',
        organization_id: TEST_ORG_ID,
        role: 'owner',
        password_hash: passwordHash,
      };
      pool.query
        .mockResolvedValueOnce({ rows: [user], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ role: 'owner' }], rowCount: 1 })
        .mockResolvedValueOnce(undefined);

      const res = await inject({
        method: 'POST',
        url: '/api/auth/signin',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'signed@example.com', password },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.user).toMatchObject({ email: 'signed@example.com', id: TEST_USER_ID });
      const cookies = res.headers['set-cookie'];
      const cookieArr = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
      expect(cookieArr.some((c) => c?.includes('access_token') || c?.includes('refresh_token'))).toBe(true);
    });

    it('returns 401 when user not found', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await inject({
        method: 'POST',
        url: '/api/auth/signin',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'unknown@example.com', password: 'password123' },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/invalid|credentials/i);
    });

    it('returns 401 when password is wrong', async () => {
      const user = {
        id: TEST_USER_ID,
        email: 'u@example.com',
        organization_id: TEST_ORG_ID,
        role: 'member',
        password_hash: bcrypt.hashSync('correct', 10),
      };
      pool.query.mockResolvedValueOnce({ rows: [user], rowCount: 1 });

      const res = await inject({
        method: 'POST',
        url: '/api/auth/signin',
        headers: { 'content-type': 'application/json' },
        payload: { email: 'u@example.com', password: 'wrongpassword' },
      });

      expect(res.statusCode).toBe(401);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/invalid|credentials/i);
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await inject({ method: 'GET', url: '/api/auth/me' });

      expect(res.statusCode).toBe(401);
    });

    it('returns 200 with user when valid access token in cookie', async () => {
      const accessToken = signAccessToken({
        userId: TEST_USER_ID,
        organizationId: TEST_ORG_ID,
        role: 'owner',
      });
      pool.query.mockResolvedValueOnce({
        rows: [{ id: TEST_USER_ID, email: 'me@example.com' }],
        rowCount: 1,
      });

      const res = await inject({
        method: 'GET',
        url: '/api/auth/me',
        cookies: { [AUTH_COOKIE_ACCESS]: accessToken },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        id: TEST_USER_ID,
        email: 'me@example.com',
        organizationId: TEST_ORG_ID,
        role: 'owner',
      });
    });

    it('returns 200 with user when valid Bearer token in Authorization header', async () => {
      const accessToken = signAccessToken({
        userId: TEST_USER_ID,
        organizationId: TEST_ORG_ID,
        role: 'member',
      });
      pool.query.mockResolvedValueOnce({
        rows: [{ id: TEST_USER_ID, email: 'bearer@example.com' }],
        rowCount: 1,
      });

      const res = await inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${accessToken}` },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.email).toBe('bearer@example.com');
      expect(body.role).toBe('member');
    });
  });

  describe('POST /api/auth/verify', () => {
    it('returns 400 when no token is provided', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/auth/verify',
        headers: { 'content-type': 'application/json' },
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/token|required/i);
    });

    it('returns 200 with user when valid token provided', async () => {
      const accessToken = signAccessToken({
        userId: TEST_USER_ID,
        organizationId: TEST_ORG_ID,
        role: 'owner',
      });
      pool.query.mockResolvedValueOnce({
        rows: [{ id: TEST_USER_ID, email: 'verify@example.com', organization_id: TEST_ORG_ID, role: 'owner' }],
        rowCount: 1,
      });

      const res = await inject({
        method: 'POST',
        url: '/api/auth/verify',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${accessToken}`,
        },
        payload: {},
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        id: TEST_USER_ID,
        email: 'verify@example.com',
        organizationId: TEST_ORG_ID,
        role: 'owner',
      });
    });

    it('returns 200 with user when valid token provided in body', async () => {
      const accessToken = signAccessToken({
        userId: TEST_USER_ID,
        organizationId: TEST_ORG_ID,
        role: 'owner',
      });
      pool.query.mockResolvedValueOnce({
        rows: [{ id: TEST_USER_ID, email: 'verify@example.com', organization_id: TEST_ORG_ID, role: 'owner' }],
        rowCount: 1,
      });

      const res = await inject({
        method: 'POST',
        url: '/api/auth/verify',
        headers: { 'content-type': 'application/json' },
        payload: { token: accessToken },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toMatchObject({
        id: TEST_USER_ID,
        email: 'verify@example.com',
        organizationId: TEST_ORG_ID,
        role: 'owner',
      });
    });
  });

  describe('POST /api/auth/refresh', () => {
    it('returns 400 when no refresh cookie is sent', async () => {
      const res = await inject({
        method: 'POST',
        url: '/api/auth/refresh',
      });

      expect(res.statusCode).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toMatch(/refresh|required/i);
    });

    it('returns 200 and new access token when valid refresh cookie sent', async () => {
      const refreshToken = signRefreshToken(TEST_USER_ID);
      const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const user = {
        id: TEST_USER_ID,
        email: 'refresh@example.com',
        organization_id: TEST_ORG_ID,
        role: 'owner',
      };
      pool.query
        .mockResolvedValueOnce({
          rows: [{ id: 'rt1', user_id: TEST_USER_ID, family_id: 'f1', used: false, expires_at: futureExpiry }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [user], rowCount: 1 })
        .mockResolvedValueOnce({ rows: [{ role: 'owner' }], rowCount: 1 })
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce(undefined) // UPDATE used
        .mockResolvedValueOnce(undefined) // INSERT new refresh
        .mockResolvedValueOnce(undefined); // COMMIT

      const res = await inject({
        method: 'POST',
        url: '/api/auth/refresh',
        headers: {
          cookie: `${AUTH_COOKIE_REFRESH}=${encodeURIComponent(refreshToken)}`,
        },
      });

      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.user).toMatchObject({ email: 'refresh@example.com', id: TEST_USER_ID });
      const cookies = res.headers['set-cookie'];
      const cookieArr = Array.isArray(cookies) ? cookies : cookies ? [cookies] : [];
      expect(cookieArr.some((c) => c?.includes('access_token'))).toBe(true);
    });
  });

  describe('POST /api/auth/logout', () => {
    it('returns 204 and clears cookies', async () => {
      const res = await inject({ method: 'POST', url: '/api/auth/logout' });

      expect(res.statusCode).toBe(204);
      expect(res.headers['set-cookie']).toBeDefined();
    });
  });
});
