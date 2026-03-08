export { AppError, isAppError, ErrorCodes, type ErrorCode } from './errors';

export {
  correlationId,
  extractUser,
  internalAuth,
  requireUser,
  requireRole,
  canPermission,
  validate,
  requestLogger,
  errorHandler,
  asyncHandler,
  type ServiceUser,
} from './middleware';

export {
  ServiceHttpClient,
  ServiceCallError,
  type HttpClientOptions,
} from './http-client';

export {
  createServiceApp,
  type ServiceConfig,
  type ServiceContext,
  type ServiceMetrics,
} from './service-app';
