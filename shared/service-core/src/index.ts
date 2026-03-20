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
  type RequestContext,
} from './http-client';

export {
  createServiceApp,
  type ServiceConfig,
  type ServiceContext,
  type ServiceMetrics,
} from './service-app';

export {
  parseLimit,
  parseOffset,
  parsePageLimit,
  buildPagedResponse,
  type PagedMeta,
} from './query-utils';

export { interServiceHttpDefaults } from './inter-service-http-defaults';

export { withOrgContext } from './rls';
