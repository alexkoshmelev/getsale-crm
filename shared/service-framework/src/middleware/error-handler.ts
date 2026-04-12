import { FastifyError, FastifyRequest, FastifyReply } from 'fastify';
import { Logger } from '@getsale/logger';
import { AppError, isAppError, ErrorCodes } from '../errors';

export function createErrorHandler(log: Logger) {
  return function errorHandler(error: FastifyError, request: FastifyRequest, reply: FastifyReply): void {
    if (isAppError(error)) {
      if (process.env.NODE_ENV === 'production' && (error as AppError).details != null) {
        log.warn({
          message: 'Error details (not sent to client in production)',
          correlation_id: request.correlationId,
          http_method: request.method,
          http_path: request.url,
          status_code: (error as AppError).statusCode,
        });
      }
      reply.code((error as AppError).statusCode).send((error as AppError).toJSON());
      return;
    }

    if (error.validation) {
      reply.code(400).send({
        error: 'Validation failed',
        code: ErrorCodes.VALIDATION,
        details: error.validation,
      });
      return;
    }

    const fstCode = (error as FastifyError).code;
    if (
      typeof (error as FastifyError).statusCode === 'number' &&
      (error as FastifyError).statusCode! >= 400 &&
      (error as FastifyError).statusCode! < 500 &&
      typeof fstCode === 'string' &&
      fstCode.startsWith('FST_ERR')
    ) {
      reply.code((error as FastifyError).statusCode!).send({
        error: error.message,
        code: ErrorCodes.VALIDATION,
      });
      return;
    }

    if (error.name === 'ZodError' || (error as any).issues) {
      reply.code(400).send({
        error: 'Validation failed',
        code: ErrorCodes.VALIDATION,
        details: (error as any).issues ?? [],
      });
      return;
    }

    log.error({
      message: `Unhandled error: ${error.message}`,
      correlation_id: request.correlationId,
      stack: error.stack,
      http_method: request.method,
      http_path: request.url,
    });

    reply.code(500).send({
      error: 'Internal server error',
      code: ErrorCodes.INTERNAL_ERROR,
    });
  };
}
