import { Router } from 'express';
import { Pool } from 'pg';
import { randomBytes } from 'crypto';
import { Logger } from '@getsale/logger';
import { asyncHandler, canPermission, requireUser, AppError, ErrorCodes, validate } from '@getsale/service-core';
import { auditLog, getClientIp, normalizeRole, getRoleLevel } from '../helpers';
import { TmCreateInviteLinkSchema } from '../validation';

interface Deps {
  pool: Pool;
  log: Logger;
}

export function invitesRouter({ pool }: Deps): Router {
  const router = Router();
  router.use(requireUser());
  const checkPermission = canPermission(pool);

  router.get('/', asyncHandler(async (req, res) => {
    const user = req.user;
    const result = await pool.query(
      `SELECT ti.id, ti.email, ti.role, ti.expires_at AS "expiresAt", ti.created_at AS "createdAt", t.name AS "teamName"
       FROM team_invitations ti
       JOIN teams t ON t.id = ti.team_id
       WHERE t.organization_id = $1 AND ti.accepted_at IS NULL AND ti.expires_at > NOW()
       ORDER BY ti.created_at DESC`,
      [user.organizationId]
    );
    res.json(result.rows);
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const user = req.user;
    const allowed = await checkPermission(user.role, 'invitations', 'delete');
    if (!allowed) {
      throw new AppError(403, 'Only owner or admin can revoke invitations', ErrorCodes.FORBIDDEN);
    }

    const { id } = req.params;
    const result = await pool.query(
      `DELETE FROM team_invitations ti
       USING teams t
       WHERE ti.id = $1 AND ti.team_id = t.id AND t.organization_id = $2
       RETURNING ti.id, ti.email, ti.role`,
      [id, user.organizationId]
    );
    if (result.rowCount === 0) {
      throw new AppError(404, 'Invitation not found', ErrorCodes.NOT_FOUND);
    }
    const row = result.rows[0] as { email: string; role: string };
    await auditLog(pool, {
      organizationId: user.organizationId,
      userId: user.id,
      action: 'team.invitation_revoked',
      resourceType: 'invitation',
      resourceId: id,
      oldValue: { email: row?.email, role: row?.role },
      ip: getClientIp(req),
    });
    res.status(204).send();
  }));

  return router;
}

export function inviteLinksRouter({ pool }: Deps): Router {
  const router = Router();
  router.use(requireUser());
  const checkPermission = canPermission(pool);

  router.get('/', asyncHandler(async (req, res) => {
    const user = req.user;
    const result = await pool.query(
      `SELECT id, token, role, expires_at AS "expiresAt", created_at AS "createdAt"
       FROM organization_invite_links
       WHERE organization_id = $1
       ORDER BY created_at DESC`,
      [user.organizationId]
    );
    res.json(
      result.rows.map((r: { expiresAt: string }) => ({
        ...r,
        expired: new Date(r.expiresAt) <= new Date(),
      }))
    );
  }));

  router.post('/', validate(TmCreateInviteLinkSchema), asyncHandler(async (req, res) => {
    const user = req.user;
    const allowed = await checkPermission(user.role, 'invite_links', 'create');
    if (!allowed) {
      throw new AppError(403, 'Only owner or admin can create invite links', ErrorCodes.FORBIDDEN);
    }
    const { role: linkRole, expiresInDays } = req.body;
    const role = normalizeRole(linkRole ?? 'bidi');
    if (getRoleLevel(role) > getRoleLevel(user.role)) {
      throw new AppError(403, 'Cannot create invite link with role higher than your own', ErrorCodes.FORBIDDEN);
    }
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + (expiresInDays ?? 7));

    await pool.query(
      `INSERT INTO organization_invite_links (organization_id, token, role, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.organizationId, token, role, expiresAt, user.id]
    );
    res.status(201).json({ token, expiresAt: expiresAt.toISOString() });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;
    const result = await pool.query(
      `DELETE FROM organization_invite_links
       WHERE id = $1 AND organization_id = $2
       RETURNING id`,
      [id, user.organizationId]
    );
    if (result.rowCount === 0) {
      throw new AppError(404, 'Invite link not found', ErrorCodes.NOT_FOUND);
    }
    res.status(204).send();
  }));

  return router;
}
