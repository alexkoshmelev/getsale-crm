import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { EventType, type Event } from '@getsale/events';
import { AppError, ErrorCodes, requireUser } from '@getsale/service-framework';
import type { MessagingDeps } from '../types';

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

const SendMessageSchema = z.object({
  contactId: z.preprocess(
    (v) => {
      if (v == null) return null;
      const s = typeof v === 'string' ? v.trim() : '';
      if (!s) return null;
      const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      return uuidRe.test(s) ? s : null;
    },
    z.string().uuid().optional().nullable(),
  ),
  channel: z.string().default('telegram'),
  channelId: z.string().min(1),
  content: z.string().max(10000).optional().default(''),
  bdAccountId: z.string().uuid(),
  fileBase64: z.string().optional().nullable(),
  fileName: z.string().optional().nullable(),
  replyToMessageId: z.union([z.string(), z.number()]).optional().nullable(),
  source: z.string().optional().nullable(),
  idempotencyKey: z.string().optional().nullable(),
  usernameHint: z.string().optional().nullable(),
  // v2-compat aliases
  conversationId: z.string().uuid().optional(),
  text: z.string().max(10000).optional(),
});

export function registerSendRoutes(app: FastifyInstance, deps: MessagingDeps): void {
  const { db, rabbitmq, log } = deps;

  app.post('/api/messaging/send', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const body = SendMessageSchema.parse(request.body);

    const channelId = body.channelId;
    const bdAccountId = body.bdAccountId;
    const channel = body.channel || 'telegram';
    const content = body.content || body.text || '';
    const contactId = body.contactId || null;
    const source = body.source || null;
    const idempotencyKey = body.idempotencyKey?.trim() || null;
    const replyToTgId = body.replyToMessageId != null ? String(body.replyToMessageId).trim() : null;
    const fileBase64 = body.fileBase64 || null;
    const fileName = body.fileName || null;

    if (channel !== 'telegram') {
      throw new AppError(400, 'Only telegram channel is supported', ErrorCodes.VALIDATION);
    }

    if (!bdAccountId) {
      throw new AppError(400, 'bdAccountId is required for Telegram messages', ErrorCodes.VALIDATION);
    }

    if (fileBase64) {
      const estimatedBytes = (fileBase64.length * 3) / 4;
      if (estimatedBytes > MAX_FILE_SIZE_BYTES) {
        return reply.code(413).send({ error: 'File too large', message: 'Maximum file size is 2 GB.' });
      }
    }

    let contactIdResolved = contactId;

    if (!contactIdResolved && /^\d+$/.test(channelId.trim())) {
      const byTg = await db.read.query(
        'SELECT id FROM contacts WHERE organization_id = $1 AND telegram_id = $2 LIMIT 1',
        [user.organizationId, channelId.trim()],
      );
      if (byTg.rows.length) {
        contactIdResolved = (byTg.rows[0] as { id: string }).id;
      }
    }

    if (contactIdResolved) {
      const contactCheck = await db.read.query(
        'SELECT id FROM contacts WHERE id = $1 AND organization_id = $2',
        [contactIdResolved, user.organizationId],
      );
      if (!contactCheck.rows.length) {
        throw new AppError(404, 'Contact not found', ErrorCodes.NOT_FOUND);
      }
    }

    if (source === 'campaign' && idempotencyKey) {
      const existing = await db.read.query(
        `SELECT * FROM messages
         WHERE organization_id = $1 AND bd_account_id = $2 AND channel = $3
           AND channel_id = $4 AND direction = 'outbound'
           AND metadata->>'idempotencyKey' = $5
         ORDER BY created_at DESC LIMIT 1`,
        [user.organizationId, bdAccountId, channel, channelId, idempotencyKey],
      );
      if (existing.rows.length) {
        return existing.rows[0];
      }
    }

    const contentForDb = content || (fileName ? `[File: ${fileName}]` : '[Media]');
    const messageId = randomUUID();

    const metadata: Record<string, unknown> = {
      sentBy: user.id,
      source,
    };
    if (idempotencyKey) metadata.idempotencyKey = idempotencyKey;

    const insertResult = await db.write.query(
      `INSERT INTO messages (
        id, organization_id, bd_account_id, channel, channel_id, contact_id,
        direction, content, status, unread, metadata, reply_to_telegram_id
      ) VALUES ($1, $2, $3, $4, $5, $6, 'outbound', $7, 'delivered', false, $8, $9)
      RETURNING *`,
      [
        messageId,
        user.organizationId,
        bdAccountId,
        channel,
        channelId,
        contactIdResolved,
        contentForDb,
        JSON.stringify(metadata),
        replyToTgId,
      ],
    );
    const message = insertResult.rows[0];

    const commandQueue = `telegram:commands:${bdAccountId}`;
    rabbitmq.publishCommand(commandQueue, {
      type: 'SEND_MESSAGE',
      id: randomUUID(),
      priority: 8,
      payload: {
        messageId,
        conversationId: body.conversationId || channelId,
        text: content,
        channelId,
        organizationId: user.organizationId,
        userId: user.id,
        contactId: contactIdResolved || undefined,
        replyTo: replyToTgId ? Number(replyToTgId) || undefined : undefined,
        fileBase64: fileBase64 || undefined,
        fileName: fileName || undefined,
        usernameHint: body.usernameHint || undefined,
      },
    }).catch((err) => {
      log.error({ message: 'Failed to publish SEND_MESSAGE command', error: String(err), message_id: messageId });
    });

    setImmediate(async () => {
      try {
        await db.write.query(
          `INSERT INTO conversations (id, organization_id, bd_account_id, channel, channel_id, contact_id, created_at, updated_at)
           VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(), NOW())
           ON CONFLICT (organization_id, bd_account_id, channel, channel_id)
           DO UPDATE SET contact_id = COALESCE(EXCLUDED.contact_id, conversations.contact_id), updated_at = NOW()`,
          [user.organizationId, bdAccountId, channel, channelId, contactIdResolved],
        );

        if (contactIdResolved) {
          await db.write.query(
            `UPDATE conversations c SET lead_id = sub.id, became_lead_at = COALESCE(c.became_lead_at, sub.created_at), updated_at = NOW()
             FROM (SELECT id, created_at FROM leads WHERE organization_id = $1 AND contact_id = $5 ORDER BY created_at DESC LIMIT 1) sub
             WHERE c.organization_id = $1 AND c.bd_account_id IS NOT DISTINCT FROM $2 AND c.channel = $3 AND c.channel_id = $4 AND c.lead_id IS NULL`,
            [user.organizationId, bdAccountId, channel, channelId, contactIdResolved],
          );
        }

        if (source !== 'campaign') {
          await db.write.query(
            `UPDATE conversations SET first_manager_reply_at = COALESCE(first_manager_reply_at, NOW()), updated_at = NOW()
             WHERE organization_id = $1 AND bd_account_id IS NOT DISTINCT FROM $2 AND channel = $3 AND channel_id = $4`,
            [user.organizationId, bdAccountId, channel, channelId],
          );
        }

        const event = {
          id: randomUUID(),
          type: EventType.MESSAGE_SENT,
          timestamp: new Date(),
          organizationId: user.organizationId,
          userId: user.id,
          data: {
            messageId,
            channel,
            channelId,
            contactId: contactIdResolved || undefined,
            bdAccountId,
            content: contentForDb,
            direction: 'outbound',
          },
        } as unknown as Event;
        await rabbitmq.publishEvent(event).catch((err) => {
          log.warn({ message: 'Message sent but publishEvent failed', messageId, error: String(err) });
        });
      } catch (err) {
        log.warn({ message: 'messaging_post_send_async_error', messageId, error: String(err) });
      }
    });

    return message;
  });
}
