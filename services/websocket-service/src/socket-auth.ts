import jwt from 'jsonwebtoken';
import type { Socket } from 'socket.io';
import type { Logger } from '@getsale/logger';
import { UserRole } from '@getsale/types';

export interface SocketUser {
  id: string;
  email: string;
  organizationId: string;
  role: UserRole;
}

interface JwtPayload {
  userId: string;
  email?: string;
  organizationId?: string;
  organization_id?: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

const ACCESS_TOKEN_COOKIE = (process.env.AUTH_COOKIE_ACCESS || 'access_token').trim() || 'access_token';

function getCookieValue(cookieHeader: string | undefined, name: string): string | undefined {
  if (!cookieHeader) return undefined;
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1].trim()) : undefined;
}

function extractToken(socket: Socket): string | undefined {
  return (
    getCookieValue(socket.handshake.headers.cookie, ACCESS_TOKEN_COOKIE) ||
    socket.handshake.auth?.token ||
    socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '')?.trim() ||
    undefined
  );
}

export function createSocketAuth(log: Logger) {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('JWT_SECRET must be set for websocket-service');
  }

  return (socket: Socket, next: (err?: Error) => void) => {
    try {
      const token = extractToken(socket);
      if (!token) {
        return next(new Error('Authentication error: No token provided'));
      }

      let payload: JwtPayload;
      try {
        payload = jwt.verify(token, secret, { algorithms: ['HS256'] }) as JwtPayload;
      } catch {
        return next(new Error('Authentication error: Invalid or expired token'));
      }

      const organizationId = payload.organizationId || payload.organization_id;
      if (!payload.userId || !organizationId) {
        return next(new Error('Authentication error: Invalid token payload'));
      }

      const user: SocketUser = {
        id: payload.userId,
        email: payload.email || '',
        organizationId,
        role: payload.role || UserRole.VIEWER,
      };

      (socket as any).user = user;
      next();
    } catch (error: any) {
      log.error({ message: 'Socket authentication error', error: String(error) });
      next(new Error('Authentication error'));
    }
  };
}
