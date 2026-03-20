import { Router } from 'express';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, Event } from '@getsale/events';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, canPermission, validate } from '@getsale/service-core';
import { TelegramManager } from '../telegram';
import { getTelegramApiCredentials, getAccountOr404, requireAccountOwner, requireBidiOwnAccount } from '../helpers';
import { encryptSession, decryptIfNeeded } from '../crypto';
import {
  BdAuthSendCodeSchema,
  BdAuthVerifyCodeSchema,
  BdAuthQrLoginPasswordSchema,
  BdAuthConnectSchema,
  BdAuthStartQrLoginSchema,
} from '../validation';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  telegramManager: TelegramManager;
}

export function authRouter({ pool, rabbitmq, log, telegramManager }: Deps): Router {
  const router = Router();
  const checkPermission = canPermission(pool);
  const normalizeProxyConfig = (raw: unknown): Record<string, unknown> | null => {
    if (!raw || typeof raw !== 'object') return null;
    const inCfg = raw as { type?: string; host?: string; port?: number; username?: string; password?: string };
    const host = typeof inCfg.host === 'string' ? inCfg.host.trim() : '';
    const port = Number(inCfg.port);
    if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
    const type = inCfg.type === 'http' ? 'http' : 'socks5';
    if (type === 'http') {
      throw new AppError(
        400,
        'HTTP/HTTPS proxy is not supported by current Telegram client. Please use SOCKS5 proxy.',
        ErrorCodes.VALIDATION
      );
    }
    return {
      type,
      host,
      port,
      ...(typeof inCfg.username === 'string' && inCfg.username.trim() ? { username: inCfg.username.trim() } : {}),
      ...(typeof inCfg.password === 'string' && inCfg.password.trim() ? { password: inCfg.password.trim() } : {}),
    };
  };

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

  // Start QR-code login (no body)
  router.post('/start-qr-login', validate(BdAuthStartQrLoginSchema), asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { proxyConfig } = req.body as { proxyConfig?: unknown };
    const { apiId, apiHash } = getTelegramApiCredentials();
    const normalizedProxy = normalizeProxyConfig(proxyConfig);

    const sessionId = (await telegramManager.startQrLogin(
      organizationId,
      userId,
      apiId,
      apiHash,
      normalizedProxy as any
    )).sessionId;

    res.json({ sessionId });
  }));

  // Submit 2FA password for QR login
  router.post('/qr-login-password', validate(BdAuthQrLoginPasswordSchema), asyncHandler(async (req, res) => {
    const { sessionId, password } = req.body;

    const accepted = await telegramManager.submitQrLoginPassword(sessionId, password);
    if (!accepted) {
      throw new AppError(400, 'Session not waiting for password or expired', ErrorCodes.BAD_REQUEST);
    }

    res.json({ ok: true });
  }));

  // Send authentication code (Telegram)
  router.post('/send-code', validate(BdAuthSendCodeSchema), asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { platform, phoneNumber, proxyConfig } = req.body;
    const { apiId, apiHash } = getTelegramApiCredentials();
    const normalizedProxy = normalizeProxyConfig(proxyConfig);

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
        `UPDATE bd_accounts
         SET created_by_user_id = COALESCE(created_by_user_id, $1),
             proxy_config = CASE WHEN $3::jsonb IS NULL THEN proxy_config ELSE $3::jsonb END
         WHERE id = $2`,
        [userId, accountId, normalizedProxy ? JSON.stringify(normalizedProxy) : null]
      );
    } else {
      const insertResult = await pool.query(
        `INSERT INTO bd_accounts (organization_id, telegram_id, phone_number, api_id, api_hash, is_active, session_encrypted, created_by_user_id, proxy_config)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7, $8) RETURNING id`,
        [organizationId, phoneNumber, phoneNumber, String(apiId), encryptSession(apiHash), false, userId, normalizedProxy ? JSON.stringify(normalizedProxy) : null]
      );
      accountId = insertResult.rows[0].id;
    }

    const { phoneCodeHash } = await telegramManager.sendCode(
      accountId,
      organizationId,
      userId,
      phoneNumber,
      apiId,
      apiHash,
      normalizedProxy as any
    );

    res.json({ accountId, phoneCodeHash });
  }));

  // Verify code and complete authentication
  router.post('/verify-code', validate(BdAuthVerifyCodeSchema), asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { accountId, phoneNumber, phoneCode, phoneCodeHash, password } = req.body;

    await getAccountOr404(pool, accountId, organizationId, 'id');

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
      correlationId: req.correlationId,
      data: { bdAccountId: accountId, platform: 'telegram', userId },
    } as Event);

    res.json(result.rows[0]);
  }));

  // Connect BD account — legacy endpoint for existing sessions
  router.post('/connect', validate(BdAuthConnectSchema), asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { platform, phoneNumber, sessionString, proxyConfig } = req.body;
    const { apiId, apiHash } = getTelegramApiCredentials();
    const normalizedProxy = normalizeProxyConfig(proxyConfig);

    const existingResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE phone_number = $1 AND organization_id = $2',
      [phoneNumber, organizationId]
    );

    let accountId: string;
    let existingSessionString: string | undefined;

    if (existingResult.rows.length > 0) {
      accountId = existingResult.rows[0].id;
      const existingAccount = await pool.query(
        'SELECT session_string, session_encrypted FROM bd_accounts WHERE id = $1',
        [accountId]
      );
      const existingRow = existingAccount.rows[0];
      existingSessionString = existingRow
        ? decryptIfNeeded(existingRow.session_string, existingRow.session_encrypted) ?? undefined
        : undefined;
      if (normalizedProxy) {
        await pool.query('UPDATE bd_accounts SET proxy_config = $1 WHERE id = $2', [JSON.stringify(normalizedProxy), accountId]);
      }
    } else {
      const insertResult = await pool.query(
        `INSERT INTO bd_accounts (organization_id, telegram_id, phone_number, api_id, api_hash, is_active, session_encrypted, proxy_config)
         VALUES ($1, $2, $3, $4, $5, $6, true, $7) RETURNING id`,
        [organizationId, phoneNumber, phoneNumber, String(apiId), encryptSession(apiHash), true, normalizedProxy ? JSON.stringify(normalizedProxy) : null]
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
      correlationId: req.correlationId,
      data: { bdAccountId: accountId, platform: 'telegram', userId },
    } as Event);

    res.json(result.rows[0]);
  }));

  // POST /:id/disconnect — temporarily disable
  router.post('/:id/disconnect', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;

    await getAccountOr404(pool, id, user.organizationId, 'id');
    await requireBidiOwnAccount(pool, id, user);
    const isOwner = await requireAccountOwner(pool, id, user);
    const canSettings = await checkPermission(user.role, 'bd_accounts', 'settings');
    if (!isOwner && !canSettings) {
      throw new AppError(403, 'No permission to disconnect account', ErrorCodes.FORBIDDEN);
    }

    // Mark inactive before disconnect so reconnect logic (TIMEOUT → scheduleReconnectAll) does not re-add this account
    await pool.query(
      "UPDATE bd_accounts SET is_active = false, connection_state = 'disconnected', disconnect_reason = 'Disconnected by user', updated_at = NOW() WHERE id = $1 AND organization_id = $2",
      [id, user.organizationId]
    );
    await telegramManager.disconnectAccount(id);

    res.json({ success: true });
  }));

  return router;
}
