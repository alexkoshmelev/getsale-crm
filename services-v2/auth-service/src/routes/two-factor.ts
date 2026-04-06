import { FastifyInstance, FastifyReply } from 'fastify';
import '@fastify/cookie';
import * as speakeasy from 'speakeasy';
import QRCode from 'qrcode';
import bcrypt from 'bcryptjs';
import { randomBytes, randomUUID } from 'crypto';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { AppError, ErrorCodes } from '@getsale/service-framework';
import { RedisClient } from '@getsale/cache';
import { TwoFactorVerifySetupSchema, TwoFactorDisableSchema, TwoFactorValidateSchema } from '../validation';
import {
  extractBearerTokenFromRequest,
  signAccessToken,
  signRefreshToken,
  hashRefreshToken,
  verifyTempToken,
  getClientIpFromRequest,
  getRoleForWorkspace,
} from '../helpers';
import {
  AUTH_COOKIE_ACCESS,
  AUTH_COOKIE_REFRESH,
  AUTH_COOKIE_OPTS,
  ACCESS_MAX_AGE_SEC,
  REFRESH_MAX_AGE_SEC,
  REFRESH_EXPIRY_MS,
} from '../cookies';

const VALIDATE_RATE_LIMIT = 5;
const VALIDATE_RATE_WINDOW_MS = 15 * 60 * 1000;
const RECOVERY_CODE_COUNT = 8;
const RECOVERY_CODE_LENGTH = 8;

interface Deps {
  pool: Pool;
  log: Logger;
  redis: RedisClient;
}

function generateRecoveryCodes(): string[] {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  const codes: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const bytes = randomBytes(RECOVERY_CODE_LENGTH);
    let code = '';
    for (let j = 0; j < RECOVERY_CODE_LENGTH; j++) {
      code += chars[bytes[j] % chars.length];
    }
    codes.push(code);
  }
  return codes;
}

function authenticateRequest(request: Parameters<typeof extractBearerTokenFromRequest>[0]): { userId: string; organizationId: string; role: string } {
  const payload = extractBearerTokenFromRequest(request, AUTH_COOKIE_ACCESS);
  return { userId: payload.userId, organizationId: payload.organizationId, role: payload.role || '' };
}

function setCookiesAndSend(
  reply: FastifyReply,
  accessToken: string,
  refreshToken: string,
  user: { id: string; email: string; organizationId: string; role: string },
) {
  reply
    .setCookie(AUTH_COOKIE_ACCESS, accessToken, { ...AUTH_COOKIE_OPTS, maxAge: ACCESS_MAX_AGE_SEC })
    .setCookie(AUTH_COOKIE_REFRESH, refreshToken, { ...AUTH_COOKIE_OPTS, maxAge: REFRESH_MAX_AGE_SEC })
    .send({ user: { id: user.id, email: user.email, organizationId: user.organizationId, role: user.role } });
}

export function registerTwoFactorRoutes(app: FastifyInstance, deps: Deps): void {
  const { pool, log, redis } = deps;

  app.post('/api/auth/2fa/setup', async (request) => {
    const { userId } = authenticateRequest(request);

    const secret = speakeasy.generateSecret({ name: 'GetSale CRM', issuer: 'GetSale' });
    if (!secret.otpauth_url) {
      throw new AppError(500, 'Failed to generate OTP auth URL', ErrorCodes.INTERNAL_ERROR);
    }

    const qrCodeUrl = await QRCode.toDataURL(secret.otpauth_url);

    log.info({ message: '2FA setup initiated', entity_type: 'user', entity_id: userId });
    return { secret: secret.base32, qrCodeUrl };
  });

  app.post('/api/auth/2fa/verify-setup', async (request) => {
    const { userId } = authenticateRequest(request);
    const { token, secret } = TwoFactorVerifySetupSchema.parse(request.body);

    const verified = speakeasy.totp.verify({
      secret,
      encoding: 'base32',
      token,
      window: 1,
    });

    if (!verified) {
      throw new AppError(400, 'Invalid verification code', ErrorCodes.VALIDATION);
    }

    const recoveryCodes = generateRecoveryCodes();
    const hashedCodes = await Promise.all(
      recoveryCodes.map((code) => bcrypt.hash(code, 12)),
    );

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE users SET mfa_secret = $1, mfa_enabled = true WHERE id = $2',
        [secret, userId],
      );
      await client.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);

      for (const hash of hashedCodes) {
        await client.query(
          'INSERT INTO recovery_codes (id, user_id, code_hash) VALUES ($1, $2, $3)',
          [randomUUID(), userId, hash],
        );
      }

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    log.info({ message: '2FA enabled', entity_type: 'user', entity_id: userId });
    return { enabled: true, recoveryCodes };
  });

  app.post('/api/auth/2fa/disable', async (request) => {
    const { userId } = authenticateRequest(request);
    const { token } = TwoFactorDisableSchema.parse(request.body);

    const userRow = await pool.query(
      'SELECT mfa_secret, mfa_enabled FROM users WHERE id = $1',
      [userId],
    );
    if (userRow.rows.length === 0) {
      throw new AppError(404, 'User not found', ErrorCodes.NOT_FOUND);
    }

    const user = userRow.rows[0];
    if (!user.mfa_enabled || !user.mfa_secret) {
      throw new AppError(400, '2FA is not enabled', ErrorCodes.BAD_REQUEST);
    }

    const verified = speakeasy.totp.verify({
      secret: user.mfa_secret,
      encoding: 'base32',
      token,
      window: 1,
    });

    if (!verified) {
      throw new AppError(400, 'Invalid verification code', ErrorCodes.VALIDATION);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE users SET mfa_enabled = false, mfa_secret = NULL WHERE id = $1',
        [userId],
      );
      await client.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    log.info({ message: '2FA disabled', entity_type: 'user', entity_id: userId });
    return { disabled: true };
  });

  app.post('/api/auth/2fa/validate', async (request, reply) => {
    const clientIp = getClientIpFromRequest(request) || 'unknown';
    const allowed = await redis.checkRateLimit(
      `auth_rate:2fa_validate:${clientIp}`,
      VALIDATE_RATE_LIMIT,
      VALIDATE_RATE_WINDOW_MS,
    );
    if (!allowed) {
      throw new AppError(429, 'Too many 2FA validation attempts. Try again later.', ErrorCodes.RATE_LIMITED);
    }

    const { tempToken, token, recoveryCode } = TwoFactorValidateSchema.parse(request.body);

    let decoded: { userId: string };
    try {
      decoded = verifyTempToken(tempToken);
    } catch {
      throw new AppError(401, 'Invalid or expired temp token', ErrorCodes.UNAUTHORIZED);
    }

    const userRow = await pool.query(
      'SELECT id, email, organization_id, role, mfa_secret, mfa_enabled FROM users WHERE id = $1',
      [decoded.userId],
    );
    if (userRow.rows.length === 0) {
      throw new AppError(401, 'User not found', ErrorCodes.UNAUTHORIZED);
    }

    const user = userRow.rows[0];
    if (!user.mfa_enabled || !user.mfa_secret) {
      throw new AppError(400, '2FA is not enabled for this user', ErrorCodes.BAD_REQUEST);
    }

    let valid = false;

    if (token && typeof token === 'string') {
      valid = speakeasy.totp.verify({
        secret: user.mfa_secret,
        encoding: 'base32',
        token,
        window: 1,
      });
    } else if (recoveryCode && typeof recoveryCode === 'string') {
      const codeRows = await pool.query(
        'SELECT id, code_hash FROM recovery_codes WHERE user_id = $1 AND used = false',
        [user.id],
      );
      for (const row of codeRows.rows) {
        const match = await bcrypt.compare(recoveryCode, row.code_hash);
        if (match) {
          await pool.query('UPDATE recovery_codes SET used = true WHERE id = $1', [row.id]);
          valid = true;
          break;
        }
      }
    }

    if (!valid) {
      throw new AppError(401, 'Invalid verification code', ErrorCodes.UNAUTHORIZED);
    }

    const role = await getRoleForWorkspace(pool, user.id, user.organization_id, user.role);
    const accessToken = signAccessToken({
      userId: user.id,
      organizationId: user.organization_id,
      role,
    });
    const refreshToken = signRefreshToken(user.id);
    const tokenHash = hashRefreshToken(refreshToken);
    const familyId = randomUUID();

    try {
      await pool.query(
        'INSERT INTO refresh_tokens (user_id, token, family_id, expires_at) VALUES ($1, $2, $3, $4)',
        [user.id, tokenHash, familyId, new Date(Date.now() + REFRESH_EXPIRY_MS)],
      );
    } catch (e: unknown) {
      const err = e as { code?: string };
      if (err.code === '23505') {
        await pool.query(
          'UPDATE refresh_tokens SET expires_at = $1, family_id = $2, used = false WHERE token = $3',
          [new Date(Date.now() + REFRESH_EXPIRY_MS), familyId, tokenHash],
        );
      } else throw e;
    }

    log.info({ message: '2FA validation successful', entity_type: 'user', entity_id: user.id });

    setCookiesAndSend(reply, accessToken, refreshToken, {
      id: user.id,
      email: user.email,
      organizationId: user.organization_id,
      role,
    });
  });
}
