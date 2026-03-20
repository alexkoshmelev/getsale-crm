import Redis from 'ioredis';
import { createLogger, Logger } from '@getsale/logger';

export class RedisClient {
  private client: Redis;
  private log: Logger;

  constructor(url: string, log?: Logger) {
    this.log = log ?? createLogger('redis');
    this.client = new Redis(url, {
      retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
      },
      maxRetriesPerRequest: 3,
    });

    this.client.on('error', (err) => {
      this.log.error({ message: 'Redis client error', error: String(err) });
    });

    this.client.on('connect', () => {
      this.log.info({ message: 'Redis client connected' });
    });
  }

  /** Check connection (for readiness probes). */
  async ping(): Promise<void> {
    await this.client.ping();
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await this.client.get(key);
    if (!value) return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return value as T;
    }
  }

  async set(
    key: string,
    value: any,
    ttlSeconds?: number
  ): Promise<void> {
    const serialized = typeof value === 'string' ? value : JSON.stringify(value);
    if (ttlSeconds) {
      await this.client.setex(key, ttlSeconds, serialized);
    } else {
      await this.client.set(key, serialized);
    }
  }

  async del(key: string): Promise<void> {
    await this.client.del(key);
  }

  /** Increment key (atomic), set TTL if provided. Returns new count. Use for rate limiting. */
  async incr(key: string, ttlSeconds?: number): Promise<number> {
    const count = await this.client.incr(key);
    if (ttlSeconds != null && count === 1) {
      await this.client.expire(key, ttlSeconds);
    }
    return count;
  }

  /** Publish message to a channel (for server-sent events / push to user). */
  async publish(channel: string, message: string): Promise<void> {
    await this.client.publish(channel, message);
  }

  /** Acquire a distributed lock: SET key value NX EX ttlSeconds. Returns true if lock acquired. */
  async tryLock(key: string, value: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.client.set(key, value, 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  /** Refresh lock TTL only if we still own it (key value equals expected). Returns true if refreshed. */
  async refreshLock(key: string, expectedValue: string, ttlSeconds: number): Promise<boolean> {
    const cur = await this.client.get(key);
    if (cur !== expectedValue) return false;
    await this.client.setex(key, ttlSeconds, expectedValue);
    return true;
  }

  async exists(key: string): Promise<boolean> {
    const result = await this.client.exists(key);
    return result === 1;
  }

  async expire(key: string, seconds: number): Promise<void> {
    await this.client.expire(key, seconds);
  }

  async keys(pattern: string): Promise<string[]> {
    return this.client.keys(pattern);
  }

  async flush(): Promise<void> {
    await this.client.flushdb();
  }

  disconnect(): void {
    this.client.disconnect();
  }

  /**
   * Separate ioredis connection for SUBSCRIBE (must not share the command connection).
   * Caller must unsubscribe and disconnect on teardown (e.g. SSE client close).
   */
  duplicateSubscriber(): Redis {
    return this.client.duplicate();
  }
}

