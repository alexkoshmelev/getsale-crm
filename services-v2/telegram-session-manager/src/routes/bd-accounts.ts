import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, ErrorCodes, requireUser, DatabasePools } from '@getsale/service-framework';
import { RedisClient } from '@getsale/cache';
import { RabbitMQClient } from '@getsale/queue';
import { Logger } from '@getsale/logger';
import { randomUUID } from 'crypto';
import { EventType, type Event } from '@getsale/events';
import { encryptSession, decryptIfNeeded } from '@getsale/telegram';
import { SessionCoordinator } from '../coordinator';
import { PhoneLoginHandler } from '../phone-login-handler';
import { CommandType } from '../command-types';

interface Deps {
  db: DatabasePools;
  rabbitmq: RabbitMQClient;
  log: Logger;
  redis: RedisClient;
  coordinator: SessionCoordinator;
  phoneLoginHandler: PhoneLoginHandler;
}

const BD_ACCOUNT_LIST_SELECT = `
  a.id, a.organization_id, a.telegram_id, a.phone_number, a.is_active, a.is_demo,
  a.connected_at, a.last_activity, a.created_at, a.sync_status,
  a.sync_progress_done, a.sync_progress_total, a.sync_error,
  a.created_by_user_id AS owner_id,
  a.first_name, a.last_name, a.username, a.bio, a.photo_file_id, a.display_name,
  a.proxy_config, a.connection_state, a.disconnect_reason,
  a.last_error_code, a.last_error_at,
  a.flood_wait_until, a.flood_wait_seconds, a.flood_reason, a.flood_last_at,
  a.spam_restricted_at, a.spam_restriction_source,
  a.peer_flood_count_1h, a.peer_flood_first_at,
  a.last_spambot_check_at, a.last_spambot_result, a.send_blocked_until,
  a.timezone, a.working_hours_start, a.working_hours_end, a.working_days,
  a.auto_responder_enabled, a.auto_responder_system_prompt, a.auto_responder_history_count`;

const BD_ACCOUNT_DETAIL_SELECT = `
  id, organization_id, telegram_id, phone_number, is_active, is_demo,
  connected_at, last_activity, created_at, sync_status,
  sync_progress_done, sync_progress_total, sync_error,
  created_by_user_id AS owner_id,
  first_name, last_name, username, bio, photo_file_id, display_name,
  proxy_config, connection_state, disconnect_reason,
  last_error_code, last_error_at,
  flood_wait_until, flood_wait_seconds, flood_reason, flood_last_at,
  spam_restricted_at, spam_restriction_source,
  peer_flood_count_1h, peer_flood_first_at,
  last_spambot_check_at, last_spambot_result, send_blocked_until,
  timezone, working_hours_start, working_hours_end, working_days,
  auto_responder_enabled, auto_responder_system_prompt, auto_responder_history_count,
  session_string IS NOT NULL AS has_session`;

// ── Zod Schemas ──

const SendCodeBody = z.object({
  platform: z.string().optional(),
  phoneNumber: z.string().min(5).optional(),
  phone: z.string().min(5).optional(),
  proxyConfig: z.any().optional(),
  apiId: z.union([z.string(), z.number()]).optional(),
  apiHash: z.string().optional(),
}).transform(data => ({
  ...data,
  phoneNumber: data.phoneNumber || data.phone,
})).refine(data => !!data.phoneNumber, { message: 'phoneNumber or phone is required' });

const VerifyCodeBody = z.object({
  accountId: z.string().optional(),
  phoneNumber: z.string().optional(),
  phone: z.string().optional(),
  phoneCode: z.string().min(4).optional(),
  code: z.string().min(4).optional(),
  phoneCodeHash: z.string().optional(),
  password: z.string().optional(),
}).transform(data => ({
  ...data,
  phoneNumber: data.phoneNumber || data.phone,
  phoneCode: data.phoneCode || data.code,
})).refine(data => !!data.phoneNumber, { message: 'phoneNumber or phone is required' })
  .refine(data => !!data.phoneCode, { message: 'phoneCode or code is required' });

const ConnectBody = z.object({
  platform: z.literal('telegram').optional(),
  phoneNumber: z.string().min(1).max(32).trim(),
  sessionString: z.string().max(10000).optional(),
  proxyConfig: z
    .union([
      z.null(),
      z.object({
        type: z.enum(['socks5']).default('socks5'),
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535),
        username: z.string().optional(),
        password: z.string().optional(),
      }),
    ])
    .optional()
    .nullable(),
});

const PurchaseBody = z.object({
  platform: z.string().default('telegram'),
  durationDays: z.number().int().min(1).max(365).default(30),
});

const ConfigBody = z.object({
  limits: z.record(z.unknown()).optional(),
  metadata: z.record(z.unknown()).optional(),
});

function assertNotViewer(user: { role: string }): void {
  if (user.role === 'viewer') {
    throw new AppError(403, 'Viewers cannot perform this action', ErrorCodes.FORBIDDEN);
  }
}

export function registerBdAccountRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, phoneLoginHandler, log, rabbitmq } = deps;

  // ── GET /api/bd-accounts — list with enrichment (unread counts, extended details) ──

  app.get('/api/bd-accounts', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;

    if (user.role === 'viewer') return [];

    let accountFilter = 'WHERE a.organization_id = $1';
    const params: unknown[] = [user.organizationId];
    if (user.role === 'agent') {
      accountFilter += ' AND a.created_by_user_id = $2';
      params.push(user.id);
    }

    const result = await db.read.query(
      `SELECT ${BD_ACCOUNT_LIST_SELECT}
       FROM bd_accounts a
       ${accountFilter}
       ORDER BY a.created_at DESC`,
      params,
    );

    const unreadQuery = user.role === 'agent'
      ? `SELECT s.bd_account_id, COALESCE(SUM(sub.cnt), 0)::int AS unread_count
         FROM bd_account_sync_chats s
         JOIN bd_accounts a ON a.id = s.bd_account_id AND a.organization_id = $1 AND a.created_by_user_id = $2
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS cnt
           FROM messages m
           WHERE m.organization_id = a.organization_id AND m.channel = 'telegram' AND m.unread = true
             AND m.bd_account_id = s.bd_account_id AND m.channel_id = s.telegram_chat_id
         ) sub ON true
         WHERE s.peer_type IN ('user', 'chat')
         GROUP BY s.bd_account_id`
      : `SELECT s.bd_account_id, COALESCE(SUM(sub.cnt), 0)::int AS unread_count
         FROM bd_account_sync_chats s
         JOIN bd_accounts a ON a.id = s.bd_account_id AND a.organization_id = $1
         LEFT JOIN LATERAL (
           SELECT COUNT(*)::int AS cnt
           FROM messages m
           WHERE m.organization_id = a.organization_id AND m.channel = 'telegram' AND m.unread = true
             AND m.bd_account_id = s.bd_account_id AND m.channel_id = s.telegram_chat_id
         ) sub ON true
         WHERE s.peer_type IN ('user', 'chat')
         GROUP BY s.bd_account_id`;
    const unreadResult = await db.read.query(
      unreadQuery,
      user.role === 'agent' ? [user.organizationId, user.id] : [user.organizationId],
    ).catch(() => ({ rows: [] as { bd_account_id: string; unread_count: number }[] }));

    const unreadByAccount: Record<string, number> = {};
    for (const row of unreadResult.rows as { bd_account_id: string; unread_count: number }[]) {
      unreadByAccount[row.bd_account_id] = Number(row.unread_count) || 0;
    }

    return result.rows.map((r: any) => {
      const pc = r.proxy_config;
      const hasProxy = pc != null && typeof pc === 'object' && Object.keys(pc).length > 0 && pc.host;
      return {
        ...r,
        is_owner: r.owner_id != null && r.owner_id === user.id,
        unread_count: unreadByAccount[r.id] ?? 0,
        proxy_status: hasProxy ? 'configured' : null,
      };
    });
  });

  // ── GET /api/bd-accounts/:id — single account detail ──

  app.get('/api/bd-accounts/:id', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;

    const result = await db.read.query(
      `SELECT ${BD_ACCOUNT_DETAIL_SELECT} FROM bd_accounts WHERE id = $1 AND organization_id = $2`,
      [id, user.organizationId],
    );
    if (!result.rows.length) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    const row = result.rows[0] as Record<string, unknown>;
    const pc = row.proxy_config;
    const hasProxy = pc != null && typeof pc === 'object' && Object.keys(pc as object).length > 0 && (pc as any).host;
    return {
      ...row,
      is_owner: row.owner_id != null && row.owner_id === user.id,
      proxy_status: hasProxy ? 'configured' : null,
    };
  });

  // ── POST /api/bd-accounts/purchase — allocate new BD account slot ──

  app.post('/api/bd-accounts/purchase', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    assertNotViewer(user);
    const { platform, durationDays } = PurchaseBody.parse(request.body);
    const expiresAt = new Date(Date.now() + durationDays * 24 * 60 * 60 * 1000);

    const result = await db.write.query(
      `INSERT INTO bd_accounts (organization_id, created_by_user_id, platform, account_type, status, purchased_at, expires_at)
       VALUES ($1, $2, $3, 'rented', 'pending', NOW(), $4) RETURNING *`,
      [user.organizationId, user.id, platform, expiresAt],
    );
    return result.rows[0];
  });

  // ── Phone login: send-code ──

  app.post('/api/bd-accounts/send-code', { preHandler: [requireUser] }, async (request, reply) => {
    const body = SendCodeBody.parse(request.body);
    const user = request.user!;
    assertNotViewer(user);

    const otherOrgResult = await db.read.query(
      'SELECT id FROM bd_accounts WHERE phone_number = $1 AND organization_id != $2 AND is_active = true',
      [body.phoneNumber, user.organizationId],
    );
    if (otherOrgResult.rows.length > 0) {
      throw new AppError(
        409,
        'Этот аккаунт уже подключён в другой организации. Один Telegram-аккаунт можно использовать только в одной организации.',
        ErrorCodes.CONFLICT,
      );
    }

    const sameOrgResult = await db.read.query(
      'SELECT id, is_active FROM bd_accounts WHERE phone_number = $1 AND organization_id = $2',
      [body.phoneNumber, user.organizationId],
    );
    if (sameOrgResult.rows.length > 0 && sameOrgResult.rows[0].is_active) {
      throw new AppError(
        409,
        'Этот аккаунт уже подключён в вашей организации. Выберите его в списке или отключите перед повторным подключением.',
        ErrorCodes.CONFLICT,
      );
    }

    try {
      const result = await phoneLoginHandler.sendCode({
        phoneNumber: body.phoneNumber!,
        organizationId: user.organizationId,
        userId: user.id,
        proxyConfig: body.proxyConfig ?? null,
        apiId: body.apiId ? Number(body.apiId) : undefined,
        apiHash: body.apiHash ?? undefined,
      });

      reply.code(200).send({
        status: 'code_sent',
        phoneCodeHash: result.phoneCodeHash,
        accountId: result.accountId,
      });
    } catch (error: any) {
      if (error.errorMessage === 'FLOOD_WAIT' || error.message?.includes('FLOOD_WAIT')) {
        const seconds = error.seconds || 0;
        throw new AppError(429, `Слишком много попыток. Подождите ${seconds} секунд.`, ErrorCodes.RATE_LIMITED);
      }
      if (error.errorMessage === 'PHONE_NUMBER_INVALID' || error.message?.includes('PHONE_NUMBER_INVALID')) {
        throw new AppError(400, 'Неверный номер телефона.', ErrorCodes.VALIDATION);
      }
      throw error;
    }
  });

  // ── Phone login: verify-code ──

  app.post('/api/bd-accounts/verify-code', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    assertNotViewer(user);
    const body = VerifyCodeBody.parse(request.body);

    if (!body.accountId) {
      throw new AppError(400, 'accountId is required', ErrorCodes.VALIDATION);
    }
    if (!body.phoneCodeHash) {
      throw new AppError(400, 'phoneCodeHash is required', ErrorCodes.VALIDATION);
    }

    try {
      const result = await phoneLoginHandler.verifyCode({
        accountId: body.accountId,
        phoneNumber: body.phoneNumber!,
        phoneCode: body.phoneCode!,
        phoneCodeHash: body.phoneCodeHash,
        password: body.password,
      });

      reply.code(200).send({
        status: result.success ? 'authenticated' : 'password_required',
        success: result.success,
        requiresPassword: result.requiresPassword,
        accountId: result.accountId,
      });
    } catch (error: any) {
      const msg = error.message || '';
      const errMsg = error.errorMessage || '';

      if (msg.includes('PHONE_CODE_INVALID') || errMsg === 'PHONE_CODE_INVALID' ||
          msg.includes('Invalid verification code') || msg.includes('Неверный код подтверждения')) {
        throw new AppError(400, 'Неверный код подтверждения', ErrorCodes.VALIDATION, {
          message: 'Пожалуйста, запросите новый код и попробуйте снова',
        });
      }
      if (msg.includes('PHONE_CODE_EXPIRED') || errMsg === 'PHONE_CODE_EXPIRED' ||
          msg.includes('Verification code expired') || msg.includes('Код подтверждения истек')) {
        throw new AppError(400, 'Код подтверждения истек', ErrorCodes.VALIDATION, {
          message: 'Пожалуйста, запросите новый код',
        });
      }
      if (msg.includes('FLOOD_WAIT') || errMsg.includes('FLOOD_WAIT')) {
        const seconds = error.seconds || 0;
        throw new AppError(429, `Слишком много попыток. Подождите ${seconds} секунд.`, ErrorCodes.RATE_LIMITED);
      }
      if (msg.includes('SESSION_EXPIRED') || errMsg === 'SESSION_EXPIRED') {
        throw new AppError(400, 'Сессия истекла. Запросите новый код.', ErrorCodes.BAD_REQUEST);
      }
      throw error;
    }
  });

  // ── POST /api/bd-accounts/connect — legacy endpoint for existing sessions ──

  app.post('/api/bd-accounts/connect', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    assertNotViewer(user);
    const body = ConnectBody.parse(request.body);
    const phoneNumber = body.phoneNumber;

    const existing = await db.read.query(
      'SELECT id, session_string, session_encrypted FROM bd_accounts WHERE phone_number = $1 AND organization_id = $2',
      [phoneNumber, user.organizationId],
    );

    let accountId: string;
    let existingSessionString: string | undefined;

    if (existing.rows.length > 0) {
      accountId = existing.rows[0].id;
      const row = existing.rows[0] as { session_string?: string; session_encrypted?: boolean };
      existingSessionString = row.session_string
        ? decryptIfNeeded(row.session_string, !!row.session_encrypted) ?? undefined
        : undefined;
      if (body.proxyConfig) {
        await db.write.query(
          'UPDATE bd_accounts SET proxy_config = $1 WHERE id = $2',
          [JSON.stringify(body.proxyConfig), accountId],
        );
      }
    } else {
      const apiId = String(phoneLoginHandler['apiId'] || 0);
      const apiHash = encryptSession(phoneLoginHandler['apiHash'] || '');
      const insertResult = await db.write.query(
        `INSERT INTO bd_accounts (organization_id, telegram_id, phone_number, api_id, api_hash,
         is_active, session_encrypted, created_by_user_id, proxy_config, connection_state)
         VALUES ($1, $2, $3, $4, $5, true, true, $6, $7, 'connecting') RETURNING id`,
        [
          user.organizationId, phoneNumber, phoneNumber, apiId, apiHash,
          user.id, body.proxyConfig ? JSON.stringify(body.proxyConfig) : null,
        ],
      );
      accountId = insertResult.rows[0].id;
    }

    const sessionToUse = body.sessionString || existingSessionString;
    if (sessionToUse) {
      await db.write.query(
        `UPDATE bd_accounts SET session_string = $1, session_encrypted = true,
         is_active = true, connection_state = 'reconnecting', updated_at = NOW()
         WHERE id = $2`,
        [encryptSession(sessionToUse), accountId],
      );
    } else {
      await db.write.query(
        "UPDATE bd_accounts SET is_active = true, connection_state = 'reconnecting', updated_at = NOW() WHERE id = $1",
        [accountId],
      );
    }

    await rabbitmq.publishCommand(`telegram:commands:${accountId}`, {
      type: CommandType.RECONNECT,
      payload: { accountId, organizationId: user.organizationId },
    });

    await rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.BD_ACCOUNT_CONNECTED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { bdAccountId: accountId, platform: 'telegram', userId: user.id },
    } as Event);

    const result = await db.read.query(
      `SELECT ${BD_ACCOUNT_DETAIL_SELECT} FROM bd_accounts WHERE id = $1`,
      [accountId],
    );
    return result.rows[0];
  });

  // ── POST /api/bd-accounts/:id/disconnect ──

  app.post('/api/bd-accounts/:id/disconnect', { preHandler: [requireUser] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    assertNotViewer(user);

    const account = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!account.rows.length) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    await db.write.query(
      `UPDATE bd_accounts SET is_active = false, connection_state = 'disconnected',
       disconnect_reason = 'Disconnected by user', updated_at = NOW()
       WHERE id = $1 AND organization_id = $2`,
      [id, user.organizationId],
    );

    await rabbitmq.publishCommand(`telegram:commands:${id}`, {
      type: CommandType.DISCONNECT,
      payload: { accountId: id, organizationId: user.organizationId },
    });

    reply.code(200).send({ success: true });
  });

  // ── PUT /api/bd-accounts/:id/config — update account limits and metadata ──

  app.put('/api/bd-accounts/:id/config', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    assertNotViewer(user);
    const { limits, metadata } = ConfigBody.parse(request.body);

    const result = await db.write.query(
      `UPDATE bd_accounts
       SET limits = $1, metadata = $2, updated_at = NOW()
       WHERE id = $3 AND organization_id = $4
       RETURNING *`,
      [JSON.stringify(limits || {}), JSON.stringify(metadata || {}), id, user.organizationId],
    );

    if (!result.rows.length) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    return result.rows[0];
  });

  // ── DELETE /api/bd-accounts/:id — cascade delete matching v1 ──

  app.delete('/api/bd-accounts/:id', { preHandler: [requireUser] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    assertNotViewer(user);

    const accountResult = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!accountResult.rows.length) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    // Mark inactive first so reconnect logic doesn't re-add this account
    await db.write.query(
      'UPDATE bd_accounts SET is_active = false WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );

    await rabbitmq.publishCommand(`telegram:commands:${id}`, {
      type: CommandType.DISCONNECT,
      payload: { accountId: id, organizationId: user.organizationId },
    });

    // Orphan messages to remove FK dependency before delete
    await db.write.query(
      'UPDATE messages SET bd_account_id = NULL WHERE bd_account_id = $1 AND organization_id = $2',
      [id, user.organizationId],
    ).catch((err: unknown) => {
      log.warn({ message: 'Failed to orphan messages during BD account delete', error: String(err), entity_id: id });
    });

    // Cascade-delete related data, then the account itself
    const client = await db.write.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM bd_account_sync_chat_folders WHERE bd_account_id = $1', [id]);
      await client.query('DELETE FROM bd_account_sync_chats WHERE bd_account_id = $1', [id]);
      await client.query('DELETE FROM bd_account_sync_folders WHERE bd_account_id = $1', [id]);
      await client.query('DELETE FROM bd_accounts WHERE id = $1 AND organization_id = $2', [id, user.organizationId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    reply.code(200).send({ success: true });
  });
}
