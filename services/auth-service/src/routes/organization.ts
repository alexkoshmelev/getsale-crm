import { FastifyInstance } from 'fastify';
import '@fastify/cookie';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { AppError, ErrorCodes, canPermission } from '@getsale/service-framework';
import {
  OrgUpdateSchema, TransferOwnershipSchema,
  AU_ORG_NAME_MAX_LEN, AU_ORG_SLUG_MAX_LEN,
} from '../validation';
import {
  extractBearerTokenFromRequest, resolveRole, auditLog, getClientIpFromRequest,
} from '../helpers';
import { AUTH_COOKIE_ACCESS } from '../cookies';

interface Deps {
  pool: Pool;
  log: Logger;
}

export function registerOrganizationRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, log } = deps;
  const checkPermission = canPermission(pool);

  app.get('/api/auth/organization', async (request) => {
    const decoded = extractBearerTokenFromRequest(request, AUTH_COOKIE_ACCESS);
    const rows = await pool.query('SELECT id, name, slug FROM organizations WHERE id = $1', [decoded.organizationId]);
    if (!rows.rows.length) throw new AppError(404, 'Organization not found', ErrorCodes.NOT_FOUND);
    return rows.rows[0];
  });

  app.patch('/api/auth/organization', async (request) => {
    const decoded = extractBearerTokenFromRequest(request, AUTH_COOKIE_ACCESS);
    const role = await resolveRole(pool, decoded.userId, decoded.organizationId, decoded.role);
    const canUpdate = await checkPermission(role, 'workspace', 'update');
    if (!canUpdate) throw new AppError(403, 'Only owner or admin can update workspace settings', ErrorCodes.FORBIDDEN);

    const body = OrgUpdateSchema.parse(request.body);
    const updates: string[] = [];
    const values: unknown[] = [];
    let idx = 1;

    if (body.name !== undefined && body.name.trim()) {
      updates.push(`name = $${idx++}`);
      values.push(body.name.trim().slice(0, AU_ORG_NAME_MAX_LEN));
    }
    if (body.slug !== undefined && body.slug.trim()) {
      const slugNormalized = body.slug.trim().toLowerCase()
        .replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '')
        .slice(0, AU_ORG_SLUG_MAX_LEN);
      const existing = await pool.query(
        'SELECT id FROM organizations WHERE slug = $1 AND id != $2',
        [slugNormalized, decoded.organizationId],
      );
      if (existing.rows.length) throw new AppError(409, 'This URL slug is already taken', ErrorCodes.CONFLICT);
      updates.push(`slug = $${idx++}`);
      values.push(slugNormalized);
    }
    if (!updates.length) throw new AppError(400, 'No valid fields to update', ErrorCodes.BAD_REQUEST);

    const oldRow = await pool.query('SELECT id, name, slug FROM organizations WHERE id = $1', [decoded.organizationId]);
    const oldValue = oldRow.rows[0] ? { name: oldRow.rows[0].name, slug: oldRow.rows[0].slug } : undefined;

    values.push(decoded.organizationId);
    await pool.query(`UPDATE organizations SET ${updates.join(', ')} WHERE id = $${idx}`, values);
    const rows = await pool.query('SELECT id, name, slug FROM organizations WHERE id = $1', [decoded.organizationId]);
    const newValue = rows.rows[0] ? { name: rows.rows[0].name, slug: rows.rows[0].slug } : undefined;

    await auditLog(pool, {
      organizationId: decoded.organizationId, userId: decoded.userId,
      action: 'organization.updated', resourceType: 'organization',
      resourceId: decoded.organizationId,
      oldValue, newValue, ip: getClientIpFromRequest(request), log,
    });

    return rows.rows[0];
  });

  app.post('/api/auth/organization/transfer-ownership', async (request) => {
    const decoded = extractBearerTokenFromRequest(request, AUTH_COOKIE_ACCESS);
    const role = await resolveRole(pool, decoded.userId, decoded.organizationId, decoded.role);
    if (role.toLowerCase() !== 'owner') {
      throw new AppError(403, 'Only the current owner can transfer ownership', ErrorCodes.FORBIDDEN);
    }

    const body = TransferOwnershipSchema.parse(request.body);
    const { newOwnerUserId: newOwnerId } = body;

    const target = await pool.query(
      'SELECT 1 FROM organization_members WHERE user_id = $1 AND organization_id = $2',
      [newOwnerId, decoded.organizationId],
    );
    if (!target.rows.length) throw new AppError(404, 'User is not a member of this organization', ErrorCodes.NOT_FOUND);
    if (newOwnerId === decoded.userId) throw new AppError(400, 'Cannot transfer to yourself', ErrorCodes.BAD_REQUEST);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE organization_members SET role = $1 WHERE user_id = $2 AND organization_id = $3',
        ['admin', decoded.userId, decoded.organizationId],
      );
      await client.query(
        'UPDATE organization_members SET role = $1 WHERE user_id = $2 AND organization_id = $3',
        ['owner', newOwnerId, decoded.organizationId],
      );
      await client.query(
        'UPDATE users SET role = $1 WHERE id = $2 AND organization_id = $3',
        ['admin', decoded.userId, decoded.organizationId],
      );
      await client.query(
        'UPDATE users SET role = $1 WHERE id = $2 AND organization_id = $3',
        ['owner', newOwnerId, decoded.organizationId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await auditLog(pool, {
      organizationId: decoded.organizationId, userId: decoded.userId,
      action: 'organization.ownership_transferred', resourceType: 'organization',
      resourceId: decoded.organizationId,
      newValue: { newOwnerUserId: newOwnerId },
      ip: getClientIpFromRequest(request), log,
    });

    return { success: true };
  });

  app.get('/api/auth/audit-logs', async (request) => {
    const decoded = extractBearerTokenFromRequest(request, AUTH_COOKIE_ACCESS);
    const role = await resolveRole(pool, decoded.userId, decoded.organizationId, decoded.role);
    const allowed = await checkPermission(role, 'audit', 'read');
    if (!allowed) throw new AppError(403, 'Only owner or admin can view audit logs', ErrorCodes.FORBIDDEN);

    const query = request.query as { limit?: string };
    const rawLimit = parseInt(query.limit || '100', 10);
    const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 100 : rawLimit), 500);

    const rows = await pool.query(
      `SELECT id, user_id, action, resource_type, resource_id, old_value, new_value, ip, created_at
       FROM audit_logs WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [decoded.organizationId, limit],
    );
    return rows.rows;
  });
}
