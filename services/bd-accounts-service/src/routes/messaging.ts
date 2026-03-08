import { Router } from 'express';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes } from '@getsale/service-core';
import { TelegramManager } from '../telegram-manager';
import { serializeMessage } from '../telegram-serialize';
import { MAX_FILE_SIZE_BYTES, BULK_SEND_DELAY_MS, requireBidiCanWriteAccount } from '../helpers';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  telegramManager: TelegramManager;
}

export function messagingRouter({ pool, log, telegramManager }: Deps): Router {
  const router = Router();

  // POST /:id/send — send message or file via Telegram
  router.post('/:id/send', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { chatId, text, fileBase64, fileName, replyToMessageId } = req.body;

    if (!chatId) {
      throw new AppError(400, 'Missing required field: chatId', ErrorCodes.VALIDATION);
    }
    if (!text && !fileBase64) {
      throw new AppError(400, 'Missing required field: text or fileBase64', ErrorCodes.VALIDATION);
    }

    const accountResult = await pool.query(
      'SELECT id, is_demo FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    if ((accountResult.rows[0] as { is_demo?: boolean }).is_demo) {
      throw new AppError(403, 'Sending messages is disabled for demo accounts. Connect a real Telegram account to send messages.', ErrorCodes.FORBIDDEN);
    }
    await requireBidiCanWriteAccount(pool, id, req.user);
    if (!telegramManager.isConnected(id)) {
      throw new AppError(400, 'BD account is not connected', ErrorCodes.BAD_REQUEST);
    }

    let message: any;
    if (fileBase64 && typeof fileBase64 === 'string') {
      const buf = Buffer.from(fileBase64, 'base64');
      if (buf.length > MAX_FILE_SIZE_BYTES) {
        throw new AppError(413, 'Maximum file size is 2 GB', ErrorCodes.VALIDATION);
      }
      message = await telegramManager.sendFile(id, chatId, buf, {
        caption: typeof text === 'string' ? text : '',
        filename: typeof fileName === 'string' ? fileName.trim() || 'file' : 'file',
        replyTo: replyToMessageId != null ? Number(replyToMessageId) : undefined,
      });
    } else {
      const replyTo = replyToMessageId != null && String(replyToMessageId).trim() ? Number(replyToMessageId) : undefined;
      message = await telegramManager.sendMessage(id, chatId, typeof text === 'string' ? text : '', { replyTo });
    }

    const serialized = serializeMessage(message);
    const payload: Record<string, unknown> = {
      success: true,
      messageId: String(message.id),
      date: message.date,
    };
    if (serialized.telegram_media) payload.telegram_media = serialized.telegram_media;
    if (serialized.telegram_entities) payload.telegram_entities = serialized.telegram_entities;
    res.json(payload);
  }));

  // POST /:id/send-bulk — send one message to multiple chats
  router.post('/:id/send-bulk', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { channelIds, text } = req.body;

    if (!Array.isArray(channelIds) || channelIds.length === 0) {
      throw new AppError(400, 'Missing or invalid channelIds array (at least one chat required)', ErrorCodes.VALIDATION);
    }
    if (!text || typeof text !== 'string') {
      throw new AppError(400, 'Missing required field: text', ErrorCodes.VALIDATION);
    }

    const accountResult = await pool.query(
      'SELECT id, is_demo FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    if ((accountResult.rows[0] as { is_demo?: boolean }).is_demo) {
      throw new AppError(403, 'Sending messages is disabled for demo accounts.', ErrorCodes.FORBIDDEN);
    }
    await requireBidiCanWriteAccount(pool, id, req.user);
    if (!telegramManager.isConnected(id)) {
      throw new AppError(400, 'BD account is not connected', ErrorCodes.BAD_REQUEST);
    }

    const failed: { channelId: string; error: string }[] = [];
    let sent = 0;
    for (let i = 0; i < channelIds.length; i++) {
      const chatId = String(channelIds[i]).trim();
      if (!chatId) continue;
      try {
        await telegramManager.sendMessage(id, chatId, text, {});
        sent++;
      } catch (err: any) {
        failed.push({ channelId: chatId, error: err?.message || String(err) });
      }
      if (i < channelIds.length - 1) {
        await new Promise((r) => setTimeout(r, BULK_SEND_DELAY_MS));
      }
    }
    res.json({ sent, failed });
  }));

  // POST /:id/forward — forward message to another chat
  router.post('/:id/forward', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { fromChatId, toChatId, telegramMessageId } = req.body;

    if (!fromChatId || !toChatId || telegramMessageId == null) {
      throw new AppError(400, 'Missing required fields: fromChatId, toChatId, telegramMessageId', ErrorCodes.VALIDATION);
    }

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiCanWriteAccount(pool, id, req.user);
    if (!telegramManager.isConnected(id)) {
      throw new AppError(400, 'BD account is not connected', ErrorCodes.BAD_REQUEST);
    }

    const message = await telegramManager.forwardMessage(
      id,
      String(fromChatId),
      String(toChatId),
      Number(telegramMessageId)
    );

    res.json({
      success: true,
      messageId: String(message.id),
      date: message.date,
    });
  }));

  // POST /:id/draft — save draft in Telegram
  router.post('/:id/draft', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { channelId, text, replyToMsgId } = req.body;

    if (!channelId) {
      throw new AppError(400, 'Missing required field: channelId', ErrorCodes.VALIDATION);
    }

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiCanWriteAccount(pool, id, req.user);
    if (!telegramManager.isConnected(id)) {
      throw new AppError(400, 'BD account is not connected', ErrorCodes.BAD_REQUEST);
    }

    const syncCheck = await pool.query(
      'SELECT 1 FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2',
      [id, String(channelId)]
    );
    if (syncCheck.rows.length === 0) {
      throw new AppError(403, 'Chat is not in sync list for this account', ErrorCodes.FORBIDDEN);
    }

    await telegramManager.saveDraft(id, String(channelId), typeof text === 'string' ? text : '', {
      replyToMsgId: replyToMsgId != null && String(replyToMsgId).trim() ? Number(replyToMsgId) : undefined,
    });
    res.json({ success: true });
  }));

  // POST /:id/delete-message — delete message in Telegram
  router.post('/:id/delete-message', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { channelId, telegramMessageId } = req.body;

    if (!channelId || telegramMessageId == null) {
      throw new AppError(400, 'Missing required fields: channelId, telegramMessageId', ErrorCodes.VALIDATION);
    }

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiCanWriteAccount(pool, id, req.user);
    if (!telegramManager.isConnected(id)) {
      throw new AppError(400, 'BD account is not connected', ErrorCodes.BAD_REQUEST);
    }

    await telegramManager.deleteMessageInTelegram(id, String(channelId), Number(telegramMessageId));
    res.json({ success: true });
  }));

  // POST /:id/create-shared-chat — create Telegram supergroup and invite users
  router.post('/:id/create-shared-chat', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id: accountId } = req.params;
    const { title, lead_telegram_user_id: leadTelegramUserId, extra_usernames: extraUsernamesRaw } = req.body ?? {};

    if (!title || typeof title !== 'string' || !title.trim()) {
      throw new AppError(400, 'Missing required field: title', ErrorCodes.VALIDATION);
    }

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [accountId, organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    if (!telegramManager.isConnected(accountId)) {
      throw new AppError(400, 'BD account is not connected', ErrorCodes.BAD_REQUEST);
    }

    const leadId = leadTelegramUserId != null ? Number(leadTelegramUserId) : undefined;
    const extraUsernames = Array.isArray(extraUsernamesRaw)
      ? extraUsernamesRaw.filter((u: unknown) => typeof u === 'string').map((u: string) => u.trim())
      : [];

    const result = await telegramManager.createSharedChat(accountId, {
      title: title.trim().slice(0, 255),
      leadTelegramUserId: leadId && Number.isInteger(leadId) && leadId > 0 ? leadId : undefined,
      extraUsernames,
    });

    res.json({ channelId: result.channelId, title: result.title, inviteLink: result.inviteLink ?? null });
  }));

  // POST /:id/messages/:telegramMessageId/reaction — set reactions on a message
  router.post('/:id/messages/:telegramMessageId/reaction', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id: accountId, telegramMessageId } = req.params;
    const { chatId, reaction: reactionBody } = req.body;

    if (!chatId) {
      throw new AppError(400, 'Missing required field: chatId', ErrorCodes.VALIDATION);
    }
    const reactionList = Array.isArray(reactionBody)
      ? reactionBody.map((e) => String(e)).filter(Boolean)
      : [];

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [accountId, organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiCanWriteAccount(pool, accountId, req.user);
    if (!telegramManager.isConnected(accountId)) {
      throw new AppError(400, 'BD account is not connected', ErrorCodes.BAD_REQUEST);
    }

    try {
      await telegramManager.sendReaction(
        accountId,
        String(chatId),
        Number(telegramMessageId),
        reactionList
      );
    } catch (error: any) {
      const isReactionInvalid =
        error?.errorMessage === 'REACTION_INVALID' ||
        error?.message?.includes('REACTION_INVALID');
      if (isReactionInvalid) {
        log.warn({ message: 'Reaction not applied in Telegram (REACTION_INVALID), local state kept', entity_id: accountId });
        return res.json({ success: true, skipped: 'REACTION_INVALID' });
      }
      throw error;
    }

    res.json({ success: true });
  }));

  // POST /:id/chats/:chatId/load-older-history — load one page of older messages from Telegram
  router.post('/:id/chats/:chatId/load-older-history', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id: accountId, chatId } = req.params;

    const accountResult = await pool.query(
      'SELECT id, organization_id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [accountId, organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    const { added, exhausted } = await telegramManager.fetchOlderMessagesFromTelegram(
      accountId,
      accountResult.rows[0].organization_id,
      chatId
    );
    res.json({ added, exhausted });
  }));

  return router;
}
