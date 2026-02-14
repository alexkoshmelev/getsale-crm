import express from 'express';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { RabbitMQClient, RedisClient } from '@getsale/utils';
import { EventType, Event } from '@getsale/events';
import { TelegramManager } from './telegram-manager';
import { serializeMessage } from './telegram-serialize';

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
  // TIMEOUT from telegram/client/updates.js — цикл обновлений таймаутит; переподключаем клиентов, чтобы перезапустить update loop (не крашим и не логируем стек)
  if (reason?.message === 'TIMEOUT') {
    if (reason?.stack?.includes('updates.js')) {
      telegramManager.scheduleReconnectAllAfterTimeout();
      console.log('[BD Accounts Service] Update loop TIMEOUT handled — reconnecting clients');
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
    role: (req.headers['x-user-role'] as string) || '',
  };
}

/** Проверка права по role_permissions (owner всегда true). */
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
    if (roleLower === 'owner') return true;
    return false;
  }
}

/** Telegram API credentials from env. */
function getTelegramApiCredentials(): { apiId: number; apiHash: string } {
  const apiId = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) {
    throw new Error(
      'TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in environment. ' +
        'On the server: set GitHub Secrets TELEGRAM_API_ID and TELEGRAM_API_HASH, or add them to .env in the same directory as docker-compose.server.yml, ' +
        'then run: docker compose -f docker-compose.server.yml up -d --force-recreate bd-accounts-service'
    );
  }
  return { apiId: parseInt(String(apiId), 10), apiHash };
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

// Get BD accounts (с суммарным непрочитанным по каждому аккаунту — только по чатам из sync)
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
              created_by_user_id AS owner_id,
              first_name, last_name, username, bio, photo_file_id, display_name
       FROM bd_accounts WHERE organization_id = $1 ORDER BY created_at DESC`,
      [user.organizationId]
    );

    // Суммарный непрочитанный по аккаунту — та же логика, что и в messaging (только sync_chats с peer_type user/chat, m.channel_id = s.telegram_chat_id)
    const unreadResult = await pool.query(
      `SELECT s.bd_account_id, COALESCE(SUM(sub.cnt), 0)::int AS unread_count
       FROM bd_account_sync_chats s
       JOIN bd_accounts a ON a.id = s.bd_account_id AND a.organization_id = $1
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS cnt
         FROM messages m
         WHERE m.organization_id = a.organization_id AND m.channel = 'telegram' AND m.unread = true
           AND m.bd_account_id = s.bd_account_id AND m.channel_id = s.telegram_chat_id
       ) sub ON true
       WHERE s.peer_type IN ('user', 'chat')
       GROUP BY s.bd_account_id`,
      [user.organizationId]
    );
    const unreadByAccount: Record<string, number> = {};
    for (const row of unreadResult.rows as any[]) {
      unreadByAccount[row.bd_account_id] = Number(row.unread_count) || 0;
    }

    const rows = result.rows.map((r: any) => ({
      ...r,
      is_owner: r.owner_id != null && r.owner_id === user.id,
      unread_count: unreadByAccount[r.id] ?? 0,
    }));
    res.json(rows);
  } catch (error: any) {
    console.error('Error fetching BD accounts:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Poll QR login status — must be before /:id so "qr-login-status" is not matched as id
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

// Get single BD account (for card/detail view)
app.get('/api/bd-accounts/:id', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;

    const result = await pool.query(
      `SELECT id, organization_id, telegram_id, phone_number, is_active, connected_at, last_activity,
              created_at, sync_status, sync_progress_done, sync_progress_total, sync_error,
              created_by_user_id AS owner_id,
              first_name, last_name, username, bio, photo_file_id, display_name
       FROM bd_accounts WHERE id = $1 AND organization_id = $2`,
      [id, user.organizationId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }
    const row = result.rows[0] as any;
    res.json({
      ...row,
      is_owner: row.owner_id != null && row.owner_id === user.id,
    });
  } catch (error: any) {
    console.error('Error fetching BD account:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Update BD account (display_name / custom name only)
app.patch('/api/bd-accounts/:id', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { display_name: displayName } = req.body ?? {};

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }
    const isOwner = await requireAccountOwner(id, user);
    if (!isOwner) {
      return res.status(403).json({ error: 'Only the account owner can update' });
    }

    const value = typeof displayName === 'string' ? displayName.trim() || null : null;
    await pool.query(
      'UPDATE bd_accounts SET display_name = $1, updated_at = NOW() WHERE id = $2',
      [value, id]
    );
    res.json({ success: true, display_name: value });
  } catch (error: any) {
    console.error('Error updating BD account:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Avatar image for BD account (profile photo from Telegram)
app.get('/api/bd-accounts/:id/avatar', async (req, res) => {
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

    const result = await telegramManager.downloadAccountProfilePhoto(id);
    if (!result) {
      return res.status(404).json({ error: 'Avatar not available (account offline or no photo)' });
    }
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(result.buffer);
  } catch (error: any) {
    console.error('Error fetching avatar:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Chat/peer avatar (for chat list — user or group photo from Telegram)
app.get('/api/bd-accounts/:id/chats/:chatId/avatar', async (req, res) => {
  try {
    const user = getUser(req);
    const { id, chatId } = req.params;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }

    const result = await telegramManager.downloadChatProfilePhoto(id, chatId);
    if (!result) {
      return res.status(404).json({ error: 'Chat avatar not available' });
    }
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(result.buffer);
  } catch (error: any) {
    console.error('Error fetching chat avatar:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Start QR-code login (Telegram: https://core.telegram.org/api/qr-login)
app.post('/api/bd-accounts/start-qr-login', async (req, res) => {
  try {
    const user = getUser(req);
    const { apiId, apiHash } = getTelegramApiCredentials();

    const sessionId = (await telegramManager.startQrLogin(
      user.organizationId,
      user.id,
      apiId,
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
    const { platform, phoneNumber } = req.body;
    const { apiId, apiHash } = getTelegramApiCredentials();

    if (!platform || !phoneNumber) {
      return res.status(400).json({ error: 'Missing required fields: platform, phoneNumber' });
    }

    if (platform !== 'telegram') {
      return res.status(400).json({ error: 'Unsupported platform' });
    }

    // Проверка: аккаунт уже подключён в другой организации
    const otherOrgResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE phone_number = $1 AND organization_id != $2 AND is_active = true',
      [phoneNumber, user.organizationId]
    );
    if (otherOrgResult.rows.length > 0) {
      return res.status(409).json({
        error: 'ACCOUNT_CONNECTED_IN_OTHER_ORGANIZATION',
        message: 'Этот аккаунт уже подключён в другой организации. Один Telegram-аккаунт можно использовать только в одной организации.',
      });
    }

    // Check if account already exists в этой организации (и не подключён ли уже)
    let existingResult = await pool.query(
      'SELECT id, is_active FROM bd_accounts WHERE phone_number = $1 AND organization_id = $2',
      [phoneNumber, user.organizationId]
    );

    let accountId: string;

    if (existingResult.rows.length > 0) {
      const row = existingResult.rows[0];
      if (row.is_active) {
        return res.status(409).json({
          error: 'ACCOUNT_ALREADY_CONNECTED',
          message: 'Этот аккаунт уже подключён в вашей организации. Выберите его в списке или отключите перед повторным подключением.',
        });
      }
      accountId = row.id;
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
      apiId,
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
      await rabbitmq.publishEvent({
        id: randomUUID(),
        type: EventType.BD_ACCOUNT_CONNECTED,
        timestamp: new Date(),
        organizationId: user.organizationId,
        userId: user.id,
        data: { bdAccountId: accountId, platform: 'telegram', userId: user.id },
      } as Event);

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
    const { platform, phoneNumber, sessionString } = req.body;
    const { apiId, apiHash } = getTelegramApiCredentials();

    if (!platform || !phoneNumber) {
      return res.status(400).json({ error: 'Missing required fields: platform, phoneNumber' });
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
        apiId,
        apiHash,
        sessionString || existingSessionString
      );

      // Get updated account info
      const result = await pool.query(
        'SELECT * FROM bd_accounts WHERE id = $1',
        [accountId]
      );

      // Publish event
      await rabbitmq.publishEvent({
        id: randomUUID(),
        type: EventType.BD_ACCOUNT_CONNECTED,
        timestamp: new Date(),
        organizationId: user.organizationId,
        userId: user.id,
        data: { bdAccountId: accountId, platform: 'telegram', userId: user.id },
      } as Event);

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

    const forceRefresh = req.query.refresh === '1';
    if (!forceRefresh) {
      const chatsRows = await pool.query(
        'SELECT telegram_chat_id, title, peer_type FROM bd_account_sync_chats WHERE bd_account_id = $1 ORDER BY created_at',
        [id]
      );
      const dialogs = (chatsRows.rows as any[]).map((r) => {
        const pt = (r.peer_type || 'user').toLowerCase();
        return {
          id: String(r.telegram_chat_id),
          name: (r.title || '').trim() || String(r.telegram_chat_id),
          isUser: pt === 'user',
          isGroup: pt === 'chat',
          isChannel: pt === 'channel',
          unreadCount: 0,
          lastMessage: '',
          lastMessageDate: null,
        };
      });
      return res.json(dialogs);
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

// --- Folders: папки первым экраном, подгрузка чатов из выбранных папок ---

// Get available folders. По умолчанию — из БД (sync_folders). ?refresh=1 — подтянуть с Telegram (GetDialogFilters).
app.get('/api/bd-accounts/:id/folders', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const forceRefresh = req.query.refresh === '1';
    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }
    if (!forceRefresh) {
      const rows = await pool.query(
        'SELECT folder_id, folder_title, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index, folder_id',
        [id]
      );
      const folders = [
        { id: 0, title: 'Все чаты', isCustom: false, emoticon: '💬' },
        ...rows.rows.map((r: any) => ({
          id: Number(r.folder_id),
          title: (r.folder_title || '').trim() || `Папка ${r.folder_id}`,
          isCustom: Number(r.folder_id) >= 2,
          emoticon: r.icon || undefined,
        })),
      ];
      return res.json({ folders });
    }
    const filters = await telegramManager.getDialogFilters(id);
    const folders = [{ id: 0, title: 'Все чаты', isCustom: false, emoticon: '💬' }, ...filters];
    res.json({ folders });
  } catch (error: any) {
    console.error('Error fetching folders:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Get dialogs grouped by folders. По умолчанию — из БД (мгновенно, без запросов к Telegram). ?refresh=1 — подтянуть с Telegram.
app.get('/api/bd-accounts/:id/dialogs-by-folders', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const forceRefresh = req.query.refresh === '1';
    const accountResult = await pool.query(
      'SELECT id, telegram_id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }
    const accountTelegramId = accountResult.rows[0].telegram_id != null ? String(accountResult.rows[0].telegram_id).trim() : null;
    const excludeSelf = (dialogs: any[]) =>
      accountTelegramId ? dialogs.filter((d: any) => !(d.isUser && String(d.id).trim() === accountTelegramId)) : dialogs;

    if (!forceRefresh) {
      const foldersRows = await pool.query(
        'SELECT folder_id, folder_title, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index, folder_id',
        [id]
      );
      const chatsRows = await pool.query(
        `SELECT s.telegram_chat_id, s.title, s.peer_type, j.folder_id
         FROM bd_account_sync_chats s
         LEFT JOIN bd_account_sync_chat_folders j ON j.bd_account_id = s.bd_account_id AND j.telegram_chat_id = s.telegram_chat_id
         WHERE s.bd_account_id = $1`,
        [id]
      );
      const chatsByFolder = new Map<number, { id: string; name: string; isUser: boolean; isGroup: boolean; isChannel: boolean }[]>();
      const folder0Dialogs: { id: string; name: string; isUser: boolean; isGroup: boolean; isChannel: boolean }[] = [];
      const seenInFolder0 = new Set<string>();
      for (const r of chatsRows.rows) {
        const chatId = String(r.telegram_chat_id);
        const name = (r.title || '').trim() || chatId;
        const pt = (r.peer_type || 'user').toLowerCase();
        const item = { id: chatId, name, isUser: pt === 'user', isGroup: pt === 'chat', isChannel: pt === 'channel' };
        if (accountTelegramId && item.isUser && chatId === accountTelegramId) continue;
        if (!seenInFolder0.has(chatId)) {
          seenInFolder0.add(chatId);
          folder0Dialogs.push(item);
        }
        const fid = r.folder_id != null ? Number(r.folder_id) : 0;
        if (!chatsByFolder.has(fid)) chatsByFolder.set(fid, []);
        if (!chatsByFolder.get(fid)!.some((d) => d.id === chatId)) chatsByFolder.get(fid)!.push(item);
      }
      const folderList: { id: number; title: string; emoticon?: string; dialogs: any[] }[] = [];
      const addedFolderIds = new Set<number>();
      if (!foldersRows.rows.some((r: any) => Number(r.folder_id) === 0)) {
        folderList.push({ id: 0, title: 'Все чаты', emoticon: '💬', dialogs: excludeSelf(folder0Dialogs) });
        addedFolderIds.add(0);
      }
      if (!foldersRows.rows.some((r: any) => Number(r.folder_id) === 1)) {
        folderList.push({ id: 1, title: 'Архив', emoticon: '📁', dialogs: excludeSelf(chatsByFolder.get(1) || []) });
        addedFolderIds.add(1);
      }
      for (const f of foldersRows.rows) {
        const fid = Number(f.folder_id);
        if (addedFolderIds.has(fid)) continue;
        const dialogs = fid === 0 ? folder0Dialogs : (chatsByFolder.get(fid) || []);
        folderList.push({
          id: fid,
          title: (f.folder_title || '').trim() || `Папка ${fid}`,
          emoticon: f.icon || undefined,
          dialogs: excludeSelf(fid === 0 ? folder0Dialogs : dialogs),
        });
        addedFolderIds.add(fid);
      }
      if (folderList.length === 0) {
        folderList.push({ id: 0, title: 'Все чаты', emoticon: '💬', dialogs: excludeSelf(folder0Dialogs) });
      }
      return res.json({ folders: folderList });
    }

    const filters = await telegramManager.getDialogFilters(id);
    const [allDialogs0, allDialogs1] = await Promise.all([
      telegramManager.getDialogsAll(id, 0, { maxDialogs: 3000, delayEveryN: 100, delayMs: 600 }),
      telegramManager.getDialogsAll(id, 1, { maxDialogs: 2000, delayEveryN: 100, delayMs: 600 }).catch(() => []),
    ]);
    const mergedById = new Map<string, any>();
    for (const d of [...allDialogs0, ...allDialogs1]) {
      if (!mergedById.has(String(d.id))) mergedById.set(String(d.id), d);
    }
    const merged = Array.from(mergedById.values());

    const folderList: { id: number; title: string; emoticon?: string; dialogs: any[] }[] = [
      { id: 0, title: 'Все чаты', emoticon: '💬', dialogs: excludeSelf(allDialogs0) },
    ];
    if (allDialogs1.length > 0) {
      folderList.push({ id: 1, title: 'Архив', emoticon: '📁', dialogs: excludeSelf(allDialogs1) });
    }
    for (const f of filters) {
      if (f.id === 0 || f.id === 1) continue;
      const filterRaw = await telegramManager.getDialogFilterRaw(id, f.id);
      const { include: includePeerIds, exclude: excludePeerIds } = require('./telegram-manager').TelegramManager.getFilterIncludeExcludePeerIds(filterRaw);
      const dialogs = merged.filter((d: any) =>
        require('./telegram-manager').TelegramManager.dialogMatchesFilter(d, filterRaw, includePeerIds, excludePeerIds)
      );
      folderList.push({ id: f.id, title: f.title, emoticon: f.emoticon, dialogs: excludeSelf(dialogs) });
    }
    // Pinned order from Telegram (folder 0: pinned dialogs first, then unpinned)
    const pinned_chat_ids = allDialogs0.filter((d: any) => d.pinned === true).map((d: any) => String(d.id));
    res.json({ folders: folderList, pinned_chat_ids });
  } catch (error: any) {
    console.error('Error fetching dialogs by folders:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Get selected sync folders for an account. По умолчанию из БД; при первичной загрузке (пустой список) — подтянуть из Telegram и сохранить.
app.get('/api/bd-accounts/:id/sync-folders', async (req, res) => {
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
    await ensureFoldersFromSyncChats(pool, telegramManager, id);
    let result = await pool.query(
      'SELECT id, folder_id, folder_title, order_index, COALESCE(is_user_created, false) AS is_user_created, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index, folder_id',
      [id]
    );
    // При первичной синхронизации папок ещё нет — загружаем из Telegram и сохраняем
    if (result.rows.length === 0 && telegramManager.isConnected(id)) {
      try {
        const rows = await fetchFoldersFromTelegramAndSave(pool, telegramManager, id);
        return res.json(rows);
      } catch (err: any) {
        console.warn('Initial folders fetch from Telegram failed:', err?.message);
      }
    }
    res.json(result.rows);
  } catch (error: any) {
    console.error('Error fetching sync folders:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Обновить папки и чаты из Telegram (как при первой синхронизации). По кнопке «Обновить папки» в диалоге синхронизации.
app.post('/api/bd-accounts/:id/folders-refetch', async (req, res) => {
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
    if (!telegramManager.isConnected(id)) {
      return res.status(400).json({ error: 'Account is not connected to Telegram' });
    }
    const rows = await fetchFoldersFromTelegramAndSave(pool, telegramManager, id);
    await refreshChatsFromFolders(pool, telegramManager, id);
    res.json({ folders: rows, success: true });
  } catch (error: any) {
    console.error('Error refetching folders:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Save selected folders + опционально отдельные контакты; обновить чаты из папок и добавить extraChats (only owner)
app.post('/api/bd-accounts/:id/sync-folders', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { folders, extraChats } = req.body; // folders: [{ folderId, folderTitle }], extraChats?: [{ id, name, isUser, isGroup, isChannel }]

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }
    const isOwner = await requireAccountOwner(id, user);
    if (!isOwner) {
      return res.status(403).json({ error: 'Only the account owner can change sync folders' });
    }
    if (!Array.isArray(folders)) {
      return res.status(400).json({ error: 'folders must be an array' });
    }

    await pool.query('DELETE FROM bd_account_sync_folders WHERE bd_account_id = $1', [id]);
    for (let i = 0; i < folders.length; i++) {
      const f = folders[i];
      const folderId = Number(f.folderId ?? f.folder_id ?? 0);
      const title = String(f.folderTitle ?? f.folder_title ?? '').trim() || `Папка ${folderId}`;
      const isUserCreated = Boolean(f.is_user_created ?? f.isUserCreated ?? false);
      const icon = f.icon != null && String(f.icon).trim() ? String(f.icon).trim().slice(0, 20) : null;
      await pool.query(
        `INSERT INTO bd_account_sync_folders (bd_account_id, folder_id, folder_title, order_index, is_user_created, icon)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, folderId, title, i, isUserCreated, icon]
      );
    }

    // Не вызываем refreshChatsFromFolders при сохранении папок — меньше GetDialogs и flood wait.
    // Пользователь может явно нажать «Обновить с Telegram» (sync-folders-refresh).

    if (Array.isArray(extraChats) && extraChats.length > 0) {
      for (const c of extraChats) {
        const chatId = String(c.id ?? c.telegram_chat_id ?? '').trim();
        if (!chatId) continue;
        const title = (c.name ?? c.title ?? '').trim() || chatId;
        const folderId = c.folderId !== undefined && c.folderId !== null ? Number(c.folderId) : null;
        let peerType = 'user';
        if (c.isChannel) peerType = 'channel';
        else if (c.isGroup) peerType = 'chat';
        await pool.query(
          `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id)
           VALUES ($1, $2, $3, $4, false, $5)
           ON CONFLICT (bd_account_id, telegram_chat_id) DO UPDATE SET
             title = EXCLUDED.title,
             peer_type = EXCLUDED.peer_type,
             folder_id = EXCLUDED.folder_id`,
          [id, chatId, title, peerType, folderId]
        );
        if (folderId != null) {
          await pool.query(
            `INSERT INTO bd_account_sync_chat_folders (bd_account_id, telegram_chat_id, folder_id)
             VALUES ($1, $2, $3) ON CONFLICT (bd_account_id, telegram_chat_id, folder_id) DO NOTHING`,
            [id, chatId, folderId]
          );
        }
      }
    }

    const result = await pool.query(
      'SELECT id, folder_id, folder_title, order_index, COALESCE(is_user_created, false) AS is_user_created, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index',
      [id]
    );
    res.json(result.rows);
  } catch (error: any) {
    console.error('Error saving sync folders:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Create custom folder (user-created; next folder_id >= 2) — регистрировать до /:folderRowId
app.post('/api/bd-accounts/:id/sync-folders/custom', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { folder_title: folderTitle, icon } = req.body;
    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }
    const isOwner = await requireAccountOwner(id, user);
    if (!isOwner) {
      return res.status(403).json({ error: 'Only the account owner can create folders' });
    }
    const title = (folderTitle != null ? String(folderTitle).trim() : '').slice(0, 12) || 'New folder';
    const iconVal = icon != null && String(icon).trim() ? String(icon).trim().slice(0, 20) : null;
    const maxRow = await pool.query(
      'SELECT COALESCE(MAX(folder_id), 1) AS max_id FROM bd_account_sync_folders WHERE bd_account_id = $1',
      [id]
    );
    const nextFolderId = Math.max(2, (Number(maxRow.rows[0]?.max_id) || 1) + 1);
    const countRow = await pool.query(
      'SELECT COUNT(*) AS c FROM bd_account_sync_folders WHERE bd_account_id = $1',
      [id]
    );
    const orderIndex = Number(countRow.rows[0]?.c) || 0;
    const insert = await pool.query(
      `INSERT INTO bd_account_sync_folders (bd_account_id, folder_id, folder_title, order_index, is_user_created, icon)
       VALUES ($1, $2, $3, $4, true, $5)
       RETURNING id, folder_id, folder_title, order_index, is_user_created, icon`,
      [id, nextFolderId, title, orderIndex, iconVal]
    );
    res.status(201).json(insert.rows[0]);
  } catch (error: any) {
    console.error('Error creating custom folder:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Reorder folders (body: { order: string[] } — array of row ids) — регистрировать до /:folderRowId
app.patch('/api/bd-accounts/:id/sync-folders/order', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { order } = req.body;
    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }
    const isOwner = await requireAccountOwner(id, user);
    if (!isOwner) {
      return res.status(403).json({ error: 'Only the account owner can reorder folders' });
    }
    if (!Array.isArray(order) || order.length === 0) {
      return res.status(400).json({ error: 'order must be a non-empty array of folder row ids' });
    }
    for (let i = 0; i < order.length; i++) {
      await pool.query(
        'UPDATE bd_account_sync_folders SET order_index = $1 WHERE id = $2 AND bd_account_id = $3',
        [i, String(order[i]), id]
      );
    }
    const result = await pool.query(
      'SELECT id, folder_id, folder_title, order_index, COALESCE(is_user_created, false) AS is_user_created, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index',
      [id]
    );
    res.json(result.rows);
  } catch (error: any) {
    console.error('Error reordering folders:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Update folder icon or title (emoji / folder_title)
app.patch('/api/bd-accounts/:id/sync-folders/:folderRowId', async (req, res) => {
  try {
    const user = getUser(req);
    const { id: accountId, folderRowId } = req.params;
    const { icon, folder_title: folderTitle } = req.body;
    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [accountId, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }
    const updates: string[] = [];
    const values: any[] = [];
    let i = 1;
    if (icon !== undefined) {
      const iconVal = icon === null || icon === '' ? null : (String(icon).trim().slice(0, 20) || null);
      updates.push(`icon = $${i++}`);
      values.push(iconVal);
    }
    if (folderTitle !== undefined) {
      const titleVal = String(folderTitle ?? '').trim().slice(0, 12) || null;
      updates.push(`folder_title = $${i++}`);
      values.push(titleVal);
    }
    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }
    values.push(folderRowId, accountId);
    const result = await pool.query(
      `UPDATE bd_account_sync_folders SET ${updates.join(', ')}
       WHERE id = $${i++} AND bd_account_id = $${i}
       RETURNING id, folder_id, folder_title, order_index, is_user_created, icon`,
      values
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    res.json(result.rows[0]);
  } catch (error: any) {
    console.error('Error updating folder:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Delete user-created folder (move chats to "no folder", then delete folder row)
app.delete('/api/bd-accounts/:id/sync-folders/:folderRowId', async (req, res) => {
  try {
    const user = getUser(req);
    const { id: accountId, folderRowId } = req.params;
    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [accountId, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }
    const isOwner = await requireAccountOwner(accountId, user);
    if (!isOwner) {
      return res.status(403).json({ error: 'Only the account owner can delete folders' });
    }
    const folderRow = await pool.query(
      'SELECT id, folder_id, is_user_created FROM bd_account_sync_folders WHERE id = $1 AND bd_account_id = $2',
      [folderRowId, accountId]
    );
    if (folderRow.rows.length === 0) {
      return res.status(404).json({ error: 'Folder not found' });
    }
    const folder = folderRow.rows[0];
    if (!folder.is_user_created) {
      return res.status(400).json({ error: 'Only user-created folders can be deleted. Telegram folders are read-only.' });
    }
    const folderIdNum = Number(folder.folder_id);
    await pool.query(
      'UPDATE bd_account_sync_chats SET folder_id = NULL WHERE bd_account_id = $1 AND folder_id = $2',
      [accountId, folderIdNum]
    );
    await pool.query(
      'DELETE FROM bd_account_sync_folders WHERE id = $1 AND bd_account_id = $2',
      [folderRowId, accountId]
    );
    res.status(204).send();
  } catch (error: any) {
    console.error('Error deleting folder:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Refresh chats from selected folders (no change to folder selection)
app.post('/api/bd-accounts/:id/sync-folders-refresh', async (req, res) => {
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
    await refreshChatsFromFolders(pool, telegramManager, id);
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error refreshing chats from folders:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Push folders from CRM to Telegram (reverse sync: update Telegram dialog filters)
app.post('/api/bd-accounts/:id/sync-folders-push-to-telegram', async (req, res) => {
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
      return res.status(403).json({ error: 'Only the account owner can push folders to Telegram' });
    }
    const result = await telegramManager.pushFoldersToTelegram(id);
    res.json({ success: true, updated: result.updated, errors: result.errors });
  } catch (error: any) {
    console.error('Error pushing folders to Telegram:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

/**
 * Загрузить папки из Telegram и сохранить в bd_account_sync_folders.
 * Используется при первичной загрузке (пустой список) и по кнопке «Обновить папки».
 * Всегда добавляет папку 0 «Все чаты», затем кастомные фильтры из getDialogFilters (2, 3, …).
 */
async function fetchFoldersFromTelegramAndSave(
  pool: Pool,
  telegramManager: TelegramManager,
  accountId: string
): Promise<{ id: string; folder_id: number; folder_title: string; order_index: number; is_user_created: boolean; icon: string | null }[]> {
  const filters = await telegramManager.getDialogFilters(accountId);
  const toSave: { folder_id: number; folder_title: string; icon: string | null }[] = [
    { folder_id: 0, folder_title: 'Все чаты', icon: '💬' },
    ...filters.map((f) => ({ folder_id: f.id, folder_title: f.title, icon: f.emoticon ?? null })),
  ];
  // Убираем дубликаты по folder_id (оставляем первое вхождение)
  const seen = new Set<number>();
  const unique = toSave.filter((f) => {
    if (seen.has(f.folder_id)) return false;
    seen.add(f.folder_id);
    return true;
  });

  await pool.query('DELETE FROM bd_account_sync_folders WHERE bd_account_id = $1', [accountId]);
  for (let i = 0; i < unique.length; i++) {
    const f = unique[i];
    await pool.query(
      `INSERT INTO bd_account_sync_folders (bd_account_id, folder_id, folder_title, order_index, is_user_created, icon)
       VALUES ($1, $2, $3, $4, false, $5)`,
      [accountId, f.folder_id, (f.folder_title || '').trim().slice(0, 255) || `Папка ${f.folder_id}`, i, f.icon]
    );
  }

  const result = await pool.query(
    'SELECT id, folder_id, folder_title, order_index, COALESCE(is_user_created, false) AS is_user_created, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index, folder_id',
    [accountId]
  );
  return result.rows;
}

/**
 * Ensure bd_account_sync_folders has a row for every distinct folder_id that appears in bd_account_sync_chats.
 * Used when chats were saved with folder_id (e.g. from POST sync-chats or partial selection) but folders table was empty.
 */
async function ensureFoldersFromSyncChats(
  pool: Pool,
  telegramManager: TelegramManager,
  accountId: string
): Promise<void> {
  const distinct = await pool.query(
    `SELECT DISTINCT folder_id FROM (
      SELECT folder_id FROM bd_account_sync_chat_folders WHERE bd_account_id = $1
      UNION
      SELECT folder_id FROM bd_account_sync_chats WHERE bd_account_id = $1 AND folder_id IS NOT NULL
    ) u ORDER BY folder_id`,
    [accountId]
  );
  if (distinct.rows.length === 0) return;

  const existing = await pool.query(
    'SELECT folder_id FROM bd_account_sync_folders WHERE bd_account_id = $1',
    [accountId]
  );
  const existingIds = new Set(existing.rows.map((r: any) => Number(r.folder_id)));

  let filtersByFolder: Map<number, { title: string; emoticon?: string }> = new Map();
  try {
    if (telegramManager.isConnected(accountId)) {
      const filters = await telegramManager.getDialogFilters(accountId);
      for (const f of filters) filtersByFolder.set(f.id, { title: f.title, emoticon: f.emoticon });
    }
  } catch (_) {}

  const defaultTitles: Record<number, string> = { 0: 'Все чаты', 1: 'Архив' };
  const defaultIcons: Record<number, string> = { 0: '💬', 1: '📁' };

  let orderIndex = (await pool.query('SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM bd_account_sync_folders WHERE bd_account_id = $1', [accountId])).rows[0]?.next ?? 0;

  for (const row of distinct.rows) {
    const folderId = Number(row.folder_id);
    if (existingIds.has(folderId)) continue;

    const fromTg = filtersByFolder.get(folderId);
    const title = (fromTg?.title ?? defaultTitles[folderId] ?? `Папка ${folderId}`).trim().slice(0, 255) || `Папка ${folderId}`;
    const icon = fromTg?.emoticon ?? defaultIcons[folderId] ?? null;

    await pool.query(
      `INSERT INTO bd_account_sync_folders (bd_account_id, folder_id, folder_title, order_index, is_user_created, icon)
       VALUES ($1, $2, $3, $4, false, $5)
       ON CONFLICT (bd_account_id, folder_id) DO NOTHING`,
      [accountId, folderId, title, orderIndex, icon ?? null]
    );
    orderIndex++;
    existingIds.add(folderId);
  }
}

async function refreshChatsFromFolders(
  pool: Pool,
  telegramManager: TelegramManager,
  accountId: string
): Promise<void> {
  const foldersRows = await pool.query(
    'SELECT folder_id, folder_title FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index',
    [accountId]
  );
  if (foldersRows.rows.length === 0) return;

  let allDialogs0: any[] = [];
  let allDialogs1: any[] = [];
  const hasFolder0 = foldersRows.rows.some((r: any) => Number(r.folder_id) === 0);
  const hasFolder1 = foldersRows.rows.some((r: any) => Number(r.folder_id) === 1);
  if (hasFolder0 || foldersRows.rows.some((r: any) => Number(r.folder_id) >= 2)) {
    try {
      allDialogs0 = await telegramManager.getDialogsAll(accountId, 0, { maxDialogs: 3000, delayEveryN: 100, delayMs: 600 });
    } catch (err: any) {
      console.warn(`[BD Accounts] refreshChatsFromFolders getDialogsAll(0) failed:`, err?.message);
    }
  }
  if (hasFolder1) {
    try {
      allDialogs1 = await telegramManager.getDialogsAll(accountId, 1, { maxDialogs: 2000, delayEveryN: 100, delayMs: 600 });
    } catch (err: any) {
      console.warn(`[BD Accounts] refreshChatsFromFolders getDialogsAll(1) failed:`, err?.message);
    }
  }
  const mergedById = new Map<string, any>();
  for (const d of [...allDialogs0, ...allDialogs1]) {
    if (!mergedById.has(String(d.id))) mergedById.set(String(d.id), d);
  }
  const merged = Array.from(mergedById.values());

  for (const row of foldersRows.rows) {
    const folderId = Number(row.folder_id);
    let dialogs: any[] = [];
    try {
      if (folderId === 0) dialogs = allDialogs0;
      else if (folderId === 1) dialogs = allDialogs1;
      else {
        const filterRaw = await telegramManager.getDialogFilterRaw(accountId, folderId);
        const { include: includePeerIds, exclude: excludePeerIds } = TelegramManager.getFilterIncludeExcludePeerIds(filterRaw);
        dialogs = merged.filter((d: any) => TelegramManager.dialogMatchesFilter(d, filterRaw, includePeerIds, excludePeerIds));
      }
      for (const d of dialogs) {
        const chatId = String(d.id ?? '').trim();
        if (!chatId) continue;
        let peerType = 'user';
        if (d.isChannel) peerType = 'channel';
        else if (d.isGroup) peerType = 'chat';
        const title = (d.name ?? '').trim() || chatId;
        await pool.query(
          `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id)
           VALUES ($1, $2, $3, $4, false, $5)
           ON CONFLICT (bd_account_id, telegram_chat_id) DO UPDATE SET
             title = EXCLUDED.title,
             peer_type = EXCLUDED.peer_type,
             folder_id = COALESCE(bd_account_sync_chats.folder_id, EXCLUDED.folder_id)`,
          [accountId, chatId, title, peerType, folderId]
        );
        await pool.query(
          `INSERT INTO bd_account_sync_chat_folders (bd_account_id, telegram_chat_id, folder_id)
           VALUES ($1, $2, $3) ON CONFLICT (bd_account_id, telegram_chat_id, folder_id) DO NOTHING`,
          [accountId, chatId, folderId]
        );
      }
    } catch (err: any) {
      console.warn(`[BD Accounts] refreshChatsFromFolders folder ${folderId} failed:`, err?.message);
    }
  }

  // Sync pinned chats from Telegram to account owner's user_chat_pins (order from folder 0: pinned first)
  const pinnedChatIds = allDialogs0.filter((d: any) => d.pinned === true).map((d: any) => String(d.id));
  if (pinnedChatIds.length > 0) {
    try {
      const acc = await pool.query(
        'SELECT created_by_user_id, organization_id FROM bd_accounts WHERE id = $1 LIMIT 1',
        [accountId]
      );
      if (acc.rows.length > 0) {
        const ownerId = acc.rows[0].created_by_user_id;
        const orgId = acc.rows[0].organization_id;
        if (ownerId) {
          await pool.query(
            `DELETE FROM user_chat_pins WHERE user_id = $1 AND organization_id = $2 AND bd_account_id = $3`,
            [ownerId, orgId, accountId]
          );
          for (let i = 0; i < pinnedChatIds.length; i++) {
            await pool.query(
              `INSERT INTO user_chat_pins (user_id, organization_id, bd_account_id, channel_id, order_index)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (user_id, organization_id, bd_account_id, channel_id) DO UPDATE SET order_index = EXCLUDED.order_index`,
              [ownerId, orgId, accountId, pinnedChatIds[i], i]
            );
          }
          console.log(`[BD Accounts] Synced ${pinnedChatIds.length} pinned chats from Telegram for account ${accountId}`);
        }
      }
    } catch (err: any) {
      console.warn(`[BD Accounts] Sync pinned chats from Telegram failed:`, err?.message);
    }
  }

  console.log(`[BD Accounts] Refreshed chats from ${foldersRows.rows.length} folders for account ${accountId}`);
}

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

    const chatsRows = await pool.query(
      'SELECT id, telegram_chat_id, title, peer_type, is_folder, folder_id, created_at FROM bd_account_sync_chats WHERE bd_account_id = $1 ORDER BY folder_id NULLS LAST, created_at',
      [id]
    );
    const junctionRows = await pool.query(
      'SELECT telegram_chat_id, folder_id FROM bd_account_sync_chat_folders WHERE bd_account_id = $1',
      [id]
    );
    const folderIdsByChat = new Map<string, number[]>();
    for (const r of junctionRows.rows) {
      const tid = String(r.telegram_chat_id);
      if (!folderIdsByChat.has(tid)) folderIdsByChat.set(tid, []);
      folderIdsByChat.get(tid)!.push(Number(r.folder_id));
    }
    const rows = chatsRows.rows.map((r: any) => {
      const tid = String(r.telegram_chat_id);
      const folder_ids = folderIdsByChat.get(tid) ?? (r.folder_id != null ? [Number(r.folder_id)] : []);
      return { ...r, folder_ids };
    });
    res.json(rows);
  } catch (error: any) {
    console.error('Error fetching sync chats:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Догрузить одну страницу более старых сообщений из Telegram для чата (при скролле вверх в Messaging)
app.post('/api/bd-accounts/:id/chats/:chatId/load-older-history', async (req, res) => {
  try {
    const user = getUser(req);
    const { id: accountId, chatId } = req.params;

    const accountResult = await pool.query(
      'SELECT id, organization_id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [accountId, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }

    const { added, exhausted } = await telegramManager.fetchOlderMessagesFromTelegram(
      accountId,
      accountResult.rows[0].organization_id,
      chatId
    );
    res.json({ added, exhausted });
  } catch (error: any) {
    console.error('Error loading older history:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Назначить чат папкам (мультивыбор — чат может быть в нескольких папках). body: { folder_ids: number[] }
app.patch('/api/bd-accounts/:id/chats/:chatId/folder', async (req, res) => {
  try {
    const user = getUser(req);
    const { id: accountId, chatId } = req.params;
    const { folder_ids: folderIdsRaw, folder_id: legacyFolderId } = req.body;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [accountId, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }

    let folderIds: number[] = [];
    if (Array.isArray(folderIdsRaw)) {
      folderIds = folderIdsRaw.map((x: any) => Number(x)).filter((n: number) => !Number.isNaN(n));
    } else if (legacyFolderId !== undefined && legacyFolderId !== null && legacyFolderId !== '') {
      folderIds = [Number(legacyFolderId)];
    }

    const chatExists = await pool.query(
      'SELECT id FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2',
      [accountId, chatId]
    );
    if (chatExists.rows.length === 0) {
      return res.status(404).json({ error: 'Chat not found in sync list' });
    }

    await pool.query('DELETE FROM bd_account_sync_chat_folders WHERE bd_account_id = $1 AND telegram_chat_id = $2', [accountId, chatId]);
    for (const fid of folderIds) {
      await pool.query(
        `INSERT INTO bd_account_sync_chat_folders (bd_account_id, telegram_chat_id, folder_id)
         VALUES ($1, $2, $3) ON CONFLICT (bd_account_id, telegram_chat_id, folder_id) DO NOTHING`,
        [accountId, chatId, fid]
      );
    }
    const primaryFolderId = folderIds[0] ?? null;
    await pool.query(
      'UPDATE bd_account_sync_chats SET folder_id = $1 WHERE bd_account_id = $2 AND telegram_chat_id = $3',
      [primaryFolderId, accountId, chatId]
    );
    res.json({ success: true, folder_ids: folderIds, folder_id: primaryFolderId });
  } catch (error: any) {
    console.error('Error updating chat folder:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Удалить чат из списка синхронизации (убрать из мессенджера) — только владелец аккаунта
app.delete('/api/bd-accounts/:id/chats/:chatId', async (req, res) => {
  try {
    const user = getUser(req);
    const { id: accountId, chatId } = req.params;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [accountId, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }
    const isOwner = await requireAccountOwner(accountId, user);
    const canDeleteChat = await canPermission(pool, user.role, 'bd_accounts', 'chat.delete');
    if (!isOwner && !canDeleteChat) {
      return res.status(403).json({ error: 'No permission to remove a chat from the list' });
    }

    await pool.query('DELETE FROM bd_account_sync_chat_folders WHERE bd_account_id = $1 AND telegram_chat_id = $2', [accountId, chatId]);
    const result = await pool.query(
      'DELETE FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 RETURNING id',
      [accountId, chatId]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Chat not found in sync list' });
    }
    res.status(200).json({ success: true });
  } catch (error: any) {
    console.error('Error removing chat from sync:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

// Save selected chats for sync (replace existing selection) — только владелец аккаунта. chats: [{ id, name, isUser, isGroup, isChannel, folderId? }]
app.post('/api/bd-accounts/:id/sync-chats', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { chats } = req.body; // [{ id, name, isUser, isGroup, isChannel, folderId? }]

    const accountResult = await pool.query(
      'SELECT id, telegram_id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
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

    const accountTelegramId = accountResult.rows[0].telegram_id != null ? String(accountResult.rows[0].telegram_id).trim() : null;

    await pool.query('DELETE FROM bd_account_sync_chats WHERE bd_account_id = $1', [id]);
    await pool.query('DELETE FROM bd_account_sync_chat_folders WHERE bd_account_id = $1', [id]);

    let inserted = 0;
    for (const c of chats) {
      const chatId = String(c.id ?? c.telegram_chat_id ?? '').trim();
      const title = (c.name ?? c.title ?? '').trim();
      const folderId = c.folderId !== undefined && c.folderId !== null ? Number(c.folderId) : null;
      const folderIds = Array.isArray(c.folderIds) ? c.folderIds.map((x: any) => Number(x)).filter((n: number) => !Number.isNaN(n)) : (folderId != null ? [folderId] : []);
      let peerType = 'user';
      if (c.isChannel) peerType = 'channel';
      else if (c.isGroup) peerType = 'chat';
      if (!chatId) {
        console.warn('[BD Accounts] Skipping chat with empty id:', c);
        continue;
      }
      if (peerType === 'user' && accountTelegramId && chatId === accountTelegramId) {
        console.log('[BD Accounts] Skipping Saved Messages (self-chat) for account', id);
        continue;
      }
      const primaryFolder = folderIds[0] ?? folderId ?? null;
      await pool.query(
        `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id)
         VALUES ($1, $2, $3, $4, false, $5)`,
        [id, chatId, title, peerType, primaryFolder]
      );
      for (const fid of folderIds) {
        await pool.query(
          `INSERT INTO bd_account_sync_chat_folders (bd_account_id, telegram_chat_id, folder_id)
           VALUES ($1, $2, $3) ON CONFLICT (bd_account_id, telegram_chat_id, folder_id) DO NOTHING`,
          [id, chatId, fid]
        );
      }
      inserted++;
    }
    console.log(`[BD Accounts] Saved ${inserted} sync chats for account ${id} (requested ${chats.length})`);

    await ensureFoldersFromSyncChats(pool, telegramManager, id);

    const chatsRows = await pool.query(
      'SELECT id, telegram_chat_id, title, peer_type, folder_id, created_at FROM bd_account_sync_chats WHERE bd_account_id = $1 ORDER BY folder_id NULLS LAST, created_at',
      [id]
    );
    const junctionRows = await pool.query('SELECT telegram_chat_id, folder_id FROM bd_account_sync_chat_folders WHERE bd_account_id = $1', [id]);
    const folderIdsByChat = new Map<string, number[]>();
    for (const r of junctionRows.rows) {
      const tid = String(r.telegram_chat_id);
      if (!folderIdsByChat.has(tid)) folderIdsByChat.set(tid, []);
      folderIdsByChat.get(tid)!.push(Number(r.folder_id));
    }
    const resultRows = chatsRows.rows.map((r: any) => ({
      ...r,
      folder_ids: folderIdsByChat.get(String(r.telegram_chat_id)) ?? (r.folder_id != null ? [Number(r.folder_id)] : []),
    }));
    res.json(resultRows);
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

// Disconnect account (temporarily disable) — владелец или право bd_accounts.settings
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
    const canSettings = await canPermission(pool, user.role, 'bd_accounts', 'settings');
    if (!isOwner && !canSettings) {
      return res.status(403).json({ error: 'No permission to disconnect account' });
    }

    await telegramManager.disconnectAccount(id);

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

// Enable account (reconnect after disconnect) — владелец или право bd_accounts.settings
app.post('/api/bd-accounts/:id/enable', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;

    const accountResult = await pool.query(
      `SELECT id, organization_id, created_by_user_id, phone_number, api_id, api_hash, session_string
       FROM bd_accounts WHERE id = $1 AND organization_id = $2`,
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }
    const isOwner = await requireAccountOwner(id, user);
    const canSettings = await canPermission(pool, user.role, 'bd_accounts', 'settings');
    if (!isOwner && !canSettings) {
      return res.status(403).json({ error: 'No permission to enable account' });
    }

    const row = accountResult.rows[0] as any;
    if (!row.session_string) {
      return res.status(400).json({ error: 'Account has no session; reconnect via QR or phone' });
    }

    await pool.query(
      'UPDATE bd_accounts SET is_active = true WHERE id = $1',
      [id]
    );

    await telegramManager.connectAccount(
      id,
      row.organization_id,
      row.created_by_user_id || user.id,
      row.phone_number || '',
      parseInt(row.api_id, 10),
      row.api_hash,
      row.session_string
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error('Error enabling account:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message || 'Failed to enable account'
    });
  }
});

// Delete account permanently — владелец или право bd_accounts.settings. Сообщения остаются, bd_account_id обнуляется.
app.delete('/api/bd-accounts/:id', async (req, res) => {
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
    const canSettings = await canPermission(pool, user.role, 'bd_accounts', 'settings');
    if (!isOwner && !canSettings) {
      return res.status(403).json({ error: 'No permission to delete account' });
    }

    await telegramManager.disconnectAccount(id);

    await pool.query('UPDATE messages SET bd_account_id = NULL WHERE bd_account_id = $1', [id]);
    await pool.query('DELETE FROM bd_account_sync_chat_folders WHERE bd_account_id = $1', [id]);
    await pool.query('DELETE FROM bd_account_sync_chats WHERE bd_account_id = $1', [id]);
    await pool.query('DELETE FROM bd_account_sync_folders WHERE bd_account_id = $1', [id]);
    await pool.query('DELETE FROM bd_accounts WHERE id = $1', [id]);

    res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting account:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message || 'Failed to delete account'
    });
  }
});

// Delete message in Telegram (internal endpoint for messaging service)
app.post('/api/bd-accounts/:id/delete-message', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { channelId, telegramMessageId } = req.body;

    if (!channelId || telegramMessageId == null) {
      return res.status(400).json({ error: 'Missing required fields: channelId, telegramMessageId' });
    }

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }

    if (!telegramManager.isConnected(id)) {
      return res.status(400).json({ error: 'BD account is not connected' });
    }

    await telegramManager.deleteMessageInTelegram(id, String(channelId), Number(telegramMessageId));
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting message in Telegram:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message || 'Failed to delete message',
    });
  }
});

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB (Telegram limit)

// Send message or file via Telegram (internal endpoint for messaging service)
app.post('/api/bd-accounts/:id/send', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { chatId, text, fileBase64, fileName, replyToMessageId } = req.body;

    if (!chatId) {
      return res.status(400).json({ error: 'Missing required field: chatId' });
    }
    if (!text && !fileBase64) {
      return res.status(400).json({ error: 'Missing required field: text or fileBase64' });
    }

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }
    if (!telegramManager.isConnected(id)) {
      return res.status(400).json({ error: 'BD account is not connected' });
    }

    let message: any;
    if (fileBase64 && typeof fileBase64 === 'string') {
      const buf = Buffer.from(fileBase64, 'base64');
      if (buf.length > MAX_FILE_SIZE_BYTES) {
        return res.status(413).json({ error: 'File too large', message: 'Maximum file size is 2 GB' });
      }
      message = await telegramManager.sendFile(id, chatId, buf, {
        caption: typeof text === 'string' ? text : '',
        filename: typeof fileName === 'string' ? fileName.trim() || 'file' : 'file',
        replyTo: replyToMessageId != null ? Number(replyToMessageId) : undefined,
      });
    } else {
      const replyTo = replyToMessageId != null && String(replyToMessageId).trim() ? Number(replyToMessageId) : undefined;
      message = await telegramManager.sendMessage(id, chatId, typeof text === 'string' ? text : '', { replyTo });
    }

    const serialized = serializeMessage(message);
    const payload: Record<string, unknown> = {
      success: true,
      messageId: String(message.id),
      date: message.date,
    };
    if (serialized.telegram_media) payload.telegram_media = serialized.telegram_media;
    if (serialized.telegram_entities) payload.telegram_entities = serialized.telegram_entities;
    res.json(payload);
  } catch (error: any) {
    console.error('Error sending message:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message || 'Failed to send message',
    });
  }
});

// Save draft in Telegram (messages.SaveDraft). Body: { channelId, text?, replyToMsgId? }. Empty text clears draft.
app.post('/api/bd-accounts/:id/draft', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { channelId, text, replyToMsgId } = req.body;

    if (!channelId) {
      return res.status(400).json({ error: 'Missing required field: channelId' });
    }

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }
    if (!telegramManager.isConnected(id)) {
      return res.status(400).json({ error: 'BD account is not connected' });
    }

    const syncCheck = await pool.query(
      'SELECT 1 FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2',
      [id, String(channelId)]
    );
    if (syncCheck.rows.length === 0) {
      return res.status(403).json({ error: 'Chat is not in sync list for this account' });
    }

    await telegramManager.saveDraft(id, String(channelId), typeof text === 'string' ? text : '', {
      replyToMsgId: replyToMsgId != null && String(replyToMsgId).trim() ? Number(replyToMsgId) : undefined,
    });
    res.json({ success: true });
  } catch (error: any) {
    console.error('Error saving draft:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message || 'Failed to save draft',
    });
  }
});

// Forward message to another chat (Telegram)
app.post('/api/bd-accounts/:id/forward', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { fromChatId, toChatId, telegramMessageId } = req.body;

    if (!fromChatId || !toChatId || telegramMessageId == null) {
      return res.status(400).json({ error: 'Missing required fields: fromChatId, toChatId, telegramMessageId' });
    }

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }
    if (!telegramManager.isConnected(id)) {
      return res.status(400).json({ error: 'BD account is not connected' });
    }

    const message = await telegramManager.forwardMessage(
      id,
      String(fromChatId),
      String(toChatId),
      Number(telegramMessageId)
    );

    res.json({
      success: true,
      messageId: String(message.id),
      date: message.date,
    });
  } catch (error: any) {
    console.error('Error forwarding message:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message || 'Failed to forward message',
    });
  }
});

// Установить реакции на сообщение в Telegram (полный список до 3, как требует API)
app.post('/api/bd-accounts/:id/messages/:telegramMessageId/reaction', async (req, res) => {
  try {
    const user = getUser(req);
    const { id: accountId, telegramMessageId } = req.params;
    const { chatId, reaction: reactionBody } = req.body;

    if (!chatId) {
      return res.status(400).json({ error: 'Missing required field: chatId' });
    }
    const reactionList = Array.isArray(reactionBody)
      ? reactionBody.map((e) => String(e)).filter(Boolean)
      : [];

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [accountId, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      return res.status(404).json({ error: 'BD account not found' });
    }
    if (!telegramManager.isConnected(accountId)) {
      return res.status(400).json({ error: 'BD account is not connected' });
    }

    await telegramManager.sendReaction(
      accountId,
      String(chatId),
      Number(telegramMessageId),
      reactionList
    );

    res.json({ success: true });
  } catch (error: any) {
    const isReactionInvalid =
      error?.errorMessage === 'REACTION_INVALID' ||
      error?.message?.includes('REACTION_INVALID');
    if (isReactionInvalid) {
      console.warn('Reaction not applied in Telegram (REACTION_INVALID), local state kept:', error?.message);
      return res.json({ success: true, skipped: 'REACTION_INVALID' });
    }
    console.error('Error sending reaction:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message || 'Failed to send reaction',
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

