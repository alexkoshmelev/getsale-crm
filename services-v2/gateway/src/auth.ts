import { FastifyRequest, FastifyReply } from 'fastify';
import jwt from 'jsonwebtoken';
import { JWT_SECRET, ACCESS_TOKEN_COOKIE } from './config';

interface JwtPayload {
  userId: string;
  organizationId: string;
  role: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    gatewayUser?: {
      id: string;
      organizationId: string;
      role: string;
    };
  }
}

function getToken(request: FastifyRequest): string | undefined {
  const cookie = (request as unknown as Record<string, unknown>).cookies as Record<string, string> | undefined;
  if (cookie?.[ACCESS_TOKEN_COOKIE]) return cookie[ACCESS_TOKEN_COOKIE];

  const authHeader = request.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7).trim();
  }

  const rawCookie = request.headers.cookie;
  if (typeof rawCookie === 'string') {
    const match = rawCookie.match(new RegExp(`(?:^|;)\\s*${ACCESS_TOKEN_COOKIE}=([^;]*)`));
    if (match) return decodeURIComponent(match[1].trim());
  }

  return undefined;
}

export async function authenticate(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const token = getToken(request);
  if (!token) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  let payload: JwtPayload;
  try {
    payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload;
  } catch {
    reply.code(401).send({ error: 'Invalid or expired token' });
    return;
  }

  const userId = typeof payload.userId === 'string' ? payload.userId.trim() : '';
  const organizationId = typeof payload.organizationId === 'string' ? payload.organizationId.trim() : '';
  if (!userId || !organizationId) {
    reply.code(401).send({ error: 'Invalid token payload' });
    return;
  }

  request.gatewayUser = {
    id: userId,
    organizationId,
    role: payload.role || 'viewer',
  };
}
