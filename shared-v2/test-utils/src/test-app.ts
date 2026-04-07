import Fastify, { FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import { extractUserHook } from '@getsale/service-framework';

export interface TestAppOptions {
  cookieParser?: boolean;
  skipUserExtract?: boolean;
}

export type InjectFn = FastifyInstance['inject'];

/**
 * Creates a lightweight Fastify app for testing with the same hooks
 * as createService (user extraction, cookie parsing) but no real
 * DB/RabbitMQ/metrics connections.
 *
 * Usage:
 *   const { app, inject } = await createTestApp(async (app) => {
 *     registerMyRoutes(app, deps);
 *   });
 *   const res = await inject({ method: 'GET', url: '/api/foo' });
 */
export async function createTestApp(
  setup: (app: FastifyInstance) => void | Promise<void>,
  options: TestAppOptions = {},
): Promise<{ app: FastifyInstance; inject: InjectFn }> {
  const app = Fastify({ logger: false });

  if (options.cookieParser !== false) {
    await app.register(cookie);
  }

  app.decorateRequest('correlationId', '');
  app.decorateRequest('user', null);

  if (!options.skipUserExtract) {
    app.addHook('onRequest', (request, _reply, done) => {
      extractUserHook(request);
      done();
    });
  }

  await setup(app);
  await app.ready();

  return { app, inject: app.inject.bind(app) };
}
