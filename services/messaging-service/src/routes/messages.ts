import { Router } from 'express';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, MessageSentEvent, MessageDeletedEvent } from '@getsale/events';
import { MessageChannel, MessageDirection, MessageStatus } from '@getsale/types';
import { Logger } from '@getsale/logger';
import {
  asyncHandler,
  AppError,
  ErrorCodes,
  canPermission,
  ServiceHttpClient,
  ServiceCallError,
} from '@getsale/service-core';
import {
  ensureConversation,
  ALLOWED_EMOJI,
  MAX_FILE_SIZE_BYTES,
  UNFURL_TIMEOUT_MS,
  UNFURL_MAX_BODY,
  URL_REGEX,
  isUrlAllowedForUnfurl,
} from '../helpers';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  bdAccountsClient: ServiceHttpClient;
}

export function messagesRouter({ pool, rabbitmq, log, bdAccountsClient }: Deps): Router {
  const router = Router();
  const checkPermission = canPermission(pool);

  // GET /inbox — unread messages
  router.get('/inbox', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const result = await pool.query(
      `SELECT m.*, c.first_name, c.last_name, c.email
       FROM messages m
       LEFT JOIN contacts c ON m.contact_id = c.id
       WHERE m.organization_id = $1 AND m.unread = true
       ORDER BY m.created_at DESC`,
      [organizationId]
    );
    res.json(result.rows);
  }));

  // GET /messages — messages for a contact/channel with Telegram history loading
  router.get('/messages', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { contactId, channel, channelId, bdAccountId, page = 1, limit = 50 } = req.query;

    const pageNum = Math.max(1, parseInt(String(page), 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10)));
    const bdId = bdAccountId && String(bdAccountId).trim() ? String(bdAccountId).trim() : null;
    const chId = channelId && String(channelId).trim() ? String(channelId).trim() : null;

    if (bdId && chId && channel === 'telegram' && pageNum === 1) {
      const countRes = await pool.query(
        'SELECT COUNT(*) FROM messages WHERE organization_id = $1 AND channel = $2 AND channel_id = $3 AND bd_account_id = $4',
        [organizationId, channel || 'telegram', chId, bdId]
      );
      const totalForChat = parseInt(countRes.rows[0].count);
      if (totalForChat === 0) {
        const exhaustedRow = await pool.query(
          'SELECT history_exhausted FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
          [bdId, chId]
        );
        const exhausted = exhaustedRow.rows.length > 0 && (exhaustedRow.rows[0] as any).history_exhausted === true;
        if (!exhausted) {
          try {
            await bdAccountsClient.post(
              `/api/bd-accounts/${bdId}/chats/${chId}/load-older-history`,
              {},
              { 'x-user-id': userId || '', 'x-organization-id': organizationId || '' }
            );
          } catch (err) {
            log.warn({ message: 'Load initial history (0 messages) request failed', error: String(err) });
          }
        }
      }
    }

    if (bdId && chId && channel === 'telegram' && pageNum > 1) {
      let countResult = await pool.query(
        'SELECT COUNT(*) FROM messages WHERE organization_id = $1 AND channel = $2 AND channel_id = $3 AND bd_account_id = $4',
        [organizationId, channel || 'telegram', chId, bdId]
      );
      let total = parseInt(countResult.rows[0].count);
      const needOffset = (pageNum - 1) * limitNum;
      if (needOffset >= total) {
        const exhaustedRow = await pool.query(
          'SELECT history_exhausted FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
          [bdId, chId]
        );
        const exhausted = exhaustedRow.rows.length > 0 && (exhaustedRow.rows[0] as any).history_exhausted === true;
        if (!exhausted) {
          try {
            const data = await bdAccountsClient.post<{ added?: number }>(
              `/api/bd-accounts/${bdId}/chats/${chId}/load-older-history`,
              {},
              { 'x-user-id': userId || '', 'x-organization-id': organizationId || '' }
            );
            if ((data.added ?? 0) > 0) {
              countResult = await pool.query(
                'SELECT COUNT(*) FROM messages WHERE organization_id = $1 AND channel = $2 AND channel_id = $3 AND bd_account_id = $4',
                [organizationId, channel || 'telegram', chId, bdId]
              );
              total = parseInt(countResult.rows[0].count);
            }
          } catch (err) {
            log.warn({ message: 'Load older history request failed', error: String(err) });
          }
        }
      }
    }

    let query = 'SELECT * FROM messages WHERE organization_id = $1';
    const params: any[] = [organizationId];

    if (contactId) {
      query += ` AND contact_id = $${params.length + 1}`;
      params.push(contactId);
    }

    if (channel && channelId) {
      query += ` AND channel = $${params.length + 1} AND channel_id = $${params.length + 2}`;
      params.push(channel, channelId);
    }

    if (bdId) {
      query += ` AND bd_account_id = $${params.length + 1}`;
      params.push(bdId);
    }

    const offset = (pageNum - 1) * limitNum;
    query += ` ORDER BY COALESCE(telegram_date, created_at) DESC NULLS LAST LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limitNum, offset);

    const result = await pool.query(query, params);
    let rows = (result.rows as any[]).slice().reverse();

    if (bdId && chId && rows.length > 0) {
      const peerRow = await pool.query(
        'SELECT peer_type FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
        [bdId, chId]
      );
      const peerType = peerRow.rows[0] as { peer_type: string } | undefined;
      if (peerType && (peerType.peer_type === 'chat' || peerType.peer_type === 'channel')) {
        const inboundContactIds = [...new Set(
          (rows as any[]).filter((r) => r.direction === 'inbound' && r.contact_id).map((r) => r.contact_id)
        )] as string[];
        let senderNames: Record<string, string> = {};
        if (inboundContactIds.length > 0) {
          const contactsRes = await pool.query(
            `SELECT id, COALESCE(NULLIF(TRIM(display_name), ''), NULLIF(TRIM(CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,''))), ''), username, telegram_id::text) AS display_name
             FROM contacts WHERE id = ANY($1::uuid[])`,
            [inboundContactIds]
          );
          for (const c of contactsRes.rows as { id: string; display_name: string | null }[]) {
            senderNames[c.id] = (c.display_name && c.display_name.trim()) ? c.display_name.trim() : c.id.slice(0, 8);
          }
        }
        rows = rows.map((r) =>
          r.direction === 'inbound' && r.contact_id
            ? { ...r, sender_name: senderNames[r.contact_id] ?? null }
            : r
        );
      }
    }

    let countQuery = 'SELECT COUNT(*) FROM messages WHERE organization_id = $1';
    const countParams: any[] = [organizationId];
    if (contactId) {
      countQuery += ` AND contact_id = $${countParams.length + 1}`;
      countParams.push(contactId);
    }
    if (channel && channelId) {
      countQuery += ` AND channel = $${countParams.length + 1} AND channel_id = $${countParams.length + 2}`;
      countParams.push(channel, channelId);
    }
    if (bdId) {
      countQuery += ` AND bd_account_id = $${countParams.length + 1}`;
      countParams.push(bdId);
    }
    const countResult2 = await pool.query(countQuery, countParams);
    const total = parseInt(countResult2.rows[0].count);

    let historyExhausted: boolean | undefined;
    if (bdId && chId) {
      const exRow = await pool.query(
        'SELECT history_exhausted FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
        [bdId, chId]
      );
      historyExhausted = exRow.rows.length > 0 ? (exRow.rows[0] as any).history_exhausted === true : undefined;
    }

    const payload: {
      messages: any[];
      pagination: { page: number; limit: number; total: number; totalPages: number };
      historyExhausted?: boolean;
    } = {
      messages: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    };
    if (historyExhausted !== undefined) payload.historyExhausted = historyExhausted;
    res.json(payload);
  }));

  // GET /messages/:id
  router.get('/messages/:id', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;

    const result = await pool.query(
      'SELECT * FROM messages WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'Message not found', ErrorCodes.NOT_FOUND);
    }
    res.json(result.rows[0]);
  }));

  // POST /send — send message (optionally with file as base64)
  router.post('/send', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { contactId, channel, channelId, content, bdAccountId, fileBase64, fileName, replyToMessageId } = req.body;

    if (!contactId || !channel || !channelId) {
      throw new AppError(400, 'Missing required fields: contactId, channel, channelId', ErrorCodes.VALIDATION);
    }
    if (!content && !fileBase64) {
      throw new AppError(400, 'Missing required field: content or fileBase64', ErrorCodes.VALIDATION);
    }

    if (fileBase64 && typeof fileBase64 === 'string') {
      const estimatedBytes = (fileBase64.length * 3) / 4;
      if (estimatedBytes > MAX_FILE_SIZE_BYTES) {
        return res.status(413).json({
          error: 'File too large',
          message: 'Maximum file size is 2 GB. Use a smaller file.',
        });
      }
    }

    const contactResult = await pool.query(
      'SELECT id, organization_id, telegram_id FROM contacts WHERE id = $1 AND organization_id = $2',
      [contactId, organizationId]
    );
    if (contactResult.rows.length === 0) {
      throw new AppError(404, 'Contact not found', ErrorCodes.NOT_FOUND);
    }

    const captionOrContent = typeof content === 'string' ? content : '';
    const contentForDb = captionOrContent || (fileName ? `[Файл: ${fileName}]` : '[Медиа]');
    const replyToTgId = replyToMessageId != null && String(replyToMessageId).trim() ? String(replyToMessageId).trim() : null;

    await ensureConversation(pool, {
      organizationId,
      bdAccountId: bdAccountId || null,
      channel,
      channelId,
      contactId,
    });

    const result = await pool.query(
      `INSERT INTO messages (organization_id, bd_account_id, channel, channel_id, contact_id, direction, content, status, unread, metadata, reply_to_telegram_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        organizationId,
        bdAccountId || null,
        channel,
        channelId,
        contactId,
        MessageDirection.OUTBOUND,
        contentForDb,
        MessageStatus.PENDING,
        false,
        JSON.stringify({ sentBy: userId }),
        replyToTgId,
      ]
    );
    const message = result.rows[0];

    await pool.query(
      `UPDATE conversations SET first_manager_reply_at = COALESCE(first_manager_reply_at, NOW()), updated_at = NOW()
       WHERE organization_id = $1 AND bd_account_id IS NOT DISTINCT FROM $2 AND channel = $3 AND channel_id = $4`,
      [organizationId, bdAccountId || null, channel, channelId]
    );

    let sent = false;
    if (channel === MessageChannel.TELEGRAM) {
      if (!bdAccountId) {
        return res.status(400).json({ error: 'bdAccountId is required for Telegram messages' });
      }
      try {
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
        const resJson = await bdAccountsClient.post<{
          messageId?: string;
          date?: number;
          telegram_media?: Record<string, unknown> | null;
          telegram_entities?: Record<string, unknown>[] | null;
        }>(
          `/api/bd-accounts/${bdAccountId}/send`,
          body,
          { 'x-user-id': userId, 'x-organization-id': organizationId }
        );

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
      } catch (error: any) {
        log.error({ message: 'Error sending Telegram message', error: String(error) });
        await pool.query('UPDATE messages SET status = $1, metadata = $2 WHERE id = $3', [
          MessageStatus.FAILED,
          JSON.stringify({ error: error.message }),
          message.id,
        ]);
        const is413 = (error instanceof ServiceCallError && error.statusCode === 413)
          || (error.message && (error.message.toLowerCase().includes('too large') || error.message.includes('2 GB')));
        const errBody = error instanceof ServiceCallError && typeof error.body === 'object' && error.body !== null
          ? error.body as { message?: string; error?: string }
          : {};
        const errMsg = is413
          ? (errBody.message || errBody.error || 'File too large')
          : (errBody.message || errBody.error || error.message || 'Failed to send message');
        return res.status(is413 ? 413 : 500).json({
          error: is413 ? 'File too large' : 'Internal server error',
          message: errMsg,
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
      data: {
        messageId: message.id,
        channel,
        contactId,
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

  // DELETE /messages/:id
  router.delete('/messages/:id', asyncHandler(async (req, res) => {
    const { id: userId, organizationId, role } = req.user;
    const allowed = await checkPermission(role, 'messaging', 'message.delete');
    if (!allowed) {
      throw new AppError(403, 'Forbidden: no permission to delete messages', ErrorCodes.FORBIDDEN);
    }
    const { id } = req.params;

    const msgResult = await pool.query(
      'SELECT id, organization_id, bd_account_id, channel_id, telegram_message_id FROM messages WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (msgResult.rows.length === 0) {
      throw new AppError(404, 'Message not found', ErrorCodes.NOT_FOUND);
    }
    const msg = msgResult.rows[0] as {
      id: string; organization_id: string; bd_account_id: string | null;
      channel_id: string; telegram_message_id: number | string | null;
    };

    if (msg.bd_account_id && msg.telegram_message_id != null) {
      try {
        const telegramMessageId = typeof msg.telegram_message_id === 'string'
          ? parseInt(msg.telegram_message_id, 10)
          : msg.telegram_message_id;
        await bdAccountsClient.post(
          `/api/bd-accounts/${msg.bd_account_id}/delete-message`,
          {
            channelId: String(msg.channel_id),
            telegramMessageId: Number.isNaN(telegramMessageId) ? Number(msg.telegram_message_id) : telegramMessageId,
          },
          { 'x-user-id': userId, 'x-organization-id': organizationId }
        );
      } catch (err: any) {
        log.error({ message: 'Error deleting message in Telegram', error: String(err) });
        const errMsg = err instanceof ServiceCallError && typeof err.body === 'object' && err.body !== null
          ? ((err.body as any).message || err.message)
          : (err.message || 'BD accounts service error');
        return res.status(502).json({
          error: 'Failed to delete in Telegram',
          message: errMsg,
        });
      }
    }

    await pool.query('DELETE FROM messages WHERE id = $1 AND organization_id = $2', [id, organizationId]);

    const ev: MessageDeletedEvent = {
      id: randomUUID(),
      type: EventType.MESSAGE_DELETED,
      timestamp: new Date(),
      organizationId,
      data: {
        messageId: msg.id,
        bdAccountId: msg.bd_account_id || '',
        channelId: msg.channel_id,
        telegramMessageId:
          msg.telegram_message_id != null
            ? typeof msg.telegram_message_id === 'string'
              ? (Number.isNaN(parseInt(msg.telegram_message_id, 10)) ? undefined : parseInt(msg.telegram_message_id, 10))
              : msg.telegram_message_id
            : undefined,
      },
    };
    await rabbitmq.publishEvent(ev);

    res.json({ success: true });
  }));

  // PATCH /messages/:id/read
  router.patch('/messages/:id/read', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;

    await pool.query(
      'UPDATE messages SET unread = false, updated_at = NOW() WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    res.json({ success: true });
  }));

  // PATCH /messages/:id/reaction
  router.patch('/messages/:id/reaction', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { id } = req.params;
    const { emoji } = req.body as { emoji?: string };

    if (!emoji || typeof emoji !== 'string' || emoji.length > 10) {
      throw new AppError(400, 'Invalid emoji', ErrorCodes.VALIDATION);
    }
    const trimmed = emoji.trim();
    if (!ALLOWED_EMOJI.includes(trimmed)) {
      throw new AppError(400, 'Emoji not allowed', ErrorCodes.VALIDATION, { allowed: ALLOWED_EMOJI });
    }

    const msgResult = await pool.query(
      'SELECT id, reactions, our_reactions, bd_account_id, channel_id, telegram_message_id FROM messages WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (msgResult.rows.length === 0) {
      throw new AppError(404, 'Message not found', ErrorCodes.NOT_FOUND);
    }
    const row = msgResult.rows[0];
    const current = (row.reactions as Record<string, number>) || {};
    const prevCount = current[trimmed] || 0;
    const next: Record<string, number> = { ...current };
    const currentOurs: string[] = Array.isArray(row.our_reactions) ? row.our_reactions : [];
    let newOurs: string[];
    if (prevCount > 0) {
      if (prevCount === 1) delete next[trimmed];
      else next[trimmed] = prevCount - 1;
      newOurs = currentOurs.filter((e) => e !== trimmed);
    } else {
      next[trimmed] = prevCount + 1;
      newOurs = [...currentOurs.filter((e) => e !== trimmed), trimmed].slice(0, 3);
    }

    await pool.query(
      'UPDATE messages SET reactions = $1, our_reactions = $2, updated_at = NOW() WHERE id = $3 AND organization_id = $4',
      [JSON.stringify(next), JSON.stringify(newOurs), id, organizationId]
    );

    const bdAccountId = row.bd_account_id;
    const channelId = row.channel_id;
    const telegramMessageId = row.telegram_message_id;
    if (bdAccountId && channelId && telegramMessageId) {
      try {
        await bdAccountsClient.post(
          `/api/bd-accounts/${bdAccountId}/messages/${telegramMessageId}/reaction`,
          { chatId: channelId, reaction: newOurs },
          { 'x-user-id': userId, 'x-organization-id': organizationId }
        );
      } catch (err) {
        log.warn({ message: 'Failed to sync reaction to Telegram', error: String(err) });
      }
    }

    const updated = await pool.query('SELECT * FROM messages WHERE id = $1', [id]);
    res.json(updated.rows[0]);
  }));

  // POST /mark-read (alternative endpoint for compatibility)
  router.post('/mark-read', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { channel, channelId } = req.body;

    if (!channel || !channelId) {
      throw new AppError(400, 'channel and channelId are required', ErrorCodes.VALIDATION);
    }

    await pool.query(
      `UPDATE messages
       SET unread = false, updated_at = NOW()
       WHERE organization_id = $1 AND channel = $2 AND channel_id = $3`,
      [organizationId, channel, channelId]
    );
    res.json({ success: true });
  }));

  // POST /chats/:chatId/mark-all-read
  router.post('/chats/:chatId/mark-all-read', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { chatId } = req.params;
    const { channel } = req.query;

    if (!channel) {
      throw new AppError(400, 'channel query parameter is required', ErrorCodes.VALIDATION);
    }

    await pool.query(
      `UPDATE messages
       SET unread = false, updated_at = NOW()
       WHERE organization_id = $1 AND channel = $2 AND channel_id = $3`,
      [organizationId, channel, chatId]
    );
    res.json({ success: true });
  }));

  // GET /unfurl — link preview (Open Graph). SSRF protection: only public URLs allowed.
  router.get('/unfurl', asyncHandler(async (req, res) => {
    const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!rawUrl || !URL_REGEX.test(rawUrl)) {
      throw new AppError(400, 'Valid url query parameter is required', ErrorCodes.VALIDATION);
    }
    if (!isUrlAllowedForUnfurl(rawUrl)) {
      throw new AppError(400, 'URL is not allowed for preview', ErrorCodes.VALIDATION);
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UNFURL_TIMEOUT_MS);
    try {
      const response = await fetch(rawUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'GetSale-CRM-Bot/1.0 (link preview)' },
        redirect: 'follow',
      });
      clearTimeout(timeout);
      if (!response.ok || !response.body) {
        return res.json({ title: null, description: null, image: null });
      }
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > UNFURL_MAX_BODY) {
        return res.json({ title: null, description: null, image: null });
      }
      const chunks: Buffer[] = [];
      let total = 0;
      const reader = (response.body as any).getReader();
      try {
        while (total < UNFURL_MAX_BODY) {
          const { done, value } = await reader.read();
          if (done) break;
          const buf = Buffer.from(value);
          total += buf.length;
          chunks.push(total <= UNFURL_MAX_BODY ? buf : buf.subarray(0, UNFURL_MAX_BODY - (total - buf.length)));
          if (total >= UNFURL_MAX_BODY) break;
        }
      } finally {
        reader.releaseLock?.();
      }
      const html = Buffer.concat(chunks).toString('utf8', 0, Math.min(total, UNFURL_MAX_BODY));
      const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1];
      const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1]
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)?.[1];
      const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
      const title = ogTitle ? ogTitle.replace(/&amp;/g, '&').replace(/&#39;/g, "'").slice(0, 200) : null;
      const description = ogDesc ? ogDesc.replace(/&amp;/g, '&').replace(/&#39;/g, "'").slice(0, 300) : null;
      let image: string | null = ogImage ? ogImage.replace(/&amp;/g, '&').trim() : null;
      if (image && !/^https?:\/\//i.test(image)) image = new URL(image, rawUrl).href;
      res.json({ title, description, image });
    } catch (err: any) {
      clearTimeout(timeout);
      res.json({ title: null, description: null, image: null });
    }
  }));

  return router;
}
