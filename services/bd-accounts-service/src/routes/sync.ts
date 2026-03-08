import { Router } from 'express';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, canPermission } from '@getsale/service-core';
import { TelegramManager } from '../telegram-manager';
import {
  requireAccountOwner,
  requireBidiOwnAccount,
  isAccountOwnerName,
  ensureFoldersFromSyncChats,
  SYNC_STALE_MINUTES,
} from '../helpers';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  telegramManager: TelegramManager;
}

export function syncRouter({ pool, log, telegramManager }: Deps): Router {
  const router = Router();
  const checkPermission = canPermission(pool);

  // GET /:id/dialogs
  router.get('/:id/dialogs', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

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

  // GET /:id/folders
  router.get('/:id/folders', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const forceRefresh = req.query.refresh === '1';

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

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

  // GET /:id/dialogs-by-folders
  router.get('/:id/dialogs-by-folders', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const forceRefresh = req.query.refresh === '1';

    const accountResult = await pool.query(
      'SELECT id, telegram_id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    const accountTelegramId = accountResult.rows[0].telegram_id != null ? String(accountResult.rows[0].telegram_id).trim() : null;
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
    const [allDialogs0, allDialogs1] = await Promise.all([
      telegramManager.getDialogsAll(id, 0, { maxDialogs: 3000, delayEveryN: 100, delayMs: 600 }),
      telegramManager.getDialogsAll(id, 1, { maxDialogs: 2000, delayEveryN: 100, delayMs: 600 }).catch(() => []),
    ]);
    const mergedById = new Map<string, any>();
    for (const d of [...allDialogs0, ...allDialogs1]) {
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
    res.json({ folders: folderList, pinned_chat_ids });
  }));

  // GET /:id/sync-folders
  router.get('/:id/sync-folders', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    await ensureFoldersFromSyncChats(pool, telegramManager, id);
    let result = await pool.query(
      'SELECT id, folder_id, folder_title, order_index, COALESCE(is_user_created, false) AS is_user_created, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index, folder_id',
      [id]
    );

    if (result.rows.length === 0 && telegramManager.isConnected(id)) {
      try {
        const filters = await telegramManager.getDialogFilters(id);
        const rows = filters.map((f, i) => ({
          id: `virtual-${f.id}`,
          folder_id: f.id,
          folder_title: (f.title || '').trim() || `Папка ${f.id}`,
          order_index: i,
          is_user_created: f.isCustom ?? false,
          icon: f.emoticon ?? null,
        }));
        return res.json(rows);
      } catch (err: any) {
        log.warn({ message: 'Initial folders fetch from Telegram failed', error: err?.message, entity_id: id });
      }
    }
    res.json(result.rows);
  }));

  // POST /:id/folders-refetch — fetch folders (+ dialogs) from Telegram for UI only; does NOT save to DB.
  // Only selected chats/folders are saved when user clicks "Save and sync" (POST sync-chats).
  router.post('/:id/folders-refetch', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiOwnAccount(pool, id, user);
    if (!telegramManager.isConnected(id)) {
      throw new AppError(400, 'Account is not connected to Telegram', ErrorCodes.BAD_REQUEST);
    }
    const filters = await telegramManager.getDialogFilters(id);
    const folders = [{ id: 0, title: 'Все чаты', isCustom: false, emoticon: '💬' }, ...filters];
    res.json({ folders, success: true });
  }));

  // POST /:id/sync-folders — save selected folders + extra chats
  router.post('/:id/sync-folders', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;
    const { folders, extraChats } = req.body;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiOwnAccount(pool, id, user);
    const isOwner = await requireAccountOwner(pool, id, user);
    if (!isOwner) {
      throw new AppError(403, 'Only the account owner can change sync folders', ErrorCodes.FORBIDDEN);
    }
    if (!Array.isArray(folders)) {
      throw new AppError(400, 'folders must be an array', ErrorCodes.VALIDATION);
    }

    await pool.query('DELETE FROM bd_account_sync_folders WHERE bd_account_id = $1', [id]);
    for (let i = 0; i < folders.length; i++) {
      const f = folders[i];
      const folderId = Number(f.folderId ?? f.folder_id ?? 0);
      const title = String(f.folderTitle ?? f.folder_title ?? '').trim() || `Папка ${folderId}`;
      const isUserCreated = Boolean(f.is_user_created ?? f.isUserCreated ?? false);
      const icon = f.icon != null && String(f.icon).trim() ? String(f.icon).trim().slice(0, 20) : null;
      await pool.query(
        `INSERT INTO bd_account_sync_folders (bd_account_id, folder_id, folder_title, order_index, is_user_created, icon)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, folderId, title, i, isUserCreated, icon]
      );
    }

    if (Array.isArray(extraChats) && extraChats.length > 0) {
      const accountRow = (await pool.query('SELECT display_name, username, first_name FROM bd_accounts WHERE id = $1 LIMIT 1', [id])).rows[0] as { display_name?: string | null; username?: string | null; first_name?: string | null } | undefined;
      for (const c of extraChats) {
        const chatId = String(c.id ?? c.telegram_chat_id ?? '').trim();
        if (!chatId) continue;
        let title = (c.name ?? c.title ?? '').trim() || chatId;
        if (accountRow && isAccountOwnerName(accountRow, title)) title = chatId;
        const folderId = c.folderId !== undefined && c.folderId !== null ? Number(c.folderId) : null;
        let peerType = 'user';
        if (c.isChannel) peerType = 'channel';
        else if (c.isGroup) peerType = 'chat';
        await pool.query(
          `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id)
           VALUES ($1, $2, $3, $4, false, $5)
           ON CONFLICT (bd_account_id, telegram_chat_id) DO UPDATE SET
             title = CASE WHEN EXISTS (
               SELECT 1 FROM bd_accounts a WHERE a.id = EXCLUDED.bd_account_id
                 AND (NULLIF(TRIM(COALESCE(a.display_name, '')), '') = TRIM(EXCLUDED.title)
                   OR a.username = TRIM(EXCLUDED.title)
                   OR NULLIF(TRIM(COALESCE(a.first_name, '')), '') = TRIM(EXCLUDED.title))
             ) THEN bd_account_sync_chats.telegram_chat_id::text ELSE EXCLUDED.title END,
             peer_type = EXCLUDED.peer_type,
             folder_id = EXCLUDED.folder_id`,
          [id, chatId, title, peerType, folderId]
        );
        if (folderId != null) {
          await pool.query(
            `INSERT INTO bd_account_sync_chat_folders (bd_account_id, telegram_chat_id, folder_id)
             VALUES ($1, $2, $3) ON CONFLICT (bd_account_id, telegram_chat_id, folder_id) DO NOTHING`,
            [id, chatId, folderId]
          );
        }
      }
    }

    const result = await pool.query(
      'SELECT id, folder_id, folder_title, order_index, COALESCE(is_user_created, false) AS is_user_created, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index',
      [id]
    );
    res.json(result.rows);
  }));

  // POST /:id/sync-folders/custom — create user-created folder
  router.post('/:id/sync-folders/custom', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;
    const { folder_title: folderTitle, icon } = req.body;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiOwnAccount(pool, id, user);
    const isOwner = await requireAccountOwner(pool, id, user);
    if (!isOwner) {
      throw new AppError(403, 'Only the account owner can create folders', ErrorCodes.FORBIDDEN);
    }
    const title = (folderTitle != null ? String(folderTitle).trim() : '').slice(0, 12) || 'New folder';
    const iconVal = icon != null && String(icon).trim() ? String(icon).trim().slice(0, 20) : null;
    const maxRow = await pool.query(
      'SELECT COALESCE(MAX(folder_id), 1) AS max_id FROM bd_account_sync_folders WHERE bd_account_id = $1',
      [id]
    );
    const nextFolderId = Math.max(2, (Number(maxRow.rows[0]?.max_id) || 1) + 1);
    const countRow = await pool.query(
      'SELECT COUNT(*) AS c FROM bd_account_sync_folders WHERE bd_account_id = $1',
      [id]
    );
    const orderIndex = Number(countRow.rows[0]?.c) || 0;
    const insert = await pool.query(
      `INSERT INTO bd_account_sync_folders (bd_account_id, folder_id, folder_title, order_index, is_user_created, icon)
       VALUES ($1, $2, $3, $4, true, $5)
       RETURNING id, folder_id, folder_title, order_index, is_user_created, icon`,
      [id, nextFolderId, title, orderIndex, iconVal]
    );
    res.status(201).json(insert.rows[0]);
  }));

  // PATCH /:id/sync-folders/order — reorder folders
  router.patch('/:id/sync-folders/order', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;
    const { order } = req.body;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiOwnAccount(pool, id, user);
    const isOwner = await requireAccountOwner(pool, id, user);
    if (!isOwner) {
      throw new AppError(403, 'Only the account owner can reorder folders', ErrorCodes.FORBIDDEN);
    }
    if (!Array.isArray(order) || order.length === 0) {
      throw new AppError(400, 'order must be a non-empty array of folder row ids', ErrorCodes.VALIDATION);
    }
    for (let i = 0; i < order.length; i++) {
      await pool.query(
        'UPDATE bd_account_sync_folders SET order_index = $1 WHERE id = $2 AND bd_account_id = $3',
        [i, String(order[i]), id]
      );
    }
    const result = await pool.query(
      'SELECT id, folder_id, folder_title, order_index, COALESCE(is_user_created, false) AS is_user_created, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index',
      [id]
    );
    res.json(result.rows);
  }));

  // PATCH /:id/sync-folders/:folderRowId — update folder icon or title
  router.patch('/:id/sync-folders/:folderRowId', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id: accountId, folderRowId } = req.params;
    const { icon, folder_title: folderTitle } = req.body;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [accountId, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiOwnAccount(pool, accountId, user);
    const updates: string[] = [];
    const values: any[] = [];
    let i = 1;
    if (icon !== undefined) {
      const iconVal = icon === null || icon === '' ? null : (String(icon).trim().slice(0, 20) || null);
      updates.push(`icon = $${i++}`);
      values.push(iconVal);
    }
    if (folderTitle !== undefined) {
      const titleVal = String(folderTitle ?? '').trim().slice(0, 12) || null;
      updates.push(`folder_title = $${i++}`);
      values.push(titleVal);
    }
    if (updates.length === 0) {
      throw new AppError(400, 'No fields to update', ErrorCodes.VALIDATION);
    }
    values.push(folderRowId, accountId);
    const result = await pool.query(
      `UPDATE bd_account_sync_folders SET ${updates.join(', ')}
       WHERE id = $${i++} AND bd_account_id = $${i}
       RETURNING id, folder_id, folder_title, order_index, is_user_created, icon`,
      values
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'Folder not found', ErrorCodes.NOT_FOUND);
    }
    res.json(result.rows[0]);
  }));

  // DELETE /:id/sync-folders/:folderRowId — delete user-created folder
  router.delete('/:id/sync-folders/:folderRowId', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id: accountId, folderRowId } = req.params;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [accountId, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiOwnAccount(pool, accountId, user);
    const isOwner = await requireAccountOwner(pool, accountId, user);
    if (!isOwner) {
      throw new AppError(403, 'Only the account owner can delete folders', ErrorCodes.FORBIDDEN);
    }
    const folderRow = await pool.query(
      'SELECT id, folder_id, is_user_created FROM bd_account_sync_folders WHERE id = $1 AND bd_account_id = $2',
      [folderRowId, accountId]
    );
    if (folderRow.rows.length === 0) {
      throw new AppError(404, 'Folder not found', ErrorCodes.NOT_FOUND);
    }
    const folder = folderRow.rows[0];
    if (!folder.is_user_created) {
      throw new AppError(400, 'Only user-created folders can be deleted. Telegram folders are read-only.', ErrorCodes.BAD_REQUEST);
    }
    const folderIdNum = Number(folder.folder_id);
    await pool.query(
      'UPDATE bd_account_sync_chats SET folder_id = NULL WHERE bd_account_id = $1 AND folder_id = $2',
      [accountId, folderIdNum]
    );
    await pool.query(
      'DELETE FROM bd_account_sync_folders WHERE id = $1 AND bd_account_id = $2',
      [folderRowId, accountId]
    );
    res.status(204).send();
  }));

  // POST /:id/sync-folders-refresh — no longer overwrites selection; only selected chats are stored via POST sync-chats.
  router.post('/:id/sync-folders-refresh', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiOwnAccount(pool, id, user);
    res.json({ success: true });
  }));

  // POST /:id/sync-folders-push-to-telegram — push CRM folders to Telegram
  router.post('/:id/sync-folders-push-to-telegram', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiOwnAccount(pool, id, user);
    const isOwner = await requireAccountOwner(pool, id, user);
    if (!isOwner) {
      throw new AppError(403, 'Only the account owner can push folders to Telegram', ErrorCodes.FORBIDDEN);
    }
    const result = await telegramManager.pushFoldersToTelegram(id);
    res.json({ success: true, updated: result.updated, errors: result.errors });
  }));

  // GET /:id/sync-chats
  router.get('/:id/sync-chats', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    const chatsRows = await pool.query(
      'SELECT id, telegram_chat_id, title, peer_type, is_folder, folder_id, created_at FROM bd_account_sync_chats WHERE bd_account_id = $1 ORDER BY folder_id NULLS LAST, created_at',
      [id]
    );
    const junctionRows = await pool.query(
      'SELECT telegram_chat_id, folder_id FROM bd_account_sync_chat_folders WHERE bd_account_id = $1',
      [id]
    );
    const folderIdsByChat = new Map<string, number[]>();
    for (const r of junctionRows.rows) {
      const tid = String(r.telegram_chat_id);
      if (!folderIdsByChat.has(tid)) folderIdsByChat.set(tid, []);
      folderIdsByChat.get(tid)!.push(Number(r.folder_id));
    }
    const rows = chatsRows.rows.map((r: any) => {
      const tid = String(r.telegram_chat_id);
      const folder_ids = folderIdsByChat.get(tid) ?? (r.folder_id != null ? [Number(r.folder_id)] : []);
      return { ...r, folder_ids };
    });
    res.json(rows);
  }));

  // POST /:id/sync-chats — save selected chats for sync (replace existing selection)
  router.post('/:id/sync-chats', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;
    const { chats } = req.body;

    const accountResult = await pool.query(
      'SELECT id, telegram_id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiOwnAccount(pool, id, user);
    const isOwner = await requireAccountOwner(pool, id, user);
    if (!isOwner) {
      throw new AppError(403, 'Only the account owner can change sync chats', ErrorCodes.FORBIDDEN);
    }

    if (!Array.isArray(chats)) {
      throw new AppError(400, 'chats must be an array', ErrorCodes.VALIDATION);
    }

    const accountTelegramId = accountResult.rows[0].telegram_id != null ? String(accountResult.rows[0].telegram_id).trim() : null;

    await pool.query('DELETE FROM bd_account_sync_chats WHERE bd_account_id = $1', [id]);
    await pool.query('DELETE FROM bd_account_sync_chat_folders WHERE bd_account_id = $1', [id]);

    let inserted = 0;
    for (const c of chats) {
      const chatId = String(c.id ?? c.telegram_chat_id ?? '').trim();
      const title = (c.name ?? c.title ?? '').trim();
      const folderId = c.folderId !== undefined && c.folderId !== null ? Number(c.folderId) : null;
      const folderIds = Array.isArray(c.folderIds) ? c.folderIds.map((x: any) => Number(x)).filter((n: number) => !Number.isNaN(n)) : (folderId != null ? [folderId] : []);
      let peerType = 'user';
      if (c.isChannel) peerType = 'channel';
      else if (c.isGroup) peerType = 'chat';
      if (!chatId) {
        log.warn({ message: 'Skipping chat with empty id', entity_id: id });
        continue;
      }
      if (peerType === 'user' && accountTelegramId && chatId === accountTelegramId) {
        log.info({ message: 'Skipping Saved Messages (self-chat)', entity_id: id });
        continue;
      }
      const primaryFolder = folderIds[0] ?? folderId ?? null;
      await pool.query(
        `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id)
         VALUES ($1, $2, $3, $4, false, $5)`,
        [id, chatId, title, peerType, primaryFolder]
      );
      for (const fid of folderIds) {
        await pool.query(
          `INSERT INTO bd_account_sync_chat_folders (bd_account_id, telegram_chat_id, folder_id)
           VALUES ($1, $2, $3) ON CONFLICT (bd_account_id, telegram_chat_id, folder_id) DO NOTHING`,
          [id, chatId, fid]
        );
      }
      inserted++;
    }
    log.info({ message: `Saved ${inserted} sync chats (requested ${chats.length})`, entity_id: id });

    await ensureFoldersFromSyncChats(pool, telegramManager, id);

    // Обогатить контакты по личным чатам из Telegram (first_name, last_name, username, phone, bio, premium) — в БД.
    // Важно: после первичной синхронизации пользователь ожидает, что мета уже сохранена, поэтому ждём завершения.
    try {
      const r = await telegramManager.enrichContactsForAccountSyncChats(user.organizationId, id, { delayMs: 60 });
      log.info({ message: `Enriched ${r.enriched} contacts for sync chats`, entity_id: id });
    } catch (err: unknown) {
      log.warn({ message: 'enrichContactsForAccountSyncChats failed', entity_id: id, error: (err as Error)?.message });
    }

    const chatsRows = await pool.query(
      'SELECT id, telegram_chat_id, title, peer_type, folder_id, created_at FROM bd_account_sync_chats WHERE bd_account_id = $1 ORDER BY folder_id NULLS LAST, created_at',
      [id]
    );
    const junctionRows = await pool.query('SELECT telegram_chat_id, folder_id FROM bd_account_sync_chat_folders WHERE bd_account_id = $1', [id]);
    const folderIdsByChat = new Map<string, number[]>();
    for (const r of junctionRows.rows) {
      const tid = String(r.telegram_chat_id);
      if (!folderIdsByChat.has(tid)) folderIdsByChat.set(tid, []);
      folderIdsByChat.get(tid)!.push(Number(r.folder_id));
    }
    const resultRows = chatsRows.rows.map((r: any) => ({
      ...r,
      folder_ids: folderIdsByChat.get(String(r.telegram_chat_id)) ?? (r.folder_id != null ? [Number(r.folder_id)] : []),
    }));
    res.json(resultRows);
  }));

  // POST /:id/sync-start — start initial history sync (background)
  router.post('/:id/sync-start', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;

    log.info({ message: 'sync-start requested', entity_id: id, organization_id: user.organizationId });

    const accountResult = await pool.query(
      'SELECT id, organization_id, sync_status, sync_started_at FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiOwnAccount(pool, id, user);
    const isOwner = await requireAccountOwner(pool, id, user);
    if (!isOwner) {
      throw new AppError(403, 'Only the account owner can start sync', ErrorCodes.FORBIDDEN);
    }

    const account = accountResult.rows[0];
    const startedAt = account.sync_started_at ? new Date(account.sync_started_at).getTime() : 0;
    const isStale = account.sync_status === 'syncing' && startedAt && Date.now() - startedAt > SYNC_STALE_MINUTES * 60 * 1000;

    if (isStale) {
      log.info({ message: 'Resetting stale syncing state', entity_id: id });
      await pool.query(
        "UPDATE bd_accounts SET sync_status = 'idle', sync_error = NULL WHERE id = $1",
        [id]
      );
    } else if (account.sync_status === 'syncing') {
      log.info({ message: 'Sync already in progress', entity_id: id });
      return res.json({ success: true, message: 'Sync already in progress' });
    }

    if (!telegramManager.isConnected(id)) {
      log.warn({ message: 'Cannot start sync, account not connected', entity_id: id, organization_id: account.organization_id });
      throw new AppError(400, 'Account is not connected', ErrorCodes.BAD_REQUEST);
    }

    const syncChatsCount = await pool.query(
      'SELECT COUNT(*) AS c FROM bd_account_sync_chats WHERE bd_account_id = $1',
      [id]
    );
    const numChats = Number(syncChatsCount.rows[0]?.c ?? 0);

    if (numChats === 0) {
      log.info({ message: 'sync-start rejected: no chats selected', entity_id: id });
      return res.status(400).json({
        error: 'no_chats_selected',
        message: 'Сначала выберите чаты и папки для синхронизации в BD Аккаунтах',
      });
    }

    log.info({ message: `sync-start: ${numChats} chats to sync`, entity_id: id });
    res.json({ success: true, message: 'Sync started' });

    telegramManager.syncHistory(id, account.organization_id).catch((err) => {
      log.error({ message: 'Sync failed', entity_id: id, error: String(err) });
    });
  }));

  // GET /:id/sync-status
  router.get('/:id/sync-status', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;

    const result = await pool.query(
      `SELECT sync_status, sync_error, sync_progress_total, sync_progress_done, sync_started_at, sync_completed_at
       FROM bd_accounts WHERE id = $1 AND organization_id = $2`,
      [id, organizationId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    const row = result.rows[0];
    let syncStatus = row.sync_status ?? 'idle';
    const startedAt = row.sync_started_at ? new Date(row.sync_started_at).getTime() : 0;
    if (syncStatus === 'syncing' && startedAt && Date.now() - startedAt > SYNC_STALE_MINUTES * 60 * 1000) {
      await pool.query(
        "UPDATE bd_accounts SET sync_status = 'idle', sync_error = 'Синхронизация прервана по таймауту' WHERE id = $1",
        [id]
      );
      syncStatus = 'idle';
    }
    const chatsCount = await pool.query(
      'SELECT COUNT(*) AS c FROM bd_account_sync_chats WHERE bd_account_id = $1',
      [id]
    );
    const has_sync_chats = Number(chatsCount.rows[0]?.c ?? 0) > 0;
    res.json({ ...row, sync_status: syncStatus, has_sync_chats: !!has_sync_chats });
  }));

  // PATCH /:id/chats/:chatId/folder — assign chat to folders
  router.patch('/:id/chats/:chatId/folder', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id: accountId, chatId } = req.params;
    const { folder_ids: folderIdsRaw, folder_id: legacyFolderId } = req.body;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [accountId, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiOwnAccount(pool, accountId, user);

    let folderIds: number[] = [];
    if (Array.isArray(folderIdsRaw)) {
      folderIds = folderIdsRaw.map((x: any) => Number(x)).filter((n: number) => !Number.isNaN(n));
    } else if (legacyFolderId !== undefined && legacyFolderId !== null && legacyFolderId !== '') {
      folderIds = [Number(legacyFolderId)];
    }

    const chatExists = await pool.query(
      'SELECT id FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2',
      [accountId, chatId]
    );
    if (chatExists.rows.length === 0) {
      throw new AppError(404, 'Chat not found in sync list', ErrorCodes.NOT_FOUND);
    }

    await pool.query('DELETE FROM bd_account_sync_chat_folders WHERE bd_account_id = $1 AND telegram_chat_id = $2', [accountId, chatId]);
    for (const fid of folderIds) {
      await pool.query(
        `INSERT INTO bd_account_sync_chat_folders (bd_account_id, telegram_chat_id, folder_id)
         VALUES ($1, $2, $3) ON CONFLICT (bd_account_id, telegram_chat_id, folder_id) DO NOTHING`,
        [accountId, chatId, fid]
      );
    }
    const primaryFolderId = folderIds[0] ?? null;
    await pool.query(
      'UPDATE bd_account_sync_chats SET folder_id = $1 WHERE bd_account_id = $2 AND telegram_chat_id = $3',
      [primaryFolderId, accountId, chatId]
    );
    res.json({ success: true, folder_ids: folderIds, folder_id: primaryFolderId });
  }));

  // DELETE /:id/chats/:chatId — remove chat from sync list
  router.delete('/:id/chats/:chatId', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id: accountId, chatId } = req.params;

    const accountResult = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [accountId, user.organizationId]
    );
    if (accountResult.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    await requireBidiOwnAccount(pool, accountId, user);
    const isOwner = await requireAccountOwner(pool, accountId, user);
    const canDeleteChat = await checkPermission(user.role, 'bd_accounts', 'chat.delete');
    if (!isOwner && !canDeleteChat) {
      throw new AppError(403, 'No permission to remove a chat from the list', ErrorCodes.FORBIDDEN);
    }

    await pool.query('DELETE FROM bd_account_sync_chat_folders WHERE bd_account_id = $1 AND telegram_chat_id = $2', [accountId, chatId]);
    const result = await pool.query(
      'DELETE FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 RETURNING id',
      [accountId, chatId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'Chat not found in sync list', ErrorCodes.NOT_FOUND);
    }
    res.status(200).json({ success: true });
  }));

  return router;
}
