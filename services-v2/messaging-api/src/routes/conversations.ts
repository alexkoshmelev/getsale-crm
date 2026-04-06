import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { EventType, type Event } from '@getsale/events';
import { AppError, ErrorCodes, requireUser } from '@getsale/service-framework';
import type { MessagingDeps } from '../types';

export function registerConversationRoutes(app: FastifyInstance, deps: MessagingDeps): void {
  const { db, rabbitmq, inbox, log } = deps;

  // GET /api/messaging/conversations/:id/messages — list messages for a conversation
  app.get('/api/messaging/conversations/:id/messages', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const { limit = 50, before } = request.query as { limit?: number; before?: string };

    const conv = await db.read.query(
      'SELECT channel_id, bd_account_id FROM conversations WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!conv.rows.length) throw new AppError(404, 'Conversation not found', ErrorCodes.NOT_FOUND);
    const { channel_id, bd_account_id } = conv.rows[0];

    let query = `SELECT * FROM messages WHERE channel_id = $1 AND bd_account_id IS NOT DISTINCT FROM $2 AND organization_id = $3`;
    const params: unknown[] = [channel_id, bd_account_id, user.organizationId];
    let idx = 4;

    if (before) {
      query += ` AND created_at < $${idx}`;
      params.push(before);
      idx++;
    }

    query += ` ORDER BY COALESCE(telegram_date, created_at) DESC LIMIT $${idx}`;
    params.push(Math.min(Number(limit) || 50, 200));

    const result = await db.read.query(query, params);
    return { messages: result.rows.reverse() };
  });

  // GET /api/messaging/conversations/:id — single conversation with contact info enrichment
  app.get('/api/messaging/conversations/:id', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;

    const result = await db.read.query(
      `SELECT c.*,
              ct.first_name, ct.last_name, ct.display_name, ct.username, ct.telegram_id,
              (SELECT COUNT(*)::int FROM messages m
               WHERE m.organization_id = c.organization_id AND m.channel = c.channel
                 AND m.channel_id = c.channel_id AND m.bd_account_id IS NOT DISTINCT FROM c.bd_account_id
                 AND m.unread = true AND m.direction = 'inbound') AS unread_count,
              (SELECT COALESCE(NULLIF(TRIM(m2.content), ''), '[Media]')
               FROM messages m2
               WHERE m2.organization_id = c.organization_id AND m2.channel = c.channel
                 AND m2.channel_id = c.channel_id AND m2.bd_account_id IS NOT DISTINCT FROM c.bd_account_id
               ORDER BY COALESCE(m2.telegram_date, m2.created_at) DESC LIMIT 1) AS last_message,
              (SELECT MAX(COALESCE(m3.telegram_date, m3.created_at))
               FROM messages m3
               WHERE m3.organization_id = c.organization_id AND m3.channel = c.channel
                 AND m3.channel_id = c.channel_id AND m3.bd_account_id IS NOT DISTINCT FROM c.bd_account_id) AS last_message_at,
              ba.phone_number AS bd_account_phone,
              ba.connection_state AS bd_account_status
       FROM conversations c
       LEFT JOIN contacts ct ON c.contact_id = ct.id
       LEFT JOIN bd_accounts ba ON c.bd_account_id = ba.id
       WHERE c.id = $1 AND c.organization_id = $2`,
      [id, user.organizationId],
    );
    if (!result.rows.length) throw new AppError(404, 'Conversation not found', ErrorCodes.NOT_FOUND);
    return result.rows[0];
  });

  // POST /api/messaging/conversations/:id/read — mark conversation read + Telegram read receipt
  app.post('/api/messaging/conversations/:id/read', { preHandler: [requireUser] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;

    const conv = await db.read.query(
      'SELECT channel_id, bd_account_id, channel FROM conversations WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (conv.rows.length) {
      const { channel_id, bd_account_id, channel } = conv.rows[0] as {
        channel_id: string;
        bd_account_id: string | null;
        channel: string;
      };

      await db.write.query(
        `UPDATE messages SET unread = false, updated_at = NOW()
         WHERE channel_id = $1 AND bd_account_id IS NOT DISTINCT FROM $2 AND organization_id = $3 AND unread = true AND direction = 'inbound'`,
        [channel_id, bd_account_id, user.organizationId],
      );

      await db.write.query(
        'UPDATE conversations SET last_viewed_at = NOW(), updated_at = NOW() WHERE id = $1 AND organization_id = $2',
        [id, user.organizationId],
      );

      if (bd_account_id && channel === 'telegram') {
        syncReadHistoryToTelegram(deps, {
          userId: user.id,
          organizationId: user.organizationId,
          bdAccountId: bd_account_id,
          channelId: channel_id,
        });
      }
    }

    await inbox.markRead(id);

    rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.MESSAGE_READ, timestamp: new Date(),
      organizationId: user.organizationId, userId: user.id,
      data: { conversationId: id },
    } as Event).catch(() => {});

    reply.code(204).send();
  });
}

function syncReadHistoryToTelegram(
  deps: Pick<MessagingDeps, 'db' | 'rabbitmq' | 'log'>,
  ctx: { userId: string; organizationId: string; bdAccountId: string; channelId: string },
): void {
  const { db, rabbitmq, log } = deps;

  setImmediate(async () => {
    try {
      const maxRow = await db.read.query<{ max_id: string | null }>(
        `SELECT MAX(telegram_message_id::bigint)::text AS max_id FROM messages
         WHERE organization_id = $1 AND channel = 'telegram' AND channel_id = $2 AND direction = 'inbound'
           AND telegram_message_id IS NOT NULL AND telegram_message_id ~ '^[0-9]+$'`,
        [ctx.organizationId, ctx.channelId],
      );
      const maxIdRaw = maxRow.rows[0]?.max_id;
      const parsedMax = maxIdRaw != null ? parseInt(maxIdRaw, 10) : NaN;
      if (!Number.isFinite(parsedMax) || parsedMax <= 0) return;

      const commandQueue = `telegram:commands:${ctx.bdAccountId}`;
      await rabbitmq.publishCommand(commandQueue, {
        type: 'MARK_READ',
        id: randomUUID(),
        priority: 5,
        payload: { channelId: ctx.channelId, messageIds: [parsedMax] },
      });
    } catch (err) {
      log.warn({
        message: 'Failed to sync read history to Telegram',
        error: String(err),
        bdAccountId: ctx.bdAccountId,
        channelId: ctx.channelId,
      });
    }
  });
}
