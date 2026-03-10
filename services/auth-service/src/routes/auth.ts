import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, UserCreatedEvent } from '@getsale/events';
import { UserRole } from '@getsale/types';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes } from '@getsale/service-core';
import { randomUUID } from 'crypto';
import {
  signAccessToken, signRefreshToken, verifyAccessToken, verifyRefreshToken, hashRefreshToken,
} from '../helpers';
import {
  AUTH_COOKIE_ACCESS,
  AUTH_COOKIE_REFRESH,
  AUTH_COOKIE_OPTS,
  ACCESS_MAX_AGE_SEC,
  REFRESH_MAX_AGE_SEC,
} from '../cookies';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
}

const REFRESH_RATE_LIMIT = 5;
const REFRESH_RATE_WINDOW = 60_000;
const refreshAttempts = new Map<string, { count: number; resetAt: number }>();

const SIGNIN_RATE_LIMIT = 10;
const SIGNIN_RATE_WINDOW_MS = 15 * 60 * 1000;
const signinAttempts = new Map<string, { count: number; resetAt: number }>();

const SIGNUP_RATE_LIMIT = 5;
const SIGNUP_RATE_WINDOW_MS = 60 * 60 * 1000;
const signupAttempts = new Map<string, { count: number; resetAt: number }>();

function getClientIp(req: { ip?: string; headers?: Record<string, string | string[] | undefined> }): string {
  const forwarded = req.headers?.['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() || req.ip || 'unknown';
  return req.ip || 'unknown';
}

function checkSigninRateLimit(ip: string): void {
  const now = Date.now();
  const entry = signinAttempts.get(ip);
  if (!entry) {
    signinAttempts.set(ip, { count: 1, resetAt: now + SIGNIN_RATE_WINDOW_MS });
    return;
  }
  if (now > entry.resetAt) {
    signinAttempts.set(ip, { count: 1, resetAt: now + SIGNIN_RATE_WINDOW_MS });
    return;
  }
  entry.count++;
  if (entry.count > SIGNIN_RATE_LIMIT) {
    throw new AppError(429, 'Too many sign-in attempts. Try again later.', ErrorCodes.RATE_LIMITED);
  }
}

function checkSignupRateLimit(ip: string): void {
  const now = Date.now();
  const entry = signupAttempts.get(ip);
  if (!entry) {
    signupAttempts.set(ip, { count: 1, resetAt: now + SIGNUP_RATE_WINDOW_MS });
    return;
  }
  if (now > entry.resetAt) {
    signupAttempts.set(ip, { count: 1, resetAt: now + SIGNUP_RATE_WINDOW_MS });
    return;
  }
  entry.count++;
  if (entry.count > SIGNUP_RATE_LIMIT) {
    throw new AppError(429, 'Too many sign-up attempts. Try again later.', ErrorCodes.RATE_LIMITED);
  }
}

export function authRouter({ pool, rabbitmq, log }: Deps): Router {
  const router = Router();

  router.post('/signup', asyncHandler(async (req, res) => {
    checkSignupRateLimit(getClientIp(req));
    const { email, password, organizationName, inviteToken } = req.body;

    if (!email || !password) throw new AppError(400, 'Email and password required', ErrorCodes.BAD_REQUEST);
    if (typeof password !== 'string' || password.length < 8) {
      throw new AppError(400, 'Password must be at least 8 characters', ErrorCodes.VALIDATION);
    }

    let organization: { id: string; name: string };
    let user: { id: string; email: string; organization_id: string; role: string };

    try {
      if (inviteToken) {
        const inv = await pool.query('SELECT organization_id, role, expires_at FROM organization_invite_links WHERE token = $1', [inviteToken]);
        if (inv.rows.length === 0) throw new AppError(404, 'Invite not found', ErrorCodes.NOT_FOUND);

        const { organization_id: orgId, role: inviteRole, expires_at: expiresAt } = inv.rows[0];
        if (new Date(expiresAt) <= new Date()) throw new AppError(410, 'Invite expired', ErrorCodes.BAD_REQUEST);

        const orgRow = await pool.query('SELECT id, name FROM organizations WHERE id = $1', [orgId]);
        if (orgRow.rows.length === 0) throw new AppError(404, 'Organization not found', ErrorCodes.NOT_FOUND);
        organization = orgRow.rows[0];

        const passwordHash = await bcrypt.hash(password, 10);
        const userResult = await pool.query(
          'INSERT INTO users (email, password_hash, organization_id, role) VALUES ($1, $2, $3, $4) RETURNING *',
          [email, passwordHash, organization.id, inviteRole]
        );
        user = userResult.rows[0];
        await pool.query('INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, $3)', [user.id, organization.id, inviteRole]);
      } else {
        const rawSlug = (email.split('@')[0] || 'org').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'workspace';
        let slug = rawSlug;
        for (let attempt = 0; attempt < 10; attempt++) {
          const existing = await pool.query('SELECT id FROM organizations WHERE slug = $1', [slug]);
          if (existing.rows.length === 0) break;
          slug = `${rawSlug}-${Math.random().toString(36).slice(2, 6)}`;
        }

        const orgResult = await pool.query(
          'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING *',
          [organizationName || 'My Organization', slug]
        );
        organization = orgResult.rows[0];

        const passwordHash = await bcrypt.hash(password, 10);
        const userResult = await pool.query(
          'INSERT INTO users (email, password_hash, organization_id, role) VALUES ($1, $2, $3, $4) RETURNING *',
          [email, passwordHash, organization.id, UserRole.OWNER]
        );
        user = userResult.rows[0];

        const pipelineResult = await pool.query(
          'INSERT INTO pipelines (organization_id, name, description, is_default) VALUES ($1, $2, $3, $4) RETURNING *',
          [organization.id, 'Default Pipeline', 'Default sales pipeline', true]
        );
        const stages = [
          { name: 'Lead', order: 1, color: '#3B82F6' },
          { name: 'Qualified', order: 2, color: '#10B981' },
          { name: 'Proposal', order: 3, color: '#F59E0B' },
          { name: 'Negotiation', order: 4, color: '#EF4444' },
          { name: 'Closed Won', order: 5, color: '#8B5CF6' },
          { name: 'Closed Lost', order: 6, color: '#6B7280' },
        ];
        for (const stage of stages) {
          await pool.query(
            'INSERT INTO stages (pipeline_id, organization_id, name, order_index, color) VALUES ($1, $2, $3, $4, $5)',
            [pipelineResult.rows[0].id, organization.id, stage.name, stage.order, stage.color]
          );
        }

        const teamResult = await pool.query(
          'INSERT INTO teams (organization_id, name, created_by) VALUES ($1, $2, $3) RETURNING *',
          [organization.id, organization.name, user.id]
        );
        await pool.query('INSERT INTO team_members (team_id, user_id, role, invited_by) VALUES ($1, $2, $3, $4)',
          [teamResult.rows[0].id, user.id, 'admin', user.id]);
        await pool.query('INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, $3)',
          [user.id, organization.id, user.role]);
      }
    } catch (err: unknown) {
      const e = err as { code?: string };
      if (e.code === '23505') throw new AppError(409, 'Email already exists', ErrorCodes.CONFLICT);
      throw err;
    }

    const event: UserCreatedEvent = {
      id: randomUUID(), type: EventType.USER_CREATED, timestamp: new Date(),
      organizationId: organization.id, userId: user.id,
      data: { userId: user.id, email: user.email, organizationId: organization.id },
    };
    await rabbitmq.publishEvent(event).catch(() => {});

    const accessToken = signAccessToken({ userId: user.id, organizationId: organization.id, role: user.role });
    const refreshToken = signRefreshToken(user.id);
    const tokenHash = hashRefreshToken(refreshToken);
    await pool.query('INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)',
      [user.id, tokenHash, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)]);

    res.cookie(AUTH_COOKIE_ACCESS, accessToken, { ...AUTH_COOKIE_OPTS, maxAge: ACCESS_MAX_AGE_SEC * 1000 });
    res.cookie(AUTH_COOKIE_REFRESH, refreshToken, { ...AUTH_COOKIE_OPTS, maxAge: REFRESH_MAX_AGE_SEC * 1000 });
    res.json({
      user: { id: user.id, email: user.email, organizationId: organization.id, role: user.role },
    });
  }));

  router.post('/signin', asyncHandler(async (req, res) => {
    checkSigninRateLimit(getClientIp(req));
    const { email, password } = req.body;
    if (!email || !password) throw new AppError(400, 'Email and password required', ErrorCodes.BAD_REQUEST);

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
        [user.id, tokenHash, new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)]);
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code === '23505') {
        await pool.query('UPDATE refresh_tokens SET expires_at = $1 WHERE token = $2',
          [new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), tokenHash]);
      } else throw e;
    }

    log.info({ message: 'User signed in', entity_type: 'user', entity_id: user.id });

    res.cookie(AUTH_COOKIE_ACCESS, accessToken, { ...AUTH_COOKIE_OPTS, maxAge: ACCESS_MAX_AGE_SEC * 1000 });
    res.cookie(AUTH_COOKIE_REFRESH, refreshToken, { ...AUTH_COOKIE_OPTS, maxAge: REFRESH_MAX_AGE_SEC * 1000 });
    res.json({
      user: { id: user.id, email: user.email, organizationId: user.organization_id, role: user.role },
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

  router.post('/logout', asyncHandler(async (_req, res) => {
    res.cookie(AUTH_COOKIE_ACCESS, '', { ...AUTH_COOKIE_OPTS, maxAge: 0 });
    res.cookie(AUTH_COOKIE_REFRESH, '', { ...AUTH_COOKIE_OPTS, maxAge: 0 });
    res.status(204).send();
  }));

  router.post('/verify', asyncHandler(async (req, res) => {
    const token = req.cookies?.[AUTH_COOKIE_ACCESS] || req.body?.token || req.headers.authorization?.replace(/^Bearer\s+/i, '')?.trim();
    if (!token) throw new AppError(400, 'Token required', ErrorCodes.BAD_REQUEST);

    const decoded = verifyAccessToken(token);
    const result = await pool.query('SELECT id, email, organization_id, role FROM users WHERE id = $1', [decoded.userId]);
    if (result.rows.length === 0) throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);

    const user = result.rows[0];
    const organizationId = decoded.organizationId ?? user.organization_id;
    const role = decoded.role ?? user.role;

    res.json({ id: user.id, email: user.email, organization_id: organizationId, organizationId, role });
  }));

  router.post('/refresh', asyncHandler(async (req, res) => {
    const clientId = req.ip || 'unknown';
    const now = Date.now();

    const attempt = refreshAttempts.get(clientId);
    if (attempt && attempt.resetAt > now) {
      if (attempt.count >= REFRESH_RATE_LIMIT) {
        throw new AppError(429, 'Too many refresh attempts', ErrorCodes.RATE_LIMITED);
      }
      attempt.count++;
    } else {
      refreshAttempts.set(clientId, { count: 1, resetAt: now + REFRESH_RATE_WINDOW });
    }

    const refreshToken = req.cookies?.[AUTH_COOKIE_REFRESH] || req.body?.refreshToken;
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

    refreshAttempts.delete(clientId);
    res.cookie(AUTH_COOKIE_ACCESS, accessToken, { ...AUTH_COOKIE_OPTS, maxAge: ACCESS_MAX_AGE_SEC * 1000 });
    res.json({
      user: { id: user.id, email: user.email, organizationId: user.organization_id, role: user.role },
    });
  }));

  return router;
}
