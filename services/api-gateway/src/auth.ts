import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { UserRole } from '@getsale/types';
import type { Logger } from '@getsale/logger';
import type { JwtPayload } from './types';
import { JWT_SECRET, ACCESS_TOKEN_COOKIE } from './config';

export function getAccessTokenFromRequest(req: Request): string | undefined {
  const fromCookie = req.cookies?.[ACCESS_TOKEN_COOKIE];
  if (fromCookie && typeof fromCookie === 'string') return fromCookie;
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader !== 'string') return undefined;
  const match = cookieHeader.match(new RegExp(`(?:^|;)\\s*${ACCESS_TOKEN_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1].trim()) : undefined;
}

export function createAuthenticate(log: Logger) {
  return function authenticate(req: Request, res: Response, next: NextFunction): void {
    try {
      const token =
        getAccessTokenFromRequest(req) ??
        (typeof req.headers.authorization === 'string' ? req.headers.authorization.replace(/^Bearer\s+/i, '').trim() : undefined);
      if (!token) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      let payload: JwtPayload;
      try {
        payload = jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] }) as JwtPayload;
      } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
        return;
      }

      const userId = typeof payload.userId === 'string' ? payload.userId.trim() : '';
      const organizationId = typeof payload.organizationId === 'string' ? payload.organizationId.trim() : '';
      if (!userId || !organizationId) {
        res.status(401).json({ error: 'Invalid token payload' });
        return;
      }

      req.user = {
        id: userId,
        organizationId,
        role: (payload.role as UserRole) || UserRole.VIEWER,
      };
      next();
    } catch (error: unknown) {
      log.error({ message: 'Auth error', error: String(error) });
      res.status(500).json({ error: 'Authentication failed' });
    }
  };
}

export function requireRole(...roles: UserRole[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const user = req.user;
    if (!user || !roles.includes(user.role)) {
      res.status(403).json({ error: 'Forbidden' });
      return;
    }
    next();
  };
}
