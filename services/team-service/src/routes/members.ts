import { Router } from 'express';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import bcrypt from 'bcryptjs';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, TeamMemberAddedEvent } from '@getsale/events';
import { Logger } from '@getsale/logger';
import { asyncHandler, canPermission, requireUser, AppError, ErrorCodes, validate } from '@getsale/service-core';
import { normalizeRole, auditLog, getClientIp } from '../helpers';
import { TmInviteMemberSchema, TmUpdateMemberRoleSchema } from '../validation';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
}

export function membersRouter({ pool, rabbitmq, log }: Deps): Router {
  const router = Router();
  router.use(requireUser());
  const checkPermission = canPermission(pool);

  router.get('/', asyncHandler(async (req, res) => {
    const user = req.user;
    const { teamId } = req.query;

    if (teamId) {
      const query = `
        SELECT tm.*, t.name as team_name, u.email, up.first_name, up.last_name, up.avatar_url, tm.status as team_member_status
        FROM team_members tm
        JOIN teams t ON tm.team_id = t.id
        JOIN users u ON tm.user_id = u.id
        LEFT JOIN user_profiles up ON u.id = up.user_id
        WHERE t.organization_id = $1 AND tm.team_id = $2
        ORDER BY CASE LOWER(tm.role)
          WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'supervisor' THEN 3 WHEN 'bidi' THEN 4 WHEN 'viewer' THEN 5
          ELSE 6 END, LOWER(u.email)
      `;
      const result = await pool.query(query, [user.organizationId, teamId]);
      return res.json(result.rows);
    }

    const query = `
      WITH ranked AS (
        SELECT
          u.id as user_id,
          u.email,
          up.first_name,
          up.last_name,
          up.avatar_url,
          COALESCE(tm.role, om.role, u.role) as role,
          t.name as team_name,
          tm.id as team_member_id,
          tm.joined_at,
          tm.status as team_member_status,
          ROW_NUMBER() OVER (PARTITION BY u.id ORDER BY tm.joined_at ASC NULLS LAST) as rn
        FROM organization_members om
        JOIN users u ON u.id = om.user_id
        LEFT JOIN user_profiles up ON u.id = up.user_id
        LEFT JOIN team_members tm ON tm.user_id = u.id
        LEFT JOIN teams t ON tm.team_id = t.id AND t.organization_id = $1
        WHERE om.organization_id = $1
      )
      SELECT user_id, email, first_name, last_name, avatar_url, role, team_name, team_member_id, joined_at, team_member_status
      FROM ranked WHERE rn = 1
      ORDER BY CASE LOWER(role)
        WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 WHEN 'supervisor' THEN 3 WHEN 'bidi' THEN 4 WHEN 'viewer' THEN 5
        ELSE 6 END,
        LOWER(COALESCE(NULLIF(email,''), 'z'))
    `;
    const result = await pool.query(query, [user.organizationId]);
    res.json(result.rows);
  }));

  router.post('/invite', validate(TmInviteMemberSchema), asyncHandler(async (req, res) => {
    const user = req.user;
    const { teamId, email: normalizedEmail, role } = req.body;

    let actualTeamId = teamId;
    if (teamId === 'default' || !teamId) {
      const defaultTeamResult = await pool.query(
        `SELECT id FROM teams WHERE organization_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [user.organizationId]
      );
      if (defaultTeamResult.rows.length === 0) {
        throw new AppError(404, 'No team found for organization', ErrorCodes.NOT_FOUND);
      }
      actualTeamId = defaultTeamResult.rows[0].id;
    }

    const pendingInvite = await pool.query(
      `SELECT 1 FROM team_invitations ti
       JOIN teams t ON t.id = ti.team_id AND t.organization_id = $1
       WHERE LOWER(TRIM(ti.email)) = $2 AND ti.accepted_at IS NULL AND ti.expires_at > NOW()
       LIMIT 1`,
      [user.organizationId, normalizedEmail]
    );
    if (pendingInvite.rows.length > 0) {
      throw new AppError(409, 'User is already invited', ErrorCodes.CONFLICT, { code: 'ALREADY_INVITED' });
    }

    const userResult = await pool.query(
      `SELECT id FROM users WHERE LOWER(TRIM(email)) = $1 AND organization_id = $2`,
      [normalizedEmail, user.organizationId]
    );

    if (userResult.rows.length > 0) {
      const existingUserId = userResult.rows[0].id;
      const existingMember = await pool.query(
        `SELECT * FROM team_members WHERE team_id = $1 AND user_id = $2`,
        [actualTeamId, existingUserId]
      );

      if (existingMember.rows.length > 0) {
        throw new AppError(409, 'User is already a member of this team', ErrorCodes.CONFLICT);
      }

      try {
        const normalizedRole = normalizeRole(role);
        const result = await pool.query(
          `INSERT INTO team_members (team_id, user_id, role, invited_by, status)
           VALUES ($1, $2, $3, $4, $5) RETURNING *`,
          [actualTeamId, existingUserId, normalizedRole, user.id, 'active']
        );

        const event: TeamMemberAddedEvent = {
          id: randomUUID(),
          type: EventType.TEAM_MEMBER_ADDED,
          timestamp: new Date(),
          organizationId: user.organizationId,
          userId: user.id,
          correlationId: req.correlationId,
          data: { teamId: actualTeamId, userId: existingUserId, role: normalizedRole },
        };
        await rabbitmq.publishEvent(event);

        return res.json(result.rows[0]);
      } catch (err: unknown) {
        const pgErr = err as { code?: string };
        if (pgErr?.code === '23505') {
          throw new AppError(409, 'User is already invited or is a member', ErrorCodes.CONFLICT);
        }
        throw err;
      }
    }

    const tempPassword = randomUUID();
    const passwordHash = await bcrypt.hash(tempPassword, 12);
    const normalizedRole = normalizeRole(role);

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

      const teamMemberResult = await pool.query(
        `INSERT INTO team_members (team_id, user_id, role, invited_by, status)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [actualTeamId, newUser.id, normalizedRole, user.id, 'pending']
      );

      const invitationToken = randomUUID();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7);

      await pool.query(
        `INSERT INTO team_invitations (team_id, email, role, invited_by, token, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [actualTeamId, normalizedEmail, normalizedRole, user.id, invitationToken, expiresAt]
      );

      return res.json({
        teamMember: teamMemberResult.rows[0],
        user: { id: newUser.id, email: newUser.email, status: 'pending' },
        message: 'User invited and added to team with pending status',
      });
    } catch (err: unknown) {
      const pgErr = err as { code?: string };
      if (pgErr?.code === '23505') {
        throw new AppError(409, 'User is already invited or is a member', ErrorCodes.CONFLICT);
      }
      throw err;
    }
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

    let oldRole: string | undefined;
    let result: { rows: unknown[] };

    const existingByMemberId = await pool.query(
      `SELECT id, role FROM team_members WHERE id = $1 AND team_id IN (SELECT id FROM teams WHERE organization_id = $2)`,
      [id, user.organizationId]
    );

    if (existingByMemberId.rows.length > 0) {
      oldRole = existingByMemberId.rows[0].role;
      result = await pool.query(
        `UPDATE team_members SET role = $1 WHERE id = $2 RETURNING *`,
        [normalizedRole, id]
      );
    } else {
      const byUser = await pool.query(
        `SELECT tm.id, tm.role FROM team_members tm
         JOIN teams t ON t.id = tm.team_id
         WHERE t.organization_id = $1 AND tm.user_id = $2
         LIMIT 1`,
        [user.organizationId, id]
      );
      if (byUser.rows.length > 0) {
        oldRole = byUser.rows[0].role;
        const memberId = byUser.rows[0].id;
        result = await pool.query(
          `UPDATE team_members SET role = $1 WHERE id = $2 RETURNING *`,
          [normalizedRole, memberId]
        );
      } else {
        const isOrgMember = await pool.query(
          `SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
          [user.organizationId, id]
        );
        if (isOrgMember.rows.length === 0) {
          throw new AppError(404, 'Team member not found', ErrorCodes.NOT_FOUND);
        }
        const defaultTeam = await pool.query(
          `SELECT id FROM teams WHERE organization_id = $1 ORDER BY created_at ASC LIMIT 1`,
          [user.organizationId]
        );
        if (defaultTeam.rows.length === 0) {
          throw new AppError(404, 'No team found for organization', ErrorCodes.NOT_FOUND);
        }
        const teamId = defaultTeam.rows[0].id;
        result = await pool.query(
          `INSERT INTO team_members (team_id, user_id, role, invited_by, status)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (team_id, user_id) DO UPDATE SET role = EXCLUDED.role
           RETURNING *`,
          [teamId, id, normalizedRole, user.id, 'active']
        );
      }
    }

    if (result.rows.length === 0) {
      throw new AppError(404, 'Team member not found', ErrorCodes.NOT_FOUND);
    }

    await auditLog(pool, {
      organizationId: user.organizationId,
      userId: user.id,
      action: 'team.member_role_changed',
      resourceType: 'team_member',
      resourceId: (result.rows[0] as { id: string }).id,
      oldValue: oldRole !== undefined ? { role: oldRole } : undefined,
      newValue: { role: normalizedRole },
      ip: getClientIp(req),
    });

    res.json(result.rows[0]);
  }));

  return router;
}
