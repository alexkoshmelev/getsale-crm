import { Router } from 'express';
import { asyncHandler, AppError, ErrorCodes, validate, withOrgContext } from '@getsale/service-core';
import {
  getAccountOr404,
  canManageBdAccountAsConnectorOrOrgAdmin,
  requireBidiOwnAccount,
  ensureFoldersFromSyncChats,
  SYNC_STALE_MINUTES,
} from '../helpers';
import { SyncChatsBodySchema, ChatFolderPatchSchema } from '../validation';
import type { SyncRouteDeps } from './sync-route-deps';

/** GET/POST sync-chats, sync-start, sync-status, chat folder patch, delete from sync list. */
export function registerSyncChatsSyncRoutes(router: Router, deps: SyncRouteDeps): void {
  const { pool, log, telegramManager, checkPermission } = deps;

  router.get('/:id/sync-chats', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;

    await getAccountOr404(pool, id, organizationId, 'id');

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

  router.post('/:id/sync-chats', validate(SyncChatsBodySchema), asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;
    const { chats } = req.body;

    const account = await getAccountOr404<{ id: string; telegram_id?: string | null }>(pool, id, user.organizationId, 'id, telegram_id');
    await requireBidiOwnAccount(pool, id, user);
    const canManage = await canManageBdAccountAsConnectorOrOrgAdmin(pool, id, user);
    if (!canManage) {
      throw new AppError(
        403,
        'Only the account connector or an organization owner/admin can change sync chats',
        ErrorCodes.FORBIDDEN
      );
    }

    const accountTelegramId = account.telegram_id != null ? String(account.telegram_id).trim() : null;

    const { chatsRows, junctionRows } = await withOrgContext(pool, user.organizationId, async (client) => {
      await client.query(
        `DELETE FROM bd_account_sync_chats WHERE bd_account_id = $1
         AND COALESCE(sync_list_origin, 'sync_selection') = 'sync_selection'`,
        [id]
      );
      await client.query('DELETE FROM bd_account_sync_chat_folders WHERE bd_account_id = $1', [id]);

      let inserted = 0;
      for (const c of chats) {
        const chatId = String(c.id ?? c.telegram_chat_id ?? '').trim();
        const title = (c.name ?? c.title ?? '').trim();
        const folderId = c.folderId !== undefined && c.folderId !== null ? Number(c.folderId) : null;
        const folderIds = Array.isArray(c.folderIds) ? c.folderIds.map((x: unknown) => Number(x)).filter((n: number) => !Number.isNaN(n)) : (folderId != null ? [folderId] : []);
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
        await client.query(
          `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id, sync_list_origin)
           VALUES ($1, $2, $3, $4, false, $5, 'sync_selection')
           ON CONFLICT (bd_account_id, telegram_chat_id) DO UPDATE SET
             title = EXCLUDED.title,
             peer_type = EXCLUDED.peer_type,
             folder_id = EXCLUDED.folder_id,
             sync_list_origin = 'sync_selection'`,
          [id, chatId, title, peerType, primaryFolder]
        );
        for (const fid of folderIds) {
          await client.query(
            `INSERT INTO bd_account_sync_chat_folders (bd_account_id, telegram_chat_id, folder_id)
             VALUES ($1, $2, $3) ON CONFLICT (bd_account_id, telegram_chat_id, folder_id) DO NOTHING`,
            [id, chatId, fid]
          );
        }
        inserted++;
      }
      log.info({ message: `Saved ${inserted} sync chats (requested ${chats.length})`, entity_id: id });

      const chatsRows = await client.query(
        'SELECT id, telegram_chat_id, title, peer_type, folder_id, created_at FROM bd_account_sync_chats WHERE bd_account_id = $1 ORDER BY folder_id NULLS LAST, created_at',
        [id]
      );
      const junctionRows = await client.query('SELECT telegram_chat_id, folder_id FROM bd_account_sync_chat_folders WHERE bd_account_id = $1', [id]);
      return { chatsRows, junctionRows };
    });

    await ensureFoldersFromSyncChats(pool, telegramManager, id, log);

    try {
      const r = await telegramManager.enrichContactsForAccountSyncChats(user.organizationId, id, { delayMs: 60 });
      log.info({ message: `Enriched ${r.enriched} contacts for sync chats`, entity_id: id });
    } catch (err: unknown) {
      log.warn({ message: 'enrichContactsForAccountSyncChats failed', entity_id: id, error: (err as Error)?.message });
    }

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

  router.post('/:id/sync-start', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id } = req.params;

    log.info({ message: 'sync-start requested', entity_id: id, organization_id: user.organizationId });

    const account = await getAccountOr404<{ id: string; organization_id: string; sync_status?: string; sync_started_at?: unknown }>(pool, id, user.organizationId, 'id, organization_id, sync_status, sync_started_at');
    await requireBidiOwnAccount(pool, id, user);
    const canManage = await canManageBdAccountAsConnectorOrOrgAdmin(pool, id, user);
    if (!canManage) {
      throw new AppError(
        403,
        'Only the account connector or an organization owner/admin can start sync',
        ErrorCodes.FORBIDDEN
      );
    }
    const startedAt = account.sync_started_at ? new Date(account.sync_started_at as string | number | Date).getTime() : 0;
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

    telegramManager.syncHistory(id, account.organization_id).catch((err: unknown) => {
      log.error({ message: 'Sync failed', entity_id: id, error: String(err) });
    });
  }));

  router.get('/:id/sync-status', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;

    const row = await getAccountOr404<{ sync_status?: string; sync_error?: string | null; sync_progress_total?: number | null; sync_progress_done?: number | null; sync_started_at?: unknown; sync_completed_at?: unknown }>(pool, id, organizationId, 'sync_status, sync_error, sync_progress_total, sync_progress_done, sync_started_at, sync_completed_at');
    let syncStatus = row.sync_status ?? 'idle';
    const startedAt = row.sync_started_at ? new Date(row.sync_started_at as string | number | Date).getTime() : 0;
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

  router.patch('/:id/chats/:chatId/folder', validate(ChatFolderPatchSchema), asyncHandler(async (req, res) => {
    const user = req.user;
    const { id: accountId, chatId } = req.params;
    const { folder_ids: folderIdsRaw, folder_id: legacyFolderId } = req.body;

    await getAccountOr404(pool, accountId, user.organizationId, 'id');
    await requireBidiOwnAccount(pool, accountId, user);
    const canManage = await canManageBdAccountAsConnectorOrOrgAdmin(pool, accountId, user);
    if (!canManage) {
      throw new AppError(
        403,
        'Only the account connector or an organization owner/admin can change chat folder assignment',
        ErrorCodes.FORBIDDEN
      );
    }

    let folderIds: number[] = [];
    if (Array.isArray(folderIdsRaw) && folderIdsRaw.length > 0) {
      folderIds = folderIdsRaw.filter((n) => !Number.isNaN(n));
    } else if (legacyFolderId !== undefined && legacyFolderId !== null && legacyFolderId !== '') {
      const n = Number(legacyFolderId);
      if (!Number.isNaN(n)) folderIds = [n];
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

  router.delete('/:id/chats/:chatId', asyncHandler(async (req, res) => {
    const user = req.user;
    const { id: accountId, chatId } = req.params;

    await getAccountOr404(pool, accountId, user.organizationId, 'id');
    await requireBidiOwnAccount(pool, accountId, user);
    const canManage = await canManageBdAccountAsConnectorOrOrgAdmin(pool, accountId, user);
    const canDeleteChat = await checkPermission(user.role, 'bd_accounts', 'chat.delete');
    if (!canManage && !canDeleteChat) {
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
}
