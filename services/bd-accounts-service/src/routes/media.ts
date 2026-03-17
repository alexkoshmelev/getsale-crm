import { Router } from 'express';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes } from '@getsale/service-core';
import { TelegramManager } from '../telegram';
import { getAccountOr404 } from '../helpers';

interface Deps {
  pool: Pool;
  log: Logger;
  telegramManager: TelegramManager;
}

export function mediaRouter({ pool, log, telegramManager }: Deps): Router {
  const router = Router();

  // GET /:id/avatar — BD account profile photo
  router.get('/:id/avatar', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;

    await getAccountOr404(pool, id, organizationId, 'id');

    if (!telegramManager.isConnected(id)) {
      log.info({ message: 'Avatar not available: account offline', account_id: id });
      throw new AppError(404, 'Avatar not available', ErrorCodes.NOT_FOUND);
    }
    const result = await telegramManager.downloadAccountProfilePhoto(id);
    if (!result) {
      log.info({ message: 'Avatar not available: no profile photo or download error', account_id: id });
      throw new AppError(404, 'Avatar not available', ErrorCodes.NOT_FOUND);
    }
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(result.buffer);
  }));

  // GET /:id/chats/:chatId/avatar — chat/peer profile photo
  router.get('/:id/chats/:chatId/avatar', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id, chatId } = req.params;

    await getAccountOr404(pool, id, organizationId, 'id');

    if (!telegramManager.isConnected(id)) {
      log.info({ message: 'Chat avatar not available: account offline', account_id: id, chat_id: chatId });
      throw new AppError(404, 'Avatar not available', ErrorCodes.NOT_FOUND);
    }
    const result = await telegramManager.downloadChatProfilePhoto(id, chatId);
    if (!result) {
      log.info({ message: 'Chat avatar not available: no photo or download error', account_id: id, chat_id: chatId });
      throw new AppError(404, 'Avatar not available', ErrorCodes.NOT_FOUND);
    }
    res.setHeader('Content-Type', result.mimeType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(result.buffer);
  }));

  // GET /:id/media — proxy media from Telegram (photo, video, voice, document)
  router.get('/:id/media', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { channelId, messageId } = req.query;

    if (!channelId || !messageId) {
      throw new AppError(400, 'channelId and messageId query params required', ErrorCodes.VALIDATION);
    }

    await getAccountOr404(pool, id, organizationId, 'id');

    try {
      const result = await telegramManager.downloadMessageMedia(id, String(channelId), String(messageId));
      if (!result) {
        throw new AppError(404, 'Message or media not found', ErrorCodes.NOT_FOUND);
      }

      res.setHeader('Content-Type', result.mimeType);
      res.setHeader('Cache-Control', 'private, max-age=3600');
      res.send(result.buffer);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('not connected')) {
        throw new AppError(400, 'Account is not connected', ErrorCodes.BAD_REQUEST);
      }
      throw error;
    }
  }));

  return router;
}
