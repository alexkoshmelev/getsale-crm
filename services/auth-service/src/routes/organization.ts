import { Router } from 'express';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes } from '@getsale/service-core';
import { extractBearerToken, canPermission, auditLog, resolveRole, getClientIp } from '../helpers';
import { AUTH_COOKIE_ACCESS } from '../cookies';

interface Deps {
  pool: Pool;
  log: Logger;
}

export function organizationRouter({ pool, log }: Deps): Router {
  const router = Router();

  const tokenFromReq = (req: { cookies?: { [k: string]: string } }) => req.cookies?.[AUTH_COOKIE_ACCESS];

  router.get('/organization', asyncHandler(async (req, res) => {
    const decoded = extractBearerToken(req, tokenFromReq(req));
    const rows = await pool.query('SELECT id, name, slug FROM organizations WHERE id = $1', [decoded.organizationId]);
    if (rows.rows.length === 0) throw new AppError(404, 'Organization not found', ErrorCodes.NOT_FOUND);
    res.json(rows.rows[0]);
  }));

  router.patch('/organization', asyncHandler(async (req, res) => {
    const decoded = extractBearerToken(req, tokenFromReq(req));
    const role = await resolveRole(pool, decoded.userId, decoded.organizationId, decoded.role);
    const canUpdate = await canPermission(pool, role, 'workspace', 'update');
    if (!canUpdate) throw new AppError(403, 'Only owner or admin can update workspace settings', ErrorCodes.FORBIDDEN);

    const { name, slug } = req.body;
    const updates: string[] = [];
    const values: unknown[] = [];
    let i = 1;

    if (name !== undefined && typeof name === 'string' && name.trim()) {
      updates.push(`name = $${i++}`);
      values.push(name.trim());
    }
    if (slug !== undefined && typeof slug === 'string' && slug.trim()) {
      const slugNormalized = slug.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
      const existing = await pool.query('SELECT id FROM organizations WHERE slug = $1 AND id != $2', [slugNormalized, decoded.organizationId]);
      if (existing.rows.length > 0) throw new AppError(409, 'This URL slug is already taken', ErrorCodes.CONFLICT);
      updates.push(`slug = $${i++}`);
      values.push(slugNormalized);
    }
    if (updates.length === 0) throw new AppError(400, 'No valid fields to update', ErrorCodes.BAD_REQUEST);

    const oldRow = await pool.query('SELECT id, name, slug FROM organizations WHERE id = $1', [decoded.organizationId]);
    const oldValue = oldRow.rows[0] ? { name: oldRow.rows[0].name, slug: oldRow.rows[0].slug } : undefined;

    values.push(decoded.organizationId);
    await pool.query(`UPDATE organizations SET ${updates.join(', ')} WHERE id = $${i}`, values);
    const rows = await pool.query('SELECT id, name, slug FROM organizations WHERE id = $1', [decoded.organizationId]);
    const newValue = rows.rows[0] ? { name: rows.rows[0].name, slug: rows.rows[0].slug } : undefined;

    await auditLog(pool, {
      organizationId: decoded.organizationId, userId: decoded.userId,
      action: 'organization.updated', resourceType: 'organization', resourceId: decoded.organizationId,
      oldValue, newValue, ip: getClientIp(req),
    });

    res.json(rows.rows[0]);
  }));

  router.post('/organization/transfer-ownership', asyncHandler(async (req, res) => {
    const decoded = extractBearerToken(req, tokenFromReq(req));
    const role = await resolveRole(pool, decoded.userId, decoded.organizationId, decoded.role);
    if (role.toLowerCase() !== 'owner') throw new AppError(403, 'Only the current owner can transfer ownership', ErrorCodes.FORBIDDEN);

    const { newOwnerUserId } = req.body;
    if (!newOwnerUserId || typeof newOwnerUserId !== 'string') throw new AppError(400, 'newOwnerUserId is required', ErrorCodes.BAD_REQUEST);

    const target = await pool.query('SELECT 1 FROM organization_members WHERE user_id = $1 AND organization_id = $2', [newOwnerUserId.trim(), decoded.organizationId]);
    if (target.rows.length === 0) throw new AppError(404, 'User is not a member of this organization', ErrorCodes.NOT_FOUND);
    if (newOwnerUserId.trim() === decoded.userId) throw new AppError(400, 'Cannot transfer to yourself', ErrorCodes.BAD_REQUEST);

    await pool.query('UPDATE organization_members SET role = $1 WHERE user_id = $2 AND organization_id = $3', ['admin', decoded.userId, decoded.organizationId]);
    await pool.query('UPDATE organization_members SET role = $1 WHERE user_id = $2 AND organization_id = $3', ['owner', newOwnerUserId.trim(), decoded.organizationId]);
    await pool.query('UPDATE users SET role = $1 WHERE id = $2 AND organization_id = $3', ['admin', decoded.userId, decoded.organizationId]);
    await pool.query('UPDATE users SET role = $1 WHERE id = $2 AND organization_id = $3', ['owner', newOwnerUserId.trim(), decoded.organizationId]);

    await auditLog(pool, {
      organizationId: decoded.organizationId, userId: decoded.userId,
      action: 'organization.ownership_transferred', resourceType: 'organization',
      resourceId: decoded.organizationId, newValue: { newOwnerUserId: newOwnerUserId.trim() },
      ip: getClientIp(req),
    });

    res.json({ success: true });
  }));

  router.get('/audit-logs', asyncHandler(async (req, res) => {
    const decoded = extractBearerToken(req, tokenFromReq(req));
    const role = await resolveRole(pool, decoded.userId, decoded.organizationId, decoded.role);
    const allowed = await canPermission(pool, role, 'audit', 'read');
    if (!allowed) throw new AppError(403, 'Only owner or admin can view audit logs', ErrorCodes.FORBIDDEN);

    const limit = Math.min(parseInt(req.query.limit as string, 10) || 100, 500);
    const rows = await pool.query(
      `SELECT id, user_id, action, resource_type, resource_id, old_value, new_value, ip, created_at
       FROM audit_logs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [decoded.organizationId, limit]
    );
    res.json(rows.rows);
  }));

  return router;
}
