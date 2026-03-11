import type { Request, Response, NextFunction } from 'express';
import type { RedisClient } from '@getsale/utils';
import { RATE_LIMIT_AUTH, RATE_LIMIT_ANON } from './config';

const RATE_LIMIT_WINDOW_SEC = 60;

export function createRateLimit(redis: RedisClient) {
  return async function rateLimit(req: Request, res: Response, next: NextFunction): Promise<void> {
    const user = req.user;
    const limit = user?.id ? RATE_LIMIT_AUTH : RATE_LIMIT_ANON;
    const key = `rate_limit:${user?.id ?? req.ip}:${(Date.now() / 60000) | 0}`;

    const count = await redis.incr(key, RATE_LIMIT_WINDOW_SEC);
    if (count > limit) {
      res.status(429).json({ error: 'Too many requests' });
      return;
    }
    next();
  };
}
