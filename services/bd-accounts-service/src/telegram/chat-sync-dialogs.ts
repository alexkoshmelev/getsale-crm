// @ts-nocheck — GramJS types are incomplete
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import type { Pool } from 'pg';
import { getErrorMessage } from '../helpers';
import type { StructuredLog, TelegramClientInfo } from './types';

export function mapDialogToItem(dialog: any): any {
  const pinned = !!(dialog.pinned ?? dialog.dialog?.pinned);
  const entity = dialog.entity;
  const isUser = dialog.isUser ?? (entity && (entity.className === 'User' || entity.constructor?.className === 'User'));
  let first_name: string | undefined;
  let last_name: string | null | undefined;
  let username: string | null | undefined;
  if (entity && isUser) {
    first_name = (entity.firstName ?? entity.first_name ?? '').trim() || undefined;
    last_name = (entity.lastName ?? entity.last_name ?? '').trim() || null;
    username = (entity.username ?? '').trim() || null;
  }
  return {
    id: String(dialog.id),
    name: dialog.name || dialog.title || 'Unknown',
    unreadCount: dialog.unreadCount || 0,
    lastMessage: dialog.message?.text || '',
    lastMessageDate: dialog.message?.date,
    isUser: dialog.isUser ?? !!isUser,
    isGroup: dialog.isGroup,
    isChannel: dialog.isChannel,
    pinned,
    ...(isUser && { first_name, last_name, username }),
  };
}

export async function getDialogsGlobal(
  log: StructuredLog,
  accountId: string,
  client: TelegramClient,
  folderId?: number
): Promise<any[]> {
  try {
    const opts: { limit: number; folderId?: number } = { limit: 100 };
    if (folderId !== undefined && folderId !== null) {
      opts.folderId = folderId;
    }
    const dialogs = await client.getDialogs(opts);
    const mapped = dialogs.map((dialog: any) => mapDialogToItem(dialog));
    return mapped.filter((d: any) => d.isUser || d.isGroup);
  } catch (error: any) {
    log.error({ message: `Error getting dialogs for ${accountId}`, error: error?.message || String(error) });
    throw error;
  }
}

/**
 * Iterative dialogs with optional date cutoff; falls back to simple getDialogs when iterDialogs missing.
 */
export async function getDialogsAllGlobal(
  log: StructuredLog,
  accountId: string,
  client: TelegramClient,
  folderId: number,
  options: { maxDialogs?: number; delayEveryN?: number; delayMs?: number; yieldEveryN?: number; offsetDate?: number } | undefined,
  fallbackGetDialogs: () => Promise<any[]>
): Promise<any[]> {
  const maxDialogs = options?.maxDialogs ?? 3000;
  const delayEveryN = options?.delayEveryN ?? 100;
  const delayMs = options?.delayMs ?? 600;
  const yieldEveryN = options?.yieldEveryN ?? 25;
  const minActivityDate = options?.offsetDate;
  const result: any[] = [];
  let count = 0;
  const c = client as any;
  if (typeof c.iterDialogs !== 'function') {
    return fallbackGetDialogs();
  }
  try {
    const iter = c.iterDialogs({ folder: folderId, limit: maxDialogs });
    for await (const dialog of iter) {
      if (minActivityDate != null) {
        const msgDate = dialog.message?.date;
        const msgDateSec =
          typeof msgDate === 'number'
            ? msgDate > 1e10
              ? Math.floor(msgDate / 1000)
              : msgDate
            : msgDate instanceof Date
              ? Math.floor(msgDate.getTime() / 1000)
              : 0;
        if (msgDateSec > 0 && msgDateSec < minActivityDate) break;
      }
      if (dialog.isUser || dialog.isGroup) {
        result.push(mapDialogToItem(dialog));
        count++;
        if (count % delayEveryN === 0 && count < maxDialogs) {
          await new Promise((r) => setTimeout(r, delayMs));
        }
        if (count % yieldEveryN === 0) {
          await new Promise<void>((r) => setImmediate(r));
        }
      }
      if (count >= maxDialogs) break;
    }
    log.info({ message: `getDialogsAll folder=${folderId} fetched ${result.length} dialogs` });
    return result;
  } catch (error: unknown) {
    const msg = getErrorMessage(error);
    if (msg === 'TIMEOUT' || msg.includes('TIMEOUT')) throw error;
    log.error({ message: `Error getDialogsAll for ${accountId} folder ${folderId}`, error: msg });
    throw error;
  }
}

export function inputPeerToDialogIds(peer: any, out: Set<string>): void {
  if (!peer) return;
  const c = String(peer.className ?? peer.constructor?.className ?? '').toLowerCase();
  const userId = peer.userId ?? peer.user_id;
  const chatId = peer.chatId ?? peer.chat_id;
  const channelId = peer.channelId ?? peer.channel_id;
  if (c === 'inputpeeruser' && userId != null) {
    out.add(String(userId));
    return;
  }
  if (c === 'inputpeerchat' && chatId != null) {
    const n = Number(chatId);
    out.add(String(n));
    out.add(String(-n));
    return;
  }
  if (c === 'inputpeerchannel' && channelId != null) {
    const n = Number(channelId);
    out.add(String(n));
    out.add(String(-n));
    out.add(String(-1000000000 - n));
    out.add(String(-1000000000000 - n));
    return;
  }
}

export function dialogIdToVariants(dialogId: string | number): Set<string> {
  const s = String(dialogId).trim();
  const n = Number(s);
  const out = new Set<string>([s]);
  if (!Number.isNaN(n)) {
    out.add(String(n));
    out.add(String(-n));
    if (n > 0 && n < 1000000000) {
      out.add(String(-1000000000 - n));
      out.add(String(-1000000000000 - n));
    }
    if (n < -1000000000) {
      const channelId = -(n + 1000000000);
      if (Number.isInteger(channelId)) out.add(String(channelId));
      const channelIdAlt = -(n + 1000000000000);
      if (Number.isInteger(channelIdAlt)) out.add(String(channelIdAlt));
    }
  }
  return out;
}

export function dialogMatchesFilter(
  dialog: { id: string; isUser?: boolean; isGroup?: boolean; isChannel?: boolean },
  filterRaw: any,
  includePeerIds: Set<string>,
  excludePeerIds: Set<string>
): boolean {
  if (!filterRaw) return false;
  const variants = dialogIdToVariants(dialog.id);
  for (const v of variants) {
    if (excludePeerIds.has(v)) return false;
  }
  for (const v of variants) {
    if (includePeerIds.has(v)) return true;
  }
  const contacts = !!(filterRaw.contacts === true);
  const non_contacts = !!(filterRaw.non_contacts === true);
  const groups = !!(filterRaw.groups === true);
  const broadcasts = !!(filterRaw.broadcasts === true);
  const bots = !!(filterRaw.bots === true);
  const isUser = !!dialog.isUser;
  const isGroup = !!dialog.isGroup;
  const isChannel = !!dialog.isChannel;
  if ((contacts || non_contacts || bots) && isUser) return true;
  if (groups && isGroup) return true;
  if (broadcasts && isChannel) return true;
  return false;
}

export function getFilterIncludeExcludePeerIds(filterRaw: any): { include: Set<string>; exclude: Set<string> } {
  const include = new Set<string>();
  const exclude = new Set<string>();
  if (!filterRaw) return { include, exclude };
  const pinned = filterRaw.pinned_peers ?? filterRaw.pinnedPeers ?? [];
  const included = filterRaw.include_peers ?? filterRaw.includePeers ?? [];
  const excluded = filterRaw.exclude_peers ?? filterRaw.excludePeers ?? [];
  for (const p of [...pinned, ...included]) {
    inputPeerToDialogIds(p, include);
  }
  for (const p of excluded) {
    inputPeerToDialogIds(p, exclude);
  }
  return { include, exclude };
}

export async function fetchDialogFiltersRaw(
  clients: Map<string, TelegramClientInfo>,
  dialogFiltersCache: Map<string, { ts: number; filters: unknown[] }>,
  ttlMs: number,
  accountId: string
): Promise<any[]> {
  const now = Date.now();
  const cached = dialogFiltersCache.get(accountId);
  if (cached && now - cached.ts < ttlMs) {
    return cached.filters as any[];
  }
  const clientInfo = clients.get(accountId);
  if (!clientInfo || !clientInfo.isConnected) {
    throw new Error(`Account ${accountId} is not connected`);
  }
  const result = await clientInfo.client.invoke(new Api.messages.GetDialogFilters({}));
  const filters = (result as any).filters ?? [];
  dialogFiltersCache.set(accountId, { ts: now, filters });
  return filters;
}

export function collectDialogFilterPeerIds(filters: any[], filterId: number): Set<string> {
  const f = filters.find((x: any) => (x.id ?? -1) === filterId);
  if (!f) return new Set();
  const ids = new Set<string>();
  const pinned = f.pinned_peers ?? f.pinnedPeers ?? [];
  const included = f.include_peers ?? f.includePeers ?? [];
  const peers = [...pinned, ...included];
  for (const p of peers) {
    inputPeerToDialogIds(p, ids);
  }
  return ids;
}

export function findDialogFilterRaw(filters: any[], filterId: number): any | null {
  return filters.find((x: any) => (x.id ?? -1) === filterId) ?? null;
}

export function formatDialogFiltersList(
  filters: any[]
): { id: number; title: string; isCustom: boolean; emoticon?: string }[] {
  const list: { id: number; title: string; isCustom: boolean; emoticon?: string }[] = [];
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i];
    const id = f.id ?? i;
    const rawTitle = typeof f.title === 'string' ? f.title : (f.title?.text ?? '');
    const title =
      (typeof rawTitle === 'string' ? rawTitle : String(rawTitle)).trim() ||
      (id === 0 ? 'Все чаты' : id === 1 ? 'Архив' : `Папка ${id}`);
    const emoticon = typeof f.emoticon === 'string' && f.emoticon.trim() ? f.emoticon.trim() : undefined;
    list.push({ id, title, isCustom: id >= 2, emoticon });
  }
  return list;
}

export async function pushFoldersToTelegramGlobal(
  pool: Pool,
  client: TelegramClient,
  accountId: string
): Promise<{ updated: number; errors: string[] }> {
  const errors: string[] = [];
  let updated = 0;

  const foldersRows = await pool.query(
    'SELECT id, folder_id, folder_title, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 AND folder_id >= 2 ORDER BY order_index',
    [accountId]
  );
  if (foldersRows.rows.length === 0) {
    return { updated: 0, errors: [] };
  }

  for (const row of foldersRows.rows) {
    const folderId = Number(row.folder_id);
    const title = String(row.folder_title || '').trim() || `Folder ${folderId}`;
    const emoticon = row.icon && String(row.icon).trim() ? String(row.icon).trim().slice(0, 4) : undefined;

    const chatsRows = await pool.query(
      'SELECT telegram_chat_id FROM bd_account_sync_chat_folders WHERE bd_account_id = $1 AND folder_id = $2',
      [accountId, folderId]
    );
    const includePeers: any[] = [];
    for (const c of chatsRows.rows) {
      const tid = String(c.telegram_chat_id || '').trim();
      if (!tid) continue;
      try {
        const peerIdNum = Number(tid);
        const peerInput = Number.isNaN(peerIdNum) ? tid : peerIdNum;
        const peer = await client.getInputEntity(peerInput);
        includePeers.push(new Api.InputDialogPeer({ peer }));
      } catch (e: unknown) {
        errors.push(`Chat ${tid}: ${getErrorMessage(e)}`);
      }
    }

    try {
      const filter = new Api.DialogFilter({
        id: folderId,
        title,
        emoticon: emoticon || '',
        pinnedPeers: [],
        includePeers: includePeers,
        excludePeers: [],
        contacts: false,
        nonContacts: false,
        groups: false,
        broadcasts: false,
        bots: false,
      });
      await client.invoke(new Api.messages.UpdateDialogFilter({ id: folderId, filter }));
      updated += 1;
    } catch (e: unknown) {
      if (getErrorMessage(e).includes('includePeers') || getErrorMessage(e).includes('include_peers')) {
        try {
          const filterAlt = new (Api as any).DialogFilter({
            id: folderId,
            title,
            emoticon: emoticon || '',
            pinned_peers: [],
            include_peers: includePeers,
            exclude_peers: [],
            contacts: false,
            non_contacts: false,
            groups: false,
            broadcasts: false,
            bots: false,
          });
          await client.invoke(new Api.messages.UpdateDialogFilter({ id: folderId, filter: filterAlt }));
          updated += 1;
        } catch (e2: any) {
          errors.push(`Folder "${title}" (id=${folderId}): ${e2?.message || String(e2)}`);
        }
      } else {
        const msg = getErrorMessage(e);
        errors.push(`Folder "${title}" (id=${folderId}): ${msg}`);
      }
    }
  }
  return { updated, errors };
}

export type GetDialogsByFolderDeps = {
  getDialogsAll: (
    accountId: string,
    folderId: number,
    options?: { maxDialogs?: number; delayEveryN?: number; delayMs?: number; yieldEveryN?: number; offsetDate?: number }
  ) => Promise<any[]>;
  getDialogFilterRaw: (accountId: string, filterId: number) => Promise<any | null>;
};

export async function getDialogsByFolderGlobal(
  accountId: string,
  folderId: number,
  deps: GetDialogsByFolderDeps
): Promise<any[]> {
  if (folderId === 0) {
    return deps.getDialogsAll(accountId, 0, { maxDialogs: 3000, delayEveryN: 100, delayMs: 600 });
  }
  if (folderId === 1) {
    return deps.getDialogsAll(accountId, 1, { maxDialogs: 2000, delayEveryN: 100, delayMs: 600 }).catch(() => []);
  }
  const [all0, all1] = await Promise.all([
    deps.getDialogsAll(accountId, 0, { maxDialogs: 3000, delayEveryN: 100, delayMs: 600 }),
    deps.getDialogsAll(accountId, 1, { maxDialogs: 2000, delayEveryN: 100, delayMs: 600 }).catch(() => []),
  ]);
  const mergedById = new Map<string, any>();
  for (const d of [...all0, ...all1]) {
    if (!mergedById.has(String(d.id))) mergedById.set(String(d.id), d);
  }
  const merged = Array.from(mergedById.values());
  const filterRaw = await deps.getDialogFilterRaw(accountId, folderId);
  const { include: includePeerIds, exclude: excludePeerIds } = getFilterIncludeExcludePeerIds(filterRaw);
  return merged.filter((d: any) => dialogMatchesFilter(d, filterRaw, includePeerIds, excludePeerIds));
}
