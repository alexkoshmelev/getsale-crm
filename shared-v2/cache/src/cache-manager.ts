import { RedisClient } from './redis-client';

export interface CacheOptions {
  ttlSeconds: number;
  prefix?: string;
}

/**
 * Typed cache manager with TTL and invalidation patterns.
 * Wraps RedisClient with typed get/set and invalidation helpers.
 */
export class CacheManager<T = unknown> {
  private redis: RedisClient;
  private ttl: number;
  private prefix: string;

  constructor(redis: RedisClient, options: CacheOptions) {
    this.redis = redis;
    this.ttl = options.ttlSeconds;
    this.prefix = options.prefix ?? 'cache';
  }

  private k(key: string): string {
    return `${this.prefix}:${key}`;
  }

  async get(key: string): Promise<T | null> {
    return this.redis.get<T>(this.k(key));
  }

  async set(key: string, value: T, ttlOverride?: number): Promise<void> {
    await this.redis.set(this.k(key), value, ttlOverride ?? this.ttl);
  }

  async invalidate(key: string): Promise<void> {
    await this.redis.del(this.k(key));
  }

  async invalidatePattern(pattern: string): Promise<number> {
    const keys: string[] = [];
    for await (const key of this.redis.scan(`${this.prefix}:${pattern}`)) {
      keys.push(key);
    }
    if (keys.length === 0) return 0;
    return this.redis.del(...keys);
  }

  /**
   * Get with cache-aside pattern: fetch from cache first, else call loader and cache result.
   */
  async getOrLoad(key: string, loader: () => Promise<T>, ttlOverride?: number): Promise<T> {
    const cached = await this.get(key);
    if (cached !== null) return cached;
    const value = await loader();
    await this.set(key, value, ttlOverride);
    return value;
  }

  /**
   * Batch get — fetches multiple keys in one pipeline call.
   */
  async mget(keys: string[]): Promise<Map<string, T | null>> {
    const pipe = this.redis.pipeline();
    const fullKeys = keys.map((k) => this.k(k));
    for (const fk of fullKeys) {
      pipe.get(fk);
    }
    const results = await pipe.exec();
    const map = new Map<string, T | null>();
    if (!results) return map;
    for (let i = 0; i < keys.length; i++) {
      const [err, val] = results[i];
      if (err || val === null) {
        map.set(keys[i], null);
      } else {
        try { map.set(keys[i], JSON.parse(val as string) as T); } catch { map.set(keys[i], null); }
      }
    }
    return map;
  }
}
