import { Router } from 'express';
import { Pool } from 'pg';
import { randomBytes } from 'crypto';
import { Logger } from '@getsale/logger';
import { asyncHandler, canPermission, requireUser, validate, AppError, ErrorCodes } from '@getsale/service-core';
import { normalizeRole, getRoleLevel } from '../helpers';
import { TmCreateInviteLinkSchema } from '../validation';

interface Deps {
  pool: Pool;
  log: Logger;
}

/** Legacy email invitations (team_invitations) removed; use workspace invite links only. */
export function invitesRouter(_deps: Deps): Router {
  const router = Router();
  router.use(requireUser());

  router.get('/', asyncHandler(async (_req, res) => {
    res.json([]);
  }));

  router.delete('/:id', asyncHandler(async (_req, res) => {
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
