import express from 'express';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
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

function getUser(req: express.Request) {
  return {
    id: req.headers['x-user-id'] as string,
    organizationId: req.headers['x-organization-id'] as string,
  };
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
      `;
      const result = await pool.query(query, [user.organizationId, teamId]);
      return res.json(result.rows);
    }

    // Return all users in organization with their team membership info
    const query = `
      SELECT 
        u.id as user_id,
        u.email,
        up.first_name,
        up.last_name,
        up.avatar_url,
        COALESCE(tm.role, u.role) as role,
        t.name as team_name,
        tm.id as team_member_id,
        tm.joined_at,
        tm.status as team_member_status
      FROM users u
      LEFT JOIN user_profiles up ON u.id = up.user_id
      LEFT JOIN team_members tm ON u.id = tm.user_id
      LEFT JOIN teams t ON tm.team_id = t.id
      WHERE u.organization_id = $1
      ORDER BY u.created_at DESC
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

      const result = await pool.query(
        `INSERT INTO team_members (team_id, user_id, role, invited_by, status)
         VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [actualTeamId, existingUserId, role || 'member', user.id, 'active']
      );

      // Publish event
      const event: TeamMemberAddedEvent = {
        id: randomUUID(),
        type: EventType.TEAM_MEMBER_ADDED,
        timestamp: new Date(),
        organizationId: user.organizationId,
        userId: user.id,
        data: { teamId: actualTeamId, userId: existingUserId, role: role || 'member' },
      };
      await rabbitmq.publishEvent(event);

      return res.json(result.rows[0]);
    } else {
      // User doesn't exist - create user with pending status and add to team
      // Generate a temporary password that user will need to change on first login
      const tempPassword = randomUUID();
      const passwordHash = await bcrypt.hash(tempPassword, 10);

      // Create user in the organization with pending status
      const newUserResult = await pool.query(
        `INSERT INTO users (email, password_hash, organization_id, role)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [email, passwordHash, user.organizationId, role || 'member']
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
        [actualTeamId, newUser.id, role || 'member', user.id, 'pending']
      );

      // Create invitation record for tracking
      const invitationToken = randomUUID();
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + 7); // 7 days from now

      await pool.query(
        `INSERT INTO team_invitations (team_id, email, role, invited_by, token, expires_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [actualTeamId, email, role || 'member', user.id, invitationToken, expiresAt]
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

// Update team member role
app.put('/api/team/members/:id/role', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { role, permissions } = req.body;

    const result = await pool.query(
      `UPDATE team_members 
       SET role = $1, permissions = $2
       WHERE id = $3 AND team_id IN (
         SELECT id FROM teams WHERE organization_id = $4
       )
       RETURNING *`,
      [role, JSON.stringify(permissions || {}), id, user.organizationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Team member not found' });
    }

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

app.listen(PORT, () => {
  console.log(`Team service running on port ${PORT}`);
});

