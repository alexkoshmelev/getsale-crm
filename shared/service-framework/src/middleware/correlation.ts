import { FastifyRequest, FastifyReply } from 'fastify';
import { randomUUID } from 'crypto';

declare module 'fastify' {
  interface FastifyRequest {
    correlationId: string;
  }
}

export function correlationIdHook(request: FastifyRequest, reply: FastifyReply, done: () => void): void {
  const incoming = request.headers['x-correlation-id'];
  request.correlationId =
    typeof incoming === 'string' && incoming.trim()
      ? incoming.trim()
      : randomUUID();
  reply.header('x-correlation-id', request.correlationId);
  done();
}
