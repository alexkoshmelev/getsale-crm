import { Router } from 'express';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, validate } from '@getsale/service-core';
import { TelegramManager } from '../telegram';
import { serializeMessage } from '../telegram-serialize';
import {
  MAX_FILE_SIZE_BYTES,
  BULK_SEND_DELAY_MS,
  getAccountOr404,
  getErrorMessage,
  getErrorCode,
  getRetryAfterSeconds,
  requireBidiCanWriteAccount,
  assertBdAccountsNotViewer,
} from '../helpers';
import { telegramSendErrorToAppError } from '../telegram-send-error-map';
import { incrementPeerFloodAndMaybeEscalate } from '../bd-account-spam-persist';
import { canonicalTelegramChatIdFromMessage } from '../telegram-peer-chat-id';
import {
  BdSendMessageSchema,
  BdSendBulkSchema,
  BdForwardMessageSchema,
  BdDraftSchema,
  BdDeleteMessageSchema,
  BdCreateSharedChatSchema,
  BdReactionBodySchema,
  BdChatIdBodySchema,
  BdResolvePeerSchema,
} from '../validation';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  telegramManager: TelegramManager;
}

function peerTypeFromChatId(chatId: string): 'chat' | 'user' {
  return /^-?\d+$/.test(chatId) && parseInt(chatId, 10) < 0 ? 'chat' : 'user';
}

/**
 * After outbound send: migrate username-based rows to the canonical numeric chat id.
 * Three idempotent queries, no branching — minimises lock duration vs the old 5-query pattern.
 */
async function mergeOutboundSendSyncRow(
  pool: Pool,
  bdAccountId: string,
  requestChatId: string,
  canonical: string | null | undefined
): Promise<void> {
  if (!canonical || canonical === requestChatId) return;

  await pool.query(
    `UPDATE campaign_participants
     SET channel_id = $1, updated_at = NOW()
     WHERE bd_account_id = $2::uuid AND channel_id = $3 AND status IN ('pending', 'sent')`,
    [canonical, bdAccountId, requestChatId]
  );

  const pt = peerTypeFromChatId(canonical);
  await pool.query(
    `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id, sync_list_origin)
     VALUES ($1, $2, '', $3, false, NULL, 'outbound_send')
     ON CONFLICT (bd_account_id, telegram_chat_id)
     DO UPDATE SET sync_list_origin = 'outbound_send'`,
    [bdAccountId, canonical, pt]
  );

  await pool.query(
    `DELETE FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2`,
    [bdAccountId, requestChatId]
  );
}

export function messagingRouter({ pool, log, telegramManager }: Deps): Router {
  const router = Router();
  router.use((req, res, next) => {
    try {
      assertBdAccountsNotViewer(req.user);
      next();
    } catch (e) {
      next(e);
    }
  });
  const assertAccountNotReauthRequired = async (accountId: string, organizationId: string): Promise<void> => {
    const r = await pool.query(
      'SELECT connection_state FROM bd_accounts WHERE id = $1 AND organization_id = $2 LIMIT 1',
      [accountId, organizationId]
    );
    const state = r.rows[0]?.connection_state;
    if (state === 'reauth_required') {
      throw new AppError(409, 'Telegram session expired. Reconnect account via QR or phone login.', ErrorCodes.BAD_REQUEST);
    }
  };

  // POST /:id/send — send message or file via Telegram
  router.post('/:id/send', validate(BdSendMessageSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { chatId, text, fileBase64, fileName, replyToMessageId, usernameHint } = req.body;
    const usernameHintNorm =
      typeof usernameHint === 'string' && usernameHint.trim() ? usernameHint.trim().replace(/^@/, '') : '';

    const bdHttpT0 = Date.now();
    const correlationId = req.correlationId;
    const chatIdTrim = String(chatId).trim();
    const chatIdSuffix = chatIdTrim.length <= 6 ? chatIdTrim : chatIdTrim.slice(-6);
    log.info({
      message: 'bd_send_http_enter',
      correlation_id: correlationId,
      account_id: id,
      chat_id_suffix: chatIdSuffix,
      has_file: !!(fileBase64 && typeof fileBase64 === 'string'),
    });

    const account = await getAccountOr404<{ id: string; is_demo?: boolean }>(pool, id, organizationId, 'id, is_demo');
    if (account.is_demo) {
      throw new AppError(403, 'Sending messages is disabled for demo accounts. Connect a real Telegram account to send messages.', ErrorCodes.FORBIDDEN);
    }
    await requireBidiCanWriteAccount(pool, id, req.user);
    await assertAccountNotReauthRequired(id, organizationId);
    if (!telegramManager.isConnected(id)) {
      throw new AppError(400, 'BD account is not connected', ErrorCodes.BAD_REQUEST);
    }

    log.info({
      message: 'bd_send_prechecks',
      correlation_id: correlationId,
      account_id: id,
      elapsed_ms: Date.now() - bdHttpT0,
    });

    const sendToPeer = async (peer: string): Promise<{ id: unknown; date?: unknown; peerId?: unknown }> => {
      log.info({
        message: 'bd_send_telegram_invoke_start',
        correlation_id: correlationId,
        account_id: id,
      });
      const invokeT0 = Date.now();
      try {
        if (fileBase64 && typeof fileBase64 === 'string') {
          const buf = Buffer.from(fileBase64, 'base64');
          if (buf.length > MAX_FILE_SIZE_BYTES) {
            throw new AppError(413, 'Maximum file size is 2 GB', ErrorCodes.VALIDATION);
          }
          return await telegramManager.sendFile(id, peer, buf, {
            caption: typeof text === 'string' ? text : '',
            filename: typeof fileName === 'string' ? fileName.trim() || 'file' : 'file',
            replyTo: replyToMessageId != null ? Number(replyToMessageId) : undefined,
            traceId: correlationId,
          });
        }
        const replyTo = replyToMessageId != null && String(replyToMessageId).trim() ? Number(replyToMessageId) : undefined;
        return await telegramManager.sendMessage(id, peer, typeof text === 'string' ? text : '', {
          replyTo,
          traceId: correlationId,
        });
      } finally {
        log.info({
          message: 'bd_send_telegram_invoke_done',
          correlation_id: correlationId,
          account_id: id,
          duration_ms: Date.now() - invokeT0,
        });
      }
    };

    const mapSendError = async (sendErr: unknown, peerForLog: string): Promise<never> => {
      const mapped = telegramSendErrorToAppError(sendErr);
      if (mapped) throw mapped;
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
      const retryAfterSeconds = getRetryAfterSeconds(sendErr);
      const codeNum = sendErr != null && typeof sendErr === 'object' && 'code' in sendErr ? (sendErr as { code: unknown }).code : undefined;
      const isFlood =
        codeNum === 420 ||
        (typeof errMsg === 'string' && /wait of \d+ seconds?/i.test(errMsg));
      if (isFlood && retryAfterSeconds != null) {
        throw new AppError(
          429,
          errMsg && errMsg.length < 256 ? errMsg : 'Telegram flood wait. Retry after the indicated time.',
          ErrorCodes.RATE_LIMITED,
          { retryAfterSeconds }
        );
      }
      if (
        (typeof code === 'string' && /^PEER_FLOOD$/i.test(code)) ||
        (typeof errMsg === 'string' && errMsg.includes('PEER_FLOOD'))
      ) {
        try {
          await incrementPeerFloodAndMaybeEscalate(pool, id);
        } catch {
          /* non-fatal */
        }
        throw new AppError(
          429,
          'Telegram rate limit (PEER_FLOOD). Send fewer messages to this user or wait before retrying.',
          ErrorCodes.RATE_LIMITED,
          retryAfterSeconds != null ? { retryAfterSeconds } : undefined
        );
      }
      if (
        (typeof code === 'string' && /^INPUT_USER_DEACTIVATED$/i.test(code)) ||
        (typeof errMsg === 'string' && errMsg.includes('INPUT_USER_DEACTIVATED'))
      ) {
        throw new AppError(
          400,
          'Recipient Telegram account is deactivated.',
          ErrorCodes.BAD_REQUEST
        );
      }
      log.warn({ message: 'Telegram send failed', accountId: id, chatId: peerForLog, error: errMsg, code });
      throw new AppError(
        502,
        errMsg && errMsg.length < 256 ? errMsg : 'Telegram send failed',
        ErrorCodes.SERVICE_UNAVAILABLE
      );
    };

    let usedPeerForSync = String(chatId).trim();
    /** Set in try/catch; all non-throwing paths assign before use below. */
    let message!: { id: unknown; date?: unknown; peerId?: unknown };
    try {
      message = await sendToPeer(usedPeerForSync);
    } catch (sendErr: unknown) {
      const errMsg = getErrorMessage(sendErr);
      const code = getErrorCode(sendErr);
      const isEntityResolution =
        (typeof errMsg === 'string' &&
          (errMsg.includes('Could not find the input entity') ||
            errMsg.includes('input entity') ||
            errMsg.includes('PEER_ID_INVALID') ||
            errMsg.includes('CHAT_ID_INVALID'))) ||
        (typeof code === 'string' && /^(PEER_ID_INVALID|CHAT_ID_INVALID)$/i.test(code));
      if (isEntityResolution && usernameHintNorm && usernameHintNorm !== usedPeerForSync) {
        log.info({
          message: 'Telegram send retry with usernameHint after entity resolution failure',
          accountId: id,
          chatId: usedPeerForSync,
          usernameHint: usernameHintNorm,
        });
        usedPeerForSync = usernameHintNorm;
        try {
          message = await sendToPeer(usernameHintNorm);
        } catch (sendErr2: unknown) {
          await mapSendError(sendErr2, usernameHintNorm);
        }
      } else {
        await mapSendError(sendErr, usedPeerForSync);
      }
    }

    const chatIdStr = usedPeerForSync;
    const canonical = chatIdStr ? canonicalTelegramChatIdFromMessage(message) : null;
    const resolvedChatId: string = (canonical || chatIdStr) ?? chatIdStr;

    const serialized = serializeMessage(message);
    const payload: Record<string, unknown> = {
      success: true,
      messageId: String(message.id),
      date: message.date,
      resolvedChatId,
    };
    if (serialized.telegram_media) payload.telegram_media = serialized.telegram_media;
    if (serialized.telegram_entities) payload.telegram_entities = serialized.telegram_entities;

    log.info({
      message: 'bd_send_http_response',
      correlation_id: correlationId,
      account_id: id,
      elapsed_ms: Date.now() - bdHttpT0,
    });
    res.json(payload);

    if (chatIdStr) {
      setImmediate(async () => {
        const syncT0 = Date.now();
        try {
          log.info({ message: 'bd_send_post_sync_start', correlation_id: correlationId, account_id: id });
          const peerType = peerTypeFromChatId(chatIdStr);
          await pool.query(
            `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id, sync_list_origin)
             VALUES ($1, $2, '', $3, false, NULL, 'outbound_send')
             ON CONFLICT (bd_account_id, telegram_chat_id) DO NOTHING`,
            [id, chatIdStr, peerType]
          );
          await mergeOutboundSendSyncRow(pool, id, chatIdStr, canonical);
        } catch (e) {
          log.warn({
            message: 'bd_send_post_sync_error',
            correlation_id: correlationId,
            account_id: id,
            error: e instanceof Error ? e.message : String(e),
            elapsed_ms: Date.now() - syncT0,
          });
          return;
        }
        log.info({
          message: 'bd_send_post_sync_done',
          correlation_id: correlationId,
          account_id: id,
          elapsed_ms: Date.now() - syncT0,
        });
      });
    }
  }));

  // POST /:id/send-bulk — send one message to multiple chats
  router.post('/:id/send-bulk', validate(BdSendBulkSchema), asyncHandler(async (req, res) => {
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
        const sentMsg = await telegramManager.sendMessage(id, chatId, text, {});
        sent++;
        const bulkChatId = chatId;
        const bulkCanonical = canonicalTelegramChatIdFromMessage(sentMsg as { peerId?: unknown });
        setImmediate(async () => {
          try {
            const peerType = peerTypeFromChatId(bulkChatId);
            await pool.query(
              `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id, sync_list_origin)
               VALUES ($1, $2, '', $3, false, NULL, 'outbound_send')
               ON CONFLICT (bd_account_id, telegram_chat_id) DO NOTHING`,
              [id, bulkChatId, peerType]
            );
            await mergeOutboundSendSyncRow(pool, id, bulkChatId, bulkCanonical);
          } catch (e) {
            log.warn({ message: 'bd_send_bulk_post_sync_error', account_id: id, chatId: bulkChatId, error: e instanceof Error ? e.message : String(e) });
          }
        });
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
  router.post('/:id/forward', validate(BdForwardMessageSchema), asyncHandler(async (req, res) => {
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
  router.post('/:id/draft', validate(BdDraftSchema), asyncHandler(async (req, res) => {
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
  router.post('/:id/delete-message', validate(BdDeleteMessageSchema), asyncHandler(async (req, res) => {
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
  router.post('/:id/create-shared-chat', validate(BdCreateSharedChatSchema), asyncHandler(async (req, res) => {
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
        `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id, access_hash, sync_list_origin)
         VALUES ($1, $2, $3, 'chat', false, NULL, $4, 'outbound_send')
         ON CONFLICT (bd_account_id, telegram_chat_id) DO UPDATE SET title = EXCLUDED.title, access_hash = COALESCE(EXCLUDED.access_hash, bd_account_sync_chats.access_hash)`,
        [accountId, fullChannelId, (result.title ?? title.trim()).slice(0, 500), accessHash]
      );
    }

    res.json({ channelId: result.channelId, title: result.title, inviteLink: result.inviteLink ?? null });
  }));

  // POST /:id/messages/:telegramMessageId/reaction — set reactions on a message
  router.post('/:id/messages/:telegramMessageId/reaction', validate(BdReactionBodySchema), asyncHandler(async (req, res) => {
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

  // POST /:id/resolve-peer — resolve username or numeric id to stable peer id (primes session cache; no message send)
  router.post('/:id/resolve-peer', validate(BdResolvePeerSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { chatId, usernameHint } = req.body as { chatId: string; usernameHint?: string | null };

    await getAccountOr404(pool, id, organizationId, 'id');
    await assertAccountNotReauthRequired(id, organizationId);
    if (!telegramManager.isConnected(id)) {
      return res.json({ resolvedPeerId: null });
    }

    const hintNorm =
      typeof usernameHint === 'string' && usernameHint.trim() ? usernameHint.trim().replace(/^@/, '') : null;
    const result = await telegramManager.resolvePeerIdForCampaign(id, String(chatId).trim(), hintNorm);
    res.json({ resolvedPeerId: result.resolvedPeerId ?? null });
  }));

  // POST /:id/typing — send typing indicator (no-op if account not connected, so campaign human sim does not fail)
  router.post('/:id/typing', validate(BdChatIdBodySchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { chatId } = req.body;

    await getAccountOr404(pool, id, organizationId, 'id');
    await assertAccountNotReauthRequired(id, organizationId);
    if (!telegramManager.isConnected(id)) {
      return res.json({ success: true });
    }
    await telegramManager.setTyping(id, String(chatId));
    res.json({ success: true });
  }));

  // POST /:id/read — mark messages as read (no-op if account not connected, so campaign human sim does not fail)
  router.post('/:id/read', validate(BdChatIdBodySchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { chatId, maxId } = req.body as { chatId: string; maxId?: number };

    await getAccountOr404(pool, id, organizationId, 'id');
    await assertAccountNotReauthRequired(id, organizationId);
    if (!telegramManager.isConnected(id)) {
      return res.json({ success: true });
    }
    await telegramManager.markAsRead(id, String(chatId), typeof maxId === 'number' && maxId > 0 ? { maxId } : undefined);
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
