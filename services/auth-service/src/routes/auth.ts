import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, UserCreatedEvent } from '@getsale/events';
import { UserRole } from '@getsale/types';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, ServiceHttpClient } from '@getsale/service-core';
import { randomUUID } from 'crypto';
import {
  signAccessToken, signRefreshToken, signWsToken, verifyAccessToken, verifyRefreshToken, hashRefreshToken,
} from '../helpers';
import {
  AUTH_COOKIE_ACCESS,
  AUTH_COOKIE_REFRESH,
  AUTH_COOKIE_OPTS,
  ACCESS_MAX_AGE_SEC,
  REFRESH_MAX_AGE_SEC,
  REFRESH_EXPIRY_MS,
} from '../cookies';
import type { RedisClient } from '@getsale/utils';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  redis: RedisClient;
  /** Optional: used to create default pipeline for new orgs (pipeline-service internal API) */
  pipelineClient?: ServiceHttpClient | null;
}

const REFRESH_RATE_LIMIT = 5;
const REFRESH_RATE_WINDOW = 60_000; // 1 min in ms
const REFRESH_RATE_WINDOW_SEC = Math.ceil(REFRESH_RATE_WINDOW / 1000);

const SIGNIN_RATE_LIMIT = 10;
const SIGNIN_RATE_WINDOW_MS = 15 * 60 * 1000; // 15 min
const SIGNIN_RATE_WINDOW_SEC = Math.ceil(SIGNIN_RATE_WINDOW_MS / 1000);

const SIGNUP_RATE_LIMIT = 5;
const SIGNUP_RATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const SIGNUP_RATE_WINDOW_SEC = Math.ceil(SIGNUP_RATE_WINDOW_MS / 1000);

const ORG_NAME_MAX_LEN = 200;
const ORG_SLUG_MAX_LEN = 100;

function getClientIp(req: { ip?: string; headers?: Record<string, string | string[] | undefined> }): string {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() || req.ip || 'unknown';
  return req.ip || 'unknown';
}

async function checkRateLimit(
  redis: RedisClient,
  opts: { keyPrefix: string; clientId: string; limit: number; windowMs: number; message: string }
): Promise<void> {
  const slot = Math.floor(Date.now() / opts.windowMs);
  const key = `${opts.keyPrefix}:${opts.clientId}:${slot}`;
  const windowSec = Math.ceil(opts.windowMs / 1000);
  const count = await redis.incr(key, windowSec);
  if (count > opts.limit) {
    throw new AppError(429, opts.message, ErrorCodes.RATE_LIMITED);
  }
}

function validateEmailAndPassword(
  body: unknown,
  opts: { requirePasswordLength?: boolean } = {}
): { email: string; password: string } {
  const email = (body as { email?: unknown }).email;
  const password = (body as { password?: unknown }).password;
  if (!email || !password) throw new AppError(400, 'Email and password required', ErrorCodes.BAD_REQUEST);
  if (typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw new AppError(400, 'Invalid email format', ErrorCodes.VALIDATION);
  }
  if (typeof password !== 'string') throw new AppError(400, 'Invalid password', ErrorCodes.VALIDATION);
  if (opts.requirePasswordLength !== false && password.length < 8) {
    throw new AppError(400, 'Password must be at least 8 characters', ErrorCodes.VALIDATION);
  }
  return { email: email.trim(), password };
}

function setAuthCookiesAndRespond(
  res: import('express').Response,
  accessToken: string,
  refreshToken: string,
  user: { id: string; email: string; organizationId: string; role: string }
): void {
  res.cookie(AUTH_COOKIE_ACCESS, accessToken, { ...AUTH_COOKIE_OPTS, maxAge: ACCESS_MAX_AGE_SEC * 1000 });
  res.cookie(AUTH_COOKIE_REFRESH, refreshToken, { ...AUTH_COOKIE_OPTS, maxAge: REFRESH_MAX_AGE_SEC * 1000 });
  res.json({ user: { id: user.id, email: user.email, organizationId: user.organizationId, role: user.role } });
}

export function authRouter({ pool, rabbitmq, log, redis, pipelineClient }: Deps): Router {
  const router = Router();

  router.post('/signup', asyncHandler(async (req, res) => {
    await checkRateLimit(redis, {
      keyPrefix: 'auth_rate:signup',
      clientId: getClientIp(req),
      limit: SIGNUP_RATE_LIMIT,
      windowMs: SIGNUP_RATE_WINDOW_MS,
      message: 'Too many sign-up attempts. Try again later.',
    });
    const { email, password } = validateEmailAndPassword(req.body, { requirePasswordLength: true });
    const { organizationName, inviteToken } = (req.body as { organizationName?: unknown; inviteToken?: unknown });
    const orgName =
      organizationName != null && typeof organizationName === 'string' && organizationName.trim()
        ? organizationName.trim().slice(0, ORG_NAME_MAX_LEN)
        : 'My Organization';

    let organization: { id: string; name: string };
    let user: { id: string; email: string; organization_id: string; role: string };
    let createdNewOrg = false;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Invite path: user joins an existing organization; create user and add to organization_members.
      if (inviteToken) {
        const inv = await client.query('SELECT organization_id, role, expires_at FROM organization_invite_links WHERE token = $1', [inviteToken]);
        if (inv.rows.length === 0) throw new AppError(404, 'Invite not found', ErrorCodes.NOT_FOUND);

        const { organization_id: orgId, role: inviteRole, expires_at: expiresAt } = inv.rows[0];
        if (new Date(expiresAt) <= new Date()) throw new AppError(410, 'Invite expired', ErrorCodes.BAD_REQUEST);

        const orgRow = await client.query('SELECT id, name FROM organizations WHERE id = $1', [orgId]);
        if (orgRow.rows.length === 0) throw new AppError(404, 'Organization not found', ErrorCodes.NOT_FOUND);
        organization = orgRow.rows[0];

        const passwordHash = await bcrypt.hash(password, 10);
        const userResult = await client.query(
          'INSERT INTO users (email, password_hash, organization_id, role) VALUES ($1, $2, $3, $4) RETURNING *',
          [email, passwordHash, organization.id, inviteRole]
        );
        user = userResult.rows[0];
        await client.query('INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, $3)', [user.id, organization.id, inviteRole]);
      } else {
        // New org path: create organization, user (owner), default team + members, and organization_members. Default pipeline is created later via pipeline-service.
        createdNewOrg = true;
        const rawSlug = (email.split('@')[0] || 'org').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'workspace';
        let slug = rawSlug;
        for (let attempt = 0; attempt < 10; attempt++) {
          const existing = await client.query('SELECT id FROM organizations WHERE slug = $1', [slug]);
          if (existing.rows.length === 0) break;
          slug = `${rawSlug}-${Math.random().toString(36).slice(2, 6)}`;
        }

        const orgResult = await client.query(
          'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING *',
          [orgName, slug.slice(0, ORG_SLUG_MAX_LEN)]
        );
        organization = orgResult.rows[0];

        const passwordHash = await bcrypt.hash(password, 10);
        const userResult = await client.query(
          'INSERT INTO users (email, password_hash, organization_id, role) VALUES ($1, $2, $3, $4) RETURNING *',
          [email, passwordHash, organization.id, UserRole.OWNER]
        );
        user = userResult.rows[0];

        const teamResult = await client.query(
          'INSERT INTO teams (organization_id, name, created_by) VALUES ($1, $2, $3) RETURNING *',
          [organization.id, organization.name, user.id]
        );
        await client.query('INSERT INTO team_members (team_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)',
          [teamResult.rows[0].id, user.id, 'admin', user.id]);
        await client.query('INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, $3)',
          [user.id, organization.id, user.role]);
      }
      await client.query('COMMIT');
    } catch (err: unknown) {
      await client.query('ROLLBACK').catch(() => {});
      const e = err as { code?: string };
      if (e.code === '23505') {
        throw new AppError(409, 'Registration failed. If you already have an account, try signing in.', ErrorCodes.CONFLICT);
      }
      throw err;
    } finally {
      client.release();
    }

    if (createdNewOrg && pipelineClient) {
      await pipelineClient
        .post('/internal/pipeline/default-for-org', { organizationId: organization.id })
        .catch((err) => {
          log.warn({
            message: 'Failed to create default pipeline for new organization',
            organization_id: organization.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }

    const event: UserCreatedEvent = {
      id: randomUUID(), type: EventType.USER_CREATED, timestamp: new Date(),
      organizationId: organization.id, userId: user.id,
      data: { userId: user.id, email: user.email, organizationId: organization.id },
    };
    await rabbitmq.publishEvent(event).catch((err) => {
      log.warn({ message: 'Failed to publish USER_CREATED', error: err instanceof Error ? err.message : String(err) });
    });

    const accessToken = signAccessToken({ userId: user.id, organizationId: organization.id, role: user.role });
    const refreshToken = signRefreshToken(user.id);
    const tokenHash = hashRefreshToken(refreshToken);
    await pool.query('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, new Date(Date.now() + REFRESH_EXPIRY_MS)]);

    setAuthCookiesAndRespond(res, accessToken, refreshToken, {
      id: user.id, email: user.email, organizationId: organization.id, role: user.role,
    });
  }));

  router.post('/signin', asyncHandler(async (req, res) => {
    await checkRateLimit(redis, {
      keyPrefix: 'auth_rate:signin',
      clientId: getClientIp(req),
      limit: SIGNIN_RATE_LIMIT,
      windowMs: SIGNIN_RATE_WINDOW_MS,
      message: 'Too many sign-in attempts. Try again later.',
    });
    const { email, password } = validateEmailAndPassword(req.body, { requirePasswordLength: false });

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) throw new AppError(401, 'Invalid credentials', ErrorCodes.UNAUTHORIZED);

    const user = result.rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) throw new AppError(401, 'Invalid credentials', ErrorCodes.UNAUTHORIZED);

    const accessToken = signAccessToken({ userId: user.id, organizationId: user.organization_id, role: user.role });
    const refreshToken = signRefreshToken(user.id);
    const tokenHash = hashRefreshToken(refreshToken);

    try {
      await pool.query('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
        [user.id, tokenHash, new Date(Date.now() + REFRESH_EXPIRY_MS)]);
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code === '23505') {
        await pool.query('UPDATE refresh_tokens SET expires_at = $1 WHERE token = $2',
          [new Date(Date.now() + REFRESH_EXPIRY_MS), tokenHash]);
      } else throw e;
    }

    log.info({ message: 'User signed in', entity_type: 'user', entity_id: user.id });

    setAuthCookiesAndRespond(res, accessToken, refreshToken, {
      id: user.id, email: user.email, organizationId: user.organization_id, role: user.role,
    });
  }));

  router.get('/me', asyncHandler(async (req, res) => {
    const token = req.cookies?.[AUTH_COOKIE_ACCESS] || req.headers.authorization?.replace(/^Bearer\s+/i, '')?.trim();
    if (!token) throw new AppError(401, 'Not authenticated', ErrorCodes.UNAUTHORIZED);

    const decoded = verifyAccessToken(token);
    const result = await pool.query('SELECT id, email FROM users WHERE id = $1', [decoded.userId]);
    if (result.rows.length === 0) throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);

    const user = result.rows[0];
    // Return organizationId and role from JWT (current workspace), not from DB — so switch-workspace is reflected.
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({
      id: user.id,
      email: user.email,
      organization_id: decoded.organizationId,
      organizationId: decoded.organizationId,
      role: decoded.role ?? '',
    });
  }));

  router.post('/logout', asyncHandler(async (req, res) => {
    const refreshToken = req.cookies?.[AUTH_COOKIE_REFRESH];
    if (refreshToken) {
      const tokenHash = hashRefreshToken(refreshToken);
      await pool.query('DELETE FROM refresh_tokens WHERE token = $1 OR token = $2', [tokenHash, refreshToken]);
    }
    res.cookie(AUTH_COOKIE_ACCESS, '', { ...AUTH_COOKIE_OPTS, maxAge: 0 });
    res.cookie(AUTH_COOKIE_REFRESH, '', { ...AUTH_COOKIE_OPTS, maxAge: 0 });
    res.status(204).send();
  }));

  router.post('/verify', asyncHandler(async (req, res) => {
    const token =
      (req.body as { token?: string } | undefined)?.token ||
      req.cookies?.[AUTH_COOKIE_ACCESS] ||
      req.headers.authorization?.replace(/^Bearer\s+/i, '')?.trim();
    if (!token) throw new AppError(400, 'Token required', ErrorCodes.BAD_REQUEST);

    const decoded = verifyAccessToken(token);
    const result = await pool.query('SELECT id, email, organization_id, role FROM users WHERE id = $1', [decoded.userId]);
    if (result.rows.length === 0) throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);

    const user = result.rows[0];
    const organizationId = decoded.organizationId ?? user.organization_id;
    const role = decoded.role ?? user.role;

    res.json({ id: user.id, email: user.email, organization_id: organizationId, organizationId, role });
  }));

  /** Short-lived token for WebSocket handshake (e.g. 5 min). Call with credentials; returns { token } for socket.io auth. */
  router.get('/ws-token', asyncHandler(async (req, res) => {
    const accessToken = req.cookies?.[AUTH_COOKIE_ACCESS] || req.headers.authorization?.replace(/^Bearer\s+/i, '')?.trim();
    let payload: { userId: string; organizationId: string; role: string } | null = null;

    if (accessToken) {
      try {
        const decoded = verifyAccessToken(accessToken);
        const row = await pool.query('SELECT organization_id, role FROM users WHERE id = $1', [decoded.userId]);
        if (row.rows.length > 0) {
          const u = row.rows[0];
          payload = {
            userId: decoded.userId,
            organizationId: decoded.organizationId ?? u.organization_id,
            role: decoded.role ?? u.role ?? '',
          };
        }
      } catch {
        // access expired or invalid, try refresh
      }
    }

    if (!payload) {
      const refreshToken = req.cookies?.[AUTH_COOKIE_REFRESH];
      if (!refreshToken) throw new AppError(401, 'Not authenticated', ErrorCodes.UNAUTHORIZED);
      await checkRateLimit(redis, {
        keyPrefix: 'auth_rate:ws_token',
        clientId: getClientIp(req),
        limit: REFRESH_RATE_LIMIT,
        windowMs: REFRESH_RATE_WINDOW,
        message: 'Too many ws-token attempts',
      });
      let decoded: { userId: string };
      try {
        decoded = verifyRefreshToken(refreshToken);
      } catch {
        throw new AppError(401, 'Invalid or expired refresh token', ErrorCodes.UNAUTHORIZED);
      }
      const tokenHash = hashRefreshToken(refreshToken);
      const tokenCheck = await pool.query('SELECT * FROM refresh_tokens WHERE token = $1 OR token = $2', [tokenHash, refreshToken]);
      if (tokenCheck.rows.length === 0) throw new AppError(401, 'Invalid refresh token', ErrorCodes.UNAUTHORIZED);
      const userResult = await pool.query('SELECT id, organization_id, role FROM users WHERE id = $1', [decoded.userId]);
      if (userResult.rows.length === 0) throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);
      const u = userResult.rows[0];
      payload = { userId: u.id, organizationId: u.organization_id, role: u.role ?? '' };
    }

    const token = signWsToken(payload);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.json({ token });
  }));

  router.post('/refresh', asyncHandler(async (req, res) => {
    const clientId = req.ip || 'unknown';
    await checkRateLimit(redis, {
      keyPrefix: 'auth_rate:refresh',
      clientId,
      limit: REFRESH_RATE_LIMIT,
      windowMs: REFRESH_RATE_WINDOW,
      message: 'Too many refresh attempts',
    });

    const refreshToken = req.cookies?.[AUTH_COOKIE_REFRESH];
    if (!refreshToken) throw new AppError(400, 'Refresh token required', ErrorCodes.BAD_REQUEST);

    let decoded: { userId: string };
    try {
      decoded = verifyRefreshToken(refreshToken);
    } catch {
      throw new AppError(401, 'Invalid or expired refresh token', ErrorCodes.UNAUTHORIZED);
    }

    const tokenHash = hashRefreshToken(refreshToken);
    let tokenCheck = await pool.query('SELECT * FROM refresh_tokens WHERE token = $1', [tokenHash]);
    if (tokenCheck.rows.length === 0) {
      tokenCheck = await pool.query('SELECT * FROM refresh_tokens WHERE token = $1', [refreshToken]);
      if (tokenCheck.rows.length > 0) {
        await pool.query('UPDATE refresh_tokens SET token = $1 WHERE id = $2', [tokenHash, tokenCheck.rows[0].id]);
      }
    }
    if (tokenCheck.rows.length === 0) throw new AppError(401, 'Invalid refresh token', ErrorCodes.UNAUTHORIZED);
    if (new Date(tokenCheck.rows[0].expires_at) <= new Date()) throw new AppError(401, 'Refresh token expired', ErrorCodes.UNAUTHORIZED);

    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [decoded.userId]);
    if (userResult.rows.length === 0) throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);

    const user = userResult.rows[0];
    const accessToken = signAccessToken({ userId: user.id, organizationId: user.organization_id, role: user.role });

    res.cookie(AUTH_COOKIE_ACCESS, accessToken, { ...AUTH_COOKIE_OPTS, maxAge: ACCESS_MAX_AGE_SEC * 1000 });
    res.json({
      user: { id: user.id, email: user.email, organizationId: user.organization_id, role: user.role },
    });
  }));

  return router;
}
