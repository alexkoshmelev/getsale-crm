import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { EventType, type Event } from '@getsale/events';
import { AppError, ErrorCodes, requireUser } from '@getsale/service-framework';
import type { MessagingDeps } from '../types';

const ALLOWED_EMOJI = ['👍', '👎', '❤️', '🔥', '👏', '😄', '😮', '😢', '🙏'];

function publishMarkReadToTelegram(
  deps: Pick<MessagingDeps, 'db' | 'rabbitmq' | 'log'>,
  ctx: { userId: string; organizationId: string; channel: string; channelId: string },
): void {
  const { db, rabbitmq, log } = deps;
  const { userId, organizationId, channel, channelId } = ctx;

  setImmediate(async () => {
    try {
      const accRow = await db.read.query<{ bd_account_id: string }>(
        `SELECT DISTINCT bd_account_id::text AS bd_account_id FROM messages
         WHERE organization_id = $1 AND channel = $2 AND channel_id = $3 AND bd_account_id IS NOT NULL
         LIMIT 1`,
        [organizationId, channel, channelId],
      );
      const bdAccountId = accRow.rows[0]?.bd_account_id;
      if (!bdAccountId) return;

      const maxRow = await db.read.query<{ max_id: string | null }>(
        `SELECT MAX(telegram_message_id::bigint)::text AS max_id FROM messages
         WHERE organization_id = $1 AND channel = $2 AND channel_id = $3 AND direction = 'inbound'
           AND telegram_message_id IS NOT NULL AND telegram_message_id ~ '^[0-9]+$'`,
        [organizationId, channel, channelId],
      );
      const maxIdRaw = maxRow.rows[0]?.max_id;
      const parsedMax = maxIdRaw != null ? parseInt(maxIdRaw, 10) : NaN;

      const messageIds = Number.isFinite(parsedMax) && parsedMax > 0 ? [parsedMax] : [];
      if (messageIds.length === 0) return;

      const commandQueue = `telegram:commands:${bdAccountId}`;
      await rabbitmq.publishCommand(commandQueue, {
        type: 'MARK_READ',
        id: randomUUID(),
        priority: 5,
        payload: { channelId, messageIds },
      });
    } catch (err) {
      log.warn({ message: 'Failed to sync read history to Telegram', error: String(err), channelId });
    }
  });
}

export function registerMessageActionRoutes(app: FastifyInstance, deps: MessagingDeps): void {
  const { db, rabbitmq, inbox, log } = deps;

  // GET /api/messaging/messages — list messages with full v1-compatible filters
  app.get('/api/messaging/messages', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const {
      limit = 50,
      page = 1,
      offset,
      channelId,
      bdAccountId,
      contactId,
      channel,
      direction,
      search,
      type,
      dateFrom,
      dateTo,
      before,
    } = request.query as Record<string, string | number | undefined>;

    const safeLimit = Math.min(Number(limit) || 50, 200);
    const safePage = Math.max(1, Number(page) || 1);
    const safeOffset = offset != null ? (Number(offset) || 0) : (safePage - 1) * safeLimit;

    let whereClause = 'WHERE m.organization_id = $1';
    const params: unknown[] = [user.organizationId];
    let idx = 2;

    if (channelId) {
      whereClause += ` AND m.channel_id = $${idx}`;
      params.push(String(channelId));
      idx++;
    }
    if (bdAccountId) {
      whereClause += ` AND m.bd_account_id = $${idx}`;
      params.push(String(bdAccountId));
      idx++;
    }
    if (contactId) {
      whereClause += ` AND m.contact_id = $${idx}`;
      params.push(String(contactId));
      idx++;
    }
    if (channel) {
      whereClause += ` AND m.channel = $${idx}`;
      params.push(String(channel));
      idx++;
    }
    if (direction) {
      whereClause += ` AND m.direction = $${idx}`;
      params.push(String(direction));
      idx++;
    }
    if (search && String(search).trim().length >= 2) {
      whereClause += ` AND m.content ILIKE $${idx}`;
      params.push(`%${String(search).trim()}%`);
      idx++;
    }
    if (type) {
      const msgType = String(type).toLowerCase();
      if (msgType === 'media') {
        whereClause += ` AND m.telegram_media IS NOT NULL`;
      } else if (msgType === 'link') {
        whereClause += ` AND m.content ~* 'https?://'`;
      } else if (msgType === 'text') {
        whereClause += ` AND m.telegram_media IS NULL`;
      }
    }
    if (dateFrom) {
      whereClause += ` AND COALESCE(m.telegram_date, m.created_at) >= $${idx}`;
      params.push(String(dateFrom));
      idx++;
    }
    if (dateTo) {
      whereClause += ` AND COALESCE(m.telegram_date, m.created_at) <= $${idx}`;
      params.push(String(dateTo));
      idx++;
    }
    if (before) {
      whereClause += ` AND m.created_at < $${idx}`;
      params.push(String(before));
      idx++;
    }

    const countResult = await db.read.query(
      `SELECT COUNT(*)::int AS total FROM messages m ${whereClause}`,
      params,
    );
    const total = Number(countResult.rows[0]?.total ?? 0);

    const dataParams = [...params, safeLimit, safeOffset];
    const dataQuery = `SELECT m.* FROM messages m ${whereClause} ORDER BY COALESCE(m.telegram_date, m.created_at) DESC LIMIT $${idx} OFFSET $${idx + 1}`;
    const result = await db.read.query(dataQuery, dataParams);
    const rows = result.rows.reverse();

    return {
      messages: rows,
      pagination: { total, page: safePage, limit: safeLimit, totalPages: Math.max(1, Math.ceil(total / safeLimit)) },
      historyExhausted: rows.length < safeLimit,
    };
  });

  // GET /api/messaging/messages/:id — single message by ID
  app.get('/api/messaging/messages/:id', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const result = await db.read.query(
      'SELECT * FROM messages WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!result.rows.length) {
      throw new AppError(404, 'Message not found', ErrorCodes.NOT_FOUND);
    }
    return result.rows[0];
  });

  // PATCH /api/messaging/messages/:id/read — mark single message as read
  app.patch('/api/messaging/messages/:id/read', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const before = await db.read.query<{ channel: string; channel_id: string }>(
      'SELECT channel, channel_id FROM messages WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );

    await db.write.query(
      'UPDATE messages SET unread = false, updated_at = NOW() WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );

    const row = before.rows[0];
    if (row) {
      publishMarkReadToTelegram(deps, {
        userId: user.id,
        organizationId: user.organizationId,
        channel: row.channel,
        channelId: row.channel_id,
      });
    }
    return { success: true };
  });

  // POST /api/messaging/mark-read — mark all messages read by channel+channelId (v1 parity)
  app.post('/api/messaging/mark-read', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { channel, channelId } = request.body as { channel?: string; channelId?: string };

    if (!channel || !channelId) {
      throw new AppError(400, 'channel and channelId are required', ErrorCodes.VALIDATION);
    }

    await db.write.query(
      `UPDATE messages SET unread = false, updated_at = NOW()
       WHERE organization_id = $1 AND channel = $2 AND channel_id = $3`,
      [user.organizationId, channel, channelId],
    );

    publishMarkReadToTelegram(deps, {
      userId: user.id,
      organizationId: user.organizationId,
      channel,
      channelId,
    });

    return { success: true };
  });

  // POST /api/messaging/chats/:chatId/mark-all-read — mark all messages in chat as read
  app.post('/api/messaging/chats/:chatId/mark-all-read', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { chatId } = request.params as { chatId: string };
    const { channel: channelRaw } = request.query as { channel?: string };
    const channel = typeof channelRaw === 'string' ? channelRaw : '';

    if (!channel) {
      throw new AppError(400, 'channel query parameter is required', ErrorCodes.VALIDATION);
    }

    const conv = await db.read.query(
      'SELECT id, channel_id, bd_account_id FROM conversations WHERE channel_id = $1 AND organization_id = $2 ORDER BY updated_at DESC LIMIT 1',
      [chatId, user.organizationId],
    );

    let channelId = chatId;
    let bdAccountId: string | null = null;
    let conversationId: string | null = null;

    if (conv.rows.length) {
      channelId = conv.rows[0].channel_id;
      bdAccountId = conv.rows[0].bd_account_id;
      conversationId = conv.rows[0].id;
    }

    let markQuery = `UPDATE messages SET unread = false, updated_at = NOW() WHERE channel_id = $1 AND organization_id = $2 AND unread = true`;
    const markParams: unknown[] = [channelId, user.organizationId];
    if (bdAccountId) {
      markQuery += ` AND bd_account_id = $3`;
      markParams.push(bdAccountId);
    }
    if (channel) {
      markQuery += ` AND channel = $${markParams.length + 1}`;
      markParams.push(channel);
    }
    await db.write.query(markQuery, markParams);

    if (conversationId) await inbox.markRead(user.organizationId, user.id, conversationId);

    publishMarkReadToTelegram(deps, {
      userId: user.id,
      organizationId: user.organizationId,
      channel,
      channelId,
    });

    rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.MESSAGE_READ,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { conversationId: conversationId ?? chatId },
    } as Event).catch(() => {});

    return { success: true };
  });

  // PATCH /api/messaging/messages/:id/reaction — toggle reaction (v1 parity: dedicated columns + Telegram sync)
  app.patch('/api/messaging/messages/:id/reaction', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const body = request.body as { reaction?: string; emoji?: string };
    const emoji = (body.emoji || body.reaction || '').trim();

    if (!emoji || emoji.length > 10) {
      throw new AppError(400, 'Invalid emoji', ErrorCodes.VALIDATION);
    }
    if (!ALLOWED_EMOJI.includes(emoji)) {
      throw new AppError(400, 'Emoji not allowed', ErrorCodes.VALIDATION);
    }

    const msgResult = await db.read.query(
      'SELECT id, reactions, our_reactions, bd_account_id, channel_id, telegram_message_id FROM messages WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!msgResult.rows.length) {
      throw new AppError(404, 'Message not found', ErrorCodes.NOT_FOUND);
    }
    const row = msgResult.rows[0] as {
      id: string;
      reactions: Record<string, number> | null;
      our_reactions: string[] | null;
      bd_account_id: string | null;
      channel_id: string;
      telegram_message_id: string | number | null;
    };

    const current = row.reactions || {};
    const prevCount = current[emoji] || 0;
    const next: Record<string, number> = { ...current };
    const currentOurs: string[] = Array.isArray(row.our_reactions) ? row.our_reactions : [];
    let newOurs: string[];

    if (prevCount > 0) {
      if (prevCount === 1) delete next[emoji];
      else next[emoji] = prevCount - 1;
      newOurs = currentOurs.filter((e) => e !== emoji);
    } else {
      next[emoji] = prevCount + 1;
      newOurs = [...currentOurs.filter((e) => e !== emoji), emoji].slice(0, 3);
    }

    await db.write.query(
      'UPDATE messages SET reactions = $1, our_reactions = $2, updated_at = NOW() WHERE id = $3 AND organization_id = $4',
      [JSON.stringify(next), JSON.stringify(newOurs), id, user.organizationId],
    );

    if (row.bd_account_id && row.channel_id && row.telegram_message_id) {
      const commandQueue = `telegram:commands:${row.bd_account_id}`;
      rabbitmq.publishCommand(commandQueue, {
        type: 'SEND_REACTION',
        id: randomUUID(),
        priority: 5,
        payload: {
          channelId: row.channel_id,
          telegramMessageId: Number(row.telegram_message_id),
          reactions: newOurs,
        },
      }).catch((err) => {
        log.warn({ message: 'Failed to sync reaction to Telegram', error: String(err) });
      });
    }

    const updated = await db.read.query('SELECT * FROM messages WHERE id = $1', [id]);
    return updated.rows[0];
  });

  // DELETE /api/messaging/messages/:id — delete from Telegram + hard delete locally (v1 parity)
  app.delete('/api/messaging/messages/:id', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const existing = await db.read.query(
      'SELECT id, bd_account_id, channel_id, telegram_message_id FROM messages WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!existing.rows.length) {
      throw new AppError(404, 'Message not found', ErrorCodes.NOT_FOUND);
    }

    const msg = existing.rows[0] as {
      id: string;
      bd_account_id: string | null;
      channel_id: string;
      telegram_message_id: string | number | null;
    };

    if (msg.bd_account_id && msg.telegram_message_id != null) {
      const telegramMessageId = typeof msg.telegram_message_id === 'string'
        ? parseInt(msg.telegram_message_id, 10)
        : msg.telegram_message_id;

      const commandQueue = `telegram:commands:${msg.bd_account_id}`;
      rabbitmq.publishCommand(commandQueue, {
        type: 'DELETE_MESSAGE',
        id: randomUUID(),
        priority: 5,
        payload: {
          channelId: msg.channel_id,
          telegramMessageId: Number.isNaN(telegramMessageId) ? Number(msg.telegram_message_id) : telegramMessageId,
        },
      }).catch((err) => {
        log.warn({ message: 'Failed to publish delete command to Telegram', error: String(err) });
      });
    }

    await db.write.query(
      'DELETE FROM messages WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );

    const ev = {
      id: randomUUID(),
      type: EventType.MESSAGE_DELETED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      correlationId: request.correlationId,
      data: {
        messageId: msg.id,
        bdAccountId: msg.bd_account_id || '',
        channelId: msg.channel_id,
        telegramMessageId: msg.telegram_message_id != null ? Number(msg.telegram_message_id) : undefined,
      },
    } as unknown as Event;
    rabbitmq.publishEvent(ev).catch(() => {});

    return { success: true };
  });
}
