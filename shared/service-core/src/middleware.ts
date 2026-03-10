import { Request, Response, NextFunction, RequestHandler } from 'express';
import { randomUUID } from 'crypto';
import { ZodSchema, ZodError } from 'zod';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { AppError, ErrorCodes, isAppError } from './errors';

// ─── Request augmentation ────────────────────────────────────────────────

export interface ServiceUser {
  id: string;
  organizationId: string;
  role: string;
}

declare global {
  namespace Express {
    interface Request {
      user: ServiceUser;
      correlationId: string;
    }
  }
}

// ─── Internal auth (gateway → backend) ────────────────────────────────────

const INTERNAL_AUTH_HEADER = 'x-internal-auth';

/** Reject requests that did not come from the gateway (missing or invalid X-Internal-Auth).
 *  When INTERNAL_AUTH_SECRET is set: require either valid X-Internal-Auth header or present X-User-Id + X-Organization-Id (gateway sets these after JWT).
 *  When INTERNAL_AUTH_SECRET is not set: reject with 503 so the service never runs in insecure "trust any headers" mode. */
export function internalAuth(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const secret = process.env.INTERNAL_AUTH_SECRET?.trim();
    if (!secret) {
      return next(new AppError(503, 'Service unavailable: INTERNAL_AUTH_SECRET is not configured', ErrorCodes.INTERNAL_ERROR));
    }
    const value = req.headers[INTERNAL_AUTH_HEADER];
    const headerOk = typeof value === 'string' && value.trim() === secret;
    const userId = req.headers['x-user-id'];
    const orgId = req.headers['x-organization-id'];
    const hasUserHeaders = typeof userId === 'string' && userId.trim() !== '' && typeof orgId === 'string' && orgId.trim() !== '';
    if (headerOk || hasUserHeaders) {
      return next();
    }
    return next(new AppError(401, 'Unauthorized', ErrorCodes.UNAUTHORIZED));
  };
}

// ─── Correlation ID ──────────────────────────────────────────────────────

const CORRELATION_HEADER = 'x-correlation-id';

export function correlationId(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const incoming = req.headers[CORRELATION_HEADER];
    req.correlationId =
      typeof incoming === 'string' && incoming.trim()
        ? incoming.trim()
        : randomUUID();
    next();
  };
}

// ─── Extract user from gateway headers ───────────────────────────────────

export function extractUser(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const id = req.headers['x-user-id'] as string | undefined;
    const organizationId = req.headers['x-organization-id'] as string | undefined;
    const role = (req.headers['x-user-role'] as string) || '';

    req.user = {
      id: id || '',
      organizationId: organizationId || '',
      role,
    };
    next();
  };
}

// ─── Require authenticated user ──────────────────────────────────────────

export function requireUser(): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user?.id || !req.user?.organizationId) {
      return next(new AppError(401, 'Authentication required', ErrorCodes.UNAUTHORIZED));
    }
    next();
  };
}

// ─── Role check ──────────────────────────────────────────────────────────

export function requireRole(...roles: string[]): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const userRole = req.user?.role?.toLowerCase() || '';
    if (!roles.map((r) => r.toLowerCase()).includes(userRole)) {
      return next(new AppError(403, 'Insufficient permissions', ErrorCodes.FORBIDDEN));
    }
    next();
  };
}

// ─── RBAC permission check (DB-backed) ───────────────────────────────────

export function canPermission(pool: Pool) {
  return async function check(
    role: string,
    resource: string,
    action: string
  ): Promise<boolean> {
    const roleLower = (role || '').toLowerCase();
    try {
      const r = await pool.query(
        `SELECT 1 FROM role_permissions
         WHERE role = $1 AND resource = $2 AND (action = $3 OR action = '*')
         LIMIT 1`,
        [roleLower, resource, action]
      );
      if (r.rows.length > 0) return true;
      return roleLower === 'owner';
    } catch {
      return roleLower === 'owner';
    }
  };
}

// ─── Zod validation ──────────────────────────────────────────────────────

type ValidationTarget = 'body' | 'query' | 'params';

export function validate(
  schema: ZodSchema,
  target: ValidationTarget = 'body'
): RequestHandler {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[target]);
    if (!result.success) {
      const formatted = formatZodErrors(result.error);
      return next(
        new AppError(400, 'Validation failed', ErrorCodes.VALIDATION, formatted)
      );
    }
    req[target] = result.data;
    next();
  };
}

function formatZodErrors(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

// ─── Request logging ─────────────────────────────────────────────────────

export function requestLogger(log: Logger): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();

    res.on('finish', () => {
      const duration = Date.now() - start;
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';

      log[level]({
        message: `${req.method} ${req.path}`,
        correlation_id: req.correlationId,
        status: level === 'error' ? 'failed' : 'success',
        http_method: req.method,
        http_path: req.path,
        http_status: res.statusCode,
        duration_ms: duration,
        user_id: req.user?.id,
        organization_id: req.user?.organizationId,
      });
    });

    next();
  };
}

// ─── Global error handler ────────────────────────────────────────────────

export function errorHandler(log: Logger) {
  return (err: Error, req: Request, res: Response, _next: NextFunction) => {
    if (isAppError(err)) {
      res.status(err.statusCode).json(err.toJSON());
      return;
    }

    log.error({
      message: `Unhandled error: ${err.message}`,
      correlation_id: req.correlationId,
      stack: err.stack,
      http_method: req.method,
      http_path: req.path,
    });

    res.status(500).json({
      error: 'Internal server error',
      code: ErrorCodes.INTERNAL_ERROR,
    });
  };
}

// ─── Async route wrapper (catches promise rejections) ────────────────────

type AsyncHandler = (req: Request, res: Response, next: NextFunction) => Promise<unknown>;

export function asyncHandler(fn: AsyncHandler): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}
