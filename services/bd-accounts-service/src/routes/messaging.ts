import { Router } from 'express';
import { Pool } from 'pg';
import { z } from 'zod';
import { RabbitMQClient } from '@getsale/utils';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, validate } from '@getsale/service-core';
import { TelegramManager } from '../telegram';
import { serializeMessage } from '../telegram-serialize';
import { MAX_FILE_SIZE_BYTES, BULK_SEND_DELAY_MS, getAccountOr404, getErrorMessage, getErrorCode, requireBidiCanWriteAccount } from '../helpers';

const SendMessageSchema = z.object({
  chatId: z.string().min(1).max(256),
  text: z.string().optional(),
  fileBase64: z.string().optional(),
  fileName: z.string().max(512).optional(),
  replyToMessageId: z.union([z.string(), z.number()]).optional(),
}).refine((d) => (d.text != null && d.text !== '') || (d.fileBase64 != null && d.fileBase64 !== ''), { message: 'text or fileBase64 is required' });

const SendBulkSchema = z.object({
  channelIds: z.array(z.string().min(1).max(256)).min(1).max(100),
  text: z.string().min(1).max(100_000),
});

const ForwardMessageSchema = z.object({
  fromChatId: z.string().min(1).max(256),
  toChatId: z.string().min(1).max(256),
  telegramMessageId: z.coerce.number().int().positive(),
});

const DraftSchema = z.object({
  channelId: z.string().min(1).max(256),
  text: z.string().max(100_000).optional(),
  replyToMsgId: z.union([z.string(), z.number()]).optional(),
});

const DeleteMessageSchema = z.object({
  channelId: z.string().min(1).max(256),
  telegramMessageId: z.coerce.number().int().nonnegative(),
});

const CreateSharedChatSchema = z.object({
  title: z.string().min(1).max(255).trim(),
  lead_telegram_user_id: z.coerce.number().int().positive().optional().nullable(),
  lead_username: z.string().max(128).trim().optional().nullable(),
  extra_usernames: z.array(z.string().max(128).trim()).optional(),
});

const ReactionBodySchema = z.object({
  chatId: z.string().min(1).max(256),
  reaction: z.array(z.string().max(64)).optional(),
});

const ChatIdBodySchema = z.object({
  chatId: z.string().min(1).max(256),
});

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  telegramManager: TelegramManager;
}

export function messagingRouter({ pool, log, telegramManager }: Deps): Router {
  const router = Router();

  // POST /:id/send — send message or file via Telegram
  router.post('/:id/send', validate(SendMessageSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { chatId, text, fileBase64, fileName, replyToMessageId } = req.body;

    const account = await getAccountOr404<{ id: string; is_demo?: boolean }>(pool, id, organizationId, 'id, is_demo');
    if (account.is_demo) {
      throw new AppError(403, 'Sending messages is disabled for demo accounts. Connect a real Telegram account to send messages.', ErrorCodes.FORBIDDEN);
    }
    await requireBidiCanWriteAccount(pool, id, req.user);
    if (!telegramManager.isConnected(id)) {
      throw new AppError(400, 'BD account is not connected', ErrorCodes.BAD_REQUEST);
    }

    let message: { id: unknown; date?: unknown };
    try {
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
    } catch (sendErr: unknown) {
      const errMsg = getErrorMessage(sendErr);
      const code = getErrorCode(sendErr);
      const isClientError =
        (typeof errMsg === 'string' &&
          (errMsg.includes('Could not find the input entity') ||
            errMsg.includes('input entity') ||
            errMsg.includes('PEER_ID_INVALID') ||
            errMsg.includes('CHAT_ID_INVALID') ||
            errMsg.includes('USERNAME_NOT_OCCUPIED') ||
            errMsg.includes('USERNAME_INVALID') ||
            errMsg.includes('Username not found'))) ||
        (typeof code === 'string' &&
          /^(PEER_ID_INVALID|CHAT_ID_INVALID|USERNAME_NOT_OCCUPIED|USERNAME_INVALID|CHAT_NOT_FOUND)$/i.test(code));
      if (isClientError) {
        throw new AppError(
          400,
          'User or chat not found. Check that the Telegram ID or username is correct and the account can message this peer.',
          ErrorCodes.BAD_REQUEST
        );
      }
      log.warn({ message: 'Telegram send failed', accountId: id, chatId, error: errMsg, code });
      throw new AppError(
        502,
        errMsg && errMsg.length < 256 ? errMsg : 'Telegram send failed',
        ErrorCodes.SERVICE_UNAVAILABLE
      );
    }

    const chatIdStr = String(chatId).trim();
    if (chatIdStr) {
      const peerType = /^\d+$/.test(chatIdStr) && parseInt(chatIdStr, 10) > 0 ? 'user' : 'chat';
      await pool.query(
        `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id)
         VALUES ($1, $2, '', $3, false, NULL)
         ON CONFLICT (bd_account_id, telegram_chat_id) DO NOTHING`,
        [id, chatIdStr, peerType]
      );
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
  router.post('/:id/send-bulk', validate(SendBulkSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { channelIds, text } = req.body;

    const account = await getAccountOr404<{ id: string; is_demo?: boolean }>(pool, id, organizationId, 'id, is_demo');
    if (account.is_demo) {
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
        const peerType = /^\d+$/.test(chatId) && parseInt(chatId, 10) > 0 ? 'user' : 'chat';
        await pool.query(
          `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id)
           VALUES ($1, $2, '', $3, false, NULL)
           ON CONFLICT (bd_account_id, telegram_chat_id) DO NOTHING`,
          [id, chatId, peerType]
        );
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
  router.post('/:id/forward', validate(ForwardMessageSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { fromChatId, toChatId, telegramMessageId } = req.body;

    await getAccountOr404(pool, id, organizationId, 'id');
    await requireBidiCanWriteAccount(pool, id, req.user);
    if (!telegramManager.isConnected(id)) {
      throw new AppError(400, 'BD account is not connected', ErrorCodes.BAD_REQUEST);
    }

    const message = await telegramManager.forwardMessage(id, fromChatId, toChatId, telegramMessageId);

    res.json({
      success: true,
      messageId: String(message.id),
      date: message.date,
    });
  }));

  // POST /:id/draft — save draft in Telegram
  router.post('/:id/draft', validate(DraftSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { channelId, text, replyToMsgId } = req.body;

    await getAccountOr404(pool, id, organizationId, 'id');
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

    await telegramManager.saveDraft(id, channelId, text ?? '', {
      replyToMsgId: replyToMsgId != null && String(replyToMsgId).trim() ? Number(replyToMsgId) : undefined,
    });
    res.json({ success: true });
  }));

  // POST /:id/delete-message — delete message in Telegram
  router.post('/:id/delete-message', validate(DeleteMessageSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { channelId, telegramMessageId } = req.body;

    await getAccountOr404(pool, id, organizationId, 'id');
    await requireBidiCanWriteAccount(pool, id, req.user);
    if (!telegramManager.isConnected(id)) {
      throw new AppError(400, 'BD account is not connected', ErrorCodes.BAD_REQUEST);
    }

    await telegramManager.deleteMessageInTelegram(id, String(channelId), Number(telegramMessageId));
    res.json({ success: true });
  }));

  // POST /:id/create-shared-chat — create Telegram supergroup and invite users
  router.post('/:id/create-shared-chat', validate(CreateSharedChatSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id: accountId } = req.params;
    const { title, lead_telegram_user_id: leadTelegramUserId, lead_username: leadUsername, extra_usernames: extraUsernamesRaw } = req.body;

    await getAccountOr404(pool, accountId, organizationId, 'id');
    if (!telegramManager.isConnected(accountId)) {
      throw new AppError(400, 'BD account is not connected', ErrorCodes.BAD_REQUEST);
    }

    const leadId = leadTelegramUserId != null ? Number(leadTelegramUserId) : undefined;
    const extraUsernames = extraUsernamesRaw ?? [];
    const leadUser = leadUsername && String(leadUsername).trim() ? String(leadUsername).trim().replace(/^@/, '') : undefined;

    log.info({
      message: 'create-shared-chat request',
      accountId,
      leadTelegramUserId: leadId ?? null,
      extraUsernamesCount: extraUsernames.length,
    });

    const result = await telegramManager.createSharedChat(accountId, {
      title: title.trim().slice(0, 255),
      leadTelegramUserId: leadId && Number.isInteger(leadId) && leadId > 0 ? leadId : undefined,
      leadUsername: leadUser,
      extraUsernames,
    });

    const inviteLinkTrimmed = typeof result.inviteLink === 'string' ? result.inviteLink.trim() : '';
    const inviteMessage = inviteLinkTrimmed ? `Присоединяйтесь к группе:\n${inviteLinkTrimmed}` : '';
    if (inviteMessage) {
      let leadDmSent = false;
      if (leadId != null && Number.isInteger(leadId) && leadId > 0) {
        try {
          await telegramManager.sendMessage(accountId, String(leadId), inviteMessage);
          leadDmSent = true;
        } catch (sendErr: unknown) {
          log.warn({
            message: 'create-shared-chat: failed to send invite link to lead DM',
            accountId,
            leadId,
            error: getErrorMessage(sendErr),
          });
        }
      }
      if (!leadDmSent && leadUser) {
        try {
          await telegramManager.sendMessage(accountId, leadUser, inviteMessage);
        } catch (sendErr: unknown) {
          log.warn({
            message: 'create-shared-chat: failed to send invite link to lead DM by username',
            accountId,
            leadUsername: leadUser,
            error: getErrorMessage(sendErr),
          });
        }
      }
      for (const username of extraUsernames) {
        const u = (username ?? '').trim().replace(/^@/, '');
        if (!u) continue;
        try {
          await telegramManager.sendMessage(accountId, u, inviteMessage);
        } catch (sendErr: unknown) {
          log.warn({
            message: 'create-shared-chat: failed to send invite link to extra participant DM',
            accountId,
            username: u,
            error: getErrorMessage(sendErr),
          });
        }
      }
    }

    // Добавить созданный общий чат в bd_account_sync_chats (с access_hash для отправки без кэша).
    const rawId = Number(result.channelId);
    const fullChannelId = Number.isInteger(rawId) && rawId > 0 ? String(-1000000000 - rawId) : String(result.channelId ?? '').trim();
    const accessHash = (result as { accessHash?: string }).accessHash ?? null;
    if (fullChannelId) {
      await pool.query(
        `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id, access_hash)
         VALUES ($1, $2, $3, 'chat', false, NULL, $4)
         ON CONFLICT (bd_account_id, telegram_chat_id) DO UPDATE SET title = EXCLUDED.title, access_hash = COALESCE(EXCLUDED.access_hash, bd_account_sync_chats.access_hash)`,
        [accountId, fullChannelId, (result.title ?? title.trim()).slice(0, 500), accessHash]
      );
    }

    res.json({ channelId: result.channelId, title: result.title, inviteLink: result.inviteLink ?? null });
  }));

  // POST /:id/messages/:telegramMessageId/reaction — set reactions on a message
  router.post('/:id/messages/:telegramMessageId/reaction', validate(ReactionBodySchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id: accountId, telegramMessageId } = req.params;
    const { chatId, reaction: reactionBody } = req.body;

    const reactionList = (reactionBody ?? []).map((e: string) => String(e)).filter(Boolean);

    await getAccountOr404(pool, accountId, organizationId, 'id');
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
    } catch (error: unknown) {
      const err = error as { errorMessage?: string; message?: string };
      const isReactionInvalid =
        err?.errorMessage === 'REACTION_INVALID' ||
        (typeof err?.message === 'string' && err.message.includes('REACTION_INVALID'));
      if (isReactionInvalid) {
        log.warn({ message: 'Reaction not applied in Telegram (REACTION_INVALID), local state kept', entity_id: accountId });
        return res.json({ success: true, skipped: 'REACTION_INVALID' });
      }
      throw error;
    }

    res.json({ success: true });
  }));

  // POST /:id/typing — send typing indicator (no-op if account not connected, so campaign human sim does not fail)
  router.post('/:id/typing', validate(ChatIdBodySchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { chatId } = req.body;

    await getAccountOr404(pool, id, organizationId, 'id');
    if (!telegramManager.isConnected(id)) {
      return res.json({ success: true });
    }
    await telegramManager.setTyping(id, String(chatId));
    res.json({ success: true });
  }));

  // POST /:id/read — mark messages as read (no-op if account not connected, so campaign human sim does not fail)
  router.post('/:id/read', validate(ChatIdBodySchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { chatId } = req.body;

    await getAccountOr404(pool, id, organizationId, 'id');
    if (!telegramManager.isConnected(id)) {
      return res.json({ success: true });
    }
    await telegramManager.markAsRead(id, String(chatId));
    res.json({ success: true });
  }));

  // POST /:id/chats/:chatId/load-older-history — load one page of older messages from Telegram
  router.post('/:id/chats/:chatId/load-older-history', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id: accountId, chatId } = req.params;

    const account = await getAccountOr404<{ id: string; organization_id: string }>(pool, accountId, organizationId, 'id, organization_id');

    try {
      const { added, exhausted } = await telegramManager.fetchOlderMessagesFromTelegram(
        accountId,
        account.organization_id,
        chatId
      );
      res.json({ added, exhausted });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      throw new AppError(503, message, ErrorCodes.SERVICE_UNAVAILABLE);
    }
  }));

  return router;
}
