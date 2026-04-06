import Redis from 'ioredis';
import { RedisClient } from './redis-client';

/**
 * CQRS inbox read model backed by Redis sorted sets.
 *
 * Data model:
 *   inbox:{orgId}:{userId}   — ZSET, score = timestamp, member = conversationId
 *   conv:{convId}:meta        — HASH, fields: lastMessage, unreadCount, contactName, contactId, updatedAt
 */
export interface ConversationMeta {
  lastMessage: string;
  unreadCount: number;
  contactName: string;
  contactId: string;
  updatedAt: number;
}

export interface InboxEntry {
  conversationId: string;
  score: number;
  meta: ConversationMeta | null;
}

export class InboxModel {
  private redis: RedisClient;

  constructor(redis: RedisClient) {
    this.redis = redis;
  }

  private inboxKey(orgId: string, userId: string): string {
    return `inbox:${orgId}:${userId}`;
  }

  private metaKey(conversationId: string): string {
    return `conv:${conversationId}:meta`;
  }

  /**
   * Update inbox when a message is received or sent.
   * Atomic pipeline: ZADD inbox + HSET conversation metadata.
   */
  async onMessage(params: {
    orgId: string;
    userId: string;
    conversationId: string;
    messagePreview: string;
    contactName: string;
    contactId: string;
    timestamp: number;
    incrementUnread?: boolean;
  }): Promise<void> {
    const { orgId, userId, conversationId, messagePreview, contactName, contactId, timestamp } = params;
    const pipe = this.redis.pipeline();

    pipe.zadd(this.inboxKey(orgId, userId), String(timestamp), conversationId);

    const metaK = this.metaKey(conversationId);
    pipe.hset(metaK, 'lastMessage', messagePreview.slice(0, 200));
    pipe.hset(metaK, 'contactName', contactName);
    pipe.hset(metaK, 'contactId', contactId);
    pipe.hset(metaK, 'updatedAt', String(timestamp));

    if (params.incrementUnread) {
      pipe.hincrby(metaK, 'unreadCount', 1);
    }

    pipe.expire(metaK, 86400 * 7);

    await pipe.exec();
  }

  /**
   * Mark conversation as read (reset unread counter).
   */
  async markRead(conversationId: string): Promise<void> {
    await this.redis.raw.hset(this.metaKey(conversationId), 'unreadCount', '0');
  }

  /**
   * Get inbox page (newest first).
   */
  async getInbox(orgId: string, userId: string, offset = 0, limit = 50): Promise<InboxEntry[]> {
    const key = this.inboxKey(orgId, userId);
    const results = await this.redis.raw.zrevrange(key, offset, offset + limit - 1, 'WITHSCORES');

    const entries: { conversationId: string; score: number }[] = [];
    for (let i = 0; i < results.length; i += 2) {
      entries.push({ conversationId: results[i], score: parseFloat(results[i + 1]) });
    }

    if (entries.length === 0) return [];

    const pipe = this.redis.pipeline();
    for (const entry of entries) {
      pipe.hgetall(this.metaKey(entry.conversationId));
    }
    const metaResults = await pipe.exec();

    return entries.map((entry, i) => {
      const [err, raw] = metaResults![i];
      let meta: ConversationMeta | null = null;
      if (!err && raw && typeof raw === 'object' && Object.keys(raw as object).length > 0) {
        const r = raw as Record<string, string>;
        meta = {
          lastMessage: r.lastMessage || '',
          unreadCount: parseInt(r.unreadCount || '0', 10),
          contactName: r.contactName || '',
          contactId: r.contactId || '',
          updatedAt: parseInt(r.updatedAt || '0', 10),
        };
      }
      return { ...entry, meta };
    });
  }

  /**
   * Get total conversation count for user.
   */
  async getInboxCount(orgId: string, userId: string): Promise<number> {
    return this.redis.raw.zcard(this.inboxKey(orgId, userId));
  }

  /**
   * Get total unread count across all conversations (sum of unread counters).
   */
  async getTotalUnread(orgId: string, userId: string): Promise<number> {
    const key = this.inboxKey(orgId, userId);
    const convIds = await this.redis.raw.zrevrange(key, 0, -1);
    if (convIds.length === 0) return 0;

    const pipe = this.redis.pipeline();
    for (const cid of convIds) {
      pipe.hget(this.metaKey(cid), 'unreadCount');
    }
    const results = await pipe.exec();
    let total = 0;
    for (const [err, val] of results!) {
      if (!err && val) total += parseInt(val as string, 10) || 0;
    }
    return total;
  }

  /**
   * Remove a conversation from user's inbox.
   */
  async removeFromInbox(orgId: string, userId: string, conversationId: string): Promise<void> {
    await this.redis.raw.zrem(this.inboxKey(orgId, userId), conversationId);
  }
}
