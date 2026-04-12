import Redis from 'ioredis';
import { RedisClient } from './redis-client';

/**
 * Atomically HINCRBY unreadCount and INCR the inbox counter only on 0→1 transition.
 * KEYS[1] = conv meta hash, KEYS[2] = inbox unread counter
 */
const INCR_UNREAD_LUA = `
  local prev = tonumber(redis.call('HGET', KEYS[1], 'unreadCount')) or 0
  redis.call('HINCRBY', KEYS[1], 'unreadCount', 1)
  if prev == 0 then
    redis.call('INCR', KEYS[2])
  end
  return prev
`;

/**
 * Atomically reset conversation unreadCount and DECR the inbox counter if it was > 0.
 * KEYS[1] = conv meta hash, KEYS[2] = inbox unread counter
 */
const MARK_READ_LUA = `
  local prev = tonumber(redis.call('HGET', KEYS[1], 'unreadCount')) or 0
  redis.call('HSET', KEYS[1], 'unreadCount', '0')
  if prev > 0 then
    local cnt = redis.call('DECR', KEYS[2])
    if cnt < 0 then
      redis.call('SET', KEYS[2], '0')
    end
  end
  return prev
`;

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

  private unreadCountKey(orgId: string, userId: string): string {
    return `inbox:${orgId}:${userId}:unread_count`;
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

    pipe.expire(metaK, 86400 * 7);

    await pipe.exec();

    if (params.incrementUnread) {
      const counterKey = this.unreadCountKey(orgId, userId);
      await this.redis.raw.eval(INCR_UNREAD_LUA, 2, metaK, counterKey);
    }
  }

  /**
   * Mark conversation as read (reset unread counter and decrement inbox counter atomically).
   */
  async markRead(orgId: string, userId: string, conversationId: string): Promise<void> {
    const counterKey = this.unreadCountKey(orgId, userId);
    await this.redis.raw.eval(MARK_READ_LUA, 2, this.metaKey(conversationId), counterKey);
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
   * O(1) total unread conversation count — reads the incrementally maintained counter.
   */
  async getTotalUnread(orgId: string, userId: string): Promise<number> {
    const val = await this.redis.raw.get(this.unreadCountKey(orgId, userId));
    return Math.max(0, parseInt(val || '0', 10));
  }

  /**
   * Rebuild unread counter from scratch by scanning all conversations.
   * Use for repair after inconsistencies (e.g. missed decrements, Redis flush).
   */
  async rebuildUnreadCount(orgId: string, userId: string): Promise<number> {
    const key = this.inboxKey(orgId, userId);
    const convIds = await this.redis.raw.zrevrange(key, 0, -1);

    let count = 0;
    if (convIds.length > 0) {
      const pipe = this.redis.pipeline();
      for (const cid of convIds) {
        pipe.hget(this.metaKey(cid), 'unreadCount');
      }
      const results = await pipe.exec();
      for (const [err, val] of results!) {
        if (!err && val && parseInt(val as string, 10) > 0) {
          count++;
        }
      }
    }

    await this.redis.raw.set(this.unreadCountKey(orgId, userId), String(count));
    return count;
  }

  /**
   * Remove a conversation from user's inbox, adjusting the unread counter if needed.
   */
  async removeFromInbox(orgId: string, userId: string, conversationId: string): Promise<void> {
    const unread = await this.redis.raw.hget(this.metaKey(conversationId), 'unreadCount');
    const pipe = this.redis.pipeline();
    pipe.zrem(this.inboxKey(orgId, userId), conversationId);
    if (unread && parseInt(unread, 10) > 0) {
      pipe.decr(this.unreadCountKey(orgId, userId));
    }
    await pipe.exec();
  }
}
