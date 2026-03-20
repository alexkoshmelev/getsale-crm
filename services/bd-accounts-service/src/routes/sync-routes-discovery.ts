import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, AppError, ErrorCodes, validate } from '@getsale/service-core';
import type { ResolvedSource } from '../telegram';
import { getAccountOr404, getErrorCode, getErrorMessage } from '../helpers';
import {
  ResolveChatsSchema,
  ParseResolveSchema,
  CommentParticipantsQuerySchema,
  ReactionParticipantsQuerySchema,
} from '../validation';
import type { SyncRouteDeps } from './sync-route-deps';

const RESOLVE_CHATS_MAX_INPUTS = 20;

/** Contact discovery: search, participants, resolve, parse/resolve. */
export function registerSyncDiscoveryRoutes(router: Router, deps: SyncRouteDeps): void {
  const { pool, log, telegramManager } = deps;

  router.get('/:id/search-groups', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 50));
    const maxPages = Math.min(15, Math.max(1, parseInt(String(req.query.maxPages), 10) || 10));
    const typeParam = typeof req.query.type === 'string' ? req.query.type.toLowerCase() : 'all';
    const type = typeParam === 'groups' || typeParam === 'channels' ? typeParam : 'all';

    await getAccountOr404(pool, id, organizationId, 'id');
    if (q.length < 2) {
      throw new AppError(400, 'Query must be at least 2 characters', ErrorCodes.VALIDATION);
    }
    const MAX_QUERY_LENGTH = 200;
    if (q.length > MAX_QUERY_LENGTH) {
      throw new AppError(400, `Query must be at most ${MAX_QUERY_LENGTH} characters`, ErrorCodes.VALIDATION);
    }
    const searchMode = (q.startsWith('#') || req.query.searchMode === 'hashtag') ? 'hashtag' as const : 'query' as const;
    const SEARCH_SOURCE_DELAY_MS = 400;

    try {
      type SearchItem = { chatId: string; title: string; peerType: string; membersCount?: number; username?: string };
      let groups: SearchItem[];
      if (type === 'groups') {
        groups = await telegramManager.searchGroupsByKeyword(id, q, limit, type, maxPages);
        try {
          await new Promise((r) => setTimeout(r, SEARCH_SOURCE_DELAY_MS));
          const fromContacts = await telegramManager.searchByContacts(id, q, limit);
          const onlyGroups = fromContacts.filter((item) => item.peerType === 'chat');
          const seenIds = new Set(groups.map((g) => g.chatId));
          for (const item of onlyGroups) {
            if (!seenIds.has(item.chatId)) {
              seenIds.add(item.chatId);
              groups.push(item);
            }
          }
        } catch (contactsErr: any) {
          log.warn({ message: 'contacts.search failed for type=groups', accountId: id, query: q, error: contactsErr?.message });
        }
        groups = groups.slice(0, limit);
      } else if (type === 'channels') {
        groups = await telegramManager.searchPublicChannelsByKeyword(id, q, limit, maxPages, searchMode);
        groups = groups.slice(0, limit);
      } else {
        groups = await telegramManager.searchPublicChannelsByKeyword(id, q, limit, maxPages, searchMode);
        try {
          await new Promise((r) => setTimeout(r, SEARCH_SOURCE_DELAY_MS));
          const fromContacts = await telegramManager.searchByContacts(id, q, limit);
          const seenIds = new Set(groups.map((g) => g.chatId));
          for (const item of fromContacts) {
            if (!seenIds.has(item.chatId)) {
              seenIds.add(item.chatId);
              groups.push(item);
            }
          }
        } catch (contactsErr: unknown) {
          log.warn({ message: 'contacts.search failed, returning SearchPosts only', accountId: id, query: q, error: getErrorMessage(contactsErr) });
        }
        groups = groups.slice(0, limit);
      }
      res.json(groups);
    } catch (e: unknown) {
      if (getErrorCode(e) === 'QUERY_TOO_SHORT') {
        throw new AppError(400, 'Query too short', ErrorCodes.VALIDATION);
      }
      throw e;
    }
  }));

  router.get('/:id/admined-public-channels', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;

    await getAccountOr404(pool, id, organizationId, 'id');
    const channels = await telegramManager.getAdminedPublicChannels(id);
    res.json(channels);
  }));

  router.get('/:id/chats/:chatId/participants', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id, chatId } = req.params;
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit), 10) || 200));
    const offset = Math.max(0, parseInt(String(req.query.offset), 10) || 0);
    const excludeAdmins = req.query.excludeAdmins === 'true' || req.query.excludeAdmins === '1';

    await getAccountOr404(pool, id, organizationId, 'id');
    if (!chatId || chatId.length > 128) {
      throw new AppError(400, 'Invalid chatId', ErrorCodes.VALIDATION);
    }
    try {
      const result = await telegramManager.getChannelParticipants(id, chatId, offset, limit, excludeAdmins);
      res.json(result);
    } catch (e: unknown) {
      if (getErrorCode(e) === 'CHAT_ADMIN_REQUIRED') {
        throw new AppError(403, 'No permission to get participants', ErrorCodes.FORBIDDEN);
      }
      if (getErrorCode(e) === 'CHANNEL_PRIVATE') {
        throw new AppError(404, 'Channel is private', ErrorCodes.NOT_FOUND);
      }
      throw e;
    }
  }));

  router.get(
    '/:id/chats/:chatId/reaction-participants',
    validate(ReactionParticipantsQuerySchema, 'query'),
    asyncHandler(async (req, res) => {
      const { organizationId } = req.user;
      const { id, chatId } = req.params;
      const q = req.query as unknown as z.infer<typeof ReactionParticipantsQuerySchema>;
      const depth = q.depth ?? 80;

      await getAccountOr404(pool, id, organizationId, 'id');
      if (!chatId || chatId.length > 128) {
        throw new AppError(400, 'Invalid chatId', ErrorCodes.VALIDATION);
      }
      const result = await telegramManager.getReactionContributors(id, chatId, { historyLimit: depth });
      res.json(result);
    })
  );

  router.get(
    '/:id/chats/:channelId/comment-participants',
    validate(CommentParticipantsQuerySchema, 'query'),
    asyncHandler(async (req, res) => {
      const { organizationId } = req.user;
      const { id, channelId } = req.params;
      const q = req.query as unknown as z.infer<typeof CommentParticipantsQuerySchema>;
      const excludeAdmins = q.excludeAdmins === 'true' || q.excludeAdmins === '1';

      await getAccountOr404(pool, id, organizationId, 'id');
      if (!channelId || channelId.length > 128) {
        throw new AppError(400, 'Invalid channelId', ErrorCodes.VALIDATION);
      }
      try {
        const result = await telegramManager.getCommentGroupParticipants(id, channelId, q.linkedChatId, {
          postLimit: q.postLimit,
          maxRepliesPerPost: q.maxRepliesPerPost,
          excludeAdmins,
        });
        res.json(result);
      } catch (e: unknown) {
        if (getErrorCode(e) === 'CHAT_ADMIN_REQUIRED') {
          throw new AppError(403, 'No permission', ErrorCodes.FORBIDDEN);
        }
        throw e;
      }
    })
  );

  router.get('/:id/chats/:chatId/active-participants', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id, chatId } = req.params;
    const depth = Math.min(2000, Math.max(1, parseInt(String(req.query.depth), 10) || 100));
    const excludeAdmins = req.query.excludeAdmins === 'true' || req.query.excludeAdmins === '1';

    await getAccountOr404(pool, id, organizationId, 'id');
    if (!chatId || chatId.length > 128) {
      throw new AppError(400, 'Invalid chatId', ErrorCodes.VALIDATION);
    }
    try {
      const result = await telegramManager.getActiveParticipants(id, chatId, depth, excludeAdmins);
      res.json(result);
    } catch (e: unknown) {
      if (getErrorCode(e) === 'CHANNEL_PRIVATE') {
        throw new AppError(404, 'Channel is private', ErrorCodes.NOT_FOUND);
      }
      throw e;
    }
  }));

  router.post('/:id/chats/:chatId/leave', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id, chatId } = req.params;

    await getAccountOr404(pool, id, organizationId, 'id');
    if (!chatId || chatId.length > 128) {
      throw new AppError(400, 'Invalid chatId', ErrorCodes.VALIDATION);
    }
    try {
      await telegramManager.leaveChat(id, chatId);
      res.status(204).send();
    } catch (e: unknown) {
      if (getErrorCode(e) === 'CHANNEL_PRIVATE') {
        throw new AppError(404, 'Channel is private or already left', ErrorCodes.NOT_FOUND);
      }
      throw e;
    }
  }));

  router.post('/:id/resolve-chats', validate(ResolveChatsSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const inputs = (req.body.inputs ?? []).slice(0, RESOLVE_CHATS_MAX_INPUTS);

    await getAccountOr404(pool, id, organizationId, 'id');
    const results: Array<{ chatId?: string; title?: string; peerType?: string; error?: string }> = [];
    for (const input of inputs) {
      try {
        const resolved = await telegramManager.resolveChatFromInput(id, input);
        results.push({ chatId: resolved.chatId, title: resolved.title, peerType: resolved.peerType });
      } catch (e: unknown) {
        const code = getErrorCode(e);
        const msg = getErrorMessage(e);
        results.push({ error: code === 'CHAT_NOT_FOUND' ? 'Chat not found' : code === 'INVITE_EXPIRED' ? 'Invite expired' : code === 'INVALID_INVITE' ? 'Invalid invite link' : msg });
      }
    }
    res.json({ results });
  }));

  router.post('/:id/parse/resolve', validate(ParseResolveSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const sources = (req.body.sources ?? []).slice(0, RESOLVE_CHATS_MAX_INPUTS);

    await getAccountOr404(pool, id, organizationId, 'id');
    const results: Array<ResolvedSource & { error?: string }> = [];
    for (const input of sources) {
      try {
        const resolved = await telegramManager.resolveSourceFromInput(id, input);
        results.push(resolved);
      } catch (e: unknown) {
        const code = getErrorCode(e);
        const msg = getErrorMessage(e);
        results.push({
          input,
          type: 'unknown',
          title: '',
          chatId: '',
          canGetMembers: false,
          canGetMessages: false,
          error: code === 'CHAT_NOT_FOUND' ? 'Chat not found' : code === 'INVITE_EXPIRED' ? 'Invite expired' : code === 'INVALID_INVITE' ? 'Invalid invite link' : msg,
        });
      }
    }
    res.json({ results });
  }));
}
