import express from 'express';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, BDAccountConnectedEvent } from '@getsale/events';
import { TelegramManager } from './telegram-manager';

const app = express();
const PORT = process.env.PORT || 3007;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'postgres_dev'}@localhost:5432/postgres`,
});

const rabbitmq = new RabbitMQClient(
  process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672'
);

// Initialize Telegram Manager
const telegramManager = new TelegramManager(pool, rabbitmq);

// Handle unhandled promise rejections from Telegram library
// This prevents crashes during datacenter migration when builder.resolve errors occur
process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  // Silently ignore builder.resolve errors - they're internal library issues
  // These occur when gramJS tries to process updates before builder is ready
  if (reason?.message?.includes('builder.resolve is not a function') ||
      reason?.message?.includes('builder.resolve') ||
      reason?.stack?.includes('builder.resolve')) {
    // Don't log - these are expected and harmless
    return;
  }
  
  // Log other unhandled rejections but don't crash
  console.error('[BD Accounts Service] Unhandled promise rejection:', reason);
});

// Handle uncaught exceptions from Telegram library
// This prevents crashes during datacenter migration when builder.resolve errors occur synchronously
process.on('uncaughtException', (error: Error) => {
  // Silently ignore builder.resolve errors - they're internal library issues
  if (error.message?.includes('builder.resolve is not a function') ||
      error.message?.includes('builder.resolve') ||
      error.stack?.includes('builder.resolve')) {
    // Don't log - these are expected and harmless
    return; // Don't crash the process
  }
  
  // For other uncaught exceptions, log but don't crash in development
  // In production, you might want to exit gracefully after logging
  console.error('[BD Accounts Service] Uncaught exception:', error);
});

// Initialize RabbitMQ and accounts asynchronously (don't block server startup)
(async () => {
  try {
    await rabbitmq.connect();
    console.log('✅ RabbitMQ connected');
  } catch (error) {
    console.error('Failed to connect to RabbitMQ, service will continue without event publishing:', error);
  }
  
  // Initialize accounts in background (non-blocking)
  telegramManager.initializeActiveAccounts().catch((error) => {
    console.error('Failed to initialize active accounts:', error);
  });
})();

// Graceful shutdown
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully...');
  await telegramManager.shutdown();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully...');
  await telegramManager.shutdown();
  process.exit(0);
});

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
    
    if (!user || !user.organizationId) {
      console.error('Missing user or organizationId in request');
      return res.status(401).json({ error: 'Unauthorized' });
    }
    
    console.log(`[BD Accounts] Fetching accounts for organization: ${user.organizationId}`);
    const result = await pool.query(
      'SELECT * FROM bd_accounts WHERE organization_id = $1 ORDER BY created_at DESC',
      [user.organizationId]
    );

    console.log(`[BD Accounts] Found ${result.rows.length} account(s)`);
    res.json(result.rows);
  } catch (error: any) {
    console.error('Error fetching BD accounts:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Send authentication code (Telegram)
app.post('/api/bd-accounts/send-code', async (req, res) => {
  try {
    const user = getUser(req);
    const { platform, phoneNumber, apiId, apiHash } = req.body;

    if (!platform || !phoneNumber || !apiId || !apiHash) {
      return res.status(400).json({ error: 'Missing required fields: platform, phoneNumber, apiId, apiHash' });
    }

    if (platform !== 'telegram') {
      return res.status(400).json({ error: 'Unsupported platform' });
    }

    // Check if account already exists
    let existingResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE phone_number = $1 AND organization_id = $2',
      [phoneNumber, user.organizationId]
    );

    let accountId: string;

    if (existingResult.rows.length > 0) {
      accountId = existingResult.rows[0].id;
    } else {
      // Create new account record
      const insertResult = await pool.query(
        `INSERT INTO bd_accounts (organization_id, telegram_id, phone_number, api_id, api_hash, is_active)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [user.organizationId, phoneNumber, phoneNumber, String(apiId), apiHash, false]
      );
      accountId = insertResult.rows[0].id;
    }

    // Send code
    const { phoneCodeHash } = await telegramManager.sendCode(
      accountId,
      user.organizationId,
      user.id,
      phoneNumber,
      parseInt(String(apiId)),
      apiHash
    );

    res.json({ accountId, phoneCodeHash });
  } catch (error: any) {
    console.error('Error sending code:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message || 'Failed to send code'
    });
  }
});

// Verify code and complete authentication (Telegram)
app.post('/api/bd-accounts/verify-code', async (req, res) => {
  try {
    const user = getUser(req);
    const { accountId, phoneNumber, phoneCode, phoneCodeHash, password } = req.body;

    if (!accountId || !phoneNumber || !phoneCode || !phoneCodeHash) {
      return res.status(400).json({ error: 'Missing required fields: accountId, phoneNumber, phoneCode, phoneCodeHash' });
    }

    // Verify account belongs to organization
    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [accountId, user.organizationId]
    );

    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }

    // Sign in with code
    const { requiresPassword } = await telegramManager.signIn(
      accountId,
      phoneNumber,
      phoneCode,
      phoneCodeHash
    );

    // If password is required and provided, sign in with password
    if (requiresPassword) {
      if (!password) {
        return res.status(400).json({ 
          error: 'Password required',
          requiresPassword: true 
        });
      }

      await telegramManager.signInWithPassword(accountId, password);
    }

    // Get updated account info
    const result = await pool.query(
      'SELECT * FROM bd_accounts WHERE id = $1',
      [accountId]
    );

      // Publish event
      const event: BDAccountConnectedEvent = {
        id: randomUUID(),
      type: EventType.BD_ACCOUNT_CONNECTED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: {
        bdAccountId: accountId,
        platform: 'telegram',
      },
    };
    await rabbitmq.publishEvent(event);

    res.json(result.rows[0]);
  } catch (error: any) {
    console.error('Error verifying code:', error);
    
    // Handle specific Telegram errors
    if (error.message?.includes('Неверный код подтверждения') || 
        error.message?.includes('PHONE_CODE_INVALID') ||
        error.errorMessage === 'PHONE_CODE_INVALID') {
      return res.status(400).json({ 
        error: 'Неверный код подтверждения',
        message: 'Пожалуйста, запросите новый код и попробуйте снова'
      });
    }
    
    if (error.message?.includes('Код подтверждения истек') || 
        error.message?.includes('PHONE_CODE_EXPIRED') ||
        error.errorMessage === 'PHONE_CODE_EXPIRED') {
      return res.status(400).json({ 
        error: 'Код подтверждения истек',
        message: 'Пожалуйста, запросите новый код'
      });
    }
    
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message || 'Failed to verify code'
    });
  }
});

// Connect BD account (Telegram) - Legacy endpoint for existing sessions
app.post('/api/bd-accounts/connect', async (req, res) => {
  try {
    const user = getUser(req);
    const { platform, phoneNumber, apiId, apiHash, sessionString } = req.body;

    if (!platform || !phoneNumber || !apiId || !apiHash) {
      return res.status(400).json({ error: 'Missing required fields: platform, phoneNumber, apiId, apiHash' });
    }

    if (platform === 'telegram') {
      // Check if account already exists
      const existingResult = await pool.query(
        'SELECT id FROM bd_accounts WHERE phone_number = $1 AND organization_id = $2',
        [phoneNumber, user.organizationId]
      );

      let accountId: string;
      let existingSessionString: string | undefined;

      if (existingResult.rows.length > 0) {
        // Update existing account
        accountId = existingResult.rows[0].id;
        const existingAccount = await pool.query(
          'SELECT session_string FROM bd_accounts WHERE id = $1',
          [accountId]
        );
        existingSessionString = existingAccount.rows[0]?.session_string;
      } else {
        // Create new account record first
        const insertResult = await pool.query(
          `INSERT INTO bd_accounts (organization_id, telegram_id, phone_number, api_id, api_hash, is_active)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [user.organizationId, phoneNumber, phoneNumber, String(apiId), apiHash, true]
        );
        accountId = insertResult.rows[0].id;
      }

      // Connect using Telegram Manager (for existing sessions)
      const client = await telegramManager.connectAccount(
        accountId,
        user.organizationId,
        user.id,
        phoneNumber,
        parseInt(String(apiId)),
        apiHash,
        sessionString || existingSessionString
      );

      // Get updated account info
      const result = await pool.query(
        'SELECT * FROM bd_accounts WHERE id = $1',
        [accountId]
      );

      // Publish event
      const event: BDAccountConnectedEvent = {
        id: randomUUID(),
        type: EventType.BD_ACCOUNT_CONNECTED,
        timestamp: new Date(),
        organizationId: user.organizationId,
        userId: user.id,
        data: {
          bdAccountId: accountId,
          platform: 'telegram',
        },
      };
      await rabbitmq.publishEvent(event);

      res.json(result.rows[0]);
    } else {
      res.status(400).json({ error: 'Unsupported platform' });
    }
  } catch (error: any) {
    console.error('Error connecting BD account:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message || 'Failed to connect account'
    });
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
      `SELECT a.*, s.status as last_status, s.message, s.recorded_at as checked_at
       FROM bd_accounts a
       LEFT JOIN LATERAL (
         SELECT status, message, recorded_at
         FROM bd_account_status
         WHERE account_id = a.id
         ORDER BY recorded_at DESC
         LIMIT 1
       ) s ON true
       WHERE a.id = $1 AND a.organization_id = $2`,
      [id, user.organizationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }

    const account = result.rows[0];
    const isConnected = telegramManager.isConnected(id);
    const clientInfo = telegramManager.getClientInfo(id);

    res.json({
      ...account,
      isConnected,
      lastActivity: clientInfo?.lastActivity,
      reconnectAttempts: clientInfo?.reconnectAttempts || 0,
    });
  } catch (error) {
    console.error('Error fetching BD account status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all dialogs for an account
app.get('/api/bd-accounts/:id/dialogs', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;

    // Verify account belongs to organization
    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );

    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }

    const dialogs = await telegramManager.getDialogs(id);
    res.json(dialogs);
  } catch (error: any) {
    console.error('Error fetching dialogs:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message || 'Failed to fetch dialogs'
    });
  }
});

// Disconnect account
app.post('/api/bd-accounts/:id/disconnect', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;

    // Verify account belongs to organization
    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );

    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }

    await telegramManager.disconnectAccount(id);
    
    // Update account status
    await pool.query(
      'UPDATE bd_accounts SET is_active = false WHERE id = $1',
      [id]
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('Error disconnecting account:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message || 'Failed to disconnect account'
    });
  }
});

// Send message via Telegram (internal endpoint for messaging service)
app.post('/api/bd-accounts/:id/send', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { chatId, text } = req.body;

    if (!chatId || !text) {
      return res.status(400).json({ error: 'Missing required fields: chatId, text' });
    }

    // Verify account belongs to organization
    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );

    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }

    // Check if account is connected
    if (!telegramManager.isConnected(id)) {
      return res.status(400).json({ error: 'BD account is not connected' });
    }

    // Send message
    const message = await telegramManager.sendMessage(id, chatId, text);

    res.json({
      success: true,
      messageId: String(message.id),
      date: message.date,
    });
  } catch (error: any) {
    console.error('Error sending message:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message || 'Failed to send message'
    });
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

app.listen(PORT, '0.0.0.0', () => {
  console.log(`BD Accounts service running on port ${PORT}`);
}).on('error', (error: any) => {
  console.error(`❌ Failed to start BD Accounts service on port ${PORT}:`, error);
  process.exit(1);
});

