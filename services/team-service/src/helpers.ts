import { Pool } from 'pg';
import { Request } from 'express';

const ALLOWED_ROLES = ['owner', 'admin', 'supervisor', 'bidi', 'viewer'] as const;
const ROLE_LEVEL: Record<string, number> = { owner: 4, admin: 3, supervisor: 2, bidi: 1, viewer: 0 };

export function normalizeRole(role: string | undefined): string {
  const r = (role || 'bidi').toLowerCase();
  if (r === 'member') return 'bidi';
  return ALLOWED_ROLES.includes(r as (typeof ALLOWED_ROLES)[number]) ? r : 'bidi';
}

/** Role hierarchy level for invite link creation: can only assign roles at or below own level. */
export function getRoleLevel(role: string): number {
  return ROLE_LEVEL[role.toLowerCase()] ?? 0;
}

export function getClientIp(req: Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() || null;
  return req.ip || req.socket?.remoteAddress || null;
}

export async function auditLog(
  pool: Pool,
  params: {
    organizationId: string;
    userId: string;
    action: string;
    resourceType?: string;
    resourceId?: string;
    oldValue?: object;
    newValue?: object;
    ip?: string | null;
  }
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id, old_value, new_value, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        params.organizationId,
        params.userId,
        params.action,
        params.resourceType ?? null,
        params.resourceId ?? null,
        params.oldValue ? JSON.stringify(params.oldValue) : null,
        params.newValue ? JSON.stringify(params.newValue) : null,
        params.ip ?? null,
      ]
    );
  } catch {
    // best effort - do not throw
  }
}
