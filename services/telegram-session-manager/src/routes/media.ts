// @ts-nocheck
import { FastifyInstance } from 'fastify';
import { Api } from 'telegram';
import { AppError, ErrorCodes, requireUser, DatabasePools } from '@getsale/service-framework';
import { RedisClient } from '@getsale/cache';
import { RabbitMQClient } from '@getsale/queue';
import { Logger } from '@getsale/logger';
import { SessionCoordinator } from '../coordinator';

interface Deps {
  db: DatabasePools;
  rabbitmq: RabbitMQClient;
  log: Logger;
  redis: RedisClient;
  coordinator: SessionCoordinator;
}

const AVATAR_CACHE_TTL = 3600;       // 1 hour
const MEDIA_CACHE_TTL = 86400;       // 24 hours
const MAX_CACHEABLE_SIZE = 10_485_760; // 10 MB

function cacheKey(type: 'avatar' | 'media', ...parts: string[]): string {
  return `tg:${type}:${parts.join(':')}`;
}

function getConnectedClient(coordinator: SessionCoordinator, accountId: string) {
  const actor = coordinator.getActor(accountId);
  if (!actor) return null;
  const client = actor.getClient();
  if (!client?.connected) return null;
  return client;
}

/**
 * Resolve a Telegram peer using access_hash from bd_account_sync_chats,
 * falling back to getInputEntity with getDialogs priming.
 * Mirrors v1's FileHandler.resolvePeer + peerToInputForProfilePhoto.
 */
async function resolvePeerForMedia(
  client: any,
  db: DatabasePools,
  accountId: string,
  chatId: string,
  log: Logger,
): Promise<any> {
  const numId = Number(chatId);
  const isNumeric = !Number.isNaN(numId);

  const tryIds = [chatId];
  if (isNumeric) {
    if (numId > 0) tryIds.push(String(-1000000000 - numId));
    else if (numId < 0 && numId > -1000000000) tryIds.push(String(-1000000000 + numId));
  }

  for (const tid of tryIds) {
    const r = await db.read.query(
      `SELECT telegram_chat_id, access_hash, peer_type
       FROM bd_account_sync_chats
       WHERE bd_account_id = $1 AND telegram_chat_id = $2
       LIMIT 1`,
      [accountId, tid],
    );
    const row = r.rows[0];
    if (!row?.access_hash) continue;

    const peerType = (row.peer_type || '').toLowerCase();
    const accessHash = BigInt(row.access_hash);
    const storedId = Number(row.telegram_chat_id);

    if (peerType === 'channel') {
      const rawChannelId = Math.abs(storedId) > 1000000000
        ? Math.abs(storedId) - 1000000000
        : storedId;
      return new Api.InputPeerChannel({ channelId: rawChannelId, accessHash });
    }

    if (peerType === 'chat') {
      return new Api.InputPeerChat({ chatId: Math.abs(storedId) });
    }

    if (peerType === 'user') {
      return new Api.InputPeerUser({ userId: storedId, accessHash });
    }
  }

  // Fallback: try GramJS session cache, then prime with getDialogs
  const peerVal = isNumeric ? numId : chatId;
  try {
    return await client.getInputEntity(peerVal);
  } catch {
    log.info({ message: 'getInputEntity failed in media route, priming with getDialogs', accountId, chatId });
    try {
      await client.getDialogs({ limit: 100 });
      return await client.getInputEntity(peerVal);
    } catch {
      // Last resort: try getEntity (for users seen in messages)
      const entity = await client.getEntity(peerVal);
      return await client.getInputEntity(entity);
    }
  }
}

function isEntityNotFoundError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('Could not find the input entity') || msg.includes('PeerUser');
}

export function registerMediaRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, log, redis, coordinator } = deps;

  /**
   * GET /api/bd-accounts/:id/avatar
   */
  app.get('/api/bd-accounts/:id/avatar', { preHandler: [requireUser] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;

    const result = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!result.rows.length) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    const key = cacheKey('avatar', id, 'self');
    const cached = await redis.getBuffer(key);
    if (cached && cached.length > 0) {
      return reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'public, max-age=3600')
        .header('X-Cache', 'HIT')
        .send(cached);
    }

    const client = getConnectedClient(coordinator, id);
    if (!client) {
      throw new AppError(503, 'Account is not connected', ErrorCodes.INTERNAL_ERROR);
    }

    try {
      const buffer = await client.downloadProfilePhoto('me');
      if (!buffer || buffer.length === 0) {
        throw new AppError(404, 'Avatar not available', ErrorCodes.NOT_FOUND);
      }

      const buf = Buffer.from(buffer);
      if (buf.length <= MAX_CACHEABLE_SIZE) {
        await redis.setBuffer(key, buf, AVATAR_CACHE_TTL);
      }

      return reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'public, max-age=3600')
        .header('X-Cache', 'MISS')
        .send(buf);
    } catch (err) {
      if (err instanceof AppError) throw err;
      log.error({ message: `Avatar download failed for account ${id}`, error: String(err) });
      throw new AppError(503, 'Failed to download avatar', ErrorCodes.INTERNAL_ERROR);
    }
  });

  /**
   * GET /api/bd-accounts/:id/chats/:chatId/avatar
   */
  app.get('/api/bd-accounts/:id/chats/:chatId/avatar', { preHandler: [requireUser] }, async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const user = request.user!;

    const result = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!result.rows.length) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    const key = cacheKey('avatar', id, chatId);
    const cached = await redis.getBuffer(key);
    if (cached && cached.length > 0) {
      return reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'public, max-age=3600')
        .header('X-Cache', 'HIT')
        .send(cached);
    }

    const client = getConnectedClient(coordinator, id);
    if (!client) {
      throw new AppError(503, 'Account is not connected', ErrorCodes.INTERNAL_ERROR);
    }

    try {
      const peer = await resolvePeerForMedia(client, db, id, chatId, log);
      const buffer = await client.downloadProfilePhoto(peer);
      if (!buffer || buffer.length === 0) {
        throw new AppError(404, 'Chat avatar not available', ErrorCodes.NOT_FOUND);
      }

      const buf = Buffer.from(buffer);
      if (buf.length <= MAX_CACHEABLE_SIZE) {
        await redis.setBuffer(key, buf, AVATAR_CACHE_TTL);
      }

      return reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'public, max-age=3600')
        .header('X-Cache', 'MISS')
        .send(buf);
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (isEntityNotFoundError(err)) {
        log.info({ message: `Chat avatar entity not resolvable for ${chatId}`, accountId: id });
        throw new AppError(404, 'Chat avatar not available', ErrorCodes.NOT_FOUND);
      }
      log.error({ message: `Chat avatar download failed for chat ${chatId}`, error: String(err) });
      throw new AppError(503, 'Failed to download chat avatar', ErrorCodes.INTERNAL_ERROR);
    }
  });

  /**
   * GET /api/bd-accounts/:id/media
   */
  app.get('/api/bd-accounts/:id/media', { preHandler: [requireUser] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const { channelId, messageId } = request.query as { channelId?: string; messageId?: string };

    if (!channelId || !messageId) {
      throw new AppError(400, 'channelId and messageId query params required', ErrorCodes.VALIDATION);
    }

    const result = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!result.rows.length) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    // Check Redis cache — stored as "contentType\n" + binary
    const mediaKey = cacheKey('media', id, channelId, messageId);
    const cached = await redis.getBuffer(mediaKey);
    if (cached && cached.length > 0) {
      const nlIdx = cached.indexOf(0x0a); // newline byte
      if (nlIdx > 0) {
        const ct = cached.subarray(0, nlIdx).toString('utf-8');
        const body = cached.subarray(nlIdx + 1);
        return reply
          .header('Content-Type', ct)
          .header('Cache-Control', 'public, max-age=86400')
          .header('X-Cache', 'HIT')
          .send(body);
      }
    }

    const client = getConnectedClient(coordinator, id);
    if (!client) {
      throw new AppError(503, 'Account is not connected', ErrorCodes.INTERNAL_ERROR);
    }

    try {
      const peer = await resolvePeerForMedia(client, db, id, channelId, log);
      const messages = await client.getMessages(peer, { ids: [Number(messageId)] });

      if (!messages?.length || !messages[0]?.media) {
        throw new AppError(404, 'Message or media not found', ErrorCodes.NOT_FOUND);
      }

      const buffer = await client.downloadMedia(messages[0]);
      if (!buffer || buffer.length === 0) {
        throw new AppError(404, 'Media content is empty', ErrorCodes.NOT_FOUND);
      }

      const contentType = resolveMediaContentType(messages[0]);
      const buf = Buffer.from(buffer);

      if (buf.length <= MAX_CACHEABLE_SIZE) {
        const header = Buffer.from(contentType + '\n', 'utf-8');
        const combined = Buffer.concat([header, buf]);
        await redis.setBuffer(mediaKey, combined, MEDIA_CACHE_TTL);
      }

      return reply
        .header('Content-Type', contentType)
        .header('Cache-Control', 'public, max-age=86400')
        .header('X-Cache', 'MISS')
        .send(buf);
    } catch (err) {
      if (err instanceof AppError) throw err;
      if (isEntityNotFoundError(err)) {
        log.info({ message: `Media entity not resolvable for channel ${channelId}`, accountId: id });
        throw new AppError(404, 'Media not available — peer entity not found', ErrorCodes.NOT_FOUND);
      }
      log.error({
        message: `Media download failed for account ${id}, channel ${channelId}, message ${messageId}`,
        error: String(err),
      });
      throw new AppError(503, 'Failed to download media', ErrorCodes.INTERNAL_ERROR);
    }
  });
}

function resolveMediaContentType(message: any): string {
  const media = message?.media;
  if (!media) return 'application/octet-stream';

  if (media.photo || media instanceof Api.MessageMediaPhoto || media?.className === 'MessageMediaPhoto') {
    return 'image/jpeg';
  }
  if (media.document) {
    const mimeType = media.document.mimeType;
    if (mimeType) return mimeType;
  }

  return 'application/octet-stream';
}
