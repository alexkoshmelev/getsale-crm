import { FastifyInstance } from 'fastify';
import '@fastify/cookie';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { AppError, ErrorCodes } from '@getsale/service-framework';
import { InviteTokenParamSchema } from '../validation';
import { extractBearerTokenFromRequest } from '../helpers';
import { AUTH_COOKIE_ACCESS } from '../cookies';

interface Deps {
  pool: Pool;
  log: Logger;
}

function parseInviteToken(params: unknown): string {
  const parsed = InviteTokenParamSchema.safeParse(params);
  if (!parsed.success) {
    throw new AppError(400, 'Invalid invite token format', ErrorCodes.BAD_REQUEST);
  }
  return parsed.data.token;
}

export function registerInviteRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool } = deps;

  app.get('/api/invite/:token', async (request) => {
    const token = parseInviteToken(request.params);
    const inv = await pool.query(
      `SELECT i.organization_id AS "organizationId", i.role, i.expires_at AS "expiresAt", o.name AS "organizationName"
       FROM organization_invite_links i
       JOIN organizations o ON o.id = i.organization_id
       WHERE i.token = $1`,
      [token],
    );
    if (!inv.rows.length) throw new AppError(404, 'Invite not found', ErrorCodes.NOT_FOUND);

    const row = inv.rows[0];
    if (new Date(row.expiresAt) <= new Date()) throw new AppError(410, 'Invite expired', ErrorCodes.BAD_REQUEST);

    return {
      organizationId: row.organizationId,
      organizationName: row.organizationName,
      role: row.role,
      expiresAt: row.expiresAt,
    };
  });

  app.post('/api/invite/:token/accept', async (request) => {
    const decoded = extractBearerTokenFromRequest(request, AUTH_COOKIE_ACCESS);

    const userResult = await pool.query('SELECT id FROM users WHERE id = $1', [decoded.userId]);
    if (!userResult.rows.length) throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);

    const inviteToken = parseInviteToken(request.params);
    const inv = await pool.query(
      'SELECT organization_id, role, expires_at FROM organization_invite_links WHERE token = $1',
      [inviteToken],
    );
    if (!inv.rows.length) throw new AppError(404, 'Invite not found', ErrorCodes.NOT_FOUND);

    const { organization_id: organizationId, role, expires_at: expiresAt } = inv.rows[0];
    if (new Date(expiresAt) <= new Date()) throw new AppError(410, 'Invite expired', ErrorCodes.BAD_REQUEST);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT 1 FROM organization_members WHERE user_id = $1 AND organization_id = $2',
        [decoded.userId, organizationId],
      );
      if (existing.rows.length) {
        await client.query('ROLLBACK').catch(() => {});
        return { success: true, message: 'Already a member' };
      }
      await client.query(
        'INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, $3)',
        [decoded.userId, organizationId, role],
      );
      await client.query('COMMIT');
      return { success: true };
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  });
}
