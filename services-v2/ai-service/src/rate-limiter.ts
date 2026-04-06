import { RedisClient } from '@getsale/cache';

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetInSeconds: number;
}

export class AIRateLimiter {
  private redis: RedisClient;
  private maxPerHour: number;
  private prefix: string;

  constructor(redis: RedisClient, maxPerOrgPerHour = 200) {
    this.redis = redis;
    this.maxPerHour = maxPerOrgPerHour;
    this.prefix = 'ai:rate';
  }

  async check(organizationId: string): Promise<RateLimitResult> {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % 3600);
    const windowKey = `${this.prefix}:${organizationId}:${windowStart}`;

    const current = await this.redis.get<number>(windowKey);
    const count = current ?? 0;

    if (count >= this.maxPerHour) {
      return {
        allowed: false,
        remaining: 0,
        limit: this.maxPerHour,
        resetInSeconds: 3600 - (now % 3600),
      };
    }

    return {
      allowed: true,
      remaining: this.maxPerHour - count - 1,
      limit: this.maxPerHour,
      resetInSeconds: 3600 - (now % 3600),
    };
  }

  async increment(organizationId: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % 3600);
    const key = `${this.prefix}:${organizationId}:${windowStart}`;

    const current = await this.redis.get<number>(key);
    await this.redis.set(key, (current ?? 0) + 1, 3600);
  }

  async getUsage(organizationId: string): Promise<{ used: number; limit: number; resetInSeconds: number }> {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - (now % 3600);
    const key = `${this.prefix}:${organizationId}:${windowStart}`;

    const current = await this.redis.get<number>(key);
    return {
      used: current ?? 0,
      limit: this.maxPerHour,
      resetInSeconds: 3600 - (now % 3600),
    };
  }
}
