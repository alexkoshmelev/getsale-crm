import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, ErrorCodes, requireUser } from '@getsale/service-framework';
import { Logger } from '@getsale/logger';
import { QrLoginHandler } from '../qr-login-handler';

interface Deps {
  log: Logger;
  qrLoginHandler: QrLoginHandler;
}

const StartQrLoginBody = z.object({
  proxyConfig: z
    .object({
      type: z.enum(['socks5']).default('socks5'),
      host: z.string().min(1),
      port: z.number().int().min(1).max(65535),
      username: z.string().optional(),
      password: z.string().optional(),
    })
    .optional()
    .nullable(),
});

const QrLoginPasswordBody = z.object({
  sessionId: z.string().min(1),
  password: z.string().min(1),
});

export function registerAuthRoutes(app: FastifyInstance, deps: Deps): void {
  const { log, qrLoginHandler } = deps;

  app.post('/api/bd-accounts/start-qr-login', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const body = StartQrLoginBody.parse(request.body);

    const { sessionId } = await qrLoginHandler.startQrLogin(
      user.organizationId,
      user.id,
      body.proxyConfig ?? null,
    );

    log.info({ message: 'QR login started', sessionId, userId: user.id });
    return { sessionId };
  });

  app.get('/api/bd-accounts/qr-login-status', { preHandler: [requireUser] }, async (request) => {
    const { sessionId } = request.query as { sessionId?: string };
    if (!sessionId || typeof sessionId !== 'string') {
      throw new AppError(400, 'sessionId query parameter required', ErrorCodes.VALIDATION);
    }

    const state = await qrLoginHandler.getQrLoginStatus(sessionId);
    if (!state) {
      throw new AppError(404, 'Session not found or expired', ErrorCodes.NOT_FOUND);
    }

    return state;
  });

  app.post('/api/bd-accounts/qr-login-password', { preHandler: [requireUser] }, async (request) => {
    const { sessionId, password } = QrLoginPasswordBody.parse(request.body);

    const state = await qrLoginHandler.getQrLoginStatus(sessionId);
    if (!state || state.status !== 'need_password') {
      throw new AppError(400, 'Session not waiting for password or expired', ErrorCodes.BAD_REQUEST);
    }

    await qrLoginHandler.submitQrLoginPassword(sessionId, password);
    return { ok: true };
  });
}
