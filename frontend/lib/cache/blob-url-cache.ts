import { reportWarning } from '../error-reporter';

/**
 * LRU cache for blob URLs (avatars, media).
 * Keys: e.g. "avatar:account:${id}", "avatar:chat:${bdAccountId}:${chatId}", or full media URL.
 * On eviction calls URL.revokeObjectURL to free memory.
 * Max size 500 by default (see UX_MESSAGING_ARCHITECTURE.md).
 */

const DEFAULT_MAX_SIZE = 500;

class BlobUrlCache {
  private map = new Map<string, string>();
  private readonly maxSize: number;

  constructor(maxSize: number = DEFAULT_MAX_SIZE) {
    this.maxSize = maxSize;
  }

  get(key: string): string | undefined {
    const url = this.map.get(key);
    if (url === undefined) return undefined;
    // Touch: move to end (most recently used)
    this.map.delete(key);
    this.map.set(key, url);
    return url;
  }

  set(key: string, blobUrl: string): void {
    if (this.map.has(key)) {
      this.map.delete(key);
    }
    while (this.map.size >= this.maxSize) {
      const firstKey = this.map.keys().next().value as string | undefined;
      if (firstKey === undefined) break;
      const oldUrl = this.map.get(firstKey);
      this.map.delete(firstKey);
      if (oldUrl) {
        try {
          URL.revokeObjectURL(oldUrl);
        } catch (e) {
          reportWarning('URL.revokeObjectURL failed on eviction', { error: e, key: firstKey });
        }
      }
    }
    this.map.set(key, blobUrl);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Remove one entry and revoke its URL. Use when you know the URL is no longer needed. */
  delete(key: string): void {
    const url = this.map.get(key);
    this.map.delete(key);
    if (url) {
      try {
        URL.revokeObjectURL(url);
      } catch (e) {
        reportWarning('URL.revokeObjectURL failed on delete', { error: e, key });
      }
    }
  }

  get size(): number {
    return this.map.size;
  }
}

export const blobUrlCache = new BlobUrlCache(DEFAULT_MAX_SIZE);

/** Cache key for BD account avatar */
export function avatarAccountKey(accountId: string): string {
  return `avatar:account:${accountId}`;
}

/** Cache key for chat avatar */
export function avatarChatKey(bdAccountId: string, chatId: string): string {
  return `avatar:chat:${bdAccountId}:${chatId}`;
}

const AVATAR_CHAT_MISS_TTL_MS = 10 * 60 * 1000;

/**
 * Remembers recent 404/miss for chat avatars so list remounts do not re-hit GET …/avatar.
 * Keys match {@link avatarChatKey}; entries expire after {@link AVATAR_CHAT_MISS_TTL_MS}.
 */
class AvatarChatMissCache {
  private map = new Map<string, number>();

  isMissing(key: string): boolean {
    const exp = this.map.get(key);
    if (exp == null) return false;
    if (Date.now() > exp) {
      this.map.delete(key);
      return false;
    }
    return true;
  }

  markMissing(key: string): void {
    this.map.set(key, Date.now() + AVATAR_CHAT_MISS_TTL_MS);
  }

  /** Call when a blob loads successfully so a prior miss does not block refetch forever in the same session. */
  clear(key: string): void {
    this.map.delete(key);
  }
}

export const avatarChatMissCache = new AvatarChatMissCache();

/** Cache key for media (use full URL or build from bdAccountId, channelId, messageId) */
export function mediaKey(mediaUrl: string): string {
  return `media:${mediaUrl}`;
}
