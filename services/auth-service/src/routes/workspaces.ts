import { Router } from 'express';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, type Event } from '@getsale/events';
import { UserRole } from '@getsale/types';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, validate } from '@getsale/service-core';
import {
  AuSwitchWorkspaceSchema,
  AuCreateWorkspaceSchema,
  AU_ORG_SLUG_MAX_LEN,
  AU_ORG_NAME_MAX_LEN,
} from '../validation';
import { extractBearerToken, signAccessToken } from '../helpers';
import { AUTH_COOKIE_ACCESS, AUTH_COOKIE_OPTS, ACCESS_MAX_AGE_SEC } from '../cookies';
import { deleteOrganizationData } from '../delete-organization-data';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
}

function issueUserCookie(
  res: import('express').Response,
  user: { id: string; email: string },
  organizationId: string,
  role: string
): void {
  const accessToken = signAccessToken({ userId: user.id, organizationId, role });
  res.cookie(AUTH_COOKIE_ACCESS, accessToken, { ...AUTH_COOKIE_OPTS, maxAge: ACCESS_MAX_AGE_SEC * 1000 });
}

export function workspacesRouter({ pool, rabbitmq, log }: Deps): Router {
  const router = Router();

  router.get('/workspaces', asyncHandler(async (req, res) => {
    const decoded = extractBearerToken(req, req.cookies?.[AUTH_COOKIE_ACCESS]);
    const rows = await pool.query(
      `SELECT om.organization_id AS id, o.name
       FROM organization_members om
       JOIN organizations o ON o.id = om.organization_id
       WHERE om.user_id = $1 ORDER BY o.name`,
      [decoded.userId]
    );
    res.json(rows.rows);
  }));

  router.post('/workspaces', validate(AuCreateWorkspaceSchema), asyncHandler(async (req, res) => {
    const decoded = extractBearerToken(req, req.cookies?.[AUTH_COOKIE_ACCESS]);
    const nameRaw = String(req.body.name ?? '').trim().slice(0, AU_ORG_NAME_MAX_LEN);
    if (!nameRaw) throw new AppError(400, 'Name is required', ErrorCodes.VALIDATION);

    const userRow = await pool.query('SELECT id, email FROM users WHERE id = $1', [decoded.userId]);
    if (userRow.rows.length === 0) throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);
    const user = userRow.rows[0] as { id: string; email: string };

    const rawSlug = (nameRaw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'workspace').slice(0, AU_ORG_SLUG_MAX_LEN);
    let slug = rawSlug;
    for (let attempt = 0; attempt < 10; attempt++) {
      const existing = await pool.query('SELECT id FROM organizations WHERE slug = $1', [slug]);
      if (existing.rows.length === 0) break;
      slug = `${rawSlug}-${Math.random().toString(36).slice(2, 6)}`.slice(0, AU_ORG_SLUG_MAX_LEN);
    }

    let organizationId: string;
    let orgName: string;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orgResult = await client.query(
        'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, name',
        [nameRaw, slug.slice(0, AU_ORG_SLUG_MAX_LEN)]
      );
      organizationId = orgResult.rows[0].id;
      orgName = orgResult.rows[0].name;

      await client.query(
        'INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, $3)',
        [user.id, organizationId, UserRole.OWNER]
      );

      await client.query('UPDATE users SET organization_id = $1, role = $2 WHERE id = $3', [
        organizationId,
        UserRole.OWNER,
        user.id,
      ]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const orgEvent = {
      id: randomUUID(),
      type: EventType.ORGANIZATION_CREATED,
      timestamp: new Date(),
      organizationId,
      userId: user.id,
      correlationId: req.correlationId,
      data: { organizationId, name: orgName, slug },
    };
    await rabbitmq.publishEvent(orgEvent as Event).catch((err) => {
      log.warn({
        message: 'Failed to publish ORGANIZATION_CREATED',
        organizationId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    issueUserCookie(res, user, organizationId, UserRole.OWNER);
    res.json({
      user: { id: user.id, email: user.email, organizationId, role: UserRole.OWNER },
      workspace: { id: organizationId, name: orgName },
    });
  }));

  router.post('/switch-workspace', validate(AuSwitchWorkspaceSchema), asyncHandler(async (req, res) => {
    const decoded = extractBearerToken(req, req.cookies?.[AUTH_COOKIE_ACCESS]);
    const { organizationId } = req.body;

    const member = await pool.query(
      'SELECT om.role FROM organization_members om WHERE om.user_id = $1 AND om.organization_id = $2',
      [decoded.userId, organizationId]
    );
    if (member.rows.length === 0) throw new AppError(403, 'Not a member of this organization', ErrorCodes.FORBIDDEN);

    const userRow = await pool.query('SELECT id, email FROM users WHERE id = $1', [decoded.userId]);
    if (userRow.rows.length === 0) throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);

    const user = userRow.rows[0];
    const role = member.rows[0].role;
    issueUserCookie(res, user, organizationId, role);

    res.json({ user: { id: user.id, email: user.email, organizationId, role } });
  }));

  router.post('/workspaces/:organizationId/leave', asyncHandler(async (req, res) => {
    const decoded = extractBearerToken(req, req.cookies?.[AUTH_COOKIE_ACCESS]);
    const organizationId = req.params.organizationId;
    if (!organizationId || !/^[0-9a-f-]{36}$/i.test(organizationId)) {
      throw new AppError(400, 'Invalid organization id', ErrorCodes.VALIDATION);
    }

    const mem = await pool.query(
      'SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2',
      [decoded.userId, organizationId]
    );
    if (mem.rows.length === 0) throw new AppError(404, 'Not a member of this workspace', ErrorCodes.NOT_FOUND);
    if (String(mem.rows[0].role).toLowerCase() === 'owner') {
      throw new AppError(403, 'Owners cannot leave; transfer ownership first', ErrorCodes.FORBIDDEN);
    }

    const countRes = await pool.query(
      'SELECT COUNT(*)::int AS c FROM organization_members WHERE user_id = $1',
      [decoded.userId]
    );
    const total = (countRes.rows[0] as { c: number }).c;
    if (total <= 1) {
      throw new AppError(400, 'Cannot leave your only workspace', ErrorCodes.BAD_REQUEST);
    }

    const userRow = await pool.query('SELECT id, email FROM users WHERE id = $1', [decoded.userId]);
    if (userRow.rows.length === 0) throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);
    const user = userRow.rows[0] as { id: string; email: string };

    const nextRes = await pool.query(
      `SELECT om.organization_id AS id, om.role
       FROM organization_members om
       JOIN organizations o ON o.id = om.organization_id
       WHERE om.user_id = $1 AND om.organization_id != $2
       ORDER BY o.name
       LIMIT 1`,
      [decoded.userId, organizationId]
    );
    if (nextRes.rows.length === 0) {
      throw new AppError(400, 'Cannot leave your only workspace', ErrorCodes.BAD_REQUEST);
    }
    const nextOrgId = nextRes.rows[0].id as string;
    const nextRole = nextRes.rows[0].role as string;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM organization_members WHERE user_id = $1 AND organization_id = $2', [
        decoded.userId,
        organizationId,
      ]);
      if (decoded.organizationId === organizationId) {
        await client.query('UPDATE users SET organization_id = $1, role = $2 WHERE id = $3', [
          nextOrgId,
          nextRole,
          decoded.userId,
        ]);
        await client.query('UPDATE user_profiles SET organization_id = $1 WHERE user_id = $2 AND organization_id = $3', [
          nextOrgId,
          decoded.userId,
          organizationId,
        ]);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const jwtOrg = decoded.organizationId === organizationId ? nextOrgId : decoded.organizationId;
    const jwtRoleRes = await pool.query(
      'SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2',
      [decoded.userId, jwtOrg]
    );
    const jwtRole = jwtRoleRes.rows[0]?.role ?? nextRole;
    issueUserCookie(res, user, jwtOrg, jwtRole);

    res.json({ user: { id: user.id, email: user.email, organizationId: jwtOrg, role: jwtRole } });
  }));

  /** Only org `owner` may delete; admin, supervisor, bidi, viewer cannot (enforced via organization_members.role). */
  router.delete('/workspaces/:organizationId', asyncHandler(async (req, res) => {
    const decoded = extractBearerToken(req, req.cookies?.[AUTH_COOKIE_ACCESS]);
    const organizationId = req.params.organizationId;
    if (!organizationId || !/^[0-9a-f-]{36}$/i.test(organizationId)) {
      throw new AppError(400, 'Invalid organization id', ErrorCodes.VALIDATION);
    }

    const mem = await pool.query(
      'SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2',
      [decoded.userId, organizationId]
    );
    if (mem.rows.length === 0) throw new AppError(404, 'Not a member of this workspace', ErrorCodes.NOT_FOUND);
    if (String(mem.rows[0].role).toLowerCase() !== 'owner') {
      throw new AppError(
        403,
        'Only the workspace owner can delete a workspace. Admins and other roles cannot delete.',
        ErrorCodes.FORBIDDEN
      );
    }

    const memberCountRes = await pool.query(
      'SELECT COUNT(*)::int AS c FROM organization_members WHERE organization_id = $1',
      [organizationId]
    );
    if ((memberCountRes.rows[0] as { c: number }).c > 1) {
      throw new AppError(
        400,
        'Workspace has other members. Remove them before deleting the workspace.',
        ErrorCodes.BAD_REQUEST
      );
    }

    const userWsCount = await pool.query(
      'SELECT COUNT(*)::int AS c FROM organization_members WHERE user_id = $1',
      [decoded.userId]
    );
    if ((userWsCount.rows[0] as { c: number }).c <= 1) {
      throw new AppError(400, 'Cannot delete your only workspace', ErrorCodes.BAD_REQUEST);
    }

    const nextRes = await pool.query(
      `SELECT om.organization_id AS id, om.role
       FROM organization_members om
       JOIN organizations o ON o.id = om.organization_id
       WHERE om.user_id = $1 AND om.organization_id != $2
       ORDER BY o.name
       LIMIT 1`,
      [decoded.userId, organizationId]
    );
    const nextOrgId = nextRes.rows[0].id as string;
    const nextRole = nextRes.rows[0].role as string;

    const userRow = await pool.query('SELECT id, email FROM users WHERE id = $1', [decoded.userId]);
    if (userRow.rows.length === 0) throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);
    const user = userRow.rows[0] as { id: string; email: string };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET organization_id = $1, role = $2 WHERE id = $3', [nextOrgId, nextRole, user.id]);
      await client.query('UPDATE user_profiles SET organization_id = $1 WHERE user_id = $2 AND organization_id = $3', [
        nextOrgId,
        user.id,
        organizationId,
      ]);
      await client.query('UPDATE subscriptions SET organization_id = $1 WHERE organization_id = $2', [nextOrgId, organizationId]);
      await deleteOrganizationData(client, organizationId);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    issueUserCookie(res, user, nextOrgId, nextRole);
    res.json({ user: { id: user.id, email: user.email, organizationId: nextOrgId, role: nextRole } });
  }));

  return router;
}
