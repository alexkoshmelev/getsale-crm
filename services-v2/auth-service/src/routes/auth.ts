import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import '@fastify/cookie';
import bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { EventType, type Event } from '@getsale/events';
import { UserRole } from '@getsale/types';
import { Logger } from '@getsale/logger';
import { AppError, ErrorCodes } from '@getsale/service-framework';
import { RedisClient } from '@getsale/cache';
import { RabbitMQClient } from '@getsale/queue';
import { SignupSchema, SigninSchema, AU_ORG_NAME_MAX_LEN, AU_ORG_SLUG_MAX_LEN } from '../validation';
import {
  signAccessToken, signRefreshToken, signWsToken, verifyAccessToken,
  verifyRefreshToken, hashRefreshToken, signTempToken, getRoleForWorkspace,
} from '../helpers';
import {
  AUTH_COOKIE_ACCESS, AUTH_COOKIE_REFRESH, AUTH_COOKIE_OPTS,
  ACCESS_MAX_AGE_SEC, REFRESH_MAX_AGE_SEC, REFRESH_EXPIRY_MS,
} from '../cookies';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  redis: RedisClient;
}

async function checkRateLimit(redis: RedisClient, keyPrefix: string, clientId: string, limit: number, windowMs: number, message: string): Promise<void> {
  const allowed = await redis.checkRateLimit(`${keyPrefix}:${clientId}`, limit, windowMs);
  if (!allowed) throw new AppError(429, message, ErrorCodes.RATE_LIMITED);
}

function getClientIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() || request.ip || 'unknown';
  return request.ip || 'unknown';
}

function setCookiesAndSend(reply: FastifyReply, accessToken: string, refreshToken: string, user: { id: string; email: string; organizationId: string; role: string }) {
  reply
    .setCookie(AUTH_COOKIE_ACCESS, accessToken, { ...AUTH_COOKIE_OPTS, maxAge: ACCESS_MAX_AGE_SEC })
    .setCookie(AUTH_COOKIE_REFRESH, refreshToken, { ...AUTH_COOKIE_OPTS, maxAge: REFRESH_MAX_AGE_SEC })
    .send({ user: { id: user.id, email: user.email, organizationId: user.organizationId, role: user.role } });
}

export function registerAuthRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, rabbitmq, log, redis } = deps;

  app.post('/api/auth/signup', async (request, reply) => {
    const body = SignupSchema.parse(request.body);
    await checkRateLimit(redis, 'auth:signup', getClientIp(request), 5, 3600_000, 'Too many sign-up attempts');

    const { email, password, organizationName, inviteToken } = body;
    const orgName = organizationName?.trim()?.slice(0, AU_ORG_NAME_MAX_LEN) || 'My Organization';

    let organization: { id: string; name: string };
    let user: { id: string; email: string; organization_id: string; role: string };
    let createdNewOrg = false;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      if (inviteToken) {
        const inv = await client.query('SELECT organization_id, role, expires_at FROM organization_invite_links WHERE token = $1', [inviteToken]);
        if (!inv.rows.length) throw new AppError(404, 'Invite not found', ErrorCodes.NOT_FOUND);
        const { organization_id: orgId, role: inviteRole, expires_at } = inv.rows[0];
        if (new Date(expires_at) <= new Date()) throw new AppError(410, 'Invite expired', ErrorCodes.BAD_REQUEST);

        const orgRow = await client.query('SELECT id, name FROM organizations WHERE id = $1', [orgId]);
        if (!orgRow.rows.length) throw new AppError(404, 'Organization not found', ErrorCodes.NOT_FOUND);
        organization = orgRow.rows[0];

        const hash = await bcrypt.hash(password, 12);
        const result = await client.query(
          'INSERT INTO users (email, password_hash, organization_id, role) VALUES ($1, $2, $3, $4) RETURNING *',
          [email, hash, organization.id, inviteRole],
        );
        user = result.rows[0];
        await client.query('INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, $3)', [user.id, organization.id, inviteRole]);
        await client.query('DELETE FROM organization_invite_links WHERE token = $1', [inviteToken]);
      } else {
        createdNewOrg = true;
        let slug = (email.split('@')[0] || 'org').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'workspace';
        for (let i = 0; i < 10; i++) {
          const existing = await client.query('SELECT id FROM organizations WHERE slug = $1', [slug]);
          if (!existing.rows.length) break;
          slug = `${slug}-${Math.random().toString(36).slice(2, 6)}`;
        }

        const orgResult = await client.query(
          'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING *',
          [orgName, slug.slice(0, AU_ORG_SLUG_MAX_LEN)],
        );
        organization = orgResult.rows[0];

        const hash = await bcrypt.hash(password, 12);
        const userResult = await client.query(
          'INSERT INTO users (email, password_hash, organization_id, role) VALUES ($1, $2, $3, $4) RETURNING *',
          [email, hash, organization.id, UserRole.OWNER],
        );
        user = userResult.rows[0];
        await client.query('INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, $3)', [user.id, organization.id, user.role]);
      }
      await client.query('COMMIT');
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => {});
      if ((err as { code?: string }).code === '23505') {
        throw new AppError(409, 'Registration failed. If you already have an account, try signing in.', ErrorCodes.CONFLICT);
      }
      throw err;
    } finally {
      client.release();
    }

    if (createdNewOrg) {
      rabbitmq.publishEvent({
        id: randomUUID(), type: EventType.ORGANIZATION_CREATED, timestamp: new Date(),
        organizationId: organization.id, userId: user.id,
        data: { organizationId: organization.id, name: organization.name },
      } as Event).catch(() => {});
    }

    rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.USER_CREATED, timestamp: new Date(),
      organizationId: organization.id, userId: user.id,
      data: { userId: user.id, email: user.email, organizationId: organization.id },
    } as Event).catch(() => {});

    const accessToken = signAccessToken({ userId: user.id, organizationId: organization.id, role: user.role });
    const refreshToken = signRefreshToken(user.id);
    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token, family_id, expires_at) VALUES ($1, $2, $3, $4)',
      [user.id, hashRefreshToken(refreshToken), randomUUID(), new Date(Date.now() + REFRESH_EXPIRY_MS)],
    );

    setCookiesAndSend(reply, accessToken, refreshToken, { id: user.id, email: user.email, organizationId: organization.id, role: user.role });
  });

  app.post('/api/auth/signin', async (request, reply) => {
    const body = SigninSchema.parse(request.body);
    const ip = getClientIp(request);
    await checkRateLimit(redis, 'auth:signin', ip, 10, 900_000, 'Too many sign-in attempts');
    await checkRateLimit(redis, 'auth:signin:email', body.email, 5, 900_000, 'Too many attempts for this account');

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [body.email]);
    if (!result.rows.length) throw new AppError(401, 'Invalid credentials', ErrorCodes.UNAUTHORIZED);

    const user = result.rows[0];
    const valid = await bcrypt.compare(body.password, user.password_hash);
    if (!valid) throw new AppError(401, 'Invalid credentials', ErrorCodes.UNAUTHORIZED);

    if (user.mfa_enabled) {
      return reply.send({ requiresTwoFactor: true, tempToken: signTempToken(user.id) });
    }

    const role = await getRoleForWorkspace(pool, user.id, user.organization_id, user.role);
    const accessToken = signAccessToken({ userId: user.id, organizationId: user.organization_id, role });
    const refreshToken = signRefreshToken(user.id);
    const familyId = randomUUID();

    await pool.query(
      'INSERT INTO refresh_tokens (user_id, token, family_id, expires_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING',
      [user.id, hashRefreshToken(refreshToken), familyId, new Date(Date.now() + REFRESH_EXPIRY_MS)],
    );

    setCookiesAndSend(reply, accessToken, refreshToken, { id: user.id, email: user.email, organizationId: user.organization_id, role });
  });

  app.get('/api/auth/me', async (request, reply) => {
    const cookies = (request as unknown as Record<string, unknown>).cookies as Record<string, string> | undefined;
    const token = cookies?.[AUTH_COOKIE_ACCESS] || (request.headers.authorization?.replace(/^Bearer\s+/i, '')?.trim());
    if (!token) throw new AppError(401, 'Not authenticated', ErrorCodes.UNAUTHORIZED);

    const decoded = verifyAccessToken(token);
    const result = await pool.query('SELECT id, email FROM users WHERE id = $1', [decoded.userId]);
    if (!result.rows.length) throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);

    reply.header('Cache-Control', 'no-store');
    return {
      id: result.rows[0].id,
      email: result.rows[0].email,
      organization_id: decoded.organizationId,
      organizationId: decoded.organizationId,
      role: decoded.role ?? '',
    };
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const cookies = (request as unknown as Record<string, unknown>).cookies as Record<string, string> | undefined;
    const refreshToken = cookies?.[AUTH_COOKIE_REFRESH];
    if (refreshToken) {
      const tokenHash = hashRefreshToken(refreshToken);
      const row = await pool.query('SELECT family_id FROM refresh_tokens WHERE token = $1 OR token = $2', [tokenHash, refreshToken]);
      if (row.rows.length) await pool.query('DELETE FROM refresh_tokens WHERE family_id = $1', [row.rows[0].family_id]);
    }
    reply
      .setCookie(AUTH_COOKIE_ACCESS, '', { ...AUTH_COOKIE_OPTS, maxAge: 0 })
      .setCookie(AUTH_COOKIE_REFRESH, '', { ...AUTH_COOKIE_OPTS, maxAge: 0 })
      .code(204)
      .send();
  });

  app.post('/api/auth/refresh', async (request, reply) => {
    const ip = getClientIp(request);
    await checkRateLimit(redis, 'auth:refresh', ip, 5, 60_000, 'Too many refresh attempts');

    const cookies = (request as unknown as Record<string, unknown>).cookies as Record<string, string> | undefined;
    const refreshToken = cookies?.[AUTH_COOKIE_REFRESH];
    if (!refreshToken) throw new AppError(400, 'Refresh token required', ErrorCodes.BAD_REQUEST);

    let decoded: { userId: string };
    try { decoded = verifyRefreshToken(refreshToken); } catch { throw new AppError(401, 'Invalid refresh token', ErrorCodes.UNAUTHORIZED); }

    const tokenHash = hashRefreshToken(refreshToken);
    let tokenRow = await pool.query(
      'SELECT id, user_id, family_id, used, expires_at FROM refresh_tokens WHERE token = $1',
      [tokenHash],
    );
    if (!tokenRow.rows.length) {
      tokenRow = await pool.query('SELECT id, user_id, family_id, used, expires_at FROM refresh_tokens WHERE token = $1', [refreshToken]);
    }
    if (!tokenRow.rows.length) throw new AppError(401, 'Invalid refresh token', ErrorCodes.UNAUTHORIZED);

    const stored = tokenRow.rows[0];
    if (stored.used) {
      log.warn({ message: 'Refresh token reuse detected', entity_type: 'user', entity_id: decoded.userId });
      await pool.query('DELETE FROM refresh_tokens WHERE family_id = $1', [stored.family_id]);
      throw new AppError(401, 'Invalid refresh token', ErrorCodes.UNAUTHORIZED);
    }
    if (new Date(stored.expires_at) <= new Date()) throw new AppError(401, 'Refresh token expired', ErrorCodes.UNAUTHORIZED);

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
    if (!userResult.rows.length) throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);

    const user = userResult.rows[0];
    const role = await getRoleForWorkspace(pool, user.id, user.organization_id, user.role);
    const accessToken = signAccessToken({ userId: user.id, organizationId: user.organization_id, role });
    const newRefresh = signRefreshToken(user.id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE refresh_tokens SET used = true WHERE id = $1', [stored.id]);
      await client.query(
        'INSERT INTO refresh_tokens (user_id, token, family_id, expires_at) VALUES ($1, $2, $3, $4)',
        [user.id, hashRefreshToken(newRefresh), stored.family_id, new Date(Date.now() + REFRESH_EXPIRY_MS)],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    reply
      .setCookie(AUTH_COOKIE_ACCESS, accessToken, { ...AUTH_COOKIE_OPTS, maxAge: ACCESS_MAX_AGE_SEC })
      .setCookie(AUTH_COOKIE_REFRESH, newRefresh, { ...AUTH_COOKIE_OPTS, maxAge: REFRESH_MAX_AGE_SEC })
      .send({ user: { id: user.id, email: user.email, organizationId: user.organization_id, role } });
  });

  app.post('/api/auth/verify', async (request, reply) => {
    const body = request.body as { token?: string };
    const cookies = (request as unknown as Record<string, unknown>).cookies as Record<string, string> | undefined;
    const token = body?.token || cookies?.[AUTH_COOKIE_ACCESS] || request.headers.authorization?.replace(/^Bearer\s+/i, '')?.trim();
    if (!token) throw new AppError(400, 'Token required', ErrorCodes.BAD_REQUEST);

    const decoded = verifyAccessToken(token);
    const result = await pool.query('SELECT id, email, organization_id, role FROM users WHERE id = $1', [decoded.userId]);
    if (!result.rows.length) throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);

    const user = result.rows[0];
    return { id: user.id, email: user.email, organization_id: decoded.organizationId ?? user.organization_id, organizationId: decoded.organizationId ?? user.organization_id, role: decoded.role ?? user.role };
  });

  app.get('/api/auth/ws-token', async (request, reply) => {
    const cookies = (request as unknown as Record<string, unknown>).cookies as Record<string, string> | undefined;
    const accessToken = cookies?.[AUTH_COOKIE_ACCESS] || request.headers.authorization?.replace(/^Bearer\s+/i, '')?.trim();
    let payload: { userId: string; organizationId: string; role: string } | null = null;

    if (accessToken) {
      try {
        const decoded = verifyAccessToken(accessToken);
        const row = await pool.query('SELECT organization_id, role FROM users WHERE id = $1', [decoded.userId]);
        if (row.rows.length) {
          payload = { userId: decoded.userId, organizationId: decoded.organizationId ?? row.rows[0].organization_id, role: decoded.role ?? row.rows[0].role };
        }
      } catch { /* fall through to refresh */ }
    }

    if (!payload) {
      const refreshToken = cookies?.[AUTH_COOKIE_REFRESH];
      if (!refreshToken) throw new AppError(401, 'Not authenticated', ErrorCodes.UNAUTHORIZED);
      let decoded: { userId: string };
      try { decoded = verifyRefreshToken(refreshToken); } catch { throw new AppError(401, 'Invalid refresh token', ErrorCodes.UNAUTHORIZED); }
      const tokenHash = hashRefreshToken(refreshToken);
      const tokenCheck = await pool.query('SELECT * FROM refresh_tokens WHERE (token = $1 OR token = $2) AND used = false', [tokenHash, refreshToken]);
      if (!tokenCheck.rows.length) throw new AppError(401, 'Invalid refresh token', ErrorCodes.UNAUTHORIZED);
      const userResult = await pool.query('SELECT id, organization_id, role FROM users WHERE id = $1', [decoded.userId]);
      if (!userResult.rows.length) throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);
      const u = userResult.rows[0];
      const role = await getRoleForWorkspace(pool, u.id, u.organization_id, u.role ?? '');
      payload = { userId: u.id, organizationId: u.organization_id, role };
    }

    reply.header('Cache-Control', 'no-store');
    return { token: signWsToken(payload) };
  });
}
