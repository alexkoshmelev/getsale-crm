import express, { Express, Router } from 'express';
import cookieParser from 'cookie-parser';
import type { Logger } from '@getsale/logger';
import {
  correlationId,
  extractUser,
  requestLogger,
  errorHandler,
} from '@getsale/service-core';
import { createLogger } from '@getsale/logger';

export interface TestAppOptions {
  /** Mock logger. If not provided, creates a silent logger. */
  log?: Logger;
  /** Mount routes under this prefix. */
  prefix?: string;
  /** Parse Cookie header into req.cookies (e.g. for auth tests). */
  cookieParser?: boolean;
}

/**
 * Creates a minimal Express app with the same middleware as createServiceApp
 * but without actual DB/RabbitMQ connections.
 * Use with mock pool and mock rabbitmq for integration tests.
 */
export function createTestApp(
  router: Router,
  options: TestAppOptions = {}
): Express {
  const app = express();
  const log = options.log ?? createLogger('test');

  app.use(express.json({ limit: '5mb' }));
  if (options.cookieParser) app.use(cookieParser());
  app.use(correlationId());
  app.use(extractUser());
  app.use(requestLogger(log));

  const prefix = options.prefix ?? '';
  app.use(prefix, router);

  app.use(errorHandler(log));

  return app;
}
