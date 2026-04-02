import { Router } from 'express';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, TeamMemberAddedEvent } from '@getsale/events';
import { asyncHandler, canPermission, requireUser, AppError, ErrorCodes, validate } from '@getsale/service-core';
import { normalizeRole, auditLog, getClientIp } from '../helpers';
import { TmInviteMemberSchema, TmUpdateMemberRoleSchema } from '../validation';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
}

export function membersRouter({ pool, rabbitmq }: Deps): Router {
  const router = Router();
  router.use(requireUser());
  const checkPermission = canPermission(pool);

  router.get('/', asyncHandler(async (req, res) => {
    const user = req.user;
    const query = `
      SELECT
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
        LOWER(u.email)
    `;
    const result = await pool.query(query, [user.organizationId]);
    res.json(result.rows);
  }));

  router.post('/invite', validate(TmInviteMemberSchema), asyncHandler(async (req, res) => {
    const user = req.user;
    const { email: normalizedEmail, role } = req.body;

    const userRow = await pool.query(`SELECT id FROM users WHERE LOWER(TRIM(email)) = $1`, [normalizedEmail]);
    const normalizedRole = normalizeRole(role);

    if (userRow.rows.length > 0) {
      const existingUserId = userRow.rows[0].id as string;
      const existingMember = await pool.query(
        `SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
        [user.organizationId, existingUserId]
      );
      if (existingMember.rows.length > 0) {
        throw new AppError(409, 'User is already a member of this workspace', ErrorCodes.CONFLICT);
      }

      await pool.query(
        `INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, $3)`,
        [existingUserId, user.organizationId, normalizedRole]
      );

      const event: TeamMemberAddedEvent = {
        id: randomUUID(),
        type: EventType.TEAM_MEMBER_ADDED,
        timestamp: new Date(),
        organizationId: user.organizationId,
        userId: user.id,
        correlationId: req.correlationId,
        data: { teamId: user.organizationId, userId: existingUserId, role: normalizedRole },
      };
      await rabbitmq.publishEvent(event);

      return res.json({ userId: existingUserId, role: normalizedRole, status: 'active' });
    }

    const tempPassword = randomUUID();
    const passwordHash = await bcrypt.hash(tempPassword, 12);

    try {
      const newUserResult = await pool.query(
        `INSERT INTO users (email, password_hash, organization_id, role)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [normalizedEmail, passwordHash, user.organizationId, normalizedRole]
      );
      const newUser = newUserResult.rows[0];

      await pool.query(
        `INSERT INTO user_profiles (user_id, organization_id, first_name, last_name, preferences)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO NOTHING`,
        [newUser.id, user.organizationId, null, null, JSON.stringify({})]
      );

      await pool.query(
        `INSERT INTO organization_members (user_id, organization_id, role) VALUES ($1, $2, $3)`,
        [newUser.id, user.organizationId, normalizedRole]
      );

      const event: TeamMemberAddedEvent = {
        id: randomUUID(),
        type: EventType.TEAM_MEMBER_ADDED,
        timestamp: new Date(),
        organizationId: user.organizationId,
        userId: user.id,
        correlationId: req.correlationId,
        data: { teamId: user.organizationId, userId: newUser.id, role: normalizedRole },
      };
      await rabbitmq.publishEvent(event);

      return res.json({
        user: { id: newUser.id, email: newUser.email, status: 'pending' },
        message: 'User created; they should use password reset or invite link to sign in',
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr?.code === '23505') {
        throw new AppError(409, 'User already exists', ErrorCodes.CONFLICT);
      }
      throw err;
    }
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const user = req.user;
    const roleLower = (user.role || '').toLowerCase();
    if (roleLower !== 'owner' && roleLower !== 'admin') {
      throw new AppError(403, 'Only owner or admin can remove members', ErrorCodes.FORBIDDEN);
    }

    const targetUserId = req.params.id;
    if (!targetUserId || !/^[0-9a-f-]{36}$/i.test(targetUserId)) {
      throw new AppError(400, 'Invalid user id', ErrorCodes.VALIDATION);
    }
    if (targetUserId === user.id) {
      throw new AppError(400, 'Use leave workspace in settings to remove yourself from this workspace', ErrorCodes.BAD_REQUEST);
    }

    const mem = await pool.query(
      `SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2`,
      [targetUserId, user.organizationId]
    );
    if (mem.rows.length === 0) {
      throw new AppError(404, 'Member not found in this workspace', ErrorCodes.NOT_FOUND);
    }
    if (String(mem.rows[0].role).toLowerCase() === 'owner') {
      throw new AppError(403, 'Cannot remove workspace owner; transfer ownership first', ErrorCodes.FORBIDDEN);
    }

    const membershipCount = await pool.query(
      `SELECT COUNT(*)::int AS c FROM organization_members WHERE user_id = $1`,
      [targetUserId]
    );
    if ((membershipCount.rows[0] as { c: number }).c <= 1) {
      throw new AppError(
        400,
        'Cannot remove a user who belongs only to this workspace',
        ErrorCodes.BAD_REQUEST
      );
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`DELETE FROM organization_members WHERE user_id = $1 AND organization_id = $2`, [
        targetUserId,
        user.organizationId,
      ]);

      const uRow = await client.query(`SELECT organization_id FROM users WHERE id = $1`, [targetUserId]);
      const userCurrentOrg = uRow.rows[0]?.organization_id as string | undefined;
      if (userCurrentOrg === user.organizationId) {
        const nextRes = await client.query(
          `SELECT om.organization_id AS id, om.role
           FROM organization_members om
           JOIN organizations o ON o.id = om.organization_id
           WHERE om.user_id = $1
           ORDER BY o.name
           LIMIT 1`,
          [targetUserId]
        );
        if (nextRes.rows.length === 0) {
          throw new Error('Invariant: user has no workspace after removal');
        }
        const nextOrgId = nextRes.rows[0].id as string;
        const nextRole = nextRes.rows[0].role as string;
        await client.query(`UPDATE users SET organization_id = $1, role = $2 WHERE id = $3`, [
          nextOrgId,
          nextRole,
          targetUserId,
        ]);
        await client.query(
          `UPDATE user_profiles SET organization_id = $1 WHERE user_id = $2 AND organization_id = $3`,
          [nextOrgId, targetUserId, user.organizationId]
        );
        await client.query(`UPDATE subscriptions SET organization_id = $1 WHERE user_id = $2 AND organization_id = $3`, [
          nextOrgId,
          targetUserId,
          user.organizationId,
        ]);
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    await auditLog(pool, {
      organizationId: user.organizationId,
      userId: user.id,
      action: 'workspace.member_removed',
      resourceType: 'organization_member',
      resourceId: targetUserId,
      oldValue: {},
      newValue: { removedUserId: targetUserId },
      ip: getClientIp(req),
    });

    res.status(204).send();
  }));

  router.put('/:id/role', validate(TmUpdateMemberRoleSchema), asyncHandler(async (req, res) => {
    const user = req.user;
    const roleLower = (user.role || '').toLowerCase();
    const isOwnerOrAdmin = roleLower === 'owner' || roleLower === 'admin';
    const allowed = isOwnerOrAdmin || (await checkPermission(user.role, 'team', 'update'));
    if (!allowed) {
      throw new AppError(403, 'Only owner or admin can change member roles', ErrorCodes.FORBIDDEN);
    }

    const { id } = req.params;
    const { role } = req.body;
    const normalizedRole = normalizeRole(role as string);

    const targetUserId = id;

    const mem = await pool.query(
      `SELECT role FROM organization_members WHERE user_id = $1 AND organization_id = $2`,
      [targetUserId, user.organizationId]
    );
    if (mem.rows.length === 0) {
      throw new AppError(404, 'Member not found in this workspace', ErrorCodes.NOT_FOUND);
    }
    const oldRole = mem.rows[0].role as string;

    await pool.query(
      `UPDATE organization_members SET role = $1 WHERE user_id = $2 AND organization_id = $3`,
      [normalizedRole, targetUserId, user.organizationId]
    );
    await pool.query(`UPDATE users SET role = $1 WHERE id = $2 AND organization_id = $3`, [
      normalizedRole,
      targetUserId,
      user.organizationId,
    ]);

    await auditLog(pool, {
      organizationId: user.organizationId,
      userId: user.id,
      action: 'workspace.member_role_changed',
      resourceType: 'organization_member',
      resourceId: targetUserId,
      oldValue: { role: oldRole },
      newValue: { role: normalizedRole },
      ip: getClientIp(req),
    });

    const row = await pool.query(
      `SELECT u.id AS user_id, u.email, om.role, om.joined_at
       FROM organization_members om
       JOIN users u ON u.id = om.user_id
       WHERE om.user_id = $1 AND om.organization_id = $2`,
      [targetUserId, user.organizationId]
    );
    res.json(row.rows[0]);
  }));

  return router;
}
