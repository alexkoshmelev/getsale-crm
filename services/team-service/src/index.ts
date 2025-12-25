import express from 'express';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, TeamMemberAddedEvent } from '@getsale/events';

const app = express();
const PORT = process.env.PORT || 3011;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://getsale:getsale_dev@localhost:5432/getsale_crm',
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
  await initDatabase();
})();

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      created_by UUID NOT NULL,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS team_members (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      user_id UUID NOT NULL,
      role VARCHAR(50) NOT NULL DEFAULT 'member',
      permissions JSONB DEFAULT '{}',
      invited_by UUID,
      joined_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(team_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS team_client_assignments (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      client_id UUID NOT NULL,
      assigned_to UUID,
      assigned_at TIMESTAMP DEFAULT NOW(),
      UNIQUE(team_id, client_id)
    );

    CREATE INDEX IF NOT EXISTS idx_teams_org ON teams(organization_id);
    CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);
    CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
    CREATE INDEX IF NOT EXISTS idx_team_client_assignments_team ON team_client_assignments(team_id);
    CREATE INDEX IF NOT EXISTS idx_team_client_assignments_client ON team_client_assignments(client_id);
  `);
}

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

    let query = `
      SELECT tm.*, t.name as team_name, u.email
      FROM team_members tm
      JOIN teams t ON tm.team_id = t.id
      JOIN users u ON tm.user_id = u.id
      WHERE t.organization_id = $1
    `;
    const params: any[] = [user.organizationId];

    if (teamId) {
      query += ` AND tm.team_id = $${params.length + 1}`;
      params.push(teamId);
    }

    const result = await pool.query(query, params);
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
    const { teamId, email, role, permissions } = req.body;

    // TODO: Get user by email from auth service
    const userId = crypto.randomUUID(); // Placeholder

    const result = await pool.query(
      `INSERT INTO team_members (team_id, user_id, role, permissions, invited_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [teamId, userId, role || 'member', JSON.stringify(permissions || {}), user.id]
    );

    // Publish event
    const event: TeamMemberAddedEvent = {
      id: crypto.randomUUID(),
      type: EventType.TEAM_MEMBER_ADDED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { teamId, userId, role },
    };
    await rabbitmq.publishEvent(event);

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error inviting team member:', error);
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

