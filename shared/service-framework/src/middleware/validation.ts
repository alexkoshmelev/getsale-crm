import { FastifyRequest, FastifyReply } from 'fastify';
import { ZodSchema, ZodError } from 'zod';
import { AppError, ErrorCodes } from '../errors';

function formatZodErrors(error: ZodError): Array<{ path: string; message: string }> {
  return error.issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
  }));
}

type ValidationTarget = 'body' | 'query' | 'params';

export function validate(schema: ZodSchema, target: ValidationTarget = 'body') {
  return function hook(request: FastifyRequest, reply: FastifyReply, done: (err?: Error) => void): void {
    const data = target === 'body' ? request.body : target === 'query' ? request.query : request.params;
    const result = schema.safeParse(data);
    if (!result.success) {
      return done(new AppError(400, 'Validation failed', ErrorCodes.VALIDATION, formatZodErrors(result.error)));
    }
    if (target === 'body') {
      (request as unknown as Record<string, unknown>).body = result.data;
    } else if (target === 'query') {
      (request as unknown as Record<string, unknown>).query = result.data;
    } else {
      (request as unknown as Record<string, unknown>).params = result.data;
    }
    done();
  };
}
