// @ts-nocheck — GramJS types are incomplete
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, ErrorCodes, requireUser, DatabasePools } from '@getsale/service-framework';
import { RedisClient } from '@getsale/cache';
import { RabbitMQClient } from '@getsale/queue';
import { Logger } from '@getsale/logger';
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { telegramInvokeWithFloodRetry } from '@getsale/telegram';
import { SessionCoordinator } from '../coordinator';
import { CommandType } from '../command-types';
import { executeCreateSharedChatTelegram } from '../create-shared-chat-executor';

interface Deps {
  db: DatabasePools;
  rabbitmq: RabbitMQClient;
  log: Logger;
  redis: RedisClient;
  coordinator: SessionCoordinator;
}

// ── Zod Schemas ──

const DraftBody = z.object({
  channelId: z.string().min(1),
  text: z.string().optional().default(''),
  replyToMsgId: z.union([z.number(), z.string()]).optional().nullable(),
});

const ForwardBody = z.object({
  fromChatId: z.string().min(1),
  toChatId: z.string().min(1),
  telegramMessageId: z.number(),
});

const SendBulkBody = z.object({
  channelIds: z.array(z.string()).min(1).max(100),
  text: z.string().min(1),
});

const SendMessageBody = z.object({
  chatId: z.string().min(1),
  text: z.string().optional().default(''),
  fileBase64: z.string().optional().nullable(),
  fileName: z.string().optional().nullable(),
  replyToMessageId: z.union([z.number(), z.string()]).optional().nullable(),
  usernameHint: z.string().optional().nullable(),
});

const DeleteMessageBody = z.object({
  channelId: z.string().min(1),
  telegramMessageId: z.number(),
});

const CreateSharedChatBody = z.object({
  title: z.string().min(1).max(255),
  lead_telegram_user_id: z.union([z.number(), z.string()]).optional().nullable(),
  lead_username: z.string().optional().nullable(),
  extra_usernames: z.array(z.string()).optional().default([]),
});

const ReactionBody = z.object({
  chatId: z.string().min(1),
  reaction: z.array(z.string()).default([]),
});

const ResolvePeerBody = z.object({
  chatId: z.string().min(1),
  usernameHint: z.string().optional().nullable(),
});

const ChatIdBody = z.object({
  chatId: z.string().min(1),
  maxId: z.number().optional(),
});

// ── Helpers ──

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

function getActiveClient(accountId: string, deps: Deps): TelegramClient {
  const actor = deps.coordinator.getActor(accountId);
  if (!actor) {
    throw new AppError(503, 'Telegram session not active on this instance', ErrorCodes.INTERNAL_ERROR);
  }
  const client = actor.getClient();
  if (!client || !(client as any).connected) {
    throw new AppError(503, 'Telegram client not connected', ErrorCodes.INTERNAL_ERROR);
  }
  return client;
}

function tryGetActiveClient(accountId: string, deps: Deps): TelegramClient | null {
  const actor = deps.coordinator.getActor(accountId);
  if (!actor) return null;
  const client = actor.getClient();
  if (!client || !(client as any).connected) return null;
  return client;
}

function peerInput(chatId: string): number | string {
  const n = Number(chatId);
  return Number.isNaN(n) ? chatId : n;
}

function peerTypeFromChatId(chatId: string): 'chat' | 'user' {
  return /^-?\d+$/.test(chatId) && parseInt(chatId, 10) < 0 ? 'chat' : 'user';
}

async function assertAccountExists(
  db: DatabasePools,
  accountId: string,
  organizationId: string,
  columns = 'id',
): Promise<Record<string, any>> {
  const result = await db.read.query(
    `SELECT ${columns} FROM bd_accounts WHERE id = $1 AND organization_id = $2`,
    [accountId, organizationId],
  );
  if (!result.rows.length) {
    throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
  }
  return result.rows[0] as Record<string, any>;
}

async function assertNotReauthRequired(
  db: DatabasePools,
  accountId: string,
  organizationId: string,
): Promise<void> {
  const r = await db.read.query(
    'SELECT connection_state FROM bd_accounts WHERE id = $1 AND organization_id = $2 LIMIT 1',
    [accountId, organizationId],
  );
  if ((r.rows[0] as any)?.connection_state === 'reauth_required') {
    throw new AppError(409, 'Telegram session expired. Reconnect account via QR or phone login.', ErrorCodes.BAD_REQUEST);
  }
}

function canonicalChatIdFromMessage(msg: { peerId?: any }): string | null {
  const peer = msg?.peerId;
  if (!peer) return null;
  if (peer.userId != null) return String(peer.userId);
  if (peer.channelId != null) return String(-1000000000000 - Number(peer.channelId));
  if (peer.chatId != null) return String(-Number(peer.chatId));
  return null;
}

function mapTelegramSendError(err: unknown, log: Logger, accountId: string, chatId: string): never {
  const errMsg = err instanceof Error ? err.message : String(err);
  const errCode = (err as any)?.errorMessage ?? (err as any)?.code ?? '';

  const isPeerInvalid =
    /Could not find the input entity|input entity|PEER_ID_INVALID|CHAT_ID_INVALID|USERNAME_NOT_OCCUPIED|USERNAME_INVALID|Username not found/i.test(errMsg) ||
    /^(PEER_ID_INVALID|CHAT_ID_INVALID|USERNAME_NOT_OCCUPIED|USERNAME_INVALID|CHAT_NOT_FOUND)$/i.test(String(errCode));
  if (isPeerInvalid) {
    throw new AppError(
      400,
      'User or chat not found. Check that the Telegram ID or username is correct.',
      ErrorCodes.BAD_REQUEST,
    );
  }

  const codeNum = (err as any)?.code;
  const isFlood =
    codeNum === 420 || /wait of \d+ seconds?/i.test(errMsg) || errMsg.includes('FloodWait');
  if (isFlood) {
    const match = errMsg.match(/(\d+)\s*seconds?/i);
    const retryAfterSeconds = match ? parseInt(match[1], 10) : 60;
    throw new AppError(429, 'Telegram flood wait. Retry after the indicated time.', ErrorCodes.RATE_LIMITED, { retryAfterSeconds });
  }

  if (/PEER_FLOOD/i.test(errMsg) || /PEER_FLOOD/i.test(String(errCode))) {
    throw new AppError(429, 'Telegram rate limit (PEER_FLOOD). Send fewer messages or wait before retrying.', ErrorCodes.RATE_LIMITED);
  }

  if (/INPUT_USER_DEACTIVATED/i.test(errMsg) || /INPUT_USER_DEACTIVATED/i.test(String(errCode))) {
    throw new AppError(400, 'Recipient Telegram account is deactivated.', ErrorCodes.BAD_REQUEST);
  }

  log.warn({ message: 'Telegram operation failed', accountId, chatId, error: errMsg, code: errCode });
  throw new AppError(502, errMsg.length < 256 ? errMsg : 'Telegram operation failed', ErrorCodes.SERVICE_UNAVAILABLE);
}

// ── Route Registration ──

export function registerMessagingRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, log, rabbitmq } = deps;

  // ═══════════════════════════════════════════════════════
  // SYNCHRONOUS ROUTES (use GramJS client directly)
  // ═══════════════════════════════════════════════════════

  /**
   * POST /api/bd-accounts/:id/send
   * Send a message or file via Telegram. Synchronous — returns the sent message details.
   */
  app.post('/api/bd-accounts/:id/send', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const body = SendMessageBody.parse(request.body);

    const account = await assertAccountExists(db, id, user.organizationId, 'id, is_demo');
    if (account.is_demo) {
      throw new AppError(403, 'Sending messages is disabled for demo accounts. Connect a real Telegram account to send messages.', ErrorCodes.FORBIDDEN);
    }
    await assertNotReauthRequired(db, id, user.organizationId);

    const client = getActiveClient(id, deps);

    const chatIdTrim = String(body.chatId).trim();
    const usernameHintNorm =
      typeof body.usernameHint === 'string' && body.usernameHint.trim()
        ? body.usernameHint.trim().replace(/^@/, '')
        : '';

    log.info({ message: 'bd_send_http_enter', account_id: id, has_file: !!(body.fileBase64) });

    const sendToPeer = async (peer: string | number): Promise<any> => {
      if (body.fileBase64 && typeof body.fileBase64 === 'string') {
        const buf = Buffer.from(body.fileBase64, 'base64');
        if (buf.length > MAX_FILE_SIZE_BYTES) {
          throw new AppError(413, 'Maximum file size is 2 GB', ErrorCodes.VALIDATION);
        }
        const replyTo = body.replyToMessageId != null ? Number(body.replyToMessageId) : undefined;
        return await telegramInvokeWithFloodRetry(log, id, 'SendFile', () =>
          client.sendFile(peer, {
            file: new Api.InputFile({
              id: BigInt(0),
              parts: 0,
              name: typeof body.fileName === 'string' ? body.fileName.trim() || 'file' : 'file',
              md5Checksum: '',
            }),
            caption: typeof body.text === 'string' ? body.text : '',
            replyTo,
            forceDocument: true,
            workers: 1,
            // Pass raw buffer for the upload helper
          } as any),
        );
      }
      const replyTo = body.replyToMessageId != null && String(body.replyToMessageId).trim()
        ? Number(body.replyToMessageId)
        : undefined;
      return await telegramInvokeWithFloodRetry(log, id, 'SendMessage', () =>
        client.sendMessage(peer, { message: body.text, replyTo }),
      );
    };

    let usedPeerForSync = chatIdTrim;
    let message: any;

    try {
      const entity = await client.getInputEntity(peerInput(usedPeerForSync));
      message = await sendToPeer(entity);
    } catch (sendErr: unknown) {
      const errMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
      const isPeerResolution = /Could not find the input entity|input entity|PEER_ID_INVALID|CHAT_ID_INVALID/i.test(errMsg);

      if (isPeerResolution && usernameHintNorm && usernameHintNorm !== usedPeerForSync) {
        log.info({ message: 'Retrying send with usernameHint', account_id: id, usernameHint: usernameHintNorm });
        usedPeerForSync = usernameHintNorm;
        try {
          const entity = await client.getInputEntity(usernameHintNorm);
          message = await sendToPeer(entity);
        } catch (retryErr: unknown) {
          mapTelegramSendError(retryErr, log, id, usernameHintNorm);
        }
      } else {
        mapTelegramSendError(sendErr, log, id, usedPeerForSync);
      }
    }

    const canonical = canonicalChatIdFromMessage(message);
    const resolvedChatId = canonical || usedPeerForSync;

    const payload: Record<string, unknown> = {
      success: true,
      messageId: String(message.id),
      date: message.date,
      resolvedChatId,
    };

    // Post-send: upsert sync row in background
    setImmediate(async () => {
      try {
        const pt = peerTypeFromChatId(usedPeerForSync);
        await db.write.query(
          `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id, sync_list_origin)
           VALUES ($1, $2, '', $3, false, NULL, 'outbound_send')
           ON CONFLICT (bd_account_id, telegram_chat_id) DO NOTHING`,
          [id, usedPeerForSync, pt],
        );
        if (canonical && canonical !== usedPeerForSync) {
          const cpt = peerTypeFromChatId(canonical);
          await db.write.query(
            `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id, sync_list_origin)
             VALUES ($1, $2, '', $3, false, NULL, 'outbound_send')
             ON CONFLICT (bd_account_id, telegram_chat_id) DO UPDATE SET sync_list_origin = 'outbound_send'`,
            [id, canonical, cpt],
          );
          await db.write.query(
            'DELETE FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2',
            [id, usedPeerForSync],
          );
        }
      } catch (e) {
        log.warn({ message: 'bd_send_post_sync_error', account_id: id, error: e instanceof Error ? e.message : String(e) });
      }
    });

    return payload;
  });

  /**
   * POST /api/bd-accounts/:id/resolve-peer
   * Resolve username or numeric id to a stable peer id. Synchronous.
   */
  app.post('/api/bd-accounts/:id/resolve-peer', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const body = ResolvePeerBody.parse(request.body);

    await assertAccountExists(db, id, user.organizationId);
    await assertNotReauthRequired(db, id, user.organizationId);

    const client = tryGetActiveClient(id, deps);
    if (!client) {
      return { resolvedPeerId: null };
    }

    const chatIdTrim = String(body.chatId).trim();
    const hintNorm =
      typeof body.usernameHint === 'string' && body.usernameHint.trim()
        ? body.usernameHint.trim().replace(/^@/, '')
        : null;

    let resolvedPeerId: string | null = null;
    const targets = [chatIdTrim];
    if (hintNorm && hintNorm !== chatIdTrim) targets.push(hintNorm);

    for (const target of targets) {
      try {
        const entity = await client.getEntity(peerInput(target)) as any;
        if (entity?.id != null) {
          resolvedPeerId = String(entity.id);
          break;
        }
      } catch {
        // Try next target
      }
    }

    return { resolvedPeerId };
  });

  /**
   * POST /api/bd-accounts/:id/create-shared-chat
   * Create a Telegram supergroup and invite users. Synchronous — returns channel info.
   */
  app.post('/api/bd-accounts/:id/create-shared-chat', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const body = CreateSharedChatBody.parse(request.body);

    await assertAccountExists(db, id, user.organizationId);

    const client = getActiveClient(id, deps);

    const title = body.title.trim().slice(0, 255);
    const leadId = body.lead_telegram_user_id != null ? Number(body.lead_telegram_user_id) : undefined;
    const leadUser = typeof body.lead_username === 'string' && body.lead_username.trim()
      ? body.lead_username.trim().replace(/^@/, '')
      : undefined;
    const extraUsernames = body.extra_usernames ?? [];

    const result = await executeCreateSharedChatTelegram({
      client,
      pool: db.write,
      log,
      bdAccountId: id,
      title,
      leadTelegramUserId: leadId,
      leadUsername: leadUser,
      extraUsernames,
    }).catch((err) => {
      log.error({ message: 'create-shared-chat executor failed', account_id: id, error: String(err) });
      throw new AppError(502, 'Failed to create Telegram group', ErrorCodes.SERVICE_UNAVAILABLE);
    });

    return { channelId: result.channelId, title: result.title, inviteLink: result.inviteLink };
  });

  // ═══════════════════════════════════════════════════════
  // HYBRID ROUTES (sync if client available, else queue)
  // ═══════════════════════════════════════════════════════

  /**
   * POST /api/bd-accounts/:id/delete-message
   * Delete a message in Telegram. Executes synchronously if client available, otherwise queued.
   */
  app.post('/api/bd-accounts/:id/delete-message', { preHandler: [requireUser] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const body = DeleteMessageBody.parse(request.body);

    await assertAccountExists(db, id, user.organizationId);

    const client = tryGetActiveClient(id, deps);
    if (client) {
      try {
        const peer = await client.getInputEntity(peerInput(String(body.channelId)));

        if ((peer as any)?.className === 'InputPeerChannel') {
          await telegramInvokeWithFloodRetry(log, id, 'channels.DeleteMessages', () =>
            client.invoke(new Api.channels.DeleteMessages({
              channel: peer as any,
              id: [body.telegramMessageId],
            })),
          );
        } else {
          await telegramInvokeWithFloodRetry(log, id, 'messages.DeleteMessages', () =>
            client.invoke(new Api.messages.DeleteMessages({
              id: [body.telegramMessageId],
              revoke: true,
            })),
          );
        }
        return { success: true };
      } catch (err: unknown) {
        mapTelegramSendError(err, log, id, body.channelId);
      }
    }

    await rabbitmq.publishCommand(`telegram:commands:${id}`, {
      type: CommandType.DELETE_MESSAGE,
      payload: {
        accountId: id,
        organizationId: user.organizationId,
        channelId: body.channelId,
        telegramMessageId: body.telegramMessageId,
      },
    });

    reply.code(202);
    return { status: 'queued' };
  });

  /**
   * POST /api/bd-accounts/:id/messages/:telegramMessageId/reaction
   * Send or remove reactions on a message. Sync if client available, otherwise queued.
   */
  app.post('/api/bd-accounts/:id/messages/:telegramMessageId/reaction', { preHandler: [requireUser] }, async (request, reply) => {
    const { id, telegramMessageId } = request.params as { id: string; telegramMessageId: string };
    const user = request.user!;
    const body = ReactionBody.parse(request.body);

    await assertAccountExists(db, id, user.organizationId);

    const reactionList = body.reaction.map(String).filter(Boolean);

    const client = tryGetActiveClient(id, deps);
    if (client) {
      try {
        const peer = await client.getInputEntity(peerInput(body.chatId));
        const reactionObjects = reactionList.map(
          (emoji) => new Api.ReactionEmoji({ emoticon: emoji }),
        );

        await telegramInvokeWithFloodRetry(log, id, 'SendReaction', () =>
          client.invoke(new Api.messages.SendReaction({
            peer,
            msgId: Number(telegramMessageId),
            reaction: reactionObjects,
          })),
        );
        return { success: true };
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('REACTION_INVALID') || (err as any)?.errorMessage === 'REACTION_INVALID') {
          log.warn({ message: 'Reaction not applied (REACTION_INVALID), local state kept', entity_id: id });
          return { success: true, skipped: 'REACTION_INVALID' };
        }
        mapTelegramSendError(err, log, id, body.chatId);
      }
    }

    await rabbitmq.publishCommand(`telegram:commands:${id}`, {
      type: CommandType.SEND_REACTION,
      payload: {
        accountId: id,
        organizationId: user.organizationId,
        chatId: body.chatId,
        telegramMessageId: Number(telegramMessageId),
        reaction: reactionList,
      },
    });

    reply.code(202);
    return { status: 'queued' };
  });

  /**
   * POST /api/bd-accounts/:id/typing
   * Send typing indicator. No-op if account not connected (matches v1 behaviour).
   */
  app.post('/api/bd-accounts/:id/typing', { preHandler: [requireUser] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const body = ChatIdBody.parse(request.body);

    await assertAccountExists(db, id, user.organizationId);
    await assertNotReauthRequired(db, id, user.organizationId);

    const client = tryGetActiveClient(id, deps);
    if (client) {
      try {
        const peer = await client.getInputEntity(peerInput(body.chatId));
        await client.invoke(new Api.messages.SetTyping({
          peer,
          action: new Api.SendMessageTypingAction(),
        }));
      } catch (err) {
        log.warn({ message: 'setTyping failed', account_id: id, chatId: body.chatId, error: String(err) });
      }
      return { success: true };
    }

    await rabbitmq.publishCommand(`telegram:commands:${id}`, {
      type: CommandType.TYPING,
      payload: { accountId: id, organizationId: user.organizationId, channelId: body.chatId },
    });

    reply.code(202);
    return { success: true, status: 'queued' };
  });

  /**
   * POST /api/bd-accounts/:id/read
   * Mark messages as read. No-op if account not connected (matches v1 behaviour).
   */
  app.post('/api/bd-accounts/:id/read', { preHandler: [requireUser] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const body = ChatIdBody.parse(request.body);

    await assertAccountExists(db, id, user.organizationId);
    await assertNotReauthRequired(db, id, user.organizationId);

    const client = tryGetActiveClient(id, deps);
    if (client) {
      try {
        const peer = await client.getInputEntity(peerInput(body.chatId));
        const maxId = typeof body.maxId === 'number' && body.maxId > 0 ? body.maxId : 0;

        if ((peer as any)?.className === 'InputPeerChannel') {
          await telegramInvokeWithFloodRetry(log, id, 'channels.ReadHistory', () =>
            client.invoke(new Api.channels.ReadHistory({ channel: peer as any, maxId })),
          );
        } else {
          await telegramInvokeWithFloodRetry(log, id, 'messages.ReadHistory', () =>
            client.invoke(new Api.messages.ReadHistory({ peer, maxId })),
          );
        }
      } catch (err) {
        log.warn({ message: 'markAsRead failed', account_id: id, chatId: body.chatId, error: String(err) });
      }
      return { success: true };
    }

    await rabbitmq.publishCommand(`telegram:commands:${id}`, {
      type: CommandType.MARK_READ,
      payload: {
        accountId: id,
        organizationId: user.organizationId,
        channelId: body.chatId,
        maxId: body.maxId ?? 0,
      },
    });

    reply.code(202);
    return { success: true, status: 'queued' };
  });

  // ═══════════════════════════════════════════════════════
  // ASYNC ROUTES (queued via RabbitMQ)
  // ═══════════════════════════════════════════════════════

  /**
   * POST /api/bd-accounts/:id/draft
   * Save a draft message via Telegram.
   * Publishes command to RabbitMQ for the actor to execute via GramJS.
   */
  app.post('/api/bd-accounts/:id/draft', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const body = DraftBody.parse(request.body);

    await assertAccountExists(db, id, user.organizationId);

    const syncCheck = await db.read.query(
      'SELECT 1 FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2',
      [id, String(body.channelId)],
    );
    if (!syncCheck.rows.length) {
      throw new AppError(403, 'Chat is not in sync list for this account', ErrorCodes.FORBIDDEN);
    }

    await rabbitmq.publishCommand(`telegram:commands:${id}`, {
      type: CommandType.SAVE_DRAFT,
      payload: {
        accountId: id,
        organizationId: user.organizationId,
        channelId: body.channelId,
        text: body.text,
        replyToMsgId: body.replyToMsgId ?? null,
      },
    });

    return { success: true };
  });

  /**
   * POST /api/bd-accounts/:id/forward
   * Forward a message between chats.
   * Publishes command to RabbitMQ for the actor to execute via GramJS.
   */
  app.post('/api/bd-accounts/:id/forward', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const body = ForwardBody.parse(request.body);

    await assertAccountExists(db, id, user.organizationId);

    await rabbitmq.publishCommand(`telegram:commands:${id}`, {
      type: CommandType.FORWARD_MESSAGE,
      payload: {
        accountId: id,
        organizationId: user.organizationId,
        fromChatId: body.fromChatId,
        toChatId: body.toChatId,
        telegramMessageId: body.telegramMessageId,
      },
    });

    return { success: true, status: 'queued' };
  });

  /**
   * POST /api/bd-accounts/:id/send-bulk
   * Send a message to multiple chats.
   * Publishes command to RabbitMQ for the actor to execute sequentially via GramJS.
   */
  app.post('/api/bd-accounts/:id/send-bulk', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const body = SendBulkBody.parse(request.body);

    await assertAccountExists(db, id, user.organizationId, 'id, is_active');

    await rabbitmq.publishCommand(`telegram:commands:${id}`, {
      type: CommandType.SEND_BULK,
      payload: {
        accountId: id,
        organizationId: user.organizationId,
        channelIds: body.channelIds,
        text: body.text,
      },
    });

    return { status: 'queued', channelCount: body.channelIds.length };
  });

  /**
   * POST /api/bd-accounts/:id/chats/:chatId/load-older-history
   * Load older messages from Telegram for a specific chat.
   * Publishes command to RabbitMQ for the actor to fetch via GramJS.
   */
  app.post('/api/bd-accounts/:id/chats/:chatId/load-older-history', { preHandler: [requireUser] }, async (request) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const user = request.user!;

    await assertAccountExists(db, id, user.organizationId, 'id, organization_id');

    await rabbitmq.publishCommand(`telegram:commands:${id}`, {
      type: CommandType.LOAD_OLDER_HISTORY,
      payload: {
        accountId: id,
        organizationId: user.organizationId,
        chatId,
      },
    });

    return { status: 'queued' };
  });
}
