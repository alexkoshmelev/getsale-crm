import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import bcrypt from 'bcryptjs';
import { createTestApp, createMockPool, createMockRabbitMQ } from '@getsale/test-utils';
import { createLogger } from '@getsale/logger';
import type { RedisClient } from '@getsale/utils';
import { signAccessToken, signRefreshToken, hashRefreshToken } from '../helpers';
import { AUTH_COOKIE_ACCESS, AUTH_COOKIE_REFRESH } from '../cookies';
import { authRouter } from './auth';

const TEST_ORG_ID = '11111111-1111-1111-1111-111111111111';
const TEST_USER_ID = '22222222-2222-2222-2222-222222222222';

describe('Auth Router', () => {
  let pool: ReturnType<typeof createMockPool>;
  let rabbitmq: ReturnType<typeof createMockRabbitMQ>;
  let app: ReturnType<typeof createTestApp>;
  let redis: { incr: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    pool = createMockPool();
    rabbitmq = createMockRabbitMQ();
    redis = { incr: vi.fn().mockResolvedValue(1) };
    const log = createLogger('auth-service-test');
    const router = authRouter({ pool, rabbitmq, log, redis: redis as unknown as RedisClient, pipelineClient: null });
    app = createTestApp(router, { prefix: '/api/auth', log, cookieParser: true });
  });

  describe('POST /signup', () => {
    it('returns 400 when email and password are missing', async () => {
      const res = await request(app)
        .post('/api/auth/signup')
        .set('content-type', 'application/json')
        .send({});

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/email|password|required/i);
    });

    it('returns 400 when email is invalid', async () => {
      const res = await request(app)
        .post('/api/auth/signup')
        .set('content-type', 'application/json')
        .send({ email: 'not-an-email', password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/invalid|email/i);
    });

    it('returns 400 when password is too short', async () => {
      const res = await request(app)
        .post('/api/auth/signup')
        .set('content-type', 'application/json')
        .send({ email: 'user@example.com', password: 'short' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/password|8|character/i);
    });

    it('returns 200 and sets auth cookies on successful signup', async () => {
      const org = { id: TEST_ORG_ID, name: 'Test Org' };
      const user = { id: TEST_USER_ID, email: 'new@example.com', organization_id: TEST_ORG_ID, role: 'owner' };
      const team = { id: '33333333-3333-3333-3333-333333333333' };

      pool.query
        .mockResolvedValueOnce(undefined) // BEGIN
        .mockResolvedValueOnce({ rows: [], rowCount: 0 }) // SELECT slug
        .mockResolvedValueOnce({ rows: [org], rowCount: 1 }) // INSERT organizations
        .mockResolvedValueOnce({ rows: [user], rowCount: 1 }) // INSERT users
        .mockResolvedValueOnce({ rows: [team], rowCount: 1 }) // INSERT teams
        .mockResolvedValueOnce(undefined) // INSERT team_members
        .mockResolvedValueOnce(undefined) // INSERT organization_members
        .mockResolvedValueOnce(undefined) // COMMIT
        .mockResolvedValueOnce(undefined); // INSERT refresh_tokens

      const res = await request(app)
        .post('/api/auth/signup')
        .set('content-type', 'application/json')
        .send({ email: 'new@example.com', password: 'password123' });

      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ email: 'new@example.com', id: TEST_USER_ID });
      expect(res.headers['set-cookie']).toBeDefined();
      const setCookie = res.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
      expect(cookies.some((c: string) => c.includes('access_token') || c.includes('refresh_token'))).toBe(true);
    });
  });

  describe('POST /signin', () => {
    it('returns 400 when email is missing', async () => {
      const res = await request(app)
        .post('/api/auth/signin')
        .set('content-type', 'application/json')
        .send({ password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/email|password|required/i);
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
        .mockResolvedValueOnce({ rows: [user], rowCount: 1 }) // SELECT users
        .mockResolvedValueOnce(undefined); // INSERT refresh_tokens

      const res = await request(app)
        .post('/api/auth/signin')
        .set('content-type', 'application/json')
        .send({ email: 'signed@example.com', password });

      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ email: 'signed@example.com', id: TEST_USER_ID });
      const setCookie = res.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
      expect(cookies.some((c: string) => c.includes('access_token') || c.includes('refresh_token'))).toBe(true);
    });

    it('returns 401 when user not found', async () => {
      pool.query.mockResolvedValueOnce({ rows: [], rowCount: 0 });

      const res = await request(app)
        .post('/api/auth/signin')
        .set('content-type', 'application/json')
        .send({ email: 'unknown@example.com', password: 'password123' });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid|credentials/i);
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

      const res = await request(app)
        .post('/api/auth/signin')
        .set('content-type', 'application/json')
        .send({ email: 'u@example.com', password: 'wrongpassword' });

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid|credentials/i);
    });
  });

  describe('GET /me', () => {
    it('returns 401 when no token is provided', async () => {
      const res = await request(app).get('/api/auth/me');

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/authenticated|token/i);
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

      const res = await request(app)
        .get('/api/auth/me')
        .set('Cookie', `${AUTH_COOKIE_ACCESS}=${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
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

      const res = await request(app)
        .get('/api/auth/me')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body.email).toBe('bearer@example.com');
      expect(res.body.role).toBe('member');
    });
  });

  describe('POST /verify', () => {
    it('returns 400 when no token is provided', async () => {
      const res = await request(app)
        .post('/api/auth/verify')
        .set('content-type', 'application/json');

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/token|required/i);
    });

    it('returns 200 with user when valid token provided', async () => {
      const accessToken = signAccessToken({
        userId: TEST_USER_ID,
        organizationId: TEST_ORG_ID,
        role: 'owner',
      });
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: TEST_USER_ID,
          email: 'verify@example.com',
          organization_id: TEST_ORG_ID,
          role: 'owner',
        }],
        rowCount: 1,
      });

      const res = await request(app)
        .post('/api/auth/verify')
        .set('content-type', 'application/json')
        .set('Authorization', `Bearer ${accessToken}`);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: TEST_USER_ID,
        email: 'verify@example.com',
        organizationId: TEST_ORG_ID,
        role: 'owner',
      });
    });

    it('returns 200 with user when valid token provided in body (e.g. websocket-service)', async () => {
      const accessToken = signAccessToken({
        userId: TEST_USER_ID,
        organizationId: TEST_ORG_ID,
        role: 'owner',
      });
      pool.query.mockResolvedValueOnce({
        rows: [{
          id: TEST_USER_ID,
          email: 'verify@example.com',
          organization_id: TEST_ORG_ID,
          role: 'owner',
        }],
        rowCount: 1,
      });

      const res = await request(app)
        .post('/api/auth/verify')
        .set('content-type', 'application/json')
        .send({ token: accessToken });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: TEST_USER_ID,
        email: 'verify@example.com',
        organizationId: TEST_ORG_ID,
        role: 'owner',
      });
    });
  });

  describe('POST /refresh', () => {
    it('returns 400 when no refresh cookie is sent', async () => {
      const res = await request(app)
        .post('/api/auth/refresh')
        .set('content-type', 'application/json');

      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/refresh|required/i);
    });

    it('returns 200 and new access token when valid refresh cookie sent', async () => {
      const refreshToken = signRefreshToken(TEST_USER_ID);
      const tokenHash = hashRefreshToken(refreshToken);
      const futureExpiry = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
      const user = {
        id: TEST_USER_ID,
        email: 'refresh@example.com',
        organization_id: TEST_ORG_ID,
        role: 'owner',
      };
      pool.query
        .mockResolvedValueOnce({
          rows: [{ id: 'rt1', user_id: TEST_USER_ID, expires_at: futureExpiry }],
          rowCount: 1,
        })
        .mockResolvedValueOnce({ rows: [user], rowCount: 1 });

      const res = await request(app)
        .post('/api/auth/refresh')
        .set('content-type', 'application/json')
        .set('Cookie', `${AUTH_COOKIE_REFRESH}=${refreshToken}`);

      expect(res.status).toBe(200);
      expect(res.body.user).toMatchObject({ email: 'refresh@example.com', id: TEST_USER_ID });
      expect(res.headers['set-cookie']).toBeDefined();
      const setCookie = res.headers['set-cookie'];
      const cookies = Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [];
      expect(cookies.some((c: string) => c.includes('access_token'))).toBe(true);
    });
  });

  describe('POST /logout', () => {
    it('returns 204 and clears cookies', async () => {
      const res = await request(app).post('/api/auth/logout');

      expect(res.status).toBe(204);
      expect(res.headers['set-cookie']).toBeDefined();
    });
  });
});
