import { Router } from 'express';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes } from '@getsale/service-core';
import { extractBearerToken } from '../helpers';
import { AUTH_COOKIE_ACCESS } from '../cookies';

interface Deps {
  pool: Pool;
  log: Logger;
}

export function invitesRouter({ pool }: Deps): Router {
  const router = Router();

  // Public: invite info
  router.get('/:token', asyncHandler(async (req, res) => {
    const { token } = req.params;
    const inv = await pool.query(
      `SELECT i.organization_id AS "organizationId", i.role, i.expires_at AS "expiresAt", o.name AS "organizationName"
       FROM organization_invite_links i
       JOIN organizations o ON o.id = i.organization_id
       WHERE i.token = $1`,
      [token]
    );
    if (inv.rows.length === 0) throw new AppError(404, 'Invite not found', ErrorCodes.NOT_FOUND);

    const row = inv.rows[0];
    if (new Date(row.expiresAt) <= new Date()) throw new AppError(410, 'Invite expired', ErrorCodes.BAD_REQUEST);

    res.json({
      organizationId: row.organizationId, organizationName: row.organizationName,
      role: row.role, expiresAt: row.expiresAt,
    });
  }));

  // Authenticated: accept invite
  router.post('/:token/accept', asyncHandler(async (req, res) => {
    const decoded = extractBearerToken(req, req.cookies?.[AUTH_COOKIE_ACCESS]);

    const userResult = await pool.query('SELECT id FROM users WHERE id = $1', [decoded.userId]);
    if (userResult.rows.length === 0) throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);

    const { token: inviteToken } = req.params;
    const inv = await pool.query(
      'SELECT organization_id, role, expires_at FROM organization_invite_links WHERE token = $1',
      [inviteToken]
    );
    if (inv.rows.length === 0) throw new AppError(404, 'Invite not found', ErrorCodes.NOT_FOUND);

    const { organization_id: organizationId, role, expires_at: expiresAt } = inv.rows[0];
    if (new Date(expiresAt) <= new Date()) throw new AppError(410, 'Invite expired', ErrorCodes.BAD_REQUEST);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT 1 FROM organization_members WHERE user_id = $1 AND organization_id = $2',
        [decoded.userId, organizationId]
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK').catch(() => {});
        return res.json({ success: true, message: 'Already a member' });
      }
      await client.query(
        'INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, $3)',
        [decoded.userId, organizationId, role]
      );
      await client.query('COMMIT');
      res.json({ success: true });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

  return router;
}
