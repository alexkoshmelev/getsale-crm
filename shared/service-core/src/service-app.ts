import express, { Express, Router } from 'express';
import cors from 'cors';
import { Pool, PoolConfig } from 'pg';
import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';
import { RabbitMQClient } from '@getsale/utils';
import { createLogger, Logger } from '@getsale/logger';
import {
  correlationId,
  extractUser,
  internalAuth,
  requestLogger,
  errorHandler,
} from './middleware';

// ─── Service configuration ───────────────────────────────────────────────

export interface ServiceConfig {
  name: string;
  port?: number;

  /** Skip DB pool creation (e.g. for websocket-service, api-gateway) */
  skipDb?: boolean;
  /** Skip RabbitMQ connection */
  skipRabbitMQ?: boolean;
  /** Skip extractUser middleware (e.g. auth-service that verifies JWT directly) */
  skipUserExtract?: boolean;
  /** Enable CORS (default: false) */
  cors?: boolean;
  /** Extra pool config overrides */
  poolConfig?: Partial<PoolConfig>;
  /** Optional cleanup run during graceful shutdown (e.g. close Redis). Called after server close, before pool/rabbitmq. */
  onShutdown?: () => void | Promise<void>;
}

export interface ServiceContext {
  app: Express;
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  registry: Registry;
  metrics: ServiceMetrics;

  /** Mount routes under a prefix. Applies errorHandler after all routes. */
  mount(prefix: string, router: Router): void;

  /** Start listening. Call after all routes are mounted. */
  start(): void;
}

export interface ServiceMetrics {
  httpRequestDuration: Histogram;
  httpRequestsTotal: Counter;
}

// ─── Factory ─────────────────────────────────────────────────────────────

export async function createServiceApp(config: ServiceConfig): Promise<ServiceContext> {
  const port = config.port ?? parseInt(process.env.PORT || '3000', 10);
  const log = createLogger(config.name);

  // Express setup
  const app = express();
  if (config.cors) {
    // With credentials: true the browser forbids Access-Control-Allow-Origin: *. Use concrete origin.
    const corsOrigin = process.env.CORS_ORIGIN?.trim();
    const origin = corsOrigin
      ? corsOrigin.split(',').map((o) => o.trim()).filter(Boolean)
      : undefined;
    app.use(
      cors({
        origin: origin?.length
          ? (reqOrigin: string | undefined, cb: (err: Error | null, allow?: boolean | string) => void) => {
              const o = (reqOrigin ?? process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000').trim();
              cb(null, origin!.includes(o) ? o : origin![0]);
            }
          : (reqOrigin: string | undefined, cb: (err: Error | null, allow?: boolean | string) => void) => {
              cb(null, (reqOrigin ?? process.env.FRONTEND_ORIGIN ?? 'http://localhost:3000').trim() || 'http://localhost:3000');
            },
        credentials: true,
      })
    );
  }
  app.use(express.json({ limit: '5mb' }));
  app.use(correlationId());
  if (!config.skipUserExtract) {
    app.use(extractUser());
  }
  // In production, forbid default or missing INTERNAL_AUTH_SECRET (S9)
  if (process.env.NODE_ENV === 'production') {
    const secret = process.env.INTERNAL_AUTH_SECRET?.trim();
    if (!secret || secret === 'dev_internal_auth_secret') {
      throw new Error(
        'INTERNAL_AUTH_SECRET must be set to a non-default value in production. Do not use dev_internal_auth_secret.'
      );
    }
  }
  // Require X-Internal-Auth when INTERNAL_AUTH_SECRET is set (gateway bypass prevention)
  if (process.env.INTERNAL_AUTH_SECRET?.trim()) {
    app.use((req, res, next) => {
      if (req.path === '/health' || req.path === '/metrics') return next();
      return internalAuth()(req, res, next);
    });
  }

  // Prometheus
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'path', 'status'],
    registers: [registry],
  });

  const httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'path', 'status'],
    registers: [registry],
  });

  // Request logging + metrics
  app.use(requestLogger(log));
  app.use((req, res, next) => {
    const start = process.hrtime.bigint();
    res.on('finish', () => {
      const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
      const labels = {
        method: req.method,
        path: normalizePath(req.route?.path || req.path),
        status: String(res.statusCode),
      };
      httpRequestDuration.observe(labels, durationSec);
      httpRequestsTotal.inc(labels);
    });
    next();
  });

  // DB pool
  let pool: Pool;
  if (config.skipDb) {
    pool = null as unknown as Pool;
  } else {
    pool = new Pool({
      connectionString:
        process.env.DATABASE_URL ||
        `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'postgres_dev'}@localhost:5432/postgres`,
      max: 8, // Keep low to avoid exhausting PostgreSQL max_connections; use PgBouncer in production
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      ...config.poolConfig,
    });
  }

  // RabbitMQ
  const rabbitmq = new RabbitMQClient(
    process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672'
  );
  if (!config.skipRabbitMQ) {
    try {
      await rabbitmq.connect();
      log.info({ message: 'RabbitMQ connected' });
    } catch (error) {
      log.warn({
        message: 'RabbitMQ connection failed, continuing without events',
        error: String(error),
      });
    }
  }

  // Health check
  app.get('/health', async (_req, res) => {
    const checks: Record<string, string> = {};

    if (!config.skipDb) {
      try {
        await pool.query('SELECT 1');
        checks.db = 'ok';
      } catch {
        checks.db = 'error';
      }
    }

    if (!config.skipRabbitMQ) {
      checks.rabbitmq = rabbitmq.isConnected() ? 'ok' : 'disconnected';
    }

    const allOk = Object.values(checks).every((v) => v === 'ok');
    res.status(allOk ? 200 : 503).json({
      status: allOk ? 'ok' : 'degraded',
      service: config.name,
      checks,
    });
  });

  // Metrics endpoint
  app.get('/metrics', async (_req, res) => {
    res.set('Content-Type', registry.contentType);
    res.end(await registry.metrics());
  });

  const context: ServiceContext = {
    app,
    pool,
    rabbitmq,
    log,
    registry,
    metrics: { httpRequestDuration, httpRequestsTotal },

    mount(prefix: string, router: Router) {
      app.use(prefix, router);
    },

    start() {
      app.use(errorHandler(log));

      const server = app.listen(port, () => {
        log.info({ message: `${config.name} running on port ${port}` });
      });

      const shutdown = async (signal: string) => {
        log.info({ message: `${config.name} received ${signal}, shutting down gracefully` });
        server.close(() => {
          log.info({ message: `${config.name} HTTP server closed` });
        });
        const shutdownTimeout = setTimeout(() => {
          log.warn({ message: `${config.name} shutdown timeout, exiting` });
          process.exit(1);
        }, 15_000);

        try {
          if (config.onShutdown) {
            await Promise.resolve(config.onShutdown());
            log.info({ message: `${config.name} custom shutdown cleanup completed` });
          }
          if (!config.skipDb && pool) {
            await pool.end();
            log.info({ message: `${config.name} DB pool closed` });
          }
          await rabbitmq.close();
          log.info({ message: `${config.name} RabbitMQ closed` });
        } catch (err) {
          log.warn({ message: `${config.name} error during shutdown`, error: String(err) });
        } finally {
          clearTimeout(shutdownTimeout);
          process.exit(0);
        }
      };

      process.on('SIGTERM', () => shutdown('SIGTERM'));
      process.on('SIGINT', () => shutdown('SIGINT'));
    },
  };

  return context;
}

/** Collapse path params to `:param` for metric label cardinality control */
function normalizePath(path: string): string {
  return path.replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '/:id');
}
