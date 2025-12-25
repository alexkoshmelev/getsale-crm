import express from 'express';
import { Pool } from 'pg';
import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions';
import { RabbitMQClient } from '@getsale/utils';
import { EventType } from '@getsale/events';

const app = express();
const PORT = process.env.PORT || 3007;

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
    CREATE TABLE IF NOT EXISTS bd_accounts (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      user_id UUID NOT NULL,
      platform VARCHAR(50) NOT NULL,
      account_type VARCHAR(50) NOT NULL DEFAULT 'owned',
      phone_number VARCHAR(50),
      api_id INTEGER,
      api_hash VARCHAR(255),
      session_string TEXT,
      status VARCHAR(50) NOT NULL DEFAULT 'disconnected',
      limits JSONB DEFAULT '{"messages_per_day": 0, "messages_per_hour": 0}',
      metadata JSONB DEFAULT '{}',
      purchased_at TIMESTAMP,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS bd_account_status (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      bd_account_id UUID NOT NULL REFERENCES bd_accounts(id) ON DELETE CASCADE,
      status VARCHAR(50) NOT NULL,
      message TEXT,
      checked_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_bd_accounts_org ON bd_accounts(organization_id);
    CREATE INDEX IF NOT EXISTS idx_bd_accounts_user ON bd_accounts(user_id);
    CREATE INDEX IF NOT EXISTS idx_bd_accounts_status ON bd_accounts(status);
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
  res.json({ status: 'ok', service: 'bd-accounts-service' });
});

// Get BD accounts
app.get('/api/bd-accounts', async (req, res) => {
  try {
    const user = getUser(req);
    const result = await pool.query(
      'SELECT * FROM bd_accounts WHERE organization_id = $1 ORDER BY created_at DESC',
      [user.organizationId]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching BD accounts:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Connect BD account (Telegram)
app.post('/api/bd-accounts/connect', async (req, res) => {
  try {
    const user = getUser(req);
    const { platform, phoneNumber, apiId, apiHash, phoneCode, password } = req.body;

    if (platform === 'telegram') {
      // Create Telegram client
      const client = new TelegramClient(
        new StringSession(''),
        apiId,
        apiHash,
        { connectionRetries: 5 }
      );

      await client.start({
        phoneNumber: async () => phoneNumber,
        password: async () => password,
        phoneCode: async () => phoneCode,
        onError: (err) => {
          console.error('Telegram connection error:', err);
        },
      });

      const sessionString = client.session.save() as string;

      // Save account
      const result = await pool.query(
        `INSERT INTO bd_accounts (organization_id, user_id, platform, account_type, phone_number, api_id, api_hash, session_string, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [user.organizationId, user.id, platform, 'owned', phoneNumber, apiId, apiHash, sessionString, 'connected']
      );

      // Publish event
      await rabbitmq.publishEvent({
        id: crypto.randomUUID(),
        type: EventType.BIDI_ASSIGNED,
        timestamp: new Date(),
        organizationId: user.organizationId,
        userId: user.id,
        data: { bdAccountId: result.rows[0].id, platform },
      });

      res.json(result.rows[0]);
    } else {
      res.status(400).json({ error: 'Unsupported platform' });
    }
  } catch (error) {
    console.error('Error connecting BD account:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Purchase BD account
app.post('/api/bd-accounts/purchase', async (req, res) => {
  try {
    const user = getUser(req);
    const { platform, durationDays } = req.body;

    // TODO: Integrate with payment service
    // For now, create a purchased account record

    const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);

    const result = await pool.query(
      `INSERT INTO bd_accounts (organization_id, user_id, platform, account_type, status, purchased_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [user.organizationId, user.id, platform, 'rented', 'pending', new Date(), expiresAt]
    );

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error purchasing BD account:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get account status
app.get('/api/bd-accounts/:id/status', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;

    const result = await pool.query(
      `SELECT a.*, s.status as last_status, s.message, s.checked_at
       FROM bd_accounts a
       LEFT JOIN LATERAL (
         SELECT status, message, checked_at
         FROM bd_account_status
         WHERE bd_account_id = a.id
         ORDER BY checked_at DESC
         LIMIT 1
       ) s ON true
       WHERE a.id = $1 AND a.organization_id = $2`,
      [id, user.organizationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching BD account status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update account config
app.put('/api/bd-accounts/:id/config', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { limits, metadata } = req.body;

    const result = await pool.query(
      `UPDATE bd_accounts 
       SET limits = $1, metadata = $2, updated_at = NOW()
       WHERE id = $3 AND organization_id = $4
       RETURNING *`,
      [JSON.stringify(limits || {}), JSON.stringify(metadata || {}), id, user.organizationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error updating BD account config:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(PORT, () => {
  console.log(`BD Accounts service running on port ${PORT}`);
});

