import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, ErrorCodes, requireUser, DatabasePools } from '@getsale/service-framework';
import { RedisClient } from '@getsale/cache';
import { RabbitMQClient } from '@getsale/queue';
import { Logger } from '@getsale/logger';
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { SessionCoordinator } from '../coordinator';

interface Deps {
  db: DatabasePools;
  rabbitmq: RabbitMQClient;
  log: Logger;
  redis: RedisClient;
  coordinator: SessionCoordinator;
}

const SYNC_STALE_MINUTES = 15;

const SyncChatsBody = z.object({
  chats: z.array(
    z.object({
      id: z.string().optional(),
      telegram_chat_id: z.string().optional(),
      name: z.string().optional(),
      title: z.string().optional(),
      isUser: z.boolean().optional(),
      isGroup: z.boolean().optional(),
      isChannel: z.boolean().optional(),
      folderId: z.number().nullable().optional(),
      folderIds: z.array(z.number()).optional(),
    }),
  ),
});

const SyncFoldersBody = z.object({
  folders: z.array(
    z.object({
      folderId: z.number().optional(),
      folder_id: z.number().optional(),
      folderTitle: z.string().optional(),
      folder_title: z.string().optional(),
      is_user_created: z.boolean().optional(),
      isUserCreated: z.boolean().optional(),
      icon: z.string().nullable().optional(),
    }),
  ),
  extraChats: z
    .array(
      z.object({
        id: z.string().optional(),
        telegram_chat_id: z.string().optional(),
        name: z.string().optional(),
        title: z.string().optional(),
        isUser: z.boolean().optional(),
        isGroup: z.boolean().optional(),
        isChannel: z.boolean().optional(),
        folderId: z.number().nullable().optional(),
      }),
    )
    .optional(),
});

const SyncFolderCustomBody = z.object({
  folder_title: z.string().max(12).optional(),
  icon: z.string().max(20).nullable().optional(),
});

const SyncFoldersOrderBody = z.object({
  order: z.array(z.string()),
});

const SyncFolderPatchBody = z.object({
  icon: z.string().max(20).nullable().optional(),
  folder_title: z.string().max(12).nullable().optional(),
});

const ChatFolderPatchBody = z.object({
  folder_ids: z.array(z.number()).optional(),
  folder_id: z.union([z.number(), z.string(), z.null()]).optional(),
});

function assertNotViewer(user: { role: string }): void {
  if (user.role === 'viewer') {
    throw new AppError(403, 'Viewers cannot perform this action', ErrorCodes.FORBIDDEN);
  }
}

function getAccountOr404(result: { rows: unknown[] }): void {
  if (!result.rows.length) {
    throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
  }
}

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

async function refreshDialogsFromTelegram(
  accountId: string,
  client: TelegramClient,
  db: DatabasePools,
  log: Logger,
): Promise<void> {
  const dialogs = await client.getDialogs({ limit: 500 });
  let upserted = 0;

  for (const d of dialogs) {
    const entity = (d as any).entity;
    const isUser = (d as any).isUser ?? entity?.className === 'User';
    const isGroup = (d as any).isGroup ?? false;
    const isChannel = (d as any).isChannel ?? false;
    if (!isUser && !isGroup && !isChannel) continue;

    const chatId = String(d.id);
    const title = ((d as any).name || (d as any).title || '').trim();
    let peerType = 'user';
    if (isChannel) peerType = 'channel';
    else if (isGroup) peerType = 'chat';

    await db.write.query(
      `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (bd_account_id, telegram_chat_id) DO UPDATE SET
         title = EXCLUDED.title, peer_type = EXCLUDED.peer_type`,
      [accountId, chatId, title, peerType],
    );
    upserted++;
  }

  log.info({ message: `Refreshed ${upserted} dialogs from Telegram`, entity_id: accountId });
}

function extractPeerId(peer: unknown): string | null {
  if (!peer || typeof peer !== 'object') return null;
  const p = peer as Record<string, unknown>;
  if (p.userId != null) return String(p.userId);
  if (p.chatId != null) return String(p.chatId);
  if (p.channelId != null) return String(p.channelId);
  return null;
}

async function refreshFoldersFromTelegram(
  accountId: string,
  client: TelegramClient,
  db: DatabasePools,
  log: Logger,
): Promise<void> {
  let filters: any[];
  try {
    const result = await client.invoke(new Api.messages.GetDialogFilters()) as any;
    filters = Array.isArray(result) ? result : (result?.filters ?? []);
  } catch (err) {
    log.warn({ message: 'GetDialogFilters failed, skipping folder refresh', entity_id: accountId, error: String(err) });
    return;
  }

  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    if (!f || f.className === 'DialogFilterDefault') continue;

    const folderId = Number(f.id);
    if (Number.isNaN(folderId)) continue;

    const rawTitle = typeof f.title === 'string' ? f.title : (f.title?.text ?? '');
    const folderTitle = rawTitle.trim() || `Папка ${folderId}`;
    const icon: string | null = f.emoticon || null;

    const existing = await db.read.query(
      'SELECT id, is_user_created FROM bd_account_sync_folders WHERE bd_account_id = $1 AND folder_id = $2',
      [accountId, folderId],
    );

    if (!existing.rows.length) {
      await db.write.query(
        `INSERT INTO bd_account_sync_folders (bd_account_id, folder_id, folder_title, order_index, is_user_created, icon)
         VALUES ($1, $2, $3, $4, false, $5)`,
        [accountId, folderId, folderTitle, i, icon],
      );
    } else if (!(existing.rows[0] as { is_user_created: boolean }).is_user_created) {
      await db.write.query(
        'UPDATE bd_account_sync_folders SET folder_title = $1, icon = $2 WHERE id = $3',
        [folderTitle, icon, (existing.rows[0] as { id: string }).id],
      );
    }

    const includePeers: unknown[] = f.includePeers ?? f.include_peers ?? [];
    const pinnedPeers: unknown[] = f.pinnedPeers ?? f.pinned_peers ?? [];
    for (const peer of [...includePeers, ...pinnedPeers]) {
      const chatId = extractPeerId(peer);
      if (!chatId) continue;
      await db.write.query(
        `INSERT INTO bd_account_sync_chat_folders (bd_account_id, telegram_chat_id, folder_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (bd_account_id, telegram_chat_id, folder_id) DO NOTHING`,
        [accountId, chatId, folderId],
      );
    }
  }

  log.info({ message: `Refreshed ${filters.length} folder filters from Telegram`, entity_id: accountId });
}

export function registerSyncRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, log } = deps;

  // ── Dialogs Read ──

  /**
   * GET /api/bd-accounts/:id/dialogs
   * Returns synced dialogs from DB. If ?refresh=1, fetches fresh dialogs via GramJS first.
   */
  app.get('/api/bd-accounts/:id/dialogs', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const { refresh } = request.query as { refresh?: string };

    const account = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    getAccountOr404(account);

    if (refresh === '1') {
      const client = getActiveClient(id, deps);
      await refreshDialogsFromTelegram(id, client, db, log);
    }

    const chatsRows = await db.read.query(
      'SELECT telegram_chat_id, title, peer_type FROM bd_account_sync_chats WHERE bd_account_id = $1 ORDER BY created_at',
      [id],
    );
    return chatsRows.rows.map((r: any) => {
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
  });

  /**
   * GET /api/bd-accounts/:id/dialogs-by-folders
   * Returns dialogs grouped by folders from DB.
   * If ?refresh=1, fetches fresh dialogs and folder filters via GramJS first.
   */
  app.get('/api/bd-accounts/:id/dialogs-by-folders', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const { refresh } = request.query as { refresh?: string };

    const account = await db.read.query(
      'SELECT id, telegram_id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    getAccountOr404(account);

    if (refresh === '1') {
      const client = getActiveClient(id, deps);
      await refreshDialogsFromTelegram(id, client, db, log);
      await refreshFoldersFromTelegram(id, client, db, log);
    }

    const accountTelegramId = account.rows[0].telegram_id != null
      ? String(account.rows[0].telegram_id).trim()
      : null;

    const foldersRows = await db.read.query(
      'SELECT folder_id, folder_title, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index, folder_id',
      [id],
    );
    const chatsRows = await db.read.query(
      `SELECT s.telegram_chat_id, s.title, s.peer_type, j.folder_id
       FROM bd_account_sync_chats s
       LEFT JOIN bd_account_sync_chat_folders j ON j.bd_account_id = s.bd_account_id AND j.telegram_chat_id = s.telegram_chat_id
       WHERE s.bd_account_id = $1`,
      [id],
    );

    const chatsByFolder = new Map<number, { id: string; name: string; isUser: boolean; isGroup: boolean; isChannel: boolean }[]>();
    const folder0Dialogs: { id: string; name: string; isUser: boolean; isGroup: boolean; isChannel: boolean }[] = [];
    const seenInFolder0 = new Set<string>();

    for (const r of chatsRows.rows as any[]) {
      const chatId = String(r.telegram_chat_id);
      const pt = (r.peer_type || 'user').toLowerCase();
      const item = {
        id: chatId,
        name: (r.title || '').trim() || chatId,
        isUser: pt === 'user',
        isGroup: pt === 'chat',
        isChannel: pt === 'channel',
      };
      if (accountTelegramId && item.isUser && chatId === accountTelegramId) continue;
      if (!seenInFolder0.has(chatId)) {
        seenInFolder0.add(chatId);
        folder0Dialogs.push(item);
      }
      const fid = r.folder_id != null ? Number(r.folder_id) : 0;
      if (!chatsByFolder.has(fid)) chatsByFolder.set(fid, []);
      const arr = chatsByFolder.get(fid)!;
      if (!arr.some((d) => d.id === chatId)) arr.push(item);
    }

    const folderList: { id: number; title: string; emoticon?: string; dialogs: unknown[] }[] = [];
    const addedFolderIds = new Set<number>();

    if (!foldersRows.rows.some((r: any) => Number(r.folder_id) === 0)) {
      folderList.push({ id: 0, title: 'Все чаты', emoticon: '💬', dialogs: folder0Dialogs });
      addedFolderIds.add(0);
    }
    if (!foldersRows.rows.some((r: any) => Number(r.folder_id) === 1)) {
      folderList.push({ id: 1, title: 'Архив', emoticon: '📁', dialogs: chatsByFolder.get(1) || [] });
      addedFolderIds.add(1);
    }
    for (const f of foldersRows.rows as any[]) {
      const fid = Number(f.folder_id);
      if (addedFolderIds.has(fid)) continue;
      folderList.push({
        id: fid,
        title: (f.folder_title || '').trim() || `Папка ${fid}`,
        emoticon: f.icon || undefined,
        dialogs: fid === 0 ? folder0Dialogs : (chatsByFolder.get(fid) || []),
      });
      addedFolderIds.add(fid);
    }

    if (folderList.length === 0) {
      folderList.push({ id: 0, title: 'Все чаты', emoticon: '💬', dialogs: folder0Dialogs });
    }

    return { folders: folderList };
  });

  // ── Sync Folders ──

  /**
   * GET /api/bd-accounts/:id/sync-folders
   * Returns saved sync folders from DB.
   */
  app.get('/api/bd-accounts/:id/sync-folders', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;

    const account = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    getAccountOr404(account);

    const result = await db.read.query(
      'SELECT id, folder_id, folder_title, order_index, COALESCE(is_user_created, false) AS is_user_created, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index, folder_id',
      [id],
    );
    return result.rows;
  });

  /**
   * POST /api/bd-accounts/:id/sync-folders
   * Replace sync folders for an account.
   */
  app.post('/api/bd-accounts/:id/sync-folders', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    assertNotViewer(user);
    const body = SyncFoldersBody.parse(request.body);

    const account = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    getAccountOr404(account);

    await db.write.query('DELETE FROM bd_account_sync_folders WHERE bd_account_id = $1', [id]);

    for (let i = 0; i < body.folders.length; i++) {
      const f = body.folders[i];
      const folderId = Number(f.folderId ?? f.folder_id ?? 0);
      const title = String(f.folderTitle ?? f.folder_title ?? '').trim() || `Папка ${folderId}`;
      const isUserCreated = Boolean(f.is_user_created ?? f.isUserCreated ?? false);
      const icon = f.icon != null && String(f.icon).trim() ? String(f.icon).trim().slice(0, 20) : null;
      await db.write.query(
        `INSERT INTO bd_account_sync_folders (bd_account_id, folder_id, folder_title, order_index, is_user_created, icon)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, folderId, title, i, isUserCreated, icon],
      );
    }

    if (Array.isArray(body.extraChats) && body.extraChats.length > 0) {
      for (const c of body.extraChats) {
        const chatId = String(c.id ?? c.telegram_chat_id ?? '').trim();
        if (!chatId) continue;
        const chatTitle = (c.name ?? c.title ?? '').trim() || chatId;
        const folderId = c.folderId !== undefined && c.folderId !== null ? Number(c.folderId) : null;
        let peerType = 'user';
        if (c.isChannel) peerType = 'channel';
        else if (c.isGroup) peerType = 'chat';
        await db.write.query(
          `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id)
           VALUES ($1, $2, $3, $4, false, $5)
           ON CONFLICT (bd_account_id, telegram_chat_id) DO UPDATE SET title = EXCLUDED.title, peer_type = EXCLUDED.peer_type, folder_id = EXCLUDED.folder_id`,
          [id, chatId, chatTitle, peerType, folderId],
        );
        if (folderId != null) {
          await db.write.query(
            `INSERT INTO bd_account_sync_chat_folders (bd_account_id, telegram_chat_id, folder_id)
             VALUES ($1, $2, $3) ON CONFLICT (bd_account_id, telegram_chat_id, folder_id) DO NOTHING`,
            [id, chatId, folderId],
          );
        }
      }
    }

    const result = await db.read.query(
      'SELECT id, folder_id, folder_title, order_index, COALESCE(is_user_created, false) AS is_user_created, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index',
      [id],
    );
    return result.rows;
  });

  /**
   * POST /api/bd-accounts/:id/sync-folders/custom
   * Create a new user-defined folder.
   */
  app.post('/api/bd-accounts/:id/sync-folders/custom', { preHandler: [requireUser] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    assertNotViewer(user);
    const body = SyncFolderCustomBody.parse(request.body);

    const account = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    getAccountOr404(account);

    const title = (body.folder_title ?? '').trim().slice(0, 12) || 'New folder';
    const iconVal = body.icon != null && String(body.icon).trim() ? String(body.icon).trim().slice(0, 20) : null;

    const maxRow = await db.read.query(
      'SELECT COALESCE(MAX(folder_id), 1) AS max_id FROM bd_account_sync_folders WHERE bd_account_id = $1',
      [id],
    );
    const nextFolderId = Math.max(2, (Number(maxRow.rows[0]?.max_id) || 1) + 1);
    const countRow = await db.read.query(
      'SELECT COUNT(*) AS c FROM bd_account_sync_folders WHERE bd_account_id = $1',
      [id],
    );
    const orderIndex = Number(countRow.rows[0]?.c) || 0;

    const insert = await db.write.query(
      `INSERT INTO bd_account_sync_folders (bd_account_id, folder_id, folder_title, order_index, is_user_created, icon)
       VALUES ($1, $2, $3, $4, true, $5)
       RETURNING id, folder_id, folder_title, order_index, is_user_created, icon`,
      [id, nextFolderId, title, orderIndex, iconVal],
    );
    reply.code(201);
    return insert.rows[0];
  });

  /**
   * PATCH /api/bd-accounts/:id/sync-folders/order
   * Reorder sync folders.
   */
  app.patch('/api/bd-accounts/:id/sync-folders/order', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    assertNotViewer(user);
    const { order } = SyncFoldersOrderBody.parse(request.body);

    const account = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    getAccountOr404(account);

    for (let i = 0; i < order.length; i++) {
      await db.write.query(
        'UPDATE bd_account_sync_folders SET order_index = $1 WHERE id = $2 AND bd_account_id = $3',
        [i, String(order[i]), id],
      );
    }

    const result = await db.read.query(
      'SELECT id, folder_id, folder_title, order_index, COALESCE(is_user_created, false) AS is_user_created, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index',
      [id],
    );
    return result.rows;
  });

  /**
   * PATCH /api/bd-accounts/:id/sync-folders/:folderRowId
   * Update icon / title for a sync folder.
   */
  app.patch('/api/bd-accounts/:id/sync-folders/:folderRowId', { preHandler: [requireUser] }, async (request) => {
    const { id, folderRowId } = request.params as { id: string; folderRowId: string };
    const user = request.user!;
    assertNotViewer(user);
    const body = SyncFolderPatchBody.parse(request.body);

    const account = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    getAccountOr404(account);

    const updates: string[] = [];
    const values: (string | null)[] = [];
    let i = 1;
    if (body.icon !== undefined) {
      updates.push(`icon = $${i++}`);
      values.push(body.icon === null || body.icon === '' ? null : String(body.icon).trim().slice(0, 20) || null);
    }
    if (body.folder_title !== undefined) {
      updates.push(`folder_title = $${i++}`);
      values.push(body.folder_title === null ? null : String(body.folder_title).trim().slice(0, 12) || null);
    }
    if (updates.length === 0) {
      throw new AppError(400, 'No fields to update', ErrorCodes.VALIDATION);
    }

    values.push(folderRowId, id);
    const result = await db.write.query(
      `UPDATE bd_account_sync_folders SET ${updates.join(', ')}
       WHERE id = $${i} AND bd_account_id = $${i + 1}
       RETURNING id, folder_id, folder_title, order_index, is_user_created, icon`,
      values,
    );
    if (!result.rows.length) {
      throw new AppError(404, 'Folder not found', ErrorCodes.NOT_FOUND);
    }
    return result.rows[0];
  });

  /**
   * DELETE /api/bd-accounts/:id/sync-folders/:folderRowId
   * Delete a user-created sync folder.
   */
  app.delete('/api/bd-accounts/:id/sync-folders/:folderRowId', { preHandler: [requireUser] }, async (request, reply) => {
    const { id, folderRowId } = request.params as { id: string; folderRowId: string };
    const user = request.user!;
    assertNotViewer(user);

    const account = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    getAccountOr404(account);

    const folderRow = await db.read.query(
      'SELECT id, folder_id, is_user_created FROM bd_account_sync_folders WHERE id = $1 AND bd_account_id = $2',
      [folderRowId, id],
    );
    if (!folderRow.rows.length) {
      throw new AppError(404, 'Folder not found', ErrorCodes.NOT_FOUND);
    }

    const folder = folderRow.rows[0] as { folder_id: number; is_user_created: boolean };
    if (!folder.is_user_created) {
      throw new AppError(400, 'Only user-created folders can be deleted', ErrorCodes.BAD_REQUEST);
    }

    const folderIdNum = Number(folder.folder_id);
    await db.write.query(
      'UPDATE bd_account_sync_chats SET folder_id = NULL WHERE bd_account_id = $1 AND folder_id = $2',
      [id, folderIdNum],
    );
    await db.write.query(
      'DELETE FROM bd_account_sync_folders WHERE id = $1 AND bd_account_id = $2',
      [folderRowId, id],
    );
    reply.code(204).send();
  });

  // ── Sync Chats ──

  /**
   * GET /api/bd-accounts/:id/sync-chats
   * Returns the sync-chat list with folder assignments.
   */
  app.get('/api/bd-accounts/:id/sync-chats', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;

    const account = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    getAccountOr404(account);

    const chatsRows = await db.read.query(
      'SELECT id, telegram_chat_id, title, peer_type, is_folder, folder_id, created_at FROM bd_account_sync_chats WHERE bd_account_id = $1 ORDER BY folder_id NULLS LAST, created_at',
      [id],
    );
    const junctionRows = await db.read.query(
      'SELECT telegram_chat_id, folder_id FROM bd_account_sync_chat_folders WHERE bd_account_id = $1',
      [id],
    );
    const folderIdsByChat = new Map<string, number[]>();
    for (const r of junctionRows.rows as any[]) {
      const tid = String(r.telegram_chat_id);
      if (!folderIdsByChat.has(tid)) folderIdsByChat.set(tid, []);
      folderIdsByChat.get(tid)!.push(Number(r.folder_id));
    }
    return chatsRows.rows.map((r: any) => {
      const tid = String(r.telegram_chat_id);
      const folder_ids = folderIdsByChat.get(tid) ?? (r.folder_id != null ? [Number(r.folder_id)] : []);
      return { ...r, folder_ids };
    });
  });

  /**
   * POST /api/bd-accounts/:id/sync-chats
   * Replace sync-chat list for an account.
   */
  app.post('/api/bd-accounts/:id/sync-chats', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    assertNotViewer(user);
    const { chats } = SyncChatsBody.parse(request.body);

    const account = await db.read.query(
      'SELECT id, telegram_id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    getAccountOr404(account);
    const accountTelegramId = account.rows[0].telegram_id != null
      ? String(account.rows[0].telegram_id).trim()
      : null;

    await db.write.query(
      `DELETE FROM bd_account_sync_chats WHERE bd_account_id = $1
       AND COALESCE(sync_list_origin, 'sync_selection') = 'sync_selection'`,
      [id],
    );
    await db.write.query('DELETE FROM bd_account_sync_chat_folders WHERE bd_account_id = $1', [id]);

    let inserted = 0;
    for (const c of chats) {
      const chatId = String(c.id ?? c.telegram_chat_id ?? '').trim();
      const title = (c.name ?? c.title ?? '').trim();
      const folderId = c.folderId !== undefined && c.folderId !== null ? Number(c.folderId) : null;
      const folderIds = Array.isArray(c.folderIds)
        ? c.folderIds.filter((n) => !Number.isNaN(n))
        : folderId != null ? [folderId] : [];
      let peerType = 'user';
      if (c.isChannel) peerType = 'channel';
      else if (c.isGroup) peerType = 'chat';
      if (!chatId) continue;
      if (peerType === 'user' && accountTelegramId && chatId === accountTelegramId) continue;

      const primaryFolder = folderIds[0] ?? folderId ?? null;
      await db.write.query(
        `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id, sync_list_origin)
         VALUES ($1, $2, $3, $4, false, $5, 'sync_selection')
         ON CONFLICT (bd_account_id, telegram_chat_id) DO UPDATE SET
           title = EXCLUDED.title, peer_type = EXCLUDED.peer_type,
           folder_id = EXCLUDED.folder_id, sync_list_origin = 'sync_selection'`,
        [id, chatId, title, peerType, primaryFolder],
      );
      for (const fid of folderIds) {
        await db.write.query(
          `INSERT INTO bd_account_sync_chat_folders (bd_account_id, telegram_chat_id, folder_id)
           VALUES ($1, $2, $3) ON CONFLICT (bd_account_id, telegram_chat_id, folder_id) DO NOTHING`,
          [id, chatId, fid],
        );
      }
      inserted++;
    }
    log.info({ message: `Saved ${inserted} sync chats (requested ${chats.length})`, entity_id: id });

    const chatsRows = await db.read.query(
      'SELECT id, telegram_chat_id, title, peer_type, folder_id, created_at FROM bd_account_sync_chats WHERE bd_account_id = $1 ORDER BY folder_id NULLS LAST, created_at',
      [id],
    );
    const junctionRows = await db.read.query(
      'SELECT telegram_chat_id, folder_id FROM bd_account_sync_chat_folders WHERE bd_account_id = $1',
      [id],
    );
    const folderIdsByChat = new Map<string, number[]>();
    for (const r of junctionRows.rows as any[]) {
      const tid = String(r.telegram_chat_id);
      if (!folderIdsByChat.has(tid)) folderIdsByChat.set(tid, []);
      folderIdsByChat.get(tid)!.push(Number(r.folder_id));
    }
    return chatsRows.rows.map((r: any) => ({
      ...r,
      folder_ids: folderIdsByChat.get(String(r.telegram_chat_id)) ?? (r.folder_id != null ? [Number(r.folder_id)] : []),
    }));
  });

  // ── Sync Status / Start ──

  /**
   * GET /api/bd-accounts/:id/sync-status
   * Returns current sync status for the account.
   */
  app.get('/api/bd-accounts/:id/sync-status', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;

    const result = await db.write.query(
      'SELECT sync_status, sync_error, sync_progress_total, sync_progress_done, sync_started_at, sync_completed_at FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!result.rows.length) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    const row = result.rows[0] as {
      sync_status?: string;
      sync_error?: string | null;
      sync_progress_total?: number | null;
      sync_progress_done?: number | null;
      sync_started_at?: unknown;
      sync_completed_at?: unknown;
    };
    let syncStatus = row.sync_status ?? 'idle';
    const startedAt = row.sync_started_at ? new Date(row.sync_started_at as string | number | Date).getTime() : 0;
    if (syncStatus === 'syncing' && startedAt && Date.now() - startedAt > SYNC_STALE_MINUTES * 60 * 1000) {
      await db.write.query(
        "UPDATE bd_accounts SET sync_status = 'idle', sync_error = 'Синхронизация прервана по таймауту' WHERE id = $1",
        [id],
      );
      syncStatus = 'idle';
    }

    const chatsCount = await db.read.query(
      'SELECT COUNT(*) AS c FROM bd_account_sync_chats WHERE bd_account_id = $1',
      [id],
    );
    return { ...row, sync_status: syncStatus, has_sync_chats: Number(chatsCount.rows[0]?.c ?? 0) > 0 };
  });

  /**
   * POST /api/bd-accounts/:id/sync-start
   * Start history sync via the account actor on this instance.
   */
  app.post('/api/bd-accounts/:id/sync-start', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    assertNotViewer(user);

    const result = await db.read.query(
      'SELECT id, organization_id, sync_status, sync_started_at FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!result.rows.length) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    const account = result.rows[0] as { sync_status?: string; sync_started_at?: unknown; organization_id: string };
    const startedAt = account.sync_started_at ? new Date(account.sync_started_at as string).getTime() : 0;
    const isStale = account.sync_status === 'syncing' && startedAt && Date.now() - startedAt > SYNC_STALE_MINUTES * 60 * 1000;

    if (isStale) {
      await db.write.query("UPDATE bd_accounts SET sync_status = 'idle', sync_error = NULL WHERE id = $1", [id]);
    } else if (account.sync_status === 'syncing') {
      return { success: true, message: 'Sync already in progress' };
    }

    const syncChatsCount = await db.read.query(
      'SELECT COUNT(*) AS c FROM bd_account_sync_chats WHERE bd_account_id = $1',
      [id],
    );
    if (Number(syncChatsCount.rows[0]?.c ?? 0) === 0) {
      throw new AppError(400, 'No chats selected for sync', ErrorCodes.BAD_REQUEST);
    }

    const actor = deps.coordinator.getActor(id);
    if (!actor) {
      throw new AppError(503, 'Account actor not available on this instance', ErrorCodes.INTERNAL_ERROR);
    }
    const client = actor.getClient();
    if (!client || !(client as any).connected) {
      throw new AppError(400, 'Account is not connected', ErrorCodes.BAD_REQUEST);
    }

    actor.syncHistory(account.organization_id).catch(async (err: unknown) => {
      log.error({ message: 'Sync history failed', account_id: id, error: String(err) });
      await db.write.query(
        "UPDATE bd_accounts SET sync_status = 'error', sync_error = $1 WHERE id = $2",
        [String(err).slice(0, 500), id],
      ).catch(() => {});
    });

    return { success: true, message: 'Sync started' };
  });

  // ── Chat-level operations ──

  /**
   * PATCH /api/bd-accounts/:id/chats/:chatId/folder
   * Update folder assignment for a specific chat.
   */
  app.patch('/api/bd-accounts/:id/chats/:chatId/folder', { preHandler: [requireUser] }, async (request) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const user = request.user!;
    assertNotViewer(user);
    const body = ChatFolderPatchBody.parse(request.body);

    const account = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    getAccountOr404(account);

    let folderIds: number[] = [];
    if (Array.isArray(body.folder_ids) && body.folder_ids.length > 0) {
      folderIds = body.folder_ids.filter((n) => !Number.isNaN(n));
    } else if (body.folder_id !== undefined && body.folder_id !== null && body.folder_id !== '') {
      const n = Number(body.folder_id);
      if (!Number.isNaN(n)) folderIds = [n];
    }

    const chatExists = await db.read.query(
      'SELECT id FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2',
      [id, chatId],
    );
    if (!chatExists.rows.length) {
      throw new AppError(404, 'Chat not found in sync list', ErrorCodes.NOT_FOUND);
    }

    await db.write.query('DELETE FROM bd_account_sync_chat_folders WHERE bd_account_id = $1 AND telegram_chat_id = $2', [id, chatId]);
    for (const fid of folderIds) {
      await db.write.query(
        `INSERT INTO bd_account_sync_chat_folders (bd_account_id, telegram_chat_id, folder_id)
         VALUES ($1, $2, $3) ON CONFLICT (bd_account_id, telegram_chat_id, folder_id) DO NOTHING`,
        [id, chatId, fid],
      );
    }
    const primaryFolderId = folderIds[0] ?? null;
    await db.write.query(
      'UPDATE bd_account_sync_chats SET folder_id = $1 WHERE bd_account_id = $2 AND telegram_chat_id = $3',
      [primaryFolderId, id, chatId],
    );

    return { success: true, folder_ids: folderIds, folder_id: primaryFolderId };
  });

  /**
   * DELETE /api/bd-accounts/:id/chats/:chatId
   * Remove a chat from the sync list.
   */
  app.delete('/api/bd-accounts/:id/chats/:chatId', { preHandler: [requireUser] }, async (request) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const user = request.user!;
    assertNotViewer(user);

    const account = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    getAccountOr404(account);

    await db.write.query('DELETE FROM bd_account_sync_chat_folders WHERE bd_account_id = $1 AND telegram_chat_id = $2', [id, chatId]);
    const result = await db.write.query(
      'DELETE FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 RETURNING id',
      [id, chatId],
    );
    if (!result.rows.length) {
      throw new AppError(404, 'Chat not found in sync list', ErrorCodes.NOT_FOUND);
    }
    return { success: true };
  });
}
