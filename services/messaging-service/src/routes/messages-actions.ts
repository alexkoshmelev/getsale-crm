import { randomUUID } from 'crypto';
import { Router } from 'express';
import { EventType, MessageDeletedEvent } from '@getsale/events';
import { asyncHandler, AppError, ErrorCodes, canPermission } from '@getsale/service-core';
import { ALLOWED_EMOJI, UNFURL_TIMEOUT_MS, UNFURL_MAX_BODY, URL_REGEX, isUrlAllowedForUnfurl } from '../helpers';
import type { MessagesRouterDeps } from './messages-deps';

/** Notify Telegram ReadHistory after CRM marks messages read (best-effort; failures only logged). */
async function syncReadHistoryToTelegram(
  deps: Pick<MessagesRouterDeps, 'pool' | 'log' | 'bdAccountsClient'>,
  ctx: { userId: string; organizationId: string; channel: string; chatId: string }
): Promise<void> {
  const { pool, bdAccountsClient, log } = deps;
  const { userId, organizationId, channel, chatId } = ctx;

  const accRow = await pool.query<{ bd_account_id: string }>(
    `SELECT DISTINCT bd_account_id::text AS bd_account_id FROM messages
     WHERE organization_id = $1 AND channel = $2 AND channel_id = $3 AND bd_account_id IS NOT NULL
     LIMIT 1`,
    [organizationId, channel, chatId]
  );
  const bdAccountId = accRow.rows[0]?.bd_account_id;
  if (!bdAccountId) return;

  const maxRow = await pool.query<{ max_id: string | null }>(
    `SELECT MAX(telegram_message_id::bigint)::text AS max_id FROM messages
     WHERE organization_id = $1 AND channel = $2 AND channel_id = $3 AND direction = 'inbound'
       AND telegram_message_id IS NOT NULL AND telegram_message_id ~ '^[0-9]+$'`,
    [organizationId, channel, chatId]
  );
  const maxIdRaw = maxRow.rows[0]?.max_id;
  const parsedMax = maxIdRaw != null ? parseInt(maxIdRaw, 10) : NaN;
  const body: { chatId: string; maxId?: number } = { chatId };
  if (Number.isFinite(parsedMax) && parsedMax > 0) {
    body.maxId = parsedMax;
  }

  try {
    await bdAccountsClient.post(`/api/bd-accounts/${bdAccountId}/read`, body, undefined, {
      userId,
      organizationId,
    });
  } catch (err: unknown) {
    log.warn({
      message: 'Failed to sync read history to Telegram',
      error: String(err),
      bdAccountId,
      chatId,
    });
  }
}

export function registerActionRoutes(router: Router, deps: MessagesRouterDeps): void {
  const { pool, rabbitmq, log, bdAccountsClient } = deps;
  const checkPermission = canPermission(pool);

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
          undefined,
          { userId, organizationId }
        );
      } catch (err: unknown) {
        log.error({ message: 'Error deleting message in Telegram', error: String(err) });
        return res.status(502).json({
          error: 'Failed to delete in Telegram',
          message: 'Failed to delete message in Telegram',
        });
      }
    }

    await pool.query('DELETE FROM messages WHERE id = $1 AND organization_id = $2', [id, organizationId]);

    const ev: MessageDeletedEvent = {
      id: randomUUID(),
      type: EventType.MESSAGE_DELETED,
      timestamp: new Date(),
      organizationId,
      correlationId: req.correlationId,
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

  router.patch('/messages/:id/read', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { id } = req.params;

    const before = await pool.query<{ channel: string; channel_id: string }>(
      'SELECT channel, channel_id FROM messages WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    await pool.query(
      'UPDATE messages SET unread = false, updated_at = NOW() WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    const row = before.rows[0];
    if (row) {
      void syncReadHistoryToTelegram(deps, {
        userId,
        organizationId,
        channel: row.channel,
        chatId: row.channel_id,
      });
    }
    res.json({ success: true });
  }));

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
          undefined,
          { userId, organizationId }
        );
      } catch (err) {
        log.warn({ message: 'Failed to sync reaction to Telegram', error: String(err) });
      }
    }

    const updated = await pool.query('SELECT * FROM messages WHERE id = $1', [id]);
    res.json(updated.rows[0]);
  }));

  router.post('/mark-read', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
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
    void syncReadHistoryToTelegram(deps, { userId, organizationId, channel, chatId: channelId });
    res.json({ success: true });
  }));

  router.post('/chats/:chatId/mark-all-read', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { chatId } = req.params;
    const channelRaw = req.query.channel;
    const channel =
      typeof channelRaw === 'string' ? channelRaw : Array.isArray(channelRaw) ? String(channelRaw[0] ?? '') : '';

    if (!channel) {
      throw new AppError(400, 'channel query parameter is required', ErrorCodes.VALIDATION);
    }

    await pool.query(
      `UPDATE messages
       SET unread = false, updated_at = NOW()
       WHERE organization_id = $1 AND channel = $2 AND channel_id = $3`,
      [organizationId, channel, chatId]
    );
    void syncReadHistoryToTelegram(deps, { userId, organizationId, channel, chatId });
    res.json({ success: true });
  }));

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
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
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
    } catch {
      clearTimeout(timeout);
      res.json({ title: null, description: null, image: null });
    }
  }));
}
