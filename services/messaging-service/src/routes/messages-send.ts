import { randomUUID } from 'crypto';
import { Router } from 'express';
import { EventType, MessageSentEvent } from '@getsale/events';
import { MessageChannel, MessageDirection, MessageStatus } from '@getsale/types';
import { asyncHandler, AppError, ErrorCodes, ServiceCallError, validate } from '@getsale/service-core';
import { z } from 'zod';
import { SYSTEM_MESSAGES } from '../system-messages';
import { ensureConversation, MAX_FILE_SIZE_BYTES } from '../helpers';
import type { MessagesRouterDeps } from './messages-deps';

const SendMessageSchema = z.object({
  /** Optional for group/channel chats (e.g. shared chat); required for 1-1. */
  contactId: z.union([z.string().uuid(), z.literal(''), z.null()]).optional().nullable().transform((v) => (v === '' || v == null ? null : v)),
  channel: z.string().min(1).max(64),
  channelId: z.string().min(1).max(128),
  content: z.string().max(100_000).optional(),
  bdAccountId: z.string().uuid().optional().nullable(),
  fileBase64: z.string().optional(),
  fileName: z.string().max(512).optional(),
  replyToMessageId: z.string().max(128).optional().nullable(),
  source: z.string().max(64).optional(),
}).refine((data) => (data.content != null && data.content !== '') || (data.fileBase64 != null && data.fileBase64 !== ''), {
  message: 'Either content or fileBase64 is required',
  path: ['content'],
});

export function registerSendRoutes(router: Router, deps: MessagesRouterDeps): void {
  const { pool, rabbitmq, log, bdAccountsClient } = deps;

  router.post('/send', validate(SendMessageSchema), asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { contactId, channel, channelId, content, bdAccountId, fileBase64, fileName, replyToMessageId, source } = req.body;

    if (fileBase64 && typeof fileBase64 === 'string') {
      const estimatedBytes = (fileBase64.length * 3) / 4;
      if (estimatedBytes > MAX_FILE_SIZE_BYTES) {
        return res.status(413).json({
          error: 'File too large',
          message: 'Maximum file size is 2 GB. Use a smaller file.',
        });
      }
    }

    const contactIdOrNull = contactId ?? null;
    if (contactIdOrNull) {
      const contactResult = await pool.query(
        'SELECT id, organization_id, telegram_id, first_name, last_name, username FROM contacts WHERE id = $1 AND organization_id = $2',
        [contactIdOrNull, organizationId]
      );
      if (contactResult.rows.length === 0) {
        throw new AppError(404, 'Contact not found', ErrorCodes.NOT_FOUND);
      }
    }

    const captionOrContent = typeof content === 'string' ? content : '';
    const contentForDb = captionOrContent || (fileName ? SYSTEM_MESSAGES.FILE_PLACEHOLDER(fileName) : SYSTEM_MESSAGES.MEDIA_PLACEHOLDER);
    const replyToTgId = replyToMessageId != null && String(replyToMessageId).trim() ? String(replyToMessageId).trim() : null;

    await ensureConversation(pool, {
      organizationId,
      bdAccountId: bdAccountId || null,
      channel,
      channelId,
      contactId: contactIdOrNull,
    });

    const result = await pool.query(
      `INSERT INTO messages (organization_id, bd_account_id, channel, channel_id, contact_id, direction, content, status, unread, metadata, reply_to_telegram_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        organizationId,
        bdAccountId || null,
        channel,
        channelId,
        contactIdOrNull,
        MessageDirection.OUTBOUND,
        contentForDb,
        MessageStatus.PENDING,
        false,
        JSON.stringify({ sentBy: userId }),
        replyToTgId,
      ]
    );
    const message = result.rows[0];

    if (source !== 'campaign') {
      await pool.query(
        `UPDATE conversations SET first_manager_reply_at = COALESCE(first_manager_reply_at, NOW()), updated_at = NOW()
         WHERE organization_id = $1 AND bd_account_id IS NOT DISTINCT FROM $2 AND channel = $3 AND channel_id = $4`,
        [organizationId, bdAccountId || null, channel, channelId]
      );
    }

    let sent = false;
    if (channel === MessageChannel.TELEGRAM) {
      if (!bdAccountId) {
        return res.status(400).json({ error: 'bdAccountId is required for Telegram messages' });
      }
      const body: Record<string, string> = {
        chatId: channelId,
        text: captionOrContent,
      };
      if (fileBase64 && typeof fileBase64 === 'string') {
        body.fileBase64 = fileBase64;
        body.fileName = typeof fileName === 'string' ? fileName : 'file';
      }
      if (replyToTgId) {
        body.replyToMessageId = replyToTgId;
      }
      const doSend = () =>
        bdAccountsClient.post<{
          messageId?: string;
          date?: number;
          telegram_media?: Record<string, unknown> | null;
          telegram_entities?: Record<string, unknown>[] | null;
        }>(`/api/bd-accounts/${bdAccountId}/send`, body, undefined, { userId, organizationId });

      let resJson: Awaited<ReturnType<typeof doSend>> | null = null;
      let lastError: unknown = null;
      try {
        resJson = await doSend();
      } catch (error: unknown) {
        const isNotConnected =
          error instanceof ServiceCallError &&
          error.statusCode === 400 &&
          /not connected|account is not connected/i.test(String(error.message));
        if (isNotConnected) {
          await new Promise((r) => setTimeout(r, 2500));
          try {
            resJson = await doSend();
          } catch (retryErr: unknown) {
            lastError = retryErr;
          }
        } else {
          lastError = error;
        }
      }

      if (resJson != null) {
        const tgMessageId = resJson.messageId != null ? String(resJson.messageId).trim() : null;
        const tgDate = resJson.date != null ? new Date(resJson.date * 1000) : null;
        const hasMedia = resJson.telegram_media != null && typeof resJson.telegram_media === 'object';
        const hasEntities = Array.isArray(resJson.telegram_entities);
        if (hasMedia || hasEntities) {
          await pool.query(
            `UPDATE messages SET status = $1, telegram_message_id = $2, telegram_date = $3, telegram_media = $4, telegram_entities = $5 WHERE id = $6`,
            [
              MessageStatus.DELIVERED,
              tgMessageId,
              tgDate,
              hasMedia ? JSON.stringify(resJson.telegram_media) : null,
              hasEntities ? JSON.stringify(resJson.telegram_entities) : null,
              message.id,
            ]
          );
        } else {
          await pool.query(
            `UPDATE messages SET status = $1, telegram_message_id = $2, telegram_date = $3 WHERE id = $4`,
            [MessageStatus.DELIVERED, tgMessageId, tgDate, message.id]
          );
        }
        sent = true;
      } else {
        const error = lastError;
        const errMsg = error instanceof Error ? error.message : String(error);
        log.error({ message: 'Error sending Telegram message', error: errMsg });
        await pool.query('UPDATE messages SET status = $1, metadata = $2 WHERE id = $3', [
          MessageStatus.FAILED,
          JSON.stringify({ error: errMsg }),
          message.id,
        ]);
        const is413 = (error instanceof ServiceCallError && error.statusCode === 413)
          || (errMsg.toLowerCase().includes('too large') || errMsg.includes('2 GB'));
        if (is413) {
          return res.status(413).json({ error: 'File too large', message: 'File too large' });
        }
        if (error instanceof ServiceCallError && error.statusCode >= 400 && error.statusCode < 500) {
          return res.status(error.statusCode).json({
            error: errMsg || 'Bad request',
            message: errMsg || 'Failed to send message',
          });
        }
        const status = error instanceof ServiceCallError && error.statusCode >= 500 ? error.statusCode : 500;
        return res.status(status).json({
          error: status >= 500 ? 'Downstream error' : 'Internal server error',
          message: errMsg || 'Failed to send message',
        });
      }
    }

    if (!sent) {
      return res.status(400).json({ error: 'Unsupported channel or sending failed' });
    }

    const updatedResult = await pool.query('SELECT * FROM messages WHERE id = $1', [message.id]);
    const updatedRow = updatedResult.rows[0] as Record<string, unknown> | undefined;

    const event: MessageSentEvent = {
      id: randomUUID(),
      type: EventType.MESSAGE_SENT,
      timestamp: new Date(),
      organizationId,
      userId,
      correlationId: req.correlationId,
      data: {
        messageId: message.id,
        channel,
        contactId: contactIdOrNull ?? undefined,
        bdAccountId,
        channelId: updatedRow ? String(updatedRow.channel_id ?? '') : undefined,
        content: updatedRow && typeof updatedRow.content === 'string' ? updatedRow.content : undefined,
        direction: 'outbound',
        telegramMessageId: (() => {
          const v = updatedRow?.telegram_message_id;
          return v != null && (typeof v === 'string' || typeof v === 'number') ? v : undefined;
        })(),
        createdAt: updatedRow && updatedRow.created_at != null ? String(updatedRow.created_at) : undefined,
      },
    };
    await rabbitmq.publishEvent(event);

    res.json(updatedRow);
  }));
}
