import Redis, { type ChainableCommander } from 'ioredis';
import { createLogger, type Logger } from '@getsale/logger';

/**
 * Atomic INCR + PEXPIRE in one round-trip.
 * Returns 1 if under limit, 0 if rate limited.
 */
const RATE_LIMIT_LUA = `
  local key = KEYS[1]
  local limit = tonumber(ARGV[1])
  local window_ms = tonumber(ARGV[2])
  local current = redis.call('INCR', key)
  if current == 1 then
    redis.call('PEXPIRE', key, window_ms)
  end
  if current > limit then
    return 0
  end
  return 1
`;

/**
 * Atomic distributed lock release — only delete if we still own it.
 */
const UNLOCK_LUA = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

export interface RedisClientConfig {
  url?: string;
  log?: Logger;
  keyPrefix?: string;
  maxRetriesPerRequest?: number;
}

export class RedisClient {
  private client: Redis;
  private log: Logger;
  private prefix: string;

  constructor(config?: RedisClientConfig) {
    const url = config?.url || process.env.REDIS_URL || 'redis://localhost:6379';
    this.log = config?.log ?? createLogger('redis');
    this.prefix = config?.keyPrefix ?? '';

    this.client = new Redis(url, {
      retryStrategy: (times) => Math.min(times * 100, 5000),
      maxRetriesPerRequest: config?.maxRetriesPerRequest ?? 3,
      enableReadyCheck: true,
      lazyConnect: false,
    });

    this.client.on('error', (err) => {
      this.log.error({ message: 'Redis error', error: String(err) });
    });
    this.client.on('connect', () => {
      this.log.info({ message: 'Redis connected' });
    });
  }

  get raw(): Redis { return this.client; }

  private k(key: string): string {
    return this.prefix ? `${this.prefix}:${key}` : key;
  }

  async ping(): Promise<void> {
    await this.client.ping();
  }

  async get<T>(key: string): Promise<T | null> {
    const val = await this.client.get(this.k(key));
    if (val === null) return null;
    try { return JSON.parse(val) as T; } catch { return val as unknown as T; }
  }

  async set(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (ttlSeconds) {
      await this.client.setex(this.k(key), ttlSeconds, serialized);
    } else {
      await this.client.set(this.k(key), serialized);
    }
  }

  async del(...keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.del(...keys.map((k) => this.k(k)));
  }

  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const count = await this.client.incr(this.k(key));
    if (ttlSeconds != null && count === 1) {
      await this.client.expire(this.k(key), ttlSeconds);
    }
    return count;
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(this.k(key))) === 1;
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.client.expire(this.k(key), seconds);
  }

  async publish(channel: string, message: string): Promise<void> {
    await this.client.publish(channel, message);
  }

  /**
   * SCAN-based key iterator — safe for production (no blocking KEYS).
   */
  async *scan(pattern: string, count = 100): AsyncGenerator<string> {
    let cursor = '0';
    const fullPattern = this.prefix ? `${this.prefix}:${pattern}` : pattern;
    do {
      const [nextCursor, keys] = await this.client.scan(cursor, 'MATCH', fullPattern, 'COUNT', count);
      cursor = nextCursor;
      for (const key of keys) {
        yield this.prefix ? key.slice(this.prefix.length + 1) : key;
      }
    } while (cursor !== '0');
  }

  async scanAll(pattern: string, count = 100): Promise<string[]> {
    const result: string[] = [];
    for await (const key of this.scan(pattern, count)) {
      result.push(key);
    }
    return result;
  }

  /**
   * Redis pipeline for batching multiple commands.
   */
  pipeline(): ChainableCommander {
    return this.client.pipeline();
  }

  /**
   * Atomic rate limit check. Returns true if request is allowed.
   */
  async checkRateLimit(key: string, limit: number, windowMs: number): Promise<boolean> {
    const result = await this.client.eval(RATE_LIMIT_LUA, 1, this.k(key), String(limit), String(windowMs)) as number;
    return result === 1;
  }

  /**
   * Acquire distributed lock with atomic release support.
   */
  async tryLock(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(this.k(key), value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async releaseLock(key: string, value: string): Promise<boolean> {
    const result = await this.client.eval(UNLOCK_LUA, 1, this.k(key), value) as number;
    return result === 1;
  }

  async refreshLock(key: string, expectedValue: string, ttlSeconds: number): Promise<boolean> {
    const cur = await this.client.get(this.k(key));
    if (cur !== expectedValue) return false;
    await this.client.expire(this.k(key), ttlSeconds);
    return true;
  }

  async getBuffer(key: string): Promise<Buffer | null> {
    return this.client.getBuffer(this.k(key));
  }

  async setBuffer(key: string, value: Buffer, ttlSeconds?: number): Promise<void> {
    if (ttlSeconds) {
      await this.client.setex(this.k(key), ttlSeconds, value);
    } else {
      await this.client.set(this.k(key), value);
    }
  }

  duplicateSubscriber(): Redis {
    return this.client.duplicate();
  }

  disconnect(): void {
    this.client.disconnect();
  }
}
