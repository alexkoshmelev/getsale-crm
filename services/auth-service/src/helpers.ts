import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import { Pool } from 'pg';
import { Request } from 'express';
import { AppError, ErrorCodes } from '@getsale/service-core';

/** SHA-256 hash of refresh token for storage (never store plaintext). */
export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}. Set it before starting the service.`);
  }
  return value.trim();
}

const JWT_SECRET = requireEnv('JWT_SECRET');
const JWT_REFRESH_SECRET = requireEnv('JWT_REFRESH_SECRET');
export const JWT_EXPIRES_IN = '15m';
export const REFRESH_EXPIRES_IN = '7d';

export interface JwtPayload {
  userId: string;
  organizationId: string;
  role?: string;
}

const JWT_ALGORITHM = 'HS256' as const;

export function signAccessToken(payload: { userId: string; organizationId: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN, algorithm: JWT_ALGORITHM });
}

/** Short-lived token for WebSocket handshake (same secret as access, 5 min). Accepted by /api/auth/verify. */
export function signWsToken(payload: { userId: string; organizationId: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '5m', algorithm: JWT_ALGORITHM });
}

export function signRefreshToken(userId: string): string {
  return jwt.sign({ userId }, JWT_REFRESH_SECRET, { expiresIn: REFRESH_EXPIRES_IN, algorithm: JWT_ALGORITHM });
}

export function verifyAccessToken(token: string): JwtPayload {
  return jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] }) as JwtPayload;
}

export function verifyRefreshToken(token: string): { userId: string } {
  return jwt.verify(token, JWT_REFRESH_SECRET, { algorithms: [JWT_ALGORITHM] }) as { userId: string };
}

/** Short-lived JWT for 2FA login flow — contains userId + purpose='mfa', 5 min expiry. */
export function signTempToken(userId: string): string {
  return jwt.sign({ userId, purpose: 'mfa' }, JWT_SECRET, { expiresIn: '5m', algorithm: JWT_ALGORITHM });
}

export function verifyTempToken(token: string): { userId: string } {
  const decoded = jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] }) as { userId: string; purpose?: string };
  if (decoded.purpose !== 'mfa') {
    throw new AppError(401, 'Invalid token', ErrorCodes.UNAUTHORIZED);
  }
  return { userId: decoded.userId };
}

/** Get payload from cookie (httpOnly) or Authorization header. */
export function extractBearerToken(req: Request, tokenFromCookie?: string | null): JwtPayload {
  const token = tokenFromCookie ?? req.headers.authorization?.replace(/^Bearer\s+/i, '')?.trim();
  if (!token) throw new AppError(401, 'Unauthorized', ErrorCodes.UNAUTHORIZED);
  try {
    return verifyAccessToken(token);
  } catch (e: unknown) {
    const err = e as Error;
    if (err.name === 'TokenExpiredError') throw new AppError(401, 'Token expired', ErrorCodes.UNAUTHORIZED);
    throw new AppError(401, 'Invalid token', ErrorCodes.UNAUTHORIZED);
  }
}

export function getClientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() || null;
  return req.ip || req.socket?.remoteAddress || null;
}

export async function canPermission(pool: Pool, role: string, resource: string, action: string): Promise<boolean> {
  const roleLower = (role || '').toLowerCase();
  try {
    const r = await pool.query(
      'SELECT 1 FROM role_permissions WHERE role = $1 AND resource = $2 AND (action = $3 OR action = \'*\') LIMIT 1',
      [roleLower, resource, action]
    );
    if (r.rows.length > 0) return true;
    if (roleLower === 'owner') return true;
    return false;
  } catch {
    // Fail closed: on DB error deny access (do not allow by role)
    return false;
  }
}

export async function auditLog(
  pool: Pool,
  params: {
    organizationId: string; userId: string; action: string;
    resourceType?: string; resourceId?: string;
    oldValue?: object; newValue?: object; ip?: string | null;
    log?: import('@getsale/logger').Logger;
  }
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id, old_value, new_value, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        params.organizationId, params.userId, params.action,
        params.resourceType ?? null, params.resourceId ?? null,
        params.oldValue ? JSON.stringify(params.oldValue) : null,
        params.newValue ? JSON.stringify(params.newValue) : null,
        params.ip ?? null,
      ]
    );
  } catch (err) {
    params.log?.warn({ message: 'Audit log write failed', action: params.action, error: err instanceof Error ? err.message : String(err) });
  }
}

export async function resolveRole(pool: Pool, userId: string, organizationId: string, jwtRole?: string): Promise<string> {
  if (jwtRole) return jwtRole;
  const memberRow = await pool.query(
    'SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2',
    [userId, organizationId]
  );
  return memberRow.rows[0]?.role ?? '';
}

/**
 * Role for access-token JWT: prefer `organization_members` (workspace truth), fallback to `users.role`.
 * Keeps JWT aligned with team/org role changes; `users.role` is legacy primary-org mirror.
 */
export async function getRoleForWorkspace(
  pool: Pool,
  userId: string,
  organizationId: string,
  userTableRole: string
): Promise<string> {
  const memberRow = await pool.query(
    'SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2',
    [userId, organizationId]
  );
  const r = memberRow.rows[0]?.role;
  return r != null && String(r).trim() !== '' ? String(r) : userTableRole;
}
