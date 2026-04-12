import jwt from 'jsonwebtoken';
import { createHash } from 'crypto';
import { Pool } from 'pg';
import { FastifyRequest } from 'fastify';
import { AppError, ErrorCodes } from '@getsale/service-framework';
import { Logger } from '@getsale/logger';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`Missing required env: ${name}`);
  return value.trim();
}

const JWT_SECRET = requireEnv('JWT_SECRET');
const JWT_REFRESH_SECRET = requireEnv('JWT_REFRESH_SECRET');
const JWT_ALGORITHM = 'HS256' as const;

export const JWT_EXPIRES_IN = '15m';
export const REFRESH_EXPIRES_IN = '7d';

export interface JwtPayload {
  userId: string;
  organizationId: string;
  role?: string;
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export function signAccessToken(payload: { userId: string; organizationId: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN, algorithm: JWT_ALGORITHM });
}

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

export function signTempToken(userId: string): string {
  return jwt.sign({ userId, purpose: 'mfa' }, JWT_SECRET, { expiresIn: '5m', algorithm: JWT_ALGORITHM });
}

export function verifyTempToken(token: string): { userId: string } {
  const decoded = jwt.verify(token, JWT_SECRET, { algorithms: [JWT_ALGORITHM] }) as { userId: string; purpose?: string };
  if (decoded.purpose !== 'mfa') throw new Error('Invalid temp token purpose');
  return { userId: decoded.userId };
}

export async function getRoleForWorkspace(pool: Pool, userId: string, organizationId: string, userTableRole: string): Promise<string> {
  const row = await pool.query(
    'SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2',
    [userId, organizationId],
  );
  const r = row.rows[0]?.role;
  return r != null && String(r).trim() !== '' ? String(r) : userTableRole;
}

export function extractBearerTokenFromRequest(request: FastifyRequest, cookieName: string): JwtPayload {
  const cookies = (request as unknown as Record<string, unknown>).cookies as Record<string, string> | undefined;
  const token = cookies?.[cookieName] || request.headers.authorization?.replace(/^Bearer\s+/i, '')?.trim();
  if (!token) throw new AppError(401, 'Not authenticated', ErrorCodes.UNAUTHORIZED);
  try {
    return verifyAccessToken(token);
  } catch (e: unknown) {
    if ((e as Error).name === 'TokenExpiredError') throw new AppError(401, 'Token expired', ErrorCodes.UNAUTHORIZED);
    throw new AppError(401, 'Invalid token', ErrorCodes.UNAUTHORIZED);
  }
}

export function getClientIpFromRequest(request: FastifyRequest): string | null {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() || null;
  return request.ip || null;
}

export async function resolveRole(pool: Pool, userId: string, organizationId: string, jwtRole?: string): Promise<string> {
  if (jwtRole) return jwtRole;
  const row = await pool.query(
    'SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2',
    [userId, organizationId],
  );
  return row.rows[0]?.role ?? '';
}

export async function auditLog(
  pool: Pool,
  params: {
    organizationId: string; userId: string; action: string;
    resourceType?: string; resourceId?: string;
    oldValue?: object; newValue?: object; ip?: string | null;
    log?: Logger;
  },
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
      ],
    );
  } catch (err) {
    params.log?.warn({ message: 'Audit log write failed', action: params.action, error: err instanceof Error ? err.message : String(err) });
  }
}
