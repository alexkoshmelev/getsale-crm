import { FastifyInstance, FastifyReply } from 'fastify';
import '@fastify/cookie';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { EventType, type Event } from '@getsale/events';
import { UserRole } from '@getsale/types';
import { Logger } from '@getsale/logger';
import { AppError, ErrorCodes } from '@getsale/service-framework';
import { RabbitMQClient } from '@getsale/queue';
import {
  CreateWorkspaceSchema, SwitchWorkspaceSchema, WorkspaceIdParamSchema,
  AU_ORG_NAME_MAX_LEN, AU_ORG_SLUG_MAX_LEN,
} from '../validation';
import { signAccessToken, extractBearerTokenFromRequest } from '../helpers';
import { AUTH_COOKIE_ACCESS, AUTH_COOKIE_OPTS, ACCESS_MAX_AGE_SEC } from '../cookies';
import { deleteOrganizationData } from '../delete-organization-data';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
}

function issueAccessCookie(
  reply: FastifyReply,
  user: { id: string; email: string },
  organizationId: string,
  role: string,
): void {
  const accessToken = signAccessToken({ userId: user.id, organizationId, role });
  reply.setCookie(AUTH_COOKIE_ACCESS, accessToken, { ...AUTH_COOKIE_OPTS, maxAge: ACCESS_MAX_AGE_SEC });
}

export function registerWorkspaceRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, rabbitmq, log } = deps;

  app.get('/api/auth/workspaces', async (request) => {
    const decoded = extractBearerTokenFromRequest(request, AUTH_COOKIE_ACCESS);
    const rows = await pool.query(
      `SELECT om.organization_id AS id, o.name
       FROM organization_members om
       JOIN organizations o ON o.id = om.organization_id
       WHERE om.user_id = $1 ORDER BY o.name`,
      [decoded.userId],
    );
    return rows.rows;
  });

  app.post('/api/auth/workspaces', async (request, reply) => {
    const decoded = extractBearerTokenFromRequest(request, AUTH_COOKIE_ACCESS);
    const body = CreateWorkspaceSchema.parse(request.body);
    const nameRaw = body.name.trim().slice(0, AU_ORG_NAME_MAX_LEN);
    if (!nameRaw) throw new AppError(400, 'Name is required', ErrorCodes.VALIDATION);

    const userRow = await pool.query('SELECT id, email FROM users WHERE id = $1', [decoded.userId]);
    if (!userRow.rows.length) throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);
    const user = userRow.rows[0] as { id: string; email: string };

    const rawSlug = (nameRaw.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'workspace')
      .slice(0, AU_ORG_SLUG_MAX_LEN);
    let slug = rawSlug;
    for (let attempt = 0; attempt < 10; attempt++) {
      const existing = await pool.query('SELECT id FROM organizations WHERE slug = $1', [slug]);
      if (!existing.rows.length) break;
      slug = `${rawSlug}-${Math.random().toString(36).slice(2, 6)}`.slice(0, AU_ORG_SLUG_MAX_LEN);
    }

    let organizationId: string;
    let orgName: string;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const orgResult = await client.query(
        'INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, name',
        [nameRaw, slug.slice(0, AU_ORG_SLUG_MAX_LEN)],
      );
      organizationId = orgResult.rows[0].id;
      orgName = orgResult.rows[0].name;

      await client.query(
        'INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, $3)',
        [user.id, organizationId, UserRole.OWNER],
      );
      await client.query('UPDATE users SET organization_id = $1, role = $2 WHERE id = $3', [
        organizationId, UserRole.OWNER, user.id,
      ]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.ORGANIZATION_CREATED, timestamp: new Date(),
      organizationId, userId: user.id,
      data: { organizationId, name: orgName, slug },
    } as Event).catch((err) => {
      log.warn({
        message: 'Failed to publish ORGANIZATION_CREATED',
        organizationId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    issueAccessCookie(reply, user, organizationId, UserRole.OWNER);
    return {
      user: { id: user.id, email: user.email, organizationId, role: UserRole.OWNER },
      workspace: { id: organizationId, name: orgName },
    };
  });

  app.post('/api/auth/switch-workspace', async (request, reply) => {
    const decoded = extractBearerTokenFromRequest(request, AUTH_COOKIE_ACCESS);
    const body = SwitchWorkspaceSchema.parse(request.body);
    const { organizationId } = body;

    const member = await pool.query(
      'SELECT om.role FROM organization_members om WHERE om.user_id = $1 AND om.organization_id = $2',
      [decoded.userId, organizationId],
    );
    if (!member.rows.length) throw new AppError(403, 'Not a member of this organization', ErrorCodes.FORBIDDEN);

    const userRow = await pool.query('SELECT id, email FROM users WHERE id = $1', [decoded.userId]);
    if (!userRow.rows.length) throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);

    const user = userRow.rows[0];
    const role = member.rows[0].role;
    issueAccessCookie(reply, user, organizationId, role);
    return { user: { id: user.id, email: user.email, organizationId, role } };
  });

  app.post('/api/auth/workspaces/:organizationId/leave', async (request, reply) => {
    const decoded = extractBearerTokenFromRequest(request, AUTH_COOKIE_ACCESS);
    const params = WorkspaceIdParamSchema.parse(request.params);
    const { organizationId } = params;

    const mem = await pool.query(
      'SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2',
      [decoded.userId, organizationId],
    );
    if (!mem.rows.length) throw new AppError(404, 'Not a member of this workspace', ErrorCodes.NOT_FOUND);
    if (String(mem.rows[0].role).toLowerCase() === 'owner') {
      throw new AppError(403, 'Owners cannot leave; transfer ownership first', ErrorCodes.FORBIDDEN);
    }

    const countRes = await pool.query(
      'SELECT COUNT(*)::int AS c FROM organization_members WHERE user_id = $1',
      [decoded.userId],
    );
    if ((countRes.rows[0] as { c: number }).c <= 1) {
      throw new AppError(400, 'Cannot leave your only workspace', ErrorCodes.BAD_REQUEST);
    }

    const userRow = await pool.query('SELECT id, email FROM users WHERE id = $1', [decoded.userId]);
    if (!userRow.rows.length) throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);
    const user = userRow.rows[0] as { id: string; email: string };

    const nextRes = await pool.query(
      `SELECT om.organization_id AS id, om.role
       FROM organization_members om
       JOIN organizations o ON o.id = om.organization_id
       WHERE om.user_id = $1 AND om.organization_id != $2
       ORDER BY o.name LIMIT 1`,
      [decoded.userId, organizationId],
    );
    if (!nextRes.rows.length) {
      throw new AppError(400, 'Cannot leave your only workspace', ErrorCodes.BAD_REQUEST);
    }
    const nextOrgId = nextRes.rows[0].id as string;
    const nextRole = nextRes.rows[0].role as string;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM organization_members WHERE user_id = $1 AND organization_id = $2',
        [decoded.userId, organizationId],
      );
      if (decoded.organizationId === organizationId) {
        await client.query('UPDATE users SET organization_id = $1, role = $2 WHERE id = $3', [
          nextOrgId, nextRole, decoded.userId,
        ]);
        await client.query(
          'UPDATE user_profiles SET organization_id = $1 WHERE user_id = $2 AND organization_id = $3',
          [nextOrgId, decoded.userId, organizationId],
        );
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
      [decoded.userId, jwtOrg],
    );
    const jwtRole = jwtRoleRes.rows[0]?.role ?? nextRole;
    issueAccessCookie(reply, user, jwtOrg, jwtRole);
    return { user: { id: user.id, email: user.email, organizationId: jwtOrg, role: jwtRole } };
  });

  app.delete('/api/auth/workspaces/:organizationId', async (request, reply) => {
    const decoded = extractBearerTokenFromRequest(request, AUTH_COOKIE_ACCESS);
    const params = WorkspaceIdParamSchema.parse(request.params);
    const { organizationId } = params;

    const mem = await pool.query(
      'SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2',
      [decoded.userId, organizationId],
    );
    if (!mem.rows.length) throw new AppError(404, 'Not a member of this workspace', ErrorCodes.NOT_FOUND);
    if (String(mem.rows[0].role).toLowerCase() !== 'owner') {
      throw new AppError(403, 'Only the workspace owner can delete a workspace', ErrorCodes.FORBIDDEN);
    }

    const memberCountRes = await pool.query(
      'SELECT COUNT(*)::int AS c FROM organization_members WHERE organization_id = $1',
      [organizationId],
    );
    if ((memberCountRes.rows[0] as { c: number }).c > 1) {
      throw new AppError(400, 'Workspace has other members. Remove them before deleting.', ErrorCodes.BAD_REQUEST);
    }

    const userWsCount = await pool.query(
      'SELECT COUNT(*)::int AS c FROM organization_members WHERE user_id = $1',
      [decoded.userId],
    );
    if ((userWsCount.rows[0] as { c: number }).c <= 1) {
      throw new AppError(400, 'Cannot delete your only workspace', ErrorCodes.BAD_REQUEST);
    }

    const nextRes = await pool.query(
      `SELECT om.organization_id AS id, om.role
       FROM organization_members om
       JOIN organizations o ON o.id = om.organization_id
       WHERE om.user_id = $1 AND om.organization_id != $2
       ORDER BY o.name LIMIT 1`,
      [decoded.userId, organizationId],
    );
    if (!nextRes.rows.length) {
      throw new AppError(400, 'No other workspace found to switch to', ErrorCodes.BAD_REQUEST);
    }
    const nextOrgId = nextRes.rows[0].id as string;
    const nextRole = nextRes.rows[0].role as string;

    const userRow = await pool.query('SELECT id, email FROM users WHERE id = $1', [decoded.userId]);
    if (!userRow.rows.length) throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);
    const user = userRow.rows[0] as { id: string; email: string };

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET organization_id = $1, role = $2 WHERE id = $3', [nextOrgId, nextRole, user.id]);
      await client.query(
        'UPDATE user_profiles SET organization_id = $1 WHERE user_id = $2 AND organization_id = $3',
        [nextOrgId, user.id, organizationId],
      );
      await client.query('UPDATE subscriptions SET organization_id = $1 WHERE organization_id = $2', [nextOrgId, organizationId]);
      await deleteOrganizationData(client, organizationId);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      if (err instanceof AppError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ message: 'Workspace delete failed', organizationId, error: msg });
      const pg = err as { code?: string; detail?: string };
      throw new AppError(
        500,
        'Could not delete workspace due to a server error',
        ErrorCodes.INTERNAL_ERROR,
        pg?.detail ? { detail: pg.detail } : undefined,
      );
    } finally {
      client.release();
    }

    issueAccessCookie(reply, user, nextOrgId, nextRole);
    return { user: { id: user.id, email: user.email, organizationId: nextOrgId, role: nextRole } };
  });
}
