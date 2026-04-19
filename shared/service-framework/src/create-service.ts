import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';
import { RabbitMQClient } from '@getsale/queue';
import { createLogger, Logger } from '@getsale/logger';
import { createDatabasePools, DatabasePools, DbConfig } from './db';
import { correlationIdHook } from './middleware/correlation';
import { extractUserHook, internalAuthHook, type ServiceUser } from './middleware/auth';
import { createErrorHandler } from './middleware/error-handler';

export interface ServiceConfig {
  name: string;
  port?: number;
  skipDb?: boolean;
  skipRabbitMQ?: boolean;
  skipUserExtract?: boolean;
  cors?: boolean;
  dbConfig?: Partial<DbConfig>;
  onShutdown?: () => void | Promise<void>;
}

export interface ServiceMetrics {
  httpRequestDuration: Histogram;
  httpRequestsTotal: Counter;
}

export interface ServiceContext {
  app: FastifyInstance;
  db: DatabasePools;
  rabbitmq: RabbitMQClient;
  log: Logger;
  registry: Registry;
  metrics: ServiceMetrics;
  start(): Promise<void>;
}

export async function createService(config: ServiceConfig): Promise<ServiceContext> {
  const port = config.port ?? parseInt(process.env.PORT || '3000', 10);
  const log = createLogger(config.name);

  if (process.env.NODE_ENV === 'production') {
    const secret = process.env.INTERNAL_AUTH_SECRET?.trim();
    if (!secret || secret === 'dev_internal_auth_secret') {
      throw new Error('INTERNAL_AUTH_SECRET must be set to a non-default value in production.');
    }
  }

  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
    requestTimeout: 30_000,
    keepAliveTimeout: 72_000,
  });

  if (config.cors) {
    const corsOrigin = process.env.CORS_ORIGIN?.trim();
    const origins = corsOrigin
      ? corsOrigin.split(',').map((o) => o.trim()).filter(Boolean)
      : [process.env.FRONTEND_ORIGIN || 'http://localhost:3000'];

    await app.register(cors, { origin: origins, credentials: true });
  }

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie);

  app.decorateRequest('correlationId', '');
  app.decorateRequest('user', null as unknown as ServiceUser | null);

  app.addHook('onRequest', correlationIdHook);

  if (!config.skipUserExtract) {
    app.addHook('onRequest', (request, reply, done) => {
      extractUserHook(request);
      done();
    });
  }

  if (process.env.INTERNAL_AUTH_SECRET?.trim()) {
    app.addHook('onRequest', internalAuthHook);
  }

  // --- Prometheus ---
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });

  const httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });

  const isProduction = process.env.NODE_ENV === 'production';
  const slowRequestMsParsed = parseInt(process.env.LOG_SLOW_REQUEST_MS || '1000', 10);
  const logSlowRequestMs =
    Number.isFinite(slowRequestMsParsed) && slowRequestMsParsed > 0 ? slowRequestMsParsed : 1000;

  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions?.url || request.url;
    const labels = {
      method: request.method,
      route: normalizePath(route),
      status: String(reply.statusCode),
    };
    httpRequestDuration.observe(labels, reply.elapsedTime / 1000);
    httpRequestsTotal.inc(labels);

    const durationMs = Math.round(reply.elapsedTime);
    const pathname = requestPathname(request.url);
    if (shouldLogHttpRequest(isProduction, pathname, reply.statusCode, durationMs, logSlowRequestMs)) {
      log.info({
        message: `${request.method} ${request.url}`,
        correlation_id: request.correlationId,
        http_method: request.method,
        http_path: request.url,
        http_status: reply.statusCode,
        duration_ms: durationMs,
        user_id: request.user?.id,
        organization_id: request.user?.organizationId,
      });
    }
    done();
  });

  app.setErrorHandler(createErrorHandler(log));

  // --- Database ---
  let db: DatabasePools;
  if (config.skipDb) {
    db = new Proxy({} as DatabasePools, {
      get(_, prop) {
        throw new Error(`Database accessed but skipDb was true. Cannot access db.${String(prop)}`);
      },
    });
  } else {
    db = createDatabasePools(log, config.dbConfig);
  }

  // --- RabbitMQ ---
  const rabbitmq = new RabbitMQClient(
    process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672',
  );
  if (!config.skipRabbitMQ) {
    try {
      await rabbitmq.connect();
      log.info({ message: 'RabbitMQ connected' });
    } catch (error) {
      log.warn({ message: 'RabbitMQ connection failed, continuing without events', error: String(error) });
    }
  }

  // --- Health / Ready / Metrics ---
  app.get('/health', async (request, reply) => {
    const checks: Record<string, string> = {};
    if (!config.skipDb) {
      try { await db.write.query('SELECT 1'); checks.db = 'ok'; } catch { checks.db = 'error'; }
    }
    if (!config.skipRabbitMQ) {
      checks.rabbitmq = rabbitmq.isConnected() ? 'ok' : 'disconnected';
    }
    const allOk = Object.values(checks).every((v) => v === 'ok');
    return reply.code(allOk ? 200 : 503).send({ status: allOk ? 'ok' : 'degraded', service: config.name, checks });
  });

  app.get('/ready', async (request, reply) => {
    const checks: Record<string, string> = {};
    if (!config.skipDb) {
      try { await db.write.query('SELECT 1'); checks.db = 'ok'; } catch { checks.db = 'error'; }
    }
    if (!config.skipRabbitMQ) {
      checks.rabbitmq = rabbitmq.isConnected() ? 'ok' : 'disconnected';
    }
    const allOk = Object.values(checks).every((v) => v === 'ok');
    return reply.code(allOk ? 200 : 503).send({ ready: allOk, service: config.name, checks });
  });

  app.get('/metrics', async (request, reply) => {
    reply.header('Content-Type', registry.contentType);
    return reply.send(await registry.metrics());
  });

  const context: ServiceContext = {
    app,
    db,
    rabbitmq,
    log,
    registry,
    metrics: { httpRequestDuration, httpRequestsTotal },

    async start(): Promise<void> {
      await app.listen({ port, host: '0.0.0.0' });
      log.info({ message: `${config.name} running on port ${port}` });

      let shuttingDown = false;
      const shutdown = async (signal: string) => {
        if (shuttingDown) return;
        shuttingDown = true;
        log.info({ message: `${config.name} received ${signal}, shutting down` });

        const timeout = setTimeout(() => {
          log.warn({ message: `${config.name} shutdown timeout, forcing exit` });
          process.exit(1);
        }, 15_000);

        try {
          await app.close();
          log.info({ message: `${config.name} HTTP server closed` });

          if (config.onShutdown) {
            await Promise.resolve(config.onShutdown());
          }
          if (!config.skipDb) {
            await db.shutdown();
            log.info({ message: `${config.name} DB pools closed` });
          }
          await rabbitmq.close();
          log.info({ message: `${config.name} RabbitMQ closed` });
        } catch (err) {
          log.warn({ message: `${config.name} error during shutdown`, error: String(err) });
        } finally {
          clearTimeout(timeout);
          process.exit(0);
        }
      };

      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    },
  };

  return context;
}

function normalizePath(path: string): string {
  return path
    .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id')
    .replace(/\/\d+/g, '/:n');
}

function requestPathname(url: string): string {
  const q = url.indexOf('?');
  return q === -1 ? url : url.slice(0, q);
}

/** Production: skip noisy probe paths; otherwise log only slow or error responses. Dev: log all requests. */
function shouldLogHttpRequest(
  production: boolean,
  pathname: string,
  statusCode: number,
  durationMs: number,
  slowThresholdMs: number,
): boolean {
  if (!production) return true;
  if (pathname === '/health' || pathname === '/ready' || pathname === '/metrics') return false;
  if (statusCode >= 400) return true;
  return durationMs > slowThresholdMs;
}
