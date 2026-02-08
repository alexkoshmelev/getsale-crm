import express from 'express';
import { Pool } from 'pg';
import { randomUUID, randomBytes } from 'crypto';
import bcrypt from 'bcryptjs';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, TeamMemberAddedEvent } from '@getsale/events';

const app = express();
const PORT = process.env.PORT || 3011;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'postgres_dev'}@localhost:5432/postgres`,
});

const rabbitmq = new RabbitMQClient(
  process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672'
);

(async () => {
  try {
    await rabbitmq.connect();
  } catch (error) {
    console.error('Failed to connect to RabbitMQ, service will continue without event publishing:', error);
  }
})();

const ALLOWED_ROLES = ['owner', 'admin', 'supervisor', 'bidi', 'viewer'] as const;

function getUser(req: express.Request) {
  return {
    id: req.headers['x-user-id'] as string,
    organizationId: req.headers['x-organization-id'] as string,
    role: (req.headers['x-user-role'] as string) || '',
  };
}

function normalizeRole(role: string | undefined): string {
  const r = (role || 'bidi').toLowerCase();
  if (r === 'member') return 'bidi';
  return ALLOWED_ROLES.includes(r as any) ? r : 'bidi';
}

function getClientIp(req: express.Request): string | null {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string') return forwarded.split(',')[0]?.trim() || null;
  return (req as any).ip || req.socket?.remoteAddress || null;
}

async function auditLog(
  pool: Pool,
  organizationId: string,
  userId: string,
  action: string,
  resourceType?: string,
  resourceId?: string,
  oldValue?: object,
  newValue?: object,
  ip?: string | null
) {
  try {
    await pool.query(
      `INSERT INTO audit_logs (organization_id, user_id, action, resource_type, resource_id, old_value, new_value, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        organizationId,
        userId,
        action,
        resourceType ?? null,
        resourceId ?? null,
        oldValue ? JSON.stringify(oldValue) : null,
        newValue ? JSON.stringify(newValue) : null,
        ip ?? null,
      ]
    );
  } catch (e) {
    console.error('Audit log insert failed:', e);
  }
}

/** Проверка гранулярного права (role_permissions). Fallback: owner/admin разрешено. */
async function canPermission(pool: Pool, role: string, resource: string, action: string): Promise<boolean> {
  const roleLower = (role || '').toLowerCase();
  try {
    const r = await pool.query(
      `SELECT 1 FROM role_permissions WHERE role = $1 AND resource = $2 AND (action = $3 OR action = '*') LIMIT 1`,
      [roleLower, resource, action]
    );
    if (r.rows.length > 0) return true;
    if (roleLower === 'owner') return true;
    return false;
  } catch {
    return roleLower === 'owner' || roleLower === 'admin';
  }
}

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'team-service' });
});

// Team members
app.get('/api/team/members', async (req, res) => {
  try {
    const user = getUser(req);
    const { teamId } = req.query;

    // If teamId is specified, return only members of that team
    // Otherwise, return all users in the organization (with team membership info if exists)
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

    // Return all members of the current organization (from organization_members), one row per user, sorted by role (owner first, then by importance)
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
  } catch (error) {
    console.error('Error fetching team members:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Invite team member
app.post('/api/team/members/invite', async (req, res) => {
  try {
    const user = getUser(req);
    const { teamId, email, role } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    // Validate teamId - if "default", find default team for organization
    let actualTeamId = teamId;
    if (teamId === 'default' || !teamId) {
      const defaultTeamResult = await pool.query(
        `SELECT id FROM teams WHERE organization_id = $1 ORDER BY created_at ASC LIMIT 1`,
        [user.organizationId]
      );
      if (defaultTeamResult.rows.length === 0) {
        return res.status(404).json({ error: 'No team found for organization' });
      }
      actualTeamId = defaultTeamResult.rows[0].id;
    }

    // Check if user exists by email
    const userResult = await pool.query(
      `SELECT id FROM users WHERE email = $1 AND organization_id = $2`,
      [email, user.organizationId]
    );

    if (userResult.rows.length > 0) {
      // User exists - add directly to team
      const existingUserId = userResult.rows[0].id;
      
      // Check if already a member
      const existingMember = await pool.query(
        `SELECT * FROM team_members WHERE team_id = $1 AND user_id = $2`,
        [actualTeamId, existingUserId]
      );

      if (existingMember.rows.length > 0) {
        return res.status(409).json({ error: 'User is already a member of this team' });
      }

      const normalizedRole = normalizeRole(role);
      const result = await pool.query(
        `INSERT INTO team_members (team_id, user_id, role, invited_by, status)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [actualTeamId, existingUserId, normalizedRole, user.id, 'active']
      );

      // Publish event
      const event: TeamMemberAddedEvent = {
        id: randomUUID(),
        type: EventType.TEAM_MEMBER_ADDED,
        timestamp: new Date(),
        organizationId: user.organizationId,
        userId: user.id,
        data: { teamId: actualTeamId, userId: existingUserId, role: normalizedRole },
      };
      await rabbitmq.publishEvent(event);

      return res.json(result.rows[0]);
    } else {
      // User doesn't exist - create user with pending status and add to team
      // Generate a temporary password that user will need to change on first login
      const tempPassword = randomUUID();
      const passwordHash = await bcrypt.hash(tempPassword, 10);

      // Create user in the organization with pending status
      const normalizedRole = normalizeRole(role);
      const newUserResult = await pool.query(
        `INSERT INTO users (email, password_hash, organization_id, role)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [email, passwordHash, user.organizationId, normalizedRole]
      );
      const newUser = newUserResult.rows[0];

      // Create user profile
      await pool.query(
        `INSERT INTO user_profiles (user_id, organization_id, first_name, last_name, preferences)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO NOTHING`,
        [newUser.id, user.organizationId, null, null, JSON.stringify({})]
      );

      // Add user to team with pending status
      const teamMemberResult = await pool.query(
        `INSERT INTO team_members (team_id, user_id, role, invited_by, status)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [actualTeamId, newUser.id, normalizedRole, user.id, 'pending']
      );

      // Create invitation record for tracking
      const invitationToken = randomUUID();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7); // 7 days from now

      await pool.query(
        `INSERT INTO team_invitations (team_id, email, role, invited_by, token, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [actualTeamId, email, normalizedRole, user.id, invitationToken, expiresAt]
      );

      // TODO: Send invitation email with token and temp password

      return res.json({
        teamMember: teamMemberResult.rows[0],
        user: {
          id: newUser.id,
          email: newUser.email,
          status: 'pending',
        },
        message: 'User invited and added to team with pending status',
      });
    }
  } catch (error: any) {
    console.error('Error inviting team member:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'User is already invited or is a member' });
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List pending email invitations for the organization
app.get('/api/team/invitations', async (req, res) => {
  try {
    const user = getUser(req);
    const result = await pool.query(
      `SELECT ti.id, ti.email, ti.role, ti.expires_at AS "expiresAt", ti.created_at AS "createdAt", t.name AS "teamName"
       FROM team_invitations ti
       JOIN teams t ON t.id = ti.team_id
       WHERE t.organization_id = $1 AND ti.accepted_at IS NULL AND ti.expires_at > NOW()
       ORDER BY ti.created_at DESC`,
      [user.organizationId]
    );
    res.json(result.rows);
  } catch (error: any) {
    console.error('Error listing invitations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Revoke (cancel) an email invitation
app.delete('/api/team/invitations/:id', async (req, res) => {
  try {
    const user = getUser(req);
    const allowed = await canPermission(pool, user.role, 'invitations', 'delete');
    if (!allowed) return res.status(403).json({ error: 'Only owner or admin can revoke invitations' });
    const { id } = req.params;
    const result = await pool.query(
      `DELETE FROM team_invitations ti
       USING teams t
       WHERE ti.id = $1 AND ti.team_id = t.id AND t.organization_id = $2
       RETURNING ti.id, ti.email, ti.role`,
      [id, user.organizationId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Invitation not found' });
    }
    const row = result.rows[0];
    await auditLog(pool, user.organizationId, user.id, 'team.invitation_revoked', 'invitation', id, { email: row?.email, role: row?.role }, undefined, getClientIp(req));
    res.status(204).send();
  } catch (error: any) {
    console.error('Error revoking invitation:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update team member role (only owner or admin can change roles)
// :id can be team_members.id or user_id (fallback if member was merged/moved)
app.put('/api/team/members/:id/role', async (req, res) => {
  try {
    const user = getUser(req);
    const allowed = await canPermission(pool, user.role, 'team', 'update');
    if (!allowed) return res.status(403).json({ error: 'Only owner or admin can change member roles' });
    const { id } = req.params;
    const { role } = req.body;
    const normalizedRole = normalizeRole(role);

    let oldRole: string | undefined;
    let result: { rows: any[] };

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
        // User might be in organization_members (invited to workspace) but not in any team yet — add to default team
        const isOrgMember = await pool.query(
          `SELECT 1 FROM organization_members WHERE organization_id = $1 AND user_id = $2`,
          [user.organizationId, id]
        );
        if (isOrgMember.rows.length === 0) {
          return res.status(404).json({ error: 'Team member not found' });
        }
        const defaultTeam = await pool.query(
          `SELECT id FROM teams WHERE organization_id = $1 ORDER BY created_at ASC LIMIT 1`,
          [user.organizationId]
        );
        if (defaultTeam.rows.length === 0) {
          return res.status(404).json({ error: 'No team found for organization' });
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
      return res.status(404).json({ error: 'Team member not found' });
    }

    await auditLog(pool, user.organizationId, user.id, 'team.member_role_changed', 'team_member', result.rows[0].id, oldRole !== undefined ? { role: oldRole } : undefined, { role: normalizedRole }, getClientIp(req));
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating team member role:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Assign client to team member
app.post('/api/team/clients/assign', async (req, res) => {
  try {
    const user = getUser(req);
    const { teamId, clientId, assignedTo } = req.body;

    const result = await pool.query(
      `INSERT INTO team_client_assignments (team_id, client_id, assigned_to)
       VALUES ($1, $2, $3)
       ON CONFLICT (team_id, client_id) 
       DO UPDATE SET assigned_to = EXCLUDED.assigned_to, assigned_at = NOW()
       RETURNING *`,
      [teamId, clientId, assignedTo]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error assigning client:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get shared clients
app.get('/api/team/clients/shared', async (req, res) => {
  try {
    const user = getUser(req);
    const { teamId } = req.query;

    let query = `
      SELECT DISTINCT c.*, tca.assigned_to, tca.assigned_at
      FROM contacts c
      JOIN team_client_assignments tca ON c.id = tca.client_id
      JOIN teams t ON tca.team_id = t.id
      WHERE t.organization_id = $1
    `;
    const params: any[] = [user.organizationId];

    if (teamId) {
      query += ` AND t.id = $${params.length + 1}`;
      params.push(teamId);
    }

    query += ' ORDER BY tca.assigned_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching shared clients:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List invite links (workspace v1)
app.get('/api/team/invite-links', async (req, res) => {
  try {
    const user = getUser(req);
    const result = await pool.query(
      `SELECT id, token, role, expires_at AS "expiresAt", created_at AS "createdAt"
       FROM organization_invite_links
       WHERE organization_id = $1
       ORDER BY created_at DESC`,
      [user.organizationId]
    );
    res.json(result.rows.map((r) => ({ ...r, expired: new Date(r.expiresAt) <= new Date() })));
  } catch (error: any) {
    console.error('Error listing invite links:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create invite link (workspace v1)
app.post('/api/team/invite-links', async (req, res) => {
  try {
    const user = getUser(req);
    const { role: linkRole = 'bidi', expiresInDays = 7 } = req.body;
    const role = normalizeRole(linkRole);
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + Number(expiresInDays) || 7);
    await pool.query(
      `INSERT INTO organization_invite_links (organization_id, token, role, expires_at, created_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [user.organizationId, token, role, expiresAt, user.id]
    );
    res.status(201).json({ token, expiresAt: expiresAt.toISOString() });
  } catch (error: any) {
    console.error('Error creating invite link:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Revoke invite link by id
app.delete('/api/team/invite-links/:id', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const result = await pool.query(
      `DELETE FROM organization_invite_links
       WHERE id = $1 AND organization_id = $2
       RETURNING id`,
      [id, user.organizationId]
    );
    if (result.rowCount === 0) {
      return res.status(404).json({ error: 'Invite link not found' });
    }
    res.status(204).send();
  } catch (error: any) {
    console.error('Error revoking invite link:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`Team service running on port ${PORT}`);
});

