import { Router } from 'express';
import { asyncHandler, AppError, ErrorCodes, validate, withOrgContext } from '@getsale/service-core';
import {
  getAccountOr404,
  requireAccountOwner,
  requireBidiOwnAccount,
  isAccountOwnerName,
  ensureFoldersFromSyncChats,
  getErrorMessage,
} from '../helpers';
import {
  SyncFoldersOrderSchema,
  SyncFolderCustomSchema,
  SyncFolderPatchSchema,
  SyncFoldersBodySchema,
} from '../validation';
import type { SyncRouteDeps } from './sync-route-deps';

/** sync-folders CRUD, refetch, push to Telegram. */
export function registerSyncFoldersWriteRoutes(router: Router, deps: SyncRouteDeps): void {
  const { pool, log, telegramManager } = deps;

  router.get('/:id/sync-folders', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;

    await getAccountOr404(pool, id, organizationId, 'id');

    await ensureFoldersFromSyncChats(pool, telegramManager, id, log);
    let result = await pool.query(
      'SELECT id, folder_id, folder_title, order_index, COALESCE(is_user_created, false) AS is_user_created, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index, folder_id',
      [id]
    );

    if (result.rows.length === 0 && telegramManager.isConnected(id)) {
      try {
        const filters = await telegramManager.getDialogFilters(id);
        const rows = filters.map((f: { id: number; title?: string; isCustom?: boolean; emoticon?: string | null }, i: number) => ({
          id: `virtual-${f.id}`,
          folder_id: f.id,
          folder_title: (f.title || '').trim() || `Папка ${f.id}`,
          order_index: i,
          is_user_created: f.isCustom ?? false,
          icon: f.emoticon ?? null,
        }));
        return res.json(rows);
      } catch (err: unknown) {
        log.warn({ message: 'Initial folders fetch from Telegram failed', error: getErrorMessage(err), entity_id: id });
      }
    }
    res.json(result.rows);
  }));

  router.post('/:id/folders-refetch', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;

    await getAccountOr404(pool, id, user.organizationId, 'id');
    await requireBidiOwnAccount(pool, id, user);
    if (!telegramManager.isConnected(id)) {
      throw new AppError(400, 'Account is not connected to Telegram', ErrorCodes.BAD_REQUEST);
    }
    const filters = await telegramManager.getDialogFilters(id);
    const folders = [{ id: 0, title: 'Все чаты', isCustom: false, emoticon: '💬' }, ...filters];
    res.json({ folders, success: true });
  }));

  router.post('/:id/sync-folders', validate(SyncFoldersBodySchema), asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;
    const { folders, extraChats } = req.body;

    await getAccountOr404(pool, id, user.organizationId, 'id');
    await requireBidiOwnAccount(pool, id, user);
    const isOwner = await requireAccountOwner(pool, id, user);
    if (!isOwner) {
      throw new AppError(403, 'Only the account owner can change sync folders', ErrorCodes.FORBIDDEN);
    }

    const result = await withOrgContext(pool, user.organizationId, async (client) => {
      await client.query('DELETE FROM bd_account_sync_folders WHERE bd_account_id = $1', [id]);
      for (let i = 0; i < folders.length; i++) {
        const f = folders[i];
        const folderId = Number(f.folderId ?? f.folder_id ?? 0);
        const title = String(f.folderTitle ?? f.folder_title ?? '').trim() || `Папка ${folderId}`;
        const isUserCreated = Boolean(f.is_user_created ?? f.isUserCreated ?? false);
        const icon = f.icon != null && String(f.icon).trim() ? String(f.icon).trim().slice(0, 20) : null;
        await client.query(
          `INSERT INTO bd_account_sync_folders (bd_account_id, folder_id, folder_title, order_index, is_user_created, icon)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, folderId, title, i, isUserCreated, icon]
        );
      }

      if (Array.isArray(extraChats) && extraChats.length > 0) {
        const accountRow = (await client.query('SELECT display_name, username, first_name FROM bd_accounts WHERE id = $1 LIMIT 1', [id])).rows[0] as { display_name?: string | null; username?: string | null; first_name?: string | null } | undefined;
        for (const c of extraChats) {
          const chatId = String(c.id ?? c.telegram_chat_id ?? '').trim();
          if (!chatId) continue;
          let chatTitle = (c.name ?? c.title ?? '').trim() || chatId;
          if (accountRow && isAccountOwnerName(accountRow, chatTitle)) chatTitle = chatId;
          const folderId = c.folderId !== undefined && c.folderId !== null ? Number(c.folderId) : null;
          let peerType = 'user';
          if (c.isChannel) peerType = 'channel';
          else if (c.isGroup) peerType = 'chat';
          await client.query(
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
            [id, chatId, chatTitle, peerType, folderId]
          );
          if (folderId != null) {
            await client.query(
              `INSERT INTO bd_account_sync_chat_folders (bd_account_id, telegram_chat_id, folder_id)
               VALUES ($1, $2, $3) ON CONFLICT (bd_account_id, telegram_chat_id, folder_id) DO NOTHING`,
              [id, chatId, folderId]
            );
          }
        }
      }

      return client.query(
        'SELECT id, folder_id, folder_title, order_index, COALESCE(is_user_created, false) AS is_user_created, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index',
        [id]
      );
    });
    res.json(result.rows);
  }));

  router.post('/:id/sync-folders/custom', validate(SyncFolderCustomSchema), asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;
    const body = req.body as { folder_title?: string; icon?: string | null };
    const folderTitle = body.folder_title;
    const icon = body.icon;

    await getAccountOr404(pool, id, user.organizationId, 'id');
    await requireBidiOwnAccount(pool, id, user);
    const isOwner = await requireAccountOwner(pool, id, user);
    if (!isOwner) {
      throw new AppError(403, 'Only the account owner can create folders', ErrorCodes.FORBIDDEN);
    }
    const title = (folderTitle != null ? String(folderTitle).trim() : '').slice(0, 12) || 'New folder';
    const iconVal = icon != null && String(icon).trim() ? String(icon).trim().slice(0, 20) : null;
    const insert = await withOrgContext(pool, user.organizationId, async (client) => {
      const maxRow = await client.query(
        'SELECT COALESCE(MAX(folder_id), 1) AS max_id FROM bd_account_sync_folders WHERE bd_account_id = $1',
        [id]
      );
      const nextFolderId = Math.max(2, (Number(maxRow.rows[0]?.max_id) || 1) + 1);
      const countRow = await client.query(
        'SELECT COUNT(*) AS c FROM bd_account_sync_folders WHERE bd_account_id = $1',
        [id]
      );
      const orderIndex = Number(countRow.rows[0]?.c) || 0;
      return client.query(
        `INSERT INTO bd_account_sync_folders (bd_account_id, folder_id, folder_title, order_index, is_user_created, icon)
         VALUES ($1, $2, $3, $4, true, $5)
         RETURNING id, folder_id, folder_title, order_index, is_user_created, icon`,
        [id, nextFolderId, title, orderIndex, iconVal]
      );
    });
    res.status(201).json(insert.rows[0]);
  }));

  router.patch('/:id/sync-folders/order', validate(SyncFoldersOrderSchema), asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;
    const { order } = req.body;

    await getAccountOr404(pool, id, user.organizationId, 'id');
    await requireBidiOwnAccount(pool, id, user);
    const isOwner = await requireAccountOwner(pool, id, user);
    if (!isOwner) {
      throw new AppError(403, 'Only the account owner can reorder folders', ErrorCodes.FORBIDDEN);
    }
    const result = await withOrgContext(pool, user.organizationId, async (client) => {
      for (let i = 0; i < order.length; i++) {
        await client.query(
          'UPDATE bd_account_sync_folders SET order_index = $1 WHERE id = $2 AND bd_account_id = $3',
          [i, String(order[i]), id]
        );
      }
      return client.query(
        'SELECT id, folder_id, folder_title, order_index, COALESCE(is_user_created, false) AS is_user_created, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index',
        [id]
      );
    });
    res.json(result.rows);
  }));

  router.patch('/:id/sync-folders/:folderRowId', validate(SyncFolderPatchSchema), asyncHandler(async (req, res) => {
    const user = req.user;
    const { id: accountId, folderRowId } = req.params;
    const { icon, folder_title: folderTitle } = req.body;

    await getAccountOr404(pool, accountId, user.organizationId, 'id');
    await requireBidiOwnAccount(pool, accountId, user);
    const updates: string[] = [];
    const values: (string | null)[] = [];
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
    values.push(folderRowId, accountId);
    const result = await withOrgContext(pool, user.organizationId, (client) =>
      client.query(
        `UPDATE bd_account_sync_folders SET ${updates.join(', ')}
         WHERE id = $${i} AND bd_account_id = $${i + 1}
         RETURNING id, folder_id, folder_title, order_index, is_user_created, icon`,
        values
      )
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'Folder not found', ErrorCodes.NOT_FOUND);
    }
    res.json(result.rows[0]);
  }));

  router.delete('/:id/sync-folders/:folderRowId', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id: accountId, folderRowId } = req.params;

    await getAccountOr404(pool, accountId, user.organizationId, 'id');
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
    const folder = folderRow.rows[0] as { folder_id: number; is_user_created: boolean };
    if (!folder.is_user_created) {
      throw new AppError(400, 'Only user-created folders can be deleted. Telegram folders are read-only.', ErrorCodes.BAD_REQUEST);
    }
    const folderIdNum = Number(folder.folder_id);
    await withOrgContext(pool, user.organizationId, async (client) => {
      await client.query(
        'UPDATE bd_account_sync_chats SET folder_id = NULL WHERE bd_account_id = $1 AND folder_id = $2',
        [accountId, folderIdNum]
      );
      await client.query(
        'DELETE FROM bd_account_sync_folders WHERE id = $1 AND bd_account_id = $2',
        [folderRowId, accountId]
      );
    });
    res.status(204).send();
  }));

  router.post('/:id/sync-folders-refresh', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;

    await getAccountOr404(pool, id, user.organizationId, 'id');
    await requireBidiOwnAccount(pool, id, user);
    res.json({ success: true });
  }));

  router.post('/:id/sync-folders-push-to-telegram', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;

    await getAccountOr404(pool, id, user.organizationId, 'id');
    await requireBidiOwnAccount(pool, id, user);
    const isOwner = await requireAccountOwner(pool, id, user);
    if (!isOwner) {
      throw new AppError(403, 'Only the account owner can push folders to Telegram', ErrorCodes.FORBIDDEN);
    }
    const result = await telegramManager.pushFoldersToTelegram(id);
    res.json({ success: true, updated: result.updated, errors: result.errors });
  }));
}
