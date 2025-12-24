import express from 'express';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { EventType } from '@getsale/events';
import { Contact, Company, Deal } from '@getsale/types';

const app = express();
const PORT = process.env.PORT || 3002;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://getsale:getsale_dev@localhost:5432/getsale_crm',
});

const rabbitmq = new RabbitMQClient(
  process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672'
);

(async () => {
  await rabbitmq.connect();
  await initDatabase();
})();

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS companies (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      name VARCHAR(255) NOT NULL,
      industry VARCHAR(100),
      size VARCHAR(50),
      description TEXT,
      goals JSONB,
      policies JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS contacts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      company_id UUID REFERENCES companies(id),
      first_name VARCHAR(255) NOT NULL,
      last_name VARCHAR(255),
      email VARCHAR(255),
      phone VARCHAR(50),
      telegram_id VARCHAR(100),
      consent_flags JSONB DEFAULT '{"email": false, "sms": false, "telegram": false, "marketing": false}',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS deals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      company_id UUID NOT NULL REFERENCES companies(id),
      contact_id UUID REFERENCES contacts(id),
      pipeline_id UUID NOT NULL,
      stage_id UUID NOT NULL,
      owner_id UUID NOT NULL,
      title VARCHAR(255) NOT NULL,
      value NUMERIC,
      currency VARCHAR(10),
      history JSONB DEFAULT '[]',
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_companies_org ON companies(organization_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_org ON contacts(organization_id);
    CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company_id);
    CREATE INDEX IF NOT EXISTS idx_deals_org ON deals(organization_id);
    CREATE INDEX IF NOT EXISTS idx_deals_company ON deals(company_id);
    CREATE INDEX IF NOT EXISTS idx_deals_owner ON deals(owner_id);
  `);
}

// Middleware to extract user from headers
function getUser(req: express.Request) {
  return {
    id: req.headers['x-user-id'] as string,
    organizationId: req.headers['x-organization-id'] as string,
  };
}

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'crm-service' });
});

// Companies
app.get('/api/crm/companies', async (req, res) => {
  try {
    const user = getUser(req);
    const result = await pool.query(
      'SELECT * FROM companies WHERE organization_id = $1 ORDER BY created_at DESC',
      [user.organizationId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching companies:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/crm/companies', async (req, res) => {
  try {
    const user = getUser(req);
    const { name, industry, size, description, goals, policies } = req.body;

    const result = await pool.query(
      `INSERT INTO companies (organization_id, name, industry, size, description, goals, policies)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [user.organizationId, name, industry, size, description, JSON.stringify(goals || []), JSON.stringify(policies || {})]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating company:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Contacts
app.get('/api/crm/contacts', async (req, res) => {
  try {
    const user = getUser(req);
    const { companyId } = req.query;

    let query = 'SELECT * FROM contacts WHERE organization_id = $1';
    const params: any[] = [user.organizationId];

    if (companyId) {
      query += ' AND company_id = $2';
      params.push(companyId);
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching contacts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/crm/contacts', async (req, res) => {
  try {
    const user = getUser(req);
    const { firstName, lastName, email, phone, telegramId, companyId, consentFlags } = req.body;

    const result = await pool.query(
      `INSERT INTO contacts (organization_id, company_id, first_name, last_name, email, phone, telegram_id, consent_flags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        user.organizationId,
        companyId,
        firstName,
        lastName,
        email,
        phone,
        telegramId,
        JSON.stringify(consentFlags || { email: false, sms: false, telegram: false, marketing: false }),
      ]
    );

    // Publish event
    await rabbitmq.publishEvent({
      id: crypto.randomUUID(),
      type: EventType.CONTACT_CREATED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { contactId: result.rows[0].id },
    });

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating contact:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Deals
app.get('/api/crm/deals', async (req, res) => {
  try {
    const user = getUser(req);
    const { companyId, ownerId } = req.query;

    let query = 'SELECT * FROM deals WHERE organization_id = $1';
    const params: any[] = [user.organizationId];

    if (companyId) {
      query += ` AND company_id = $${params.length + 1}`;
      params.push(companyId);
    }

    if (ownerId) {
      query += ` AND owner_id = $${params.length + 1}`;
      params.push(ownerId);
    }

    query += ' ORDER BY created_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching deals:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/crm/deals', async (req, res) => {
  try {
    const user = getUser(req);
    const { companyId, contactId, pipelineId, stageId, title, value, currency } = req.body;

    const result = await pool.query(
      `INSERT INTO deals (organization_id, company_id, contact_id, pipeline_id, stage_id, owner_id, title, value, currency)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [user.organizationId, companyId, contactId, pipelineId, stageId, user.id, title, value, currency]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error creating deal:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/crm/deals/:id/stage', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { stageId, reason } = req.body;

    const dealResult = await pool.query(
      'SELECT * FROM deals WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );

    if (dealResult.rows.length === 0) {
      return res.status(404).json({ error: 'Deal not found' });
    }

    const deal = dealResult.rows[0];
    const history = deal.history || [];

    history.push({
      id: crypto.randomUUID(),
      action: 'stage_changed',
      fromStageId: deal.stage_id,
      toStageId: stageId,
      performedBy: user.id,
      timestamp: new Date(),
      reason,
    });

    await pool.query(
      'UPDATE deals SET stage_id = $1, history = $2, updated_at = NOW() WHERE id = $3',
      [stageId, JSON.stringify(history), id]
    );

    // Publish event
    await rabbitmq.publishEvent({
      id: crypto.randomUUID(),
      type: EventType.DEAL_STAGE_CHANGED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { dealId: id, fromStageId: deal.stage_id, toStageId: stageId, reason },
    });

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating deal stage:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`CRM service running on port ${PORT}`);
});

