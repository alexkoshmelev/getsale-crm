import { FastifyInstance } from 'fastify';
import { randomBytes, randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { EventType, type TeamMemberAddedEvent, type Event } from '@getsale/events';
import { AppError, ErrorCodes, requireUser } from '@getsale/service-framework';
import type { CoreDeps } from '../types';

const ADMIN_ROLES = ['owner', 'admin'];

const CreateInviteLinkSchema = z.object({
  role: z.string().min(1).default('member'),
  expiresInDays: z.number().int().min(1).max(90).default(7),
});

const EmailInviteSchema = z.object({
  email: z.string().email(),
  role: z.string().min(1).default('member'),
});

const UpdateRoleSchema = z.object({
  role: z.string().min(1),
});

const AssignClientSchema = z.object({
  clientId: z.string().uuid(),
  userId: z.string().uuid().optional(),
  assignedTo: z.string().uuid().optional(),
}).transform((d) => ({
  clientId: d.clientId,
  assignedTo: d.assignedTo ?? d.userId!,
}));

function normalizeRole(role: string): string {
  const r = role.trim().toLowerCase();
  if (r === 'member') return 'bidi';
  return r;
}

function isAdminRole(role: string): boolean {
  return ADMIN_ROLES.includes(role.toLowerCase());
}

export function registerTeamRoutes(app: FastifyInstance, deps: CoreDeps): void {
  const { db, rabbitmq, log } = deps;

  // GET /api/team/members — list with profile info and role-priority ordering
  app.get('/api/team/members', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const result = await db.read.query(
      `SELECT
         u.id AS user_id,
         u.email,
         up.first_name,
         up.last_name,
         up.avatar_url,
         om.role,
         om.joined_at,
         'active'::text AS member_status
       FROM organization_members om
       JOIN users u ON u.id = om.user_id
       LEFT JOIN user_profiles up ON up.user_id = u.id
       WHERE om.organization_id = $1
       ORDER BY CASE LOWER(om.role)
         WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'supervisor' THEN 3 WHEN 'bidi' THEN 4 WHEN 'viewer' THEN 5
         ELSE 6 END,
         LOWER(u.email)`,
      [user.organizationId],
    );
    return result.rows;
  });

  // DELETE /api/team/members/:id — admin-only, owner protection, multi-workspace handling
  app.delete('/api/team/members/:id', { preHandler: [requireUser] }, async (request, reply) => {
    const { id: targetUserId } = request.params as { id: string };
    const user = request.user!;

    if (!isAdminRole(user.role)) {
      throw new AppError(403, 'Only owner or admin can remove members', ErrorCodes.FORBIDDEN);
    }
    if (targetUserId === user.id) {
      throw new AppError(400, 'Use leave workspace to remove yourself', ErrorCodes.BAD_REQUEST);
    }

    const mem = await db.read.query(
      'SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2',
      [targetUserId, user.organizationId],
    );
    if (!mem.rows.length) {
      throw new AppError(404, 'Member not found in this workspace', ErrorCodes.NOT_FOUND);
    }
    if (String(mem.rows[0].role).toLowerCase() === 'owner') {
      throw new AppError(403, 'Cannot remove workspace owner; transfer ownership first', ErrorCodes.FORBIDDEN);
    }

    const membershipCount = await db.read.query(
      'SELECT COUNT(*)::int AS c FROM organization_members WHERE user_id = $1',
      [targetUserId],
    );
    if ((membershipCount.rows[0] as { c: number }).c <= 1) {
      throw new AppError(400, 'Cannot remove a user who belongs only to this workspace', ErrorCodes.BAD_REQUEST);
    }

    const client = await db.write.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'DELETE FROM organization_members WHERE user_id = $1 AND organization_id = $2',
        [targetUserId, user.organizationId],
      );

      const uRow = await client.query('SELECT organization_id FROM users WHERE id = $1', [targetUserId]);
      const userCurrentOrg = uRow.rows[0]?.organization_id as string | undefined;
      if (userCurrentOrg === user.organizationId) {
        const nextRes = await client.query(
          `SELECT om.organization_id AS id, om.role
           FROM organization_members om
           JOIN organizations o ON o.id = om.organization_id
           WHERE om.user_id = $1
           ORDER BY o.name LIMIT 1`,
          [targetUserId],
        );
        if (nextRes.rows.length) {
          const nextOrgId = nextRes.rows[0].id as string;
          const nextRole = nextRes.rows[0].role as string;
          await client.query('UPDATE users SET organization_id = $1, role = $2 WHERE id = $3', [
            nextOrgId, nextRole, targetUserId,
          ]);
          await client.query(
            'UPDATE user_profiles SET organization_id = $1 WHERE user_id = $2 AND organization_id = $3',
            [nextOrgId, targetUserId, user.organizationId],
          );
        }
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    reply.code(204).send();
  });

  // PUT /api/team/members/:id/role — admin-only, updates both org_members and users table
  app.put('/api/team/members/:id/role', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id: targetUserId } = request.params as { id: string };
    const { role } = UpdateRoleSchema.parse(request.body);
    const normalizedRole = normalizeRole(role);

    if (!isAdminRole(user.role)) {
      throw new AppError(403, 'Only owner or admin can change member roles', ErrorCodes.FORBIDDEN);
    }

    const mem = await db.read.query(
      'SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2',
      [targetUserId, user.organizationId],
    );
    if (!mem.rows.length) {
      throw new AppError(404, 'Member not found in this workspace', ErrorCodes.NOT_FOUND);
    }

    await db.write.query(
      'UPDATE organization_members SET role = $1 WHERE user_id = $2 AND organization_id = $3',
      [normalizedRole, targetUserId, user.organizationId],
    );
    await db.write.query(
      'UPDATE users SET role = $1 WHERE id = $2 AND organization_id = $3',
      [normalizedRole, targetUserId, user.organizationId],
    );

    const row = await db.read.query(
      `SELECT u.id AS user_id, u.email, om.role, om.joined_at
       FROM organization_members om
       JOIN users u ON u.id = om.user_id
       WHERE om.user_id = $1 AND om.organization_id = $2`,
      [targetUserId, user.organizationId],
    );
    return row.rows[0];
  });

  // POST /api/team/members/invite — creates user if needed, adds to org, publishes event
  app.post('/api/team/members/invite', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const body = EmailInviteSchema.parse(request.body);
    const normalizedEmail = body.email.trim().toLowerCase();
    const normalizedRole = normalizeRole(body.role);

    if (!isAdminRole(user.role)) {
      throw new AppError(403, 'Only owner or admin can invite members', ErrorCodes.FORBIDDEN);
    }

    const existing = await db.read.query(
      'SELECT id FROM users WHERE LOWER(TRIM(email)) = $1',
      [normalizedEmail],
    );

    if (existing.rows.length) {
      const existingUserId = existing.rows[0].id as string;
      const alreadyMember = await db.read.query(
        'SELECT 1 FROM organization_members WHERE user_id = $1 AND organization_id = $2',
        [existingUserId, user.organizationId],
      );
      if (alreadyMember.rows.length) {
        throw new AppError(409, 'User is already a member of this workspace', ErrorCodes.CONFLICT);
      }

      await db.write.query(
        'INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, $3)',
        [existingUserId, user.organizationId, normalizedRole],
      );

      const event: TeamMemberAddedEvent = {
        id: randomUUID(),
        type: EventType.TEAM_MEMBER_ADDED,
        timestamp: new Date(),
        organizationId: user.organizationId,
        userId: user.id,
        data: { teamId: user.organizationId, userId: existingUserId, role: normalizedRole },
      };
      await rabbitmq.publishEvent(event as unknown as Event);

      return { userId: existingUserId, role: normalizedRole, status: 'active' };
    }

    const tempPassword = randomUUID();
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    try {
      const newUserResult = await db.write.query(
        `INSERT INTO users (email, password_hash, organization_id, role)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [normalizedEmail, passwordHash, user.organizationId, normalizedRole],
      );
      const newUser = newUserResult.rows[0];

      await db.write.query(
        `INSERT INTO user_profiles (user_id, organization_id, first_name, last_name, preferences)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO NOTHING`,
        [newUser.id, user.organizationId, null, null, JSON.stringify({})],
      );

      await db.write.query(
        'INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, $3)',
        [newUser.id, user.organizationId, normalizedRole],
      );

      const event: TeamMemberAddedEvent = {
        id: randomUUID(),
        type: EventType.TEAM_MEMBER_ADDED,
        timestamp: new Date(),
        organizationId: user.organizationId,
        userId: user.id,
        data: { teamId: user.organizationId, userId: newUser.id, role: normalizedRole },
      };
      await rabbitmq.publishEvent(event as unknown as Event);

      reply.code(201);
      return {
        user: { id: newUser.id, email: newUser.email, status: 'pending' },
        message: 'User created; they should use password reset or invite link to sign in',
      };
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr?.code === '23505') {
        throw new AppError(409, 'User already exists', ErrorCodes.CONFLICT);
      }
      throw err;
    }
  });

  // POST /api/team/clients/assign — with assigned_by tracking
  app.post('/api/team/clients/assign', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const { clientId, assignedTo } = AssignClientSchema.parse(request.body);

    const result = await db.write.query(
      `INSERT INTO organization_client_assignments (organization_id, client_id, assigned_to, assigned_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, client_id)
       DO UPDATE SET assigned_to = EXCLUDED.assigned_to, assigned_at = NOW(), assigned_by = EXCLUDED.assigned_by
       RETURNING *`,
      [user.organizationId, clientId, assignedTo, user.id],
    );

    reply.code(201);
    return result.rows[0];
  });

  // GET /api/team/clients/shared — full contact details
  app.get('/api/team/clients/shared', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const result = await db.read.query(
      `SELECT DISTINCT c.*, oca.assigned_to, oca.assigned_at
       FROM contacts c
       JOIN organization_client_assignments oca ON c.id = oca.client_id AND oca.organization_id = $1
       ORDER BY oca.assigned_at DESC`,
      [user.organizationId],
    );
    return result.rows;
  });

  // --- Invite Links ---

  app.get('/api/team/invite-links', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const result = await db.read.query(
      `SELECT id, token, role, expires_at, created_at
       FROM organization_invite_links
       WHERE organization_id = $1
       ORDER BY created_at DESC`,
      [user.organizationId],
    );
    return result.rows.map((r: { id: string; token: string; role: string; expires_at: string; created_at: string }) => ({
      id: r.id,
      token: r.token,
      role: r.role,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
      expired: new Date(r.expires_at) <= new Date(),
    }));
  });

  app.post('/api/team/invite-links', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    if (!isAdminRole(user.role)) {
      throw new AppError(403, 'Only owner or admin can create invite links', ErrorCodes.FORBIDDEN);
    }

    const body = CreateInviteLinkSchema.parse(request.body);
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + body.expiresInDays);

    await db.write.query(
      `INSERT INTO organization_invite_links (organization_id, token, role, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.organizationId, token, body.role, expiresAt, user.id],
    );

    reply.code(201);
    return { token, expiresAt: expiresAt.toISOString() };
  });

  app.delete('/api/team/invite-links/:id', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const result = await db.write.query(
      'DELETE FROM organization_invite_links WHERE id = $1 AND organization_id = $2 RETURNING id',
      [id, user.organizationId],
    );
    if (!result.rows.length) throw new AppError(404, 'Invite link not found', ErrorCodes.NOT_FOUND);
    reply.code(204).send();
  });
}
