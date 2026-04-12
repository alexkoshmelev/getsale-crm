export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    Object.setPrototypeOf(this, AppError.prototype);
  }

  toJSON(): { error: string; code?: string; details?: unknown } {
    const payload: { error: string; code?: string; details?: unknown } = {
      error: this.message,
      code: this.code,
    };
    if (
      this.details != null &&
      (this.code === 'VALIDATION' ||
        this.code === 'RATE_LIMITED' ||
        this.code === 'CONFLICT' ||
        process.env.NODE_ENV !== 'production')
    ) {
      payload.details = this.details;
    }
    return payload;
  }
}

export function isAppError(err: unknown): err is AppError {
  return err instanceof AppError;
}

export const ErrorCodes = {
  NOT_FOUND: 'NOT_FOUND',
  VALIDATION: 'VALIDATION',
  CONFLICT: 'CONFLICT',
  BAD_REQUEST: 'BAD_REQUEST',
  FORBIDDEN: 'FORBIDDEN',
  UNAUTHORIZED: 'UNAUTHORIZED',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];
