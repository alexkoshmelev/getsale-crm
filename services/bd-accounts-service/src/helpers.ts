import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import {
  AppError,
  ErrorCodes,
  BIDI_ROLE,
  VIEWER_ROLE,
  isBdAgentRole,
  isBdViewerRole,
  bdAccountsListScope,
  type BdAccountsListScope,
} from '@getsale/service-core';

/** Safe extraction of error message from unknown (catch). Use in catch (err: unknown) and for logging. */
export function getErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === 'string') return err;
  if (err != null && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

/** Safe extraction of optional .code from unknown (e.g. Telegram/DB errors). */
export function getErrorCode(err: unknown): string | undefined {
  if (err != null && typeof err === 'object' && 'code' in err) {
    const c = (err as { code: unknown }).code;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}

/** Extract retry_after seconds from Telegram FloodWaitError or "A wait of N seconds" message. */
export function getRetryAfterSeconds(err: unknown): number | undefined {
  if (err != null && typeof err === 'object' && 'seconds' in err) {
    const s = (err as { seconds: unknown }).seconds;
    if (typeof s === 'number' && s >= 0 && s <= 86400 * 7) return Math.ceil(s);
  }
  const msg = getErrorMessage(err);
  const match = typeof msg === 'string' ? msg.match(/wait of (\d+) seconds?/i) : null;
  if (match) {
    const n = parseInt(match[1], 10);
    if (!Number.isNaN(n) && n >= 0 && n <= 86400 * 7) return n;
  }
  return undefined;
}
import { TelegramManager } from './telegram';

/** Row from bd_account_sync_folders (folder_id). */
export interface FolderRow {
  folder_id: number;
}

/** Minimal dialog shape returned by TelegramManager.getDialogsAll / filter (GramJS dialog-like). */
export interface TelegramDialogLike {
  id?: unknown;
  name?: string;
  isChannel?: boolean;
  isGroup?: boolean;
  pinned?: boolean;
  first_name?: string;
  last_name?: string;
  username?: string;
}

export const SYNC_STALE_MINUTES = 15;
export const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB (Telegram limit)
export const BULK_SEND_DELAY_MS = 2000;

export function getTelegramApiCredentials(): { apiId: number; apiHash: string } {
  const apiId = process.env.TELEGRAM_API_ID;
  const apiHash = process.env.TELEGRAM_API_HASH;
  if (!apiId || !apiHash) {
    throw new Error(
      'TELEGRAM_API_ID and TELEGRAM_API_HASH must be set in environment. ' +
        'On the server: set GitHub Secrets TELEGRAM_API_ID and TELEGRAM_API_HASH, or add them to .env in the same directory as docker-compose.server.yml, ' +
        'then run: docker compose -f docker-compose.server.yml up -d --force-recreate bd-accounts-service'
    );
  }
  return { apiId: parseInt(String(apiId), 10), apiHash };
}

export {
  BIDI_ROLE,
  VIEWER_ROLE,
  isBdAgentRole,
  isBdViewerRole,
  bdAccountsListScope,
  type BdAccountsListScope,
};

/** Block viewer on any BD account API except empty list (GET / returns []). */
export function assertBdAccountsNotViewer(user: { role?: string }): void {
  if (isBdViewerRole(user.role)) {
    throw new AppError(403, 'Viewers cannot access BD accounts', ErrorCodes.FORBIDDEN);
  }
}

export async function isAccountOwner(
  pool: Pool,
  accountId: string,
  user: { id: string; organizationId: string }
): Promise<boolean> {
  const r = await pool.query(
    'SELECT created_by_user_id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
    [accountId, user.organizationId]
  );
  if (r.rows.length === 0) return false;
  const ownerId = r.rows[0].created_by_user_id;
  return ownerId != null && ownerId === user.id;
}

/** @deprecated Use isAccountOwner */
export async function requireAccountOwner(
  pool: Pool,
  accountId: string,
  user: { id: string; organizationId: string }
): Promise<boolean> {
  return isAccountOwner(pool, accountId, user);
}

/**
 * For role "bidi" (agent): allow write only if the user is the one who connected this BD account.
 * Other roles are not restricted. Throws 403 if agent tries to write to an account they don't own.
 */
export async function requireBidiCanWriteAccount(
  pool: Pool,
  accountId: string,
  user: { id: string; organizationId: string; role?: string }
): Promise<void> {
  if (!isBdAgentRole(user.role)) return;
  const owner = await isAccountOwner(pool, accountId, user);
  if (!owner) {
    throw new AppError(
      403,
      'As an agent you can only send messages from accounts you connected yourself. This account was connected by another user.',
      ErrorCodes.FORBIDDEN
    );
  }
}

/**
 * For role "bidi" (agent): only the account owner may perform the action (edit, sync, pause, delete).
 * Other roles are not restricted. Throws 403 if agent acts on an account they don't own.
 */
export async function requireBidiOwnAccount(
  pool: Pool,
  accountId: string,
  user: { id: string; organizationId: string; role?: string }
): Promise<void> {
  if (!isBdAgentRole(user.role)) return;
  const owner = await isAccountOwner(pool, accountId, user);
  if (!owner) {
    throw new AppError(
      403,
      'As an agent you can only manage accounts you connected yourself. This account was connected by another user.',
      ErrorCodes.FORBIDDEN
    );
  }
}

/** Fetch BD account by id and organizationId or throw 404. Use to DRY "BD account not found" checks. */
export async function getAccountOr404<T = Record<string, unknown>>(
  pool: Pool,
  accountId: string,
  organizationId: string,
  columns = 'id, organization_id, telegram_id, phone_number, is_active, is_demo, connected_at, last_activity, created_at, sync_status, sync_progress_done, sync_progress_total, sync_error, created_by_user_id, first_name, last_name, username, bio, photo_file_id, display_name'
): Promise<T> {
  const r = await pool.query(
    `SELECT ${columns} FROM bd_accounts WHERE id = $1 AND organization_id = $2 LIMIT 1`,
    [accountId, organizationId]
  );
  if (r.rows.length === 0) {
    throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
  }
  return r.rows[0] as T;
}

export function isAccountOwnerName(
  account: { display_name?: string | null; username?: string | null; first_name?: string | null },
  title: string
): boolean {
  const t = (title || '').trim();
  if (!t) return false;
  const d = (account.display_name || '').trim();
  const u = (account.username || '').trim();
  const f = (account.first_name || '').trim();
  return Boolean((d && d === t) || (u && u === t) || (f && f === t));
}

export async function fetchFoldersFromTelegramAndSave(
  pool: Pool,
  telegramManager: TelegramManager,
  accountId: string
): Promise<{ id: string; folder_id: number; folder_title: string; order_index: number; is_user_created: boolean; icon: string | null }[]> {
  const filters = await telegramManager.getDialogFilters(accountId);
  const toSave: { folder_id: number; folder_title: string; icon: string | null }[] = [
    { folder_id: 0, folder_title: 'Все чаты', icon: '💬' },
    ...filters.map((f: { id: number; title: string; emoticon?: string | null }) => ({ folder_id: f.id, folder_title: f.title, icon: f.emoticon ?? null })),
  ];
  const seen = new Set<number>();
  const unique = toSave.filter((f) => {
    if (seen.has(f.folder_id)) return false;
    seen.add(f.folder_id);
    return true;
  });

  await pool.query('DELETE FROM bd_account_sync_folders WHERE bd_account_id = $1', [accountId]);
  for (let i = 0; i < unique.length; i++) {
    const f = unique[i];
    await pool.query(
      `INSERT INTO bd_account_sync_folders (bd_account_id, folder_id, folder_title, order_index, is_user_created, icon)
       VALUES ($1, $2, $3, $4, false, $5)`,
      [accountId, f.folder_id, (f.folder_title || '').trim().slice(0, 255) || `Папка ${f.folder_id}`, i, f.icon]
    );
  }

  const result = await pool.query(
    'SELECT id, folder_id, folder_title, order_index, COALESCE(is_user_created, false) AS is_user_created, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index, folder_id',
    [accountId]
  );
  return result.rows;
}

export async function ensureFoldersFromSyncChats(
  pool: Pool,
  telegramManager: TelegramManager,
  accountId: string,
  log?: Logger
): Promise<void> {
  const distinct = await pool.query(
    `SELECT DISTINCT folder_id FROM (
      SELECT folder_id FROM bd_account_sync_chat_folders WHERE bd_account_id = $1
      UNION
      SELECT folder_id FROM bd_account_sync_chats WHERE bd_account_id = $1 AND folder_id IS NOT NULL
    ) u ORDER BY folder_id`,
    [accountId]
  );
  if (distinct.rows.length === 0) return;

  const existing = await pool.query(
    'SELECT folder_id FROM bd_account_sync_folders WHERE bd_account_id = $1',
    [accountId]
  );
  const existingIds = new Set((existing.rows as FolderRow[]).map((r) => Number(r.folder_id)));

  let filtersByFolder: Map<number, { title: string; emoticon?: string }> = new Map();
  try {
    if (telegramManager.isConnected(accountId)) {
      const filters = await telegramManager.getDialogFilters(accountId);
      for (const f of filters) filtersByFolder.set(f.id, { title: f.title, emoticon: f.emoticon });
    }
  } catch (e) {
    if (log) log.warn({ message: 'Failed to load dialog filters for folder titles', accountId, error: String(e) });
  }

  const defaultTitles: Record<number, string> = { 0: 'Все чаты', 1: 'Архив' };
  const defaultIcons: Record<number, string> = { 0: '💬', 1: '📁' };

  let orderIndex = (await pool.query('SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM bd_account_sync_folders WHERE bd_account_id = $1', [accountId])).rows[0]?.next ?? 0;

  for (const row of distinct.rows) {
    const folderId = Number(row.folder_id);
    if (existingIds.has(folderId)) continue;

    const fromTg = filtersByFolder.get(folderId);
    const title = (fromTg?.title ?? defaultTitles[folderId] ?? `Папка ${folderId}`).trim().slice(0, 255) || `Папка ${folderId}`;
    const icon = fromTg?.emoticon ?? defaultIcons[folderId] ?? null;

    await pool.query(
      `INSERT INTO bd_account_sync_folders (bd_account_id, folder_id, folder_title, order_index, is_user_created, icon)
       VALUES ($1, $2, $3, $4, false, $5)
       ON CONFLICT (bd_account_id, folder_id) DO NOTHING`,
      [accountId, folderId, title, orderIndex, icon ?? null]
    );
    orderIndex++;
    existingIds.add(folderId);
  }
}

export async function refreshChatsFromFolders(
  pool: Pool,
  telegramManager: TelegramManager,
  accountId: string,
  log: Logger
): Promise<void> {
  const accRow = await pool.query(
    'SELECT organization_id, display_name, username, first_name, telegram_id FROM bd_accounts WHERE id = $1 LIMIT 1',
    [accountId]
  );
  const account = accRow.rows[0] as { organization_id?: string; display_name?: string | null; username?: string | null; first_name?: string | null; telegram_id?: string | null } | undefined;
  const organizationId = account?.organization_id;
  const foldersRows = await pool.query(
    'SELECT folder_id, folder_title FROM bd_account_sync_folders WHERE bd_account_id = $1 ORDER BY order_index',
    [accountId]
  );
  if (foldersRows.rows.length === 0) return;

  let allDialogs0: TelegramDialogLike[] = [];
  let allDialogs1: TelegramDialogLike[] = [];
  const folderRows = foldersRows.rows as { folder_id: number }[];
  const hasFolder0 = folderRows.some((r) => Number(r.folder_id) === 0);
  const hasFolder1 = folderRows.some((r) => Number(r.folder_id) === 1);
  if (hasFolder0 || folderRows.some((r) => Number(r.folder_id) >= 2)) {
    try {
      allDialogs0 = (await telegramManager.getDialogsAll(accountId, 0, { maxDialogs: 3000, delayEveryN: 100, delayMs: 600 })) as TelegramDialogLike[];
    } catch (err: unknown) {
      log.warn({ message: 'refreshChatsFromFolders getDialogsAll(0) failed', error: err instanceof Error ? err.message : String(err), entity_id: accountId });
    }
  }
  if (hasFolder1) {
    try {
      allDialogs1 = (await telegramManager.getDialogsAll(accountId, 1, { maxDialogs: 2000, delayEveryN: 100, delayMs: 600 })) as TelegramDialogLike[];
    } catch (err: unknown) {
      log.warn({ message: 'refreshChatsFromFolders getDialogsAll(1) failed', error: err instanceof Error ? err.message : String(err), entity_id: accountId });
    }
  }
  const mergedById = new Map<string, TelegramDialogLike>();
  for (const d of [...allDialogs0, ...allDialogs1]) {
    if (!mergedById.has(String(d.id))) mergedById.set(String(d.id), d);
  }
  const merged = Array.from(mergedById.values());

  for (const row of foldersRows.rows) {
    const folderId = Number((row as { folder_id: number }).folder_id);
    let dialogs: TelegramDialogLike[] = [];
    try {
      if (folderId === 0) dialogs = allDialogs0;
      else if (folderId === 1) dialogs = allDialogs1;
      else {
        const filterRaw = await telegramManager.getDialogFilterRaw(accountId, folderId);
        const { include: includePeerIds, exclude: excludePeerIds } = TelegramManager.getFilterIncludeExcludePeerIds(filterRaw);
        dialogs = merged.filter((d) => TelegramManager.dialogMatchesFilter({ ...d, id: String(d.id ?? '') }, filterRaw, includePeerIds, excludePeerIds));
      }
      for (const d of dialogs) {
        const chatId = String(d.id ?? '').trim();
        if (!chatId) continue;
        let peerType = 'user';
        if (d.isChannel) peerType = 'channel';
        else if (d.isGroup) peerType = 'chat';
        let title = (d.name ?? '').trim() || chatId;
        if (account && (isAccountOwnerName(account, title) || (peerType === 'user' && account.telegram_id != null && String(account.telegram_id) === chatId))) title = chatId;
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
             folder_id = COALESCE(bd_account_sync_chats.folder_id, EXCLUDED.folder_id)`,
          [accountId, chatId, title, peerType, folderId]
        );
        await pool.query(
          `INSERT INTO bd_account_sync_chat_folders (bd_account_id, telegram_chat_id, folder_id)
           VALUES ($1, $2, $3) ON CONFLICT (bd_account_id, telegram_chat_id, folder_id) DO NOTHING`,
          [accountId, chatId, folderId]
        );
        if (peerType === 'user' && organizationId) {
          try {
            await telegramManager.enrichContactFromDialog(organizationId, chatId, {
              firstName: d.first_name,
              lastName: d.last_name,
              username: d.username,
            });
          } catch (err: unknown) {
            log.warn({ message: 'enrichContactFromDialog failed', entity_id: chatId, error: err instanceof Error ? err.message : String(err) });
          }
        }
      }
    } catch (err: unknown) {
      log.warn({ message: `refreshChatsFromFolders folder ${folderId} failed`, entity_id: accountId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  const pinnedChatIds = allDialogs0.filter((d) => d.pinned === true).map((d) => String(d.id));
  if (pinnedChatIds.length > 0) {
    try {
      const acc = await pool.query(
        'SELECT created_by_user_id, organization_id FROM bd_accounts WHERE id = $1 LIMIT 1',
        [accountId]
      );
      if (acc.rows.length > 0) {
        const ownerId = acc.rows[0].created_by_user_id;
        const orgId = acc.rows[0].organization_id;
        if (ownerId) {
          await pool.query(
            `DELETE FROM user_chat_pins WHERE user_id = $1 AND organization_id = $2 AND bd_account_id = $3`,
            [ownerId, orgId, accountId]
          );
          for (let i = 0; i < pinnedChatIds.length; i++) {
            await pool.query(
              `INSERT INTO user_chat_pins (user_id, organization_id, bd_account_id, channel_id, order_index)
               VALUES ($1, $2, $3, $4, $5)
               ON CONFLICT (user_id, organization_id, bd_account_id, channel_id) DO UPDATE SET order_index = EXCLUDED.order_index`,
              [ownerId, orgId, accountId, pinnedChatIds[i], i]
            );
          }
          log.info({ message: `Synced ${pinnedChatIds.length} pinned chats from Telegram`, entity_id: accountId });
        }
      }
    } catch (err: unknown) {
      log.warn({ message: 'Sync pinned chats from Telegram failed', entity_id: accountId, error: err instanceof Error ? err.message : String(err) });
    }
  }

  log.info({ message: `Refreshed chats from ${foldersRows.rows.length} folders`, entity_id: accountId });
}
