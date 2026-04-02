import { randomUUID } from 'crypto';
import { Router } from 'express';
import { EventType, MessageSentEvent } from '@getsale/events';
import { MessageChannel, MessageDirection, MessageStatus } from '@getsale/types';
import { asyncHandler, AppError, ErrorCodes, ServiceCallError, validate } from '@getsale/service-core';
import { SYSTEM_MESSAGES } from '../system-messages';
import { ensureConversation, mergeOrphanConversationPeerToCanonical, MAX_FILE_SIZE_BYTES } from '../helpers';
import { MsgSendMessageSchema } from '../validation';
import type { MessagesRouterDeps } from './messages-deps';

export function registerSendRoutes(router: Router, deps: MessagesRouterDeps): void {
  const { pool, rabbitmq, log, bdAccountsClient } = deps;
  const isEntityResolutionError = (error: unknown): boolean => {
    const msg = error instanceof Error ? error.message : String(error);
    const lowered = msg.toLowerCase();
    if (
      lowered.includes('could not find the input entity') ||
      lowered.includes('user or chat not found') ||
      lowered.includes('peer_id_invalid') ||
      lowered.includes('chat_id_invalid')
    ) {
      return true;
    }
    if (error instanceof ServiceCallError && error.body != null && typeof error.body === 'object') {
      const body = error.body as { message?: unknown; error?: unknown };
      const m = typeof body.message === 'string' ? body.message.toLowerCase() : '';
      const e = typeof body.error === 'string' ? body.error.toLowerCase() : '';
      return m.includes('user or chat not found') || e.includes('user or chat not found');
    }
    return false;
  };

  router.post('/send', validate(MsgSendMessageSchema), asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const sendFlowStart = Date.now();
    const {
      contactId,
      channel,
      channelId,
      content,
      bdAccountId,
      fileBase64,
      fileName,
      replyToMessageId,
      source,
      idempotencyKey,
      usernameHint: usernameHintRaw,
    } = req.body;

    if (fileBase64 && typeof fileBase64 === 'string') {
      const estimatedBytes = (fileBase64.length * 3) / 4;
      if (estimatedBytes > MAX_FILE_SIZE_BYTES) {
        return res.status(413).json({
          error: 'File too large',
          message: 'Maximum file size is 2 GB. Use a smaller file.',
        });
      }
    }

    let contactIdOrNull = contactId ?? null;
    let contactUsernameNorm: string | null = null;

    const hintFromRequest =
      typeof usernameHintRaw === 'string' && usernameHintRaw.trim()
        ? usernameHintRaw.trim().replace(/^@/, '')
        : null;

    if (!contactIdOrNull && channel === MessageChannel.TELEGRAM && channelId && /^\d+$/.test(String(channelId).trim())) {
      const byTg = await pool.query(
        `SELECT id, username FROM contacts WHERE organization_id = $1 AND telegram_id = $2 LIMIT 1`,
        [organizationId, String(channelId).trim()]
      );
      if (byTg.rows.length > 0) {
        const row = byTg.rows[0] as { id: string; username?: string | null };
        contactIdOrNull = row.id;
        const u = typeof row.username === 'string' ? row.username.trim().replace(/^@/, '') : '';
        contactUsernameNorm = u || null;
      }
    }

    if (contactIdOrNull) {
      const contactResult = await pool.query(
        'SELECT id, organization_id, telegram_id, first_name, last_name, username FROM contacts WHERE id = $1 AND organization_id = $2',
        [contactIdOrNull, organizationId]
      );
      if (contactResult.rows.length === 0) {
        throw new AppError(404, 'Contact not found', ErrorCodes.NOT_FOUND);
      }
      const contactRow = contactResult.rows[0] as { username?: string | null };
      const usernameRaw = typeof contactRow.username === 'string' ? contactRow.username.trim().replace(/^@/, '') : '';
      if (!contactUsernameNorm && usernameRaw) contactUsernameNorm = usernameRaw;
    }

    const effectiveUsernameHintForBd = contactUsernameNorm || hintFromRequest || null;

    const captionOrContent = typeof content === 'string' ? content : '';
    const contentForDb = captionOrContent || (fileName ? SYSTEM_MESSAGES.FILE_PLACEHOLDER(fileName) : SYSTEM_MESSAGES.MEDIA_PLACEHOLDER);
    const replyToTgId = replyToMessageId != null && String(replyToMessageId).trim() ? String(replyToMessageId).trim() : null;

    // Telegram: send first, persist only after Telegram accepts the message.
    if (channel !== MessageChannel.TELEGRAM) {
      return res.status(400).json({ error: 'Unsupported channel or sending failed' });
    }

    if (!bdAccountId) {
      return res.status(400).json({ error: 'bdAccountId is required for Telegram messages' });
    }

    log.info({
      message: 'telegram_send_flow_start',
      correlation_id: req.correlationId,
      bd_account_id: bdAccountId,
      source: source ?? null,
      has_file: !!(fileBase64 && typeof fileBase64 === 'string'),
    });

    // Campaign idempotency guard: if the same logical send was already persisted, return it.
    if (source === 'campaign' && typeof idempotencyKey === 'string' && idempotencyKey.trim()) {
      const idem = idempotencyKey.trim();
      const existing = await pool.query(
        `SELECT *
         FROM messages
         WHERE organization_id = $1
           AND bd_account_id = $2
           AND channel = $3
           AND channel_id = $4
           AND direction = 'outbound'
           AND metadata->>'idempotencyKey' = $5
         ORDER BY created_at DESC
         LIMIT 1`,
        [organizationId, bdAccountId, channel, channelId, idem]
      );
      if (existing.rows.length > 0) {
        return res.json(existing.rows[0]);
      }
    }

    log.info({
      message: 'telegram_send_flow_contacts_loaded',
      correlation_id: req.correlationId,
      bd_account_id: bdAccountId,
      elapsed_ms: Date.now() - sendFlowStart,
    });

    const makeBody = (chatIdValue: string): Record<string, string> => {
      const body: Record<string, string> = {
        chatId: chatIdValue,
        text: captionOrContent,
      };
      if (fileBase64 && typeof fileBase64 === 'string') {
        body.fileBase64 = fileBase64;
        body.fileName = typeof fileName === 'string' ? fileName : 'file';
      }
      if (replyToTgId) {
        body.replyToMessageId = replyToTgId;
      }
      if (typeof idempotencyKey === 'string' && idempotencyKey.trim()) {
        body.idempotencyKey = idempotencyKey.trim();
      }
      if (effectiveUsernameHintForBd && effectiveUsernameHintForBd !== chatIdValue) {
        body.usernameHint = effectiveUsernameHintForBd;
      }
      return body;
    };
    let sentChannelId = channelId;
    const correlationId = req.correlationId;
    const bdCtx = { userId, organizationId, correlationId };
    const invokeBdSend = async (chatIdValue: string) => {
      log.info({
        message: 'bd_accounts_invoke_start',
        correlation_id: correlationId,
        bd_account_id: bdAccountId,
        channel_id_suffix: String(chatIdValue).slice(-8),
        source: source ?? null,
      });
      const invokeStart = Date.now();
      try {
        const result = await bdAccountsClient.post<{
          messageId?: string;
          date?: number;
          resolvedChatId?: string;
          telegram_media?: Record<string, unknown> | null;
          telegram_entities?: Record<string, unknown>[] | null;
        }>(`/api/bd-accounts/${bdAccountId}/send`, makeBody(chatIdValue), undefined, bdCtx);
        log.info({
          message: 'bd_accounts_invoke_done',
          correlation_id: correlationId,
          bd_account_id: bdAccountId,
          duration_ms: Date.now() - invokeStart,
          ok: true,
        });
        return result;
      } catch (e) {
        log.info({
          message: 'bd_accounts_invoke_done',
          correlation_id: correlationId,
          bd_account_id: bdAccountId,
          duration_ms: Date.now() - invokeStart,
          ok: false,
        });
        throw e;
      }
    };

    let resJson: Awaited<ReturnType<typeof invokeBdSend>> | null = null;
    let lastError: unknown = null;
    try {
      resJson = await invokeBdSend(channelId);
    } catch (error: unknown) {
      const isNotConnected =
        error instanceof ServiceCallError &&
        error.statusCode === 400 &&
        /not connected|account is not connected/i.test(String(error.message));
      if (isNotConnected) {
        await new Promise((r) => setTimeout(r, 2500));
        try {
          resJson = await invokeBdSend(channelId);
        } catch (retryErr: unknown) {
          lastError = retryErr;
        }
      } else {
        lastError = error;
      }
    }

    // Universal fallback: if entity cannot be resolved, retry with contact username (same as campaign path).
    if (
      resJson == null &&
      lastError != null &&
      isEntityResolutionError(lastError) &&
      contactUsernameNorm &&
      contactUsernameNorm !== String(channelId).trim()
    ) {
      try {
        resJson = await invokeBdSend(contactUsernameNorm);
        sentChannelId = contactUsernameNorm;
      } catch (fallbackErr: unknown) {
        lastError = fallbackErr;
      }
    }

    if (
      resJson == null &&
      lastError != null &&
      isEntityResolutionError(lastError) &&
      hintFromRequest &&
      hintFromRequest !== String(channelId).trim() &&
      hintFromRequest !== contactUsernameNorm
    ) {
      try {
        resJson = await invokeBdSend(hintFromRequest);
        sentChannelId = hintFromRequest;
      } catch (fallbackErr: unknown) {
        lastError = fallbackErr;
      }
    }

    if (
      resJson == null &&
      lastError != null &&
      isEntityResolutionError(lastError) &&
      !contactUsernameNorm &&
      channelId &&
      /^\d+$/.test(String(channelId).trim())
    ) {
      const lu = await pool.query(
        `SELECT username FROM contacts WHERE organization_id = $1 AND telegram_id = $2 AND username IS NOT NULL AND TRIM(username) <> '' LIMIT 1`,
        [organizationId, String(channelId).trim()]
      );
      const un = lu.rows[0] as { username?: string } | undefined;
      const u = un?.username ? String(un.username).trim().replace(/^@/, '') : '';
      if (u && u !== String(channelId).trim()) {
        try {
          resJson = await invokeBdSend(u);
          sentChannelId = u;
        } catch (fallbackErr: unknown) {
          lastError = fallbackErr;
        }
      }
    }

    if (resJson == null) {
      const error = lastError;
      const errMsg = error instanceof Error ? error.message : String(error);
      const downstreamMessage =
        error instanceof ServiceCallError && error.body != null && typeof error.body === 'object'
          ? (error.body as { message?: string }).message ?? (error.body as { error?: string }).error ?? errMsg
          : errMsg;
      log.error({ message: 'Error sending Telegram message', error: downstreamMessage });
      const is413 = (error instanceof ServiceCallError && error.statusCode === 413)
        || (errMsg.toLowerCase().includes('too large') || errMsg.includes('2 GB'));
      if (is413) {
        return res.status(413).json({ error: 'File too large', message: 'File too large' });
      }
      if (error instanceof ServiceCallError && error.statusCode >= 400 && error.statusCode < 500) {
        const json: { error: string; message: string; details?: unknown } = {
          error: downstreamMessage || 'Bad request',
          message: downstreamMessage || 'Failed to send message',
        };
        if (error.statusCode === 429 && error.body != null && typeof error.body === 'object' && 'details' in error.body) {
          json.details = (error.body as { details?: unknown }).details;
        }
        return res.status(error.statusCode).json(json);
      }
      const status = error instanceof ServiceCallError && error.statusCode >= 500 ? error.statusCode : 500;
      return res.status(status).json({
        error: status >= 500 ? 'Downstream error' : 'Internal server error',
        message: downstreamMessage || 'Failed to send message',
      });
    }

    if (resJson.resolvedChatId != null && String(resJson.resolvedChatId).trim() !== '') {
      sentChannelId = String(resJson.resolvedChatId).trim();
    }

    const tgMessageId = resJson.messageId != null ? String(resJson.messageId).trim() : null;
    const tgDate = resJson.date != null ? new Date(resJson.date * 1000) : null;
    const hasMedia = resJson.telegram_media != null && typeof resJson.telegram_media === 'object';
    const hasEntities = Array.isArray(resJson.telegram_entities);

    const insertResult = await pool.query(
      `INSERT INTO messages (
        organization_id, bd_account_id, channel, channel_id, contact_id, direction, content, status, unread, metadata, reply_to_telegram_id,
        telegram_message_id, telegram_date, telegram_media, telegram_entities
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) RETURNING *`,
      [
        organizationId,
        bdAccountId,
        channel,
        sentChannelId,
        contactIdOrNull,
        MessageDirection.OUTBOUND,
        contentForDb,
        MessageStatus.DELIVERED,
        false,
        JSON.stringify({ sentBy: userId, idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey.trim() : undefined, source: source ?? null }),
        replyToTgId,
        tgMessageId,
        tgDate,
        hasMedia ? JSON.stringify(resJson.telegram_media) : null,
        hasEntities ? JSON.stringify(resJson.telegram_entities) : null,
      ]
    );
    const message = insertResult.rows[0];

    await ensureConversation(pool, {
      organizationId,
      bdAccountId: bdAccountId || null,
      channel,
      channelId: sentChannelId,
      contactId: contactIdOrNull,
    });

    if (sentChannelId !== channelId) {
      await mergeOrphanConversationPeerToCanonical(pool, {
        organizationId,
        bdAccountId: bdAccountId || null,
        channel,
        fromChannelId: channelId,
        toChannelId: sentChannelId,
      });
    }

    if (source !== 'campaign') {
      await pool.query(
        `UPDATE conversations SET first_manager_reply_at = COALESCE(first_manager_reply_at, NOW()), updated_at = NOW()
         WHERE organization_id = $1 AND bd_account_id IS NOT DISTINCT FROM $2 AND channel = $3 AND channel_id = $4`,
        [organizationId, bdAccountId, channel, sentChannelId]
      );
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
    try {
      await rabbitmq.publishEvent(event);
    } catch (publishErr) {
      log.warn({
        message: 'Message sent, but publishEvent failed',
        messageId: message.id,
        error: publishErr instanceof Error ? publishErr.message : String(publishErr),
      });
    }

    res.json(updatedRow);
  }));
}
