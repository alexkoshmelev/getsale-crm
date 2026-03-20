import { Router } from 'express';
import { asyncHandler } from '@getsale/service-core';
import { TelegramManager } from '../telegram';
import { getAccountOr404, getErrorMessage } from '../helpers';
import type { SyncRouteDeps } from './sync-route-deps';

/** GET dialogs, folders, dialogs-by-folders (DB + optional Telegram refresh). */
export function registerSyncDialogsReadRoutes(router: Router, deps: SyncRouteDeps): void {
  const { pool, telegramManager } = deps;

  router.get('/:id/dialogs', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;

    await getAccountOr404(pool, id, organizationId, 'id');

    const forceRefresh = req.query.refresh === '1';
    if (!forceRefresh) {
      const chatsRows = await pool.query(
        'SELECT telegram_chat_id, title, peer_type FROM bd_account_sync_chats WHERE bd_account_id = $1 ORDER BY created_at',
        [id]
      );
      const dialogs = (chatsRows.rows as any[]).map((r) => {
        const pt = (r.peer_type || 'user').toLowerCase();
        return {
          id: String(r.telegram_chat_id),
          name: (r.title || '').trim() || String(r.telegram_chat_id),
          isUser: pt === 'user',
          isGroup: pt === 'chat',
          isChannel: pt === 'channel',
          unreadCount: 0,
          lastMessage: '',
          lastMessageDate: null,
        };
      });
      return res.json(dialogs);
    }

    const dialogs = await telegramManager.getDialogs(id);
    res.json(dialogs);
  }));

  router.get('/:id/folders', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const forceRefresh = req.query.refresh === '1';

    await getAccountOr404(pool, id, organizationId, 'id');

    if (!forceRefresh) {
      const rows = await pool.query(
        'SELECT folder_id, folder_title, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index, folder_id',
        [id]
      );
      const folders = [
        { id: 0, title: 'Все чаты', isCustom: false, emoticon: '💬' },
        ...rows.rows.map((r: any) => ({
          id: Number(r.folder_id),
          title: (r.folder_title || '').trim() || `Папка ${r.folder_id}`,
          isCustom: Number(r.folder_id) >= 2,
          emoticon: r.icon || undefined,
        })),
      ];
      return res.json({ folders });
    }

    const filters = await telegramManager.getDialogFilters(id);
    const folders = [{ id: 0, title: 'Все чаты', isCustom: false, emoticon: '💬' }, ...filters];
    res.json({ folders });
  }));

  router.get('/:id/dialogs-by-folders', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const forceRefresh = req.query.refresh === '1';
    const limitRaw = req.query.limit;
    const daysRaw = req.query.days;
    const DEFAULT_MAX_DIALOGS = 1000;
    const maxDialogsFolder0 = forceRefresh
      ? (limitRaw != null ? Math.min(3000, Math.max(100, Number(limitRaw)) || DEFAULT_MAX_DIALOGS) : DEFAULT_MAX_DIALOGS)
      : 3000;
    const maxDialogsFolder1 = Math.min(2000, maxDialogsFolder0);
    const days = daysRaw != null ? Math.max(1, Math.min(365, Number(daysRaw) || 0)) : 0;
    const offsetDate = days > 0 ? Math.floor(Date.now() / 1000) - days * 24 * 3600 : undefined;

    const account = await getAccountOr404<{ id: string; telegram_id?: string | null }>(pool, id, organizationId, 'id, telegram_id');
    const accountTelegramId = account.telegram_id != null ? String(account.telegram_id).trim() : null;
    const excludeSelf = (dialogs: any[]) =>
      accountTelegramId ? dialogs.filter((d: any) => !(d.isUser && String(d.id).trim() === accountTelegramId)) : dialogs;

    if (!forceRefresh) {
      const foldersRows = await pool.query(
        'SELECT folder_id, folder_title, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index, folder_id',
        [id]
      );
      const chatsRows = await pool.query(
        `SELECT s.telegram_chat_id, s.title, s.peer_type, j.folder_id
         FROM bd_account_sync_chats s
         LEFT JOIN bd_account_sync_chat_folders j ON j.bd_account_id = s.bd_account_id AND j.telegram_chat_id = s.telegram_chat_id
         WHERE s.bd_account_id = $1`,
        [id]
      );
      const chatsByFolder = new Map<number, { id: string; name: string; isUser: boolean; isGroup: boolean; isChannel: boolean }[]>();
      const folder0Dialogs: { id: string; name: string; isUser: boolean; isGroup: boolean; isChannel: boolean }[] = [];
      const seenInFolder0 = new Set<string>();
      for (const r of chatsRows.rows) {
        const chatId = String(r.telegram_chat_id);
        const name = (r.title || '').trim() || chatId;
        const pt = (r.peer_type || 'user').toLowerCase();
        const item = { id: chatId, name, isUser: pt === 'user', isGroup: pt === 'chat', isChannel: pt === 'channel' };
        if (accountTelegramId && item.isUser && chatId === accountTelegramId) continue;
        if (!seenInFolder0.has(chatId)) {
          seenInFolder0.add(chatId);
          folder0Dialogs.push(item);
        }
        const fid = r.folder_id != null ? Number(r.folder_id) : 0;
        if (!chatsByFolder.has(fid)) chatsByFolder.set(fid, []);
        if (!chatsByFolder.get(fid)!.some((d) => d.id === chatId)) chatsByFolder.get(fid)!.push(item);
      }
      const folderList: { id: number; title: string; emoticon?: string; dialogs: any[] }[] = [];
      const addedFolderIds = new Set<number>();
      if (!foldersRows.rows.some((r: any) => Number(r.folder_id) === 0)) {
        folderList.push({ id: 0, title: 'Все чаты', emoticon: '💬', dialogs: excludeSelf(folder0Dialogs) });
        addedFolderIds.add(0);
      }
      if (!foldersRows.rows.some((r: any) => Number(r.folder_id) === 1)) {
        folderList.push({ id: 1, title: 'Архив', emoticon: '📁', dialogs: excludeSelf(chatsByFolder.get(1) || []) });
        addedFolderIds.add(1);
      }
      for (const f of foldersRows.rows) {
        const fid = Number(f.folder_id);
        if (addedFolderIds.has(fid)) continue;
        const dialogs = fid === 0 ? folder0Dialogs : (chatsByFolder.get(fid) || []);
        folderList.push({
          id: fid,
          title: (f.folder_title || '').trim() || `Папка ${fid}`,
          emoticon: f.icon || undefined,
          dialogs: excludeSelf(fid === 0 ? folder0Dialogs : dialogs),
        });
        addedFolderIds.add(fid);
      }
      if (folderList.length === 0) {
        folderList.push({ id: 0, title: 'Все чаты', emoticon: '💬', dialogs: excludeSelf(folder0Dialogs) });
      }
      return res.json({ folders: folderList });
    }

    const filters = await telegramManager.getDialogFilters(id);
    const opts = {
      maxDialogs: maxDialogsFolder0,
      delayEveryN: 100,
      delayMs: 600,
      ...(offsetDate != null && { offsetDate }),
    };
    const opts1 = {
      maxDialogs: maxDialogsFolder1,
      delayEveryN: 100,
      delayMs: 600,
      ...(offsetDate != null && { offsetDate }),
    };
    let allDialogs0: any[];
    let allDialogs1: any[];
    try {
      [allDialogs0, allDialogs1] = await Promise.all([
        telegramManager.getDialogsAll(id, 0, opts),
        telegramManager.getDialogsAll(id, 1, opts1).catch(() => []),
      ]);
    } catch (err: unknown) {
      const msg = getErrorMessage(err);
      if (msg === 'TIMEOUT' || msg.includes('TIMEOUT')) {
        return res.status(503).json({
          error: 'TELEGRAM_UPDATE_TIMEOUT',
          message: 'Telegram update loop timed out. Try again or use a lower limit (e.g. ?limit=1000).',
        });
      }
      throw err;
    }
    const mergedById = new Map<string, any>();
    for (const d of [...allDialogs0, ...allDialogs1] as { id: unknown }[]) {
      if (!mergedById.has(String(d.id))) mergedById.set(String(d.id), d);
    }
    const merged = Array.from(mergedById.values());

    const folderList: { id: number; title: string; emoticon?: string; dialogs: any[] }[] = [
      { id: 0, title: 'Все чаты', emoticon: '💬', dialogs: excludeSelf(allDialogs0) },
    ];
    if (allDialogs1.length > 0) {
      folderList.push({ id: 1, title: 'Архив', emoticon: '📁', dialogs: excludeSelf(allDialogs1) });
    }
    for (const f of filters) {
      if (f.id === 0 || f.id === 1) continue;
      const filterRaw = await telegramManager.getDialogFilterRaw(id, f.id);
      const { include: includePeerIds, exclude: excludePeerIds } = TelegramManager.getFilterIncludeExcludePeerIds(filterRaw);
      const dialogs = merged.filter((d: any) =>
        TelegramManager.dialogMatchesFilter(d, filterRaw, includePeerIds, excludePeerIds)
      );
      folderList.push({ id: f.id, title: f.title, emoticon: f.emoticon, dialogs: excludeSelf(dialogs) });
    }
    const pinned_chat_ids = allDialogs0.filter((d: any) => d.pinned === true).map((d: any) => String(d.id));
    const hasMore = allDialogs0.length >= maxDialogsFolder0 || allDialogs1.length >= maxDialogsFolder1;
    res.json({
      folders: folderList,
      pinned_chat_ids,
      hasMore,
      truncated: hasMore,
      maxDialogsPerFolder: maxDialogsFolder0,
      ...(days > 0 && { days }),
    });
  }));
}
