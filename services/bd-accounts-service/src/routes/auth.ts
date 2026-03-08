import { Router } from 'express';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, Event } from '@getsale/events';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, canPermission } from '@getsale/service-core';
import { TelegramManager } from '../telegram-manager';
import { getTelegramApiCredentials, requireAccountOwner, requireBidiOwnAccount } from '../helpers';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  telegramManager: TelegramManager;
}

export function authRouter({ pool, rabbitmq, log, telegramManager }: Deps): Router {
  const router = Router();
  const checkPermission = canPermission(pool);

  // Poll QR login status — literal path, must be before any /:id
  router.get('/qr-login-status', asyncHandler(async (req, res) => {
    const { sessionId } = req.query;

    if (!sessionId || typeof sessionId !== 'string') {
      throw new AppError(400, 'sessionId query parameter required', ErrorCodes.VALIDATION);
    }

    const state = await telegramManager.getQrLoginStatus(sessionId);
    if (!state) {
      throw new AppError(404, 'Session not found or expired', ErrorCodes.NOT_FOUND);
    }

    res.json(state);
  }));

  // Start QR-code login
  router.post('/start-qr-login', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { apiId, apiHash } = getTelegramApiCredentials();

    const sessionId = (await telegramManager.startQrLogin(
      organizationId,
      userId,
      apiId,
      apiHash
    )).sessionId;

    res.json({ sessionId });
  }));

  // Submit 2FA password for QR login
  router.post('/qr-login-password', asyncHandler(async (req, res) => {
    const { sessionId, password } = req.body;

    if (!sessionId || typeof sessionId !== 'string') {
      throw new AppError(400, 'sessionId required', ErrorCodes.VALIDATION);
    }
    if (password == null || typeof password !== 'string') {
      throw new AppError(400, 'password required', ErrorCodes.VALIDATION);
    }

    const accepted = await telegramManager.submitQrLoginPassword(sessionId, password);
    if (!accepted) {
      throw new AppError(400, 'Session not waiting for password or expired', ErrorCodes.BAD_REQUEST);
    }

    res.json({ ok: true });
  }));

  // Send authentication code (Telegram)
  router.post('/send-code', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { platform, phoneNumber } = req.body;
    const { apiId, apiHash } = getTelegramApiCredentials();

    if (!platform || !phoneNumber) {
      throw new AppError(400, 'Missing required fields: platform, phoneNumber', ErrorCodes.VALIDATION);
    }

    if (platform !== 'telegram') {
      throw new AppError(400, 'Unsupported platform', ErrorCodes.BAD_REQUEST);
    }

    const otherOrgResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE phone_number = $1 AND organization_id != $2 AND is_active = true',
      [phoneNumber, organizationId]
    );
    if (otherOrgResult.rows.length > 0) {
      throw new AppError(409, 'Этот аккаунт уже подключён в другой организации. Один Telegram-аккаунт можно использовать только в одной организации.', ErrorCodes.CONFLICT);
    }

    let existingResult = await pool.query(
      'SELECT id, is_active FROM bd_accounts WHERE phone_number = $1 AND organization_id = $2',
      [phoneNumber, organizationId]
    );

    let accountId: string;

    if (existingResult.rows.length > 0) {
      const row = existingResult.rows[0];
      if (row.is_active) {
        throw new AppError(409, 'Этот аккаунт уже подключён в вашей организации. Выберите его в списке или отключите перед повторным подключением.', ErrorCodes.CONFLICT);
      }
      accountId = row.id;
      await pool.query(
        `UPDATE bd_accounts SET created_by_user_id = $1 WHERE id = $2 AND created_by_user_id IS NULL`,
        [userId, accountId]
      );
    } else {
      const insertResult = await pool.query(
        `INSERT INTO bd_accounts (organization_id, telegram_id, phone_number, api_id, api_hash, is_active, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [organizationId, phoneNumber, phoneNumber, String(apiId), apiHash, false, userId]
      );
      accountId = insertResult.rows[0].id;
    }

    const { phoneCodeHash } = await telegramManager.sendCode(
      accountId,
      organizationId,
      userId,
      phoneNumber,
      apiId,
      apiHash
    );

    res.json({ accountId, phoneCodeHash });
  }));

  // Verify code and complete authentication
  router.post('/verify-code', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { accountId, phoneNumber, phoneCode, phoneCodeHash, password } = req.body;

    if (!accountId || !phoneNumber || !phoneCode || !phoneCodeHash) {
      throw new AppError(400, 'Missing required fields: accountId, phoneNumber, phoneCode, phoneCodeHash', ErrorCodes.VALIDATION);
    }

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [accountId, organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    try {
      const { requiresPassword } = await telegramManager.signIn(
        accountId,
        phoneNumber,
        phoneCode,
        phoneCodeHash
      );

      if (requiresPassword) {
        if (!password) {
          return res.status(400).json({
            error: 'Password required',
            requiresPassword: true,
          });
        }
        await telegramManager.signInWithPassword(accountId, password);
      }
    } catch (error: any) {
      if (error.message?.includes('Неверный код подтверждения') ||
          error.message?.includes('PHONE_CODE_INVALID') ||
          error.errorMessage === 'PHONE_CODE_INVALID') {
        throw new AppError(400, 'Неверный код подтверждения', ErrorCodes.VALIDATION, {
          message: 'Пожалуйста, запросите новый код и попробуйте снова',
        });
      }
      if (error.message?.includes('Код подтверждения истек') ||
          error.message?.includes('PHONE_CODE_EXPIRED') ||
          error.errorMessage === 'PHONE_CODE_EXPIRED') {
        throw new AppError(400, 'Код подтверждения истек', ErrorCodes.VALIDATION, {
          message: 'Пожалуйста, запросите новый код',
        });
      }
      throw error;
    }

    await pool.query(
      'UPDATE bd_accounts SET created_by_user_id = $1 WHERE id = $2 AND created_by_user_id IS NULL',
      [userId, accountId]
    );

    const result = await pool.query(
      'SELECT * FROM bd_accounts WHERE id = $1',
      [accountId]
    );

    await rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.BD_ACCOUNT_CONNECTED,
      timestamp: new Date(),
      organizationId,
      userId,
      data: { bdAccountId: accountId, platform: 'telegram', userId },
    } as Event);

    res.json(result.rows[0]);
  }));

  // Connect BD account — legacy endpoint for existing sessions
  router.post('/connect', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { platform, phoneNumber, sessionString } = req.body;
    const { apiId, apiHash } = getTelegramApiCredentials();

    if (!platform || !phoneNumber) {
      throw new AppError(400, 'Missing required fields: platform, phoneNumber', ErrorCodes.VALIDATION);
    }

    if (platform !== 'telegram') {
      throw new AppError(400, 'Unsupported platform', ErrorCodes.BAD_REQUEST);
    }

    const existingResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE phone_number = $1 AND organization_id = $2',
      [phoneNumber, organizationId]
    );

    let accountId: string;
    let existingSessionString: string | undefined;

    if (existingResult.rows.length > 0) {
      accountId = existingResult.rows[0].id;
      const existingAccount = await pool.query(
        'SELECT session_string FROM bd_accounts WHERE id = $1',
        [accountId]
      );
      existingSessionString = existingAccount.rows[0]?.session_string;
    } else {
      const insertResult = await pool.query(
        `INSERT INTO bd_accounts (organization_id, telegram_id, phone_number, api_id, api_hash, is_active)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [organizationId, phoneNumber, phoneNumber, String(apiId), apiHash, true]
      );
      accountId = insertResult.rows[0].id;
    }

    await telegramManager.connectAccount(
      accountId,
      organizationId,
      userId,
      phoneNumber,
      apiId,
      apiHash,
      sessionString || existingSessionString
    );

    const result = await pool.query(
      'SELECT * FROM bd_accounts WHERE id = $1',
      [accountId]
    );

    await rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.BD_ACCOUNT_CONNECTED,
      timestamp: new Date(),
      organizationId,
      userId,
      data: { bdAccountId: accountId, platform: 'telegram', userId },
    } as Event);

    res.json(result.rows[0]);
  }));

  // POST /:id/disconnect — temporarily disable
  router.post('/:id/disconnect', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiOwnAccount(pool, id, user);
    const isOwner = await requireAccountOwner(pool, id, user);
    const canSettings = await checkPermission(user.role, 'bd_accounts', 'settings');
    if (!isOwner && !canSettings) {
      throw new AppError(403, 'No permission to disconnect account', ErrorCodes.FORBIDDEN);
    }

    await telegramManager.disconnectAccount(id);

    await pool.query(
      'UPDATE bd_accounts SET is_active = false WHERE id = $1',
      [id]
    );

    res.json({ success: true });
  }));

  return router;
}
