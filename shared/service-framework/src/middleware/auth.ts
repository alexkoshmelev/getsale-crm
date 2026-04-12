import { FastifyRequest, FastifyReply } from 'fastify';
import { Pool } from 'pg';
import { AppError, ErrorCodes } from '../errors';

export interface ServiceUser {
  id: string;
  organizationId: string;
  role: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: ServiceUser | null;
  }
}

export function extractUserHook(request: FastifyRequest): void {
  const id = (request.headers['x-user-id'] as string) ?? '';
  const organizationId = (request.headers['x-organization-id'] as string) ?? '';
  const role = (request.headers['x-user-role'] as string) ?? '';

  request.user = {
    id: typeof id === 'string' ? id.trim() : '',
    organizationId: typeof organizationId === 'string' ? organizationId.trim() : '',
    role: typeof role === 'string' ? role.trim() : '',
  };
}

export function internalAuthHook(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void {
  if (request.url === '/health' || request.url === '/metrics' || request.url === '/ready') {
    return done();
  }
  const secret = process.env.INTERNAL_AUTH_SECRET?.trim();
  if (!secret) {
    return done(new AppError(503, 'INTERNAL_AUTH_SECRET not configured', ErrorCodes.INTERNAL_ERROR));
  }
  const header = request.headers['x-internal-auth'];
  if (typeof header !== 'string' || header.trim() !== secret) {
    return done(new AppError(401, 'Unauthorized', ErrorCodes.UNAUTHORIZED));
  }
  done();
}

export function requireUser(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void {
  if (!request.user?.id || !request.user?.organizationId) {
    return done(new AppError(401, 'Authentication required', ErrorCodes.UNAUTHORIZED));
  }
  done();
}

export function requireRole(...roles: string[]) {
  const lower = roles.map((r) => r.toLowerCase());
  return function hook(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void {
    const userRole = request.user?.role?.toLowerCase() || '';
    if (!lower.includes(userRole)) {
      return done(new AppError(403, 'Insufficient permissions', ErrorCodes.FORBIDDEN));
    }
    done();
  };
}

const PERMISSION_CACHE_TTL_MS = 60_000;

export function canPermission(pool: Pool) {
  const cache = new Map<string, { result: boolean; expires: number }>();

  return async function check(role: string, resource: string, action: string): Promise<boolean> {
    const roleLower = (role || '').toLowerCase();
    const key = `${roleLower}:${resource}:${action}`;
    const now = Date.now();
    const entry = cache.get(key);
    if (entry && entry.expires > now) return entry.result;

    try {
      const r = await pool.query(
        `SELECT 1 FROM role_permissions WHERE role = $1 AND resource = $2 AND (action = $3 OR action = '*') LIMIT 1`,
        [roleLower, resource, action],
      );
      let result: boolean;
      if (r.rows.length > 0) result = true;
      else if (roleLower === 'owner') result = true;
      else if (roleLower === 'admin') result = action !== 'transfer_ownership';
      else result = false;
      cache.set(key, { result, expires: now + PERMISSION_CACHE_TTL_MS });
      return result;
    } catch {
      return false;
    }
  };
}
