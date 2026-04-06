export { AppError, isAppError, ErrorCodes, type ErrorCode } from './errors';

export {
  createService,
  type ServiceConfig,
  type ServiceContext,
  type ServiceMetrics,
} from './create-service';

export {
  createDatabasePools,
  type DatabasePools,
  type DbConfig,
} from './db';

export {
  ServiceHttpClient,
  ServiceCallError,
  interServiceHttpDefaults,
  type HttpClientOptions,
  type RequestContext,
} from './http-client';

export {
  extractUserHook,
  internalAuthHook,
  requireUser,
  requireRole,
  canPermission,
  type ServiceUser,
} from './middleware/auth';

export { correlationIdHook } from './middleware/correlation';
export { createErrorHandler } from './middleware/error-handler';
export { createRateLimiter, type RateLimitConfig } from './middleware/rate-limit';
export { validate } from './middleware/validation';
