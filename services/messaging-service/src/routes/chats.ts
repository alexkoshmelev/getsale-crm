import { Router } from 'express';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, canPermission, ServiceHttpClient, ServiceCallError, withOrgContext } from '@getsale/service-core';
import type { QueryParam } from '../types';
import { runSyncListQuery, runDefaultChatsQuery } from '../chats-list-helpers';
import { fetchBdInternalSyncChats, fetchBdInternalSyncChatsForManyAccounts } from '../bd-sync-chats-fetch';
import {
  queryMessagingStats,
  listPinnedChatsForAccount,
  appendPinnedChatForUser,
  deletePinnedChatForUser,
  replacePinnedChatsOrdered,
} from '../chats-stats-and-pins-queries';

interface Deps {
  pool: Pool;
  log: Logger;
  bdAccountsClient: ServiceHttpClient;
}

export function chatsRouter({ pool, log, bdAccountsClient }: Deps): Router {
  const router = Router();
  const checkPermission = canPermission(pool);

  // GET /chats — all chats (optionally filtered by bd_account_id). A1: when bdAccountId set, sync-chat list from bd-accounts internal API. A4: withOrgContext.
  router.get('/chats', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    let { channel, bdAccountId } = req.query;
    // Normalize so both "tg" and "telegram" work (frontend/URLs may send either).
    const channelNorm = channel != null ? String(channel).trim().toLowerCase() : '';
    if (channelNorm === 'tg') (channel as string) = 'telegram';

    const orgId = organizationId != null ? String(organizationId).trim() : '';
    if (!orgId) {
      throw new AppError(400, 'Organization context required', ErrorCodes.VALIDATION);
    }

    if (bdAccountId && String(bdAccountId).trim()) {
      if (channel && String(channel) !== 'telegram') {
        return res.json([] as { name?: string; channel_id?: string; peer_type?: string; account_name?: string }[]);
      }
      const bdId = String(bdAccountId).trim();

      let chats: Awaited<ReturnType<typeof fetchBdInternalSyncChats>>;
      try {
        chats = await fetchBdInternalSyncChats(bdAccountsClient, orgId, bdId);
      } catch (err) {
        if (err instanceof ServiceCallError) {
          const msg = typeof err.body === 'object' && err.body != null && 'error' in err.body && typeof (err.body as { error: unknown }).error === 'string'
            ? (err.body as { error: string }).error
            : err.message;
          throw new AppError(err.statusCode, msg, err.statusCode >= 500 ? ErrorCodes.INTERNAL_ERROR : ErrorCodes.BAD_REQUEST);
        }
        throw err;
      }
      if (!chats?.length) {
        return res.json([] as { name?: string; channel_id?: string; peer_type?: string; account_name?: string }[]);
      }
      const syncListJson = JSON.stringify(chats);
      const rows = await withOrgContext(pool, orgId, async (client) => runSyncListQuery(client, orgId, bdId, syncListJson));
      return res.json(rows);
    }

    const hasChannel = Boolean(channel && String(channel).trim());
    const chVal = hasChannel ? String(channel).trim() : '';

    const accountIds = await withOrgContext(pool, orgId, async (client) => {
      const accRes = await client.query<{ bd_account_id: string }>(
        `SELECT DISTINCT m.bd_account_id::text AS bd_account_id FROM messages m
         WHERE m.organization_id = $1 AND m.bd_account_id IS NOT NULL
         ${hasChannel ? 'AND m.channel = $2' : ''}`,
        hasChannel ? [orgId, chVal] : [orgId]
      );
      return accRes.rows.map((r) => r.bd_account_id);
    });

    const flat = await fetchBdInternalSyncChatsForManyAccounts(bdAccountsClient, log, orgId, accountIds);
    const syncJson = JSON.stringify(flat);
    const listParams: QueryParam[] = [orgId, syncJson];
    if (hasChannel) listParams.push(chVal);
    const rows = await withOrgContext(pool, orgId, async (client) =>
      runDefaultChatsQuery(client, listParams as (string | number)[], hasChannel)
    );
    res.json(rows);
  }));

  // GET /search — search chats by name via bd-accounts internal API (A1: no sync table read in messaging).
  router.get('/search', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const orgId = organizationId != null ? String(organizationId).trim() : '';
    if (!orgId) {
      throw new AppError(400, 'Organization context required', ErrorCodes.VALIDATION);
    }
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '5'), 10) || 5, 1), 20);
    if (!q || q.length < 2) {
      return res.json({ items: [] });
    }
    try {
      const data = await bdAccountsClient.get<{ items: unknown[] }>(
        `/internal/search-sync-chats?q=${encodeURIComponent(q)}&limit=${limit}`,
        undefined,
        { organizationId: orgId }
      );
      return res.json({ items: data.items ?? [] });
    } catch (err) {
      if (err instanceof ServiceCallError) {
        const msg = typeof err.body === 'object' && err.body != null && 'error' in err.body && typeof (err.body as { error: unknown }).error === 'string'
          ? (err.body as { error: string }).error
          : err.message;
        throw new AppError(err.statusCode, msg, err.statusCode >= 500 ? ErrorCodes.INTERNAL_ERROR : ErrorCodes.BAD_REQUEST);
      }
      throw err;
    }
  }));

  // GET /stats — messaging statistics
  router.get('/stats', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { startDate, endDate } = req.query;
    const { stats, unreadCount } = await queryMessagingStats(pool, organizationId, {
      startDate: startDate ? String(startDate) : undefined,
      endDate: endDate ? String(endDate) : undefined,
    });
    res.json({ stats, unreadCount });
  }));

  // GET /pinned-chats
  router.get('/pinned-chats', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { bdAccountId } = req.query;
    if (!bdAccountId || String(bdAccountId).trim() === '') {
      throw new AppError(400, 'bdAccountId is required', ErrorCodes.VALIDATION);
    }
    const rows = await listPinnedChatsForAccount(pool, userId, organizationId, String(bdAccountId).trim());
    res.json(rows);
  }));

  // POST /pinned-chats
  router.post('/pinned-chats', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { bdAccountId, channelId } = req.body;
    if (!bdAccountId || !channelId) {
      throw new AppError(400, 'bdAccountId and channelId are required', ErrorCodes.VALIDATION);
    }
    const bdId = String(bdAccountId).trim();
    const chId = String(channelId).trim();
    const { channel_id, order_index } = await appendPinnedChatForUser(pool, userId, organizationId, bdId, chId);
    res.json({ success: true, channel_id, order_index });
  }));

  // DELETE /pinned-chats/:channelId
  router.delete('/pinned-chats/:channelId', asyncHandler(async (req, res) => {
    const { id: userId, organizationId, role } = req.user;
    const allowed = await checkPermission(role, 'messaging', 'chat.delete');
    if (!allowed) {
      throw new AppError(403, 'Forbidden: no permission to unpin chats', ErrorCodes.FORBIDDEN);
    }
    const { channelId } = req.params;
    const { bdAccountId } = req.query;
    if (!bdAccountId || String(bdAccountId).trim() === '') {
      throw new AppError(400, 'bdAccountId query is required', ErrorCodes.VALIDATION);
    }
    await deletePinnedChatForUser(pool, userId, organizationId, String(bdAccountId).trim(), String(channelId));
    res.json({ success: true });
  }));

  // POST /pinned-chats/sync — replace current user's pins with ordered list from Telegram
  router.post('/pinned-chats/sync', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { bdAccountId, pinned_chat_ids: pinnedChatIds } = req.body;
    if (!bdAccountId || String(bdAccountId).trim() === '') {
      throw new AppError(400, 'bdAccountId is required', ErrorCodes.VALIDATION);
    }
    const bdId = String(bdAccountId).trim();
    const ids = Array.isArray(pinnedChatIds) ? pinnedChatIds.map((x: unknown) => String(x)).filter(Boolean) : [];
    const count = await replacePinnedChatsOrdered(pool, userId, organizationId, bdId, ids);
    res.json({ success: true, count });
  }));

  return router;
}
