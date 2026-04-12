import { FastifyRequest, FastifyReply } from 'fastify';
import Redis from 'ioredis';
import { AppError, ErrorCodes } from '../errors';

/**
 * Sliding window rate limiter backed by Redis Lua script.
 * Atomic ZADD + ZREMRANGEBYSCORE + ZCARD in a single round-trip.
 */
const SLIDING_WINDOW_LUA = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])
  local member = ARGV[4]

  redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
  local count = redis.call('ZCARD', key)
  if count >= limit then
    return 0
  end
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return 1
`;

export interface RateLimitConfig {
  redis: Redis;
  windowMs?: number;
  maxRequests?: number;
  keyPrefix?: string;
  keyExtractor?: (request: FastifyRequest) => string;
}

export function createRateLimiter(config: RateLimitConfig) {
  const {
    redis,
    windowMs = 60_000,
    maxRequests = 100,
    keyPrefix = 'rl',
  } = config;

  const keyExtractor = config.keyExtractor ?? defaultKeyExtractor;

  return async function rateLimitHook(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    const identifier = keyExtractor(request);
    const key = `${keyPrefix}:${identifier}`;
    const now = Date.now();
    const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;

    const allowed = await redis.eval(
      SLIDING_WINDOW_LUA,
      1,
      key,
      String(now),
      String(windowMs),
      String(maxRequests),
      member,
    ) as number;

    reply.header('X-RateLimit-Limit', String(maxRequests));
    reply.header('X-RateLimit-Window', String(Math.ceil(windowMs / 1000)));

    if (!allowed) {
      const retryAfter = Math.ceil(windowMs / 1000);
      reply.header('Retry-After', String(retryAfter));
      throw new AppError(
        429,
        'Too many requests',
        ErrorCodes.RATE_LIMITED,
        { retryAfterSeconds: retryAfter },
      );
    }
  };
}

function defaultKeyExtractor(request: FastifyRequest): string {
  const userId = request.headers['x-user-id'] as string | undefined;
  if (userId) return `user:${userId}`;
  const ip = request.ip || request.headers['x-forwarded-for'] || 'unknown';
  return `ip:${ip}`;
}
