import express from 'express';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { RabbitMQClient, RedisClient } from '@getsale/utils';
import { EventType, BDAccountConnectedEvent } from '@getsale/events';
import { TelegramManager } from './telegram-manager';

const app = express();
const PORT = parseInt(String(process.env.PORT || 3007), 10);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'postgres_dev'}@localhost:5432/postgres`,
});

const rabbitmq = new RabbitMQClient(
  process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672'
);

const redisUrl = process.env.REDIS_URL;
const redis = redisUrl ? new RedisClient(redisUrl) : null;

// Initialize Telegram Manager (Redis — для QR-сессий при нескольких репликах)
const telegramManager = new TelegramManager(pool, rabbitmq, redis);

// Handle unhandled promise rejections from Telegram library
// This prevents crashes during datacenter migration when builder.resolve errors occur
process.on('unhandledRejection', (reason: any, promise: Promise<any>) => {
  // Silently ignore builder.resolve errors - they're internal library issues
  if (reason?.message?.includes('builder.resolve is not a function') ||
      reason?.message?.includes('builder.resolve') ||
      reason?.stack?.includes('builder.resolve')) {
    return;
  }
  // TIMEOUT from telegram/client/updates.js — цикл обновлений таймаутит; переподключаем клиентов, чтобы перезапустить update loop
  if (reason?.message === 'TIMEOUT') {
    if (reason?.stack?.includes('updates.js')) {
      telegramManager.scheduleReconnectAllAfterTimeout();
    }
    return;
  }
  // Log other unhandled rejections but don't crash
  console.error('[BD Accounts Service] Unhandled promise rejection:', reason);
});

// Handle uncaught exceptions from Telegram library
process.on('uncaughtException', (error: Error) => {
  if (error.message?.includes('builder.resolve is not a function') ||
      error.message?.includes('builder.resolve') ||
      error.stack?.includes('builder.resolve')) {
    return;
  }
  if (error.message === 'TIMEOUT') {
    telegramManager.scheduleReconnectAllAfterTimeout();
    return;
  }
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

/** Проверяет, что текущий пользователь — владелец аккаунта (может управлять им). */
async function requireAccountOwner(accountId: string, user: { id: string; organizationId: string }): Promise<boolean> {
  const r = await pool.query(
    'SELECT created_by_user_id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
    [accountId, user.organizationId]
  );
  if (r.rows.length === 0) return false;
  const ownerId = r.rows[0].created_by_user_id;
  return ownerId != null && ownerId === user.id;
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
    
    const result = await pool.query(
      `SELECT id, organization_id, telegram_id, phone_number, is_active, connected_at, last_activity,
              created_at, sync_status, sync_progress_done, sync_progress_total, sync_error,
              created_by_user_id AS owner_id
       FROM bd_accounts WHERE organization_id = $1 ORDER BY created_at DESC`,
      [user.organizationId]
    );

    const rows = result.rows.map((r: any) => ({
      ...r,
      is_owner: r.owner_id != null && r.owner_id === user.id,
    }));
    res.json(rows);
  } catch (error: any) {
    console.error('Error fetching BD accounts:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Start QR-code login (Telegram: https://core.telegram.org/api/qr-login)
app.post('/api/bd-accounts/start-qr-login', async (req, res) => {
  try {
    const user = getUser(req);
    const { apiId, apiHash } = req.body;

    if (!apiId || !apiHash) {
      return res.status(400).json({ error: 'Missing required fields: apiId, apiHash' });
    }

    const sessionId = (await telegramManager.startQrLogin(
      user.organizationId,
      user.id,
      parseInt(String(apiId)),
      apiHash
    )).sessionId;

    res.json({ sessionId });
  } catch (error: any) {
    console.error('Error starting QR login:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message || 'Failed to start QR login',
    });
  }
});

// Poll QR login status (loginTokenUrl for QR code, need_password, then success/error)
app.get('/api/bd-accounts/qr-login-status', async (req, res) => {
  try {
    const user = getUser(req);
    const { sessionId } = req.query;

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId query parameter required' });
    }

    const state = await telegramManager.getQrLoginStatus(sessionId);
    if (!state) {
      return res.status(404).json({ error: 'Session not found or expired' });
    }

    res.json(state);
  } catch (error: any) {
    console.error('Error getting QR login status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Submit 2FA password for QR login (when status was need_password)
app.post('/api/bd-accounts/qr-login-password', async (req, res) => {
  try {
    const user = getUser(req);
    const { sessionId, password } = req.body;

    if (!sessionId || typeof sessionId !== 'string') {
      return res.status(400).json({ error: 'sessionId required' });
    }
    if (password == null || typeof password !== 'string') {
      return res.status(400).json({ error: 'password required' });
    }

    const accepted = await telegramManager.submitQrLoginPassword(sessionId, password);
    if (!accepted) {
      return res.status(400).json({ error: 'Session not waiting for password or expired' });
    }

    res.json({ ok: true });
  } catch (error: any) {
    console.error('Error submitting QR login password:', error);
    res.status(500).json({ error: 'Internal server error' });
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
      // При повторном подключении обновляем владельца, если ещё не задан
      await pool.query(
        `UPDATE bd_accounts SET created_by_user_id = $1 WHERE id = $2 AND created_by_user_id IS NULL`,
        [user.id, accountId]
      );
    } else {
      // Create new account record (владелец — тот, кто подключает)
      const insertResult = await pool.query(
        `INSERT INTO bd_accounts (organization_id, telegram_id, phone_number, api_id, api_hash, is_active, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [user.organizationId, phoneNumber, phoneNumber, String(apiId), apiHash, false, user.id]
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

    // Владелец аккаунта — тот, кто прошёл верификацию (для старых аккаунтов без owner)
    await pool.query(
      'UPDATE bd_accounts SET created_by_user_id = $1 WHERE id = $2 AND created_by_user_id IS NULL',
      [user.id, accountId]
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

// Get selected sync chats for an account
app.get('/api/bd-accounts/:id/sync-chats', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }

    const result = await pool.query(
      'SELECT id, telegram_chat_id, title, peer_type, is_folder, created_at FROM bd_account_sync_chats WHERE bd_account_id = $1 ORDER BY created_at',
      [id]
    );
    res.json(result.rows);
  } catch (error: any) {
    console.error('Error fetching sync chats:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Save selected chats for sync (replace existing selection) — только владелец аккаунта
app.post('/api/bd-accounts/:id/sync-chats', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { chats } = req.body; // [{ id, name, isUser, isGroup, isChannel }]

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }
    const isOwner = await requireAccountOwner(id, user);
    if (!isOwner) {
      return res.status(403).json({ error: 'Only the account owner can change sync chats' });
    }

    if (!Array.isArray(chats)) {
      return res.status(400).json({ error: 'chats must be an array' });
    }

    await pool.query('DELETE FROM bd_account_sync_chats WHERE bd_account_id = $1', [id]);

    let inserted = 0;
    for (const c of chats) {
      const chatId = String(c.id ?? c.telegram_chat_id ?? '').trim();
      const title = (c.name ?? c.title ?? '').trim();
      let peerType = 'user';
      if (c.isChannel) peerType = 'channel';
      else if (c.isGroup) peerType = 'chat';
      if (!chatId) {
        console.warn('[BD Accounts] Skipping chat with empty id:', c);
        continue;
      }
      await pool.query(
        `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder)
         VALUES ($1, $2, $3, $4, false)`,
        [id, chatId, title, peerType]
      );
      inserted++;
    }
    console.log(`[BD Accounts] Saved ${inserted} sync chats for account ${id} (requested ${chats.length})`);

    const result = await pool.query(
      'SELECT id, telegram_chat_id, title, peer_type FROM bd_account_sync_chats WHERE bd_account_id = $1 ORDER BY created_at',
      [id]
    );
    res.json(result.rows);
  } catch (error: any) {
    console.error('Error saving sync chats:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Start initial history sync (runs in background; progress via WebSocket)
app.post('/api/bd-accounts/:id/sync-start', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;

    console.log('[BD Accounts] sync-start requested for account', id, 'org', user.organizationId);

    const accountResult = await pool.query(
      'SELECT id, organization_id, sync_status, sync_started_at FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }
    const isOwner = await requireAccountOwner(id, user);
    if (!isOwner) {
      return res.status(403).json({ error: 'Only the account owner can start sync' });
    }

    const account = accountResult.rows[0];
    const startedAt = account.sync_started_at ? new Date(account.sync_started_at).getTime() : 0;
    const isStale = account.sync_status === 'syncing' && startedAt && Date.now() - startedAt > SYNC_STALE_MINUTES * 60 * 1000;

    if (isStale) {
      console.log('[BD Accounts] Resetting stale syncing state for account', id);
      await pool.query(
        "UPDATE bd_accounts SET sync_status = 'idle', sync_error = NULL WHERE id = $1",
        [id]
      );
    } else if (account.sync_status === 'syncing') {
      console.log('[BD Accounts] Sync already in progress for account', id);
      return res.json({ success: true, message: 'Sync already in progress' });
    }

    // Check connection first so user gets clear "Account is not connected" before any Telegram API calls
    if (!telegramManager.isConnected(id)) {
      console.warn('[BD Accounts] Cannot start sync, account is not connected to Telegram', {
        accountId: id,
        organizationId: account.organization_id,
      });
      return res.status(400).json({ error: 'Account is not connected' });
    }

    const syncChatsCount = await pool.query(
      'SELECT COUNT(*) AS c FROM bd_account_sync_chats WHERE bd_account_id = $1',
      [id]
    );
    const numChats = Number(syncChatsCount.rows[0]?.c ?? 0);

    if (numChats === 0) {
      console.log('[BD Accounts] sync-start rejected: no chats selected for account', id);
      return res.status(400).json({
        error: 'no_chats_selected',
        message: 'Сначала выберите чаты и папки для синхронизации в BD Аккаунтах',
      });
    }

    console.log(`[BD Accounts] sync-start: account ${id}, ${numChats} chats to sync`);
    res.json({ success: true, message: 'Sync started' });

    telegramManager.syncHistory(id, account.organization_id).catch((err) => {
      console.error('[BD Accounts] Sync failed:', err);
    });
  } catch (error: any) {
    console.error('Error starting sync:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Stale sync threshold: if syncing started more than this ago, consider it stuck
const SYNC_STALE_MINUTES = 15;

// Get sync status for an account (returns 'idle' if syncing is stale so frontend can retry)
app.get('/api/bd-accounts/:id/sync-status', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;

    const result = await pool.query(
      `SELECT sync_status, sync_error, sync_progress_total, sync_progress_done, sync_started_at, sync_completed_at
       FROM bd_accounts WHERE id = $1 AND organization_id = $2`,
      [id, user.organizationId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }
    const row = result.rows[0];
    let syncStatus = row.sync_status ?? 'idle';
    const startedAt = row.sync_started_at ? new Date(row.sync_started_at).getTime() : 0;
    if (syncStatus === 'syncing' && startedAt && Date.now() - startedAt > SYNC_STALE_MINUTES * 60 * 1000) {
      await pool.query(
        "UPDATE bd_accounts SET sync_status = 'idle', sync_error = 'Синхронизация прервана по таймауту' WHERE id = $1",
        [id]
      );
      syncStatus = 'idle';
    }
    const chatsCount = await pool.query(
      'SELECT COUNT(*) AS c FROM bd_account_sync_chats WHERE bd_account_id = $1',
      [id]
    );
    const has_sync_chats = Number(chatsCount.rows[0]?.c ?? 0) > 0;
    res.json({ ...row, sync_status: syncStatus, has_sync_chats: !!has_sync_chats });
  } catch (error: any) {
    console.error('Error fetching sync status:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Proxy media from Telegram (photo, video, voice, document) — не храним файлы, отдаём по запросу
app.get('/api/bd-accounts/:id/media', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { channelId, messageId } = req.query;

    if (!channelId || !messageId) {
      return res.status(400).json({ error: 'channelId and messageId query params required' });
    }

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }

    const result = await telegramManager.downloadMessageMedia(id, String(channelId), String(messageId));
    if (!result) {
      return res.status(404).json({ error: 'Message or media not found' });
    }

    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(result.buffer);
  } catch (error: any) {
    if (error?.message?.includes('not connected')) {
      return res.status(400).json({ error: 'Account is not connected' });
    }
    console.error('Error proxying media:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Disconnect account — только владелец
app.post('/api/bd-accounts/:id/disconnect', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }
    const isOwner = await requireAccountOwner(id, user);
    if (!isOwner) {
      return res.status(403).json({ error: 'Only the account owner can disconnect' });
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

