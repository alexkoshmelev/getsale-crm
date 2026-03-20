import { apiClient } from '@/lib/api/client';
import { getApiBaseUrl } from '@/lib/api/public-api-base';
import type { BDAccount, BdSyncFolder } from '@/lib/types/bd-account';
import type { BdDialogsByFoldersResponse, SyncChatRow } from '@/lib/types/bd-connect';

export type { BDAccount, BdSyncFolder };
export interface BdProxyConfigInput {
  type: 'socks5' | 'http';
  host: string;
  port: number;
  username?: string;
  password?: string;
}

export async function listBdAccounts(): Promise<BDAccount[]> {
  const { data } = await apiClient.get<unknown>('/api/bd-accounts');
  return Array.isArray(data) ? (data as BDAccount[]) : [];
}

export async function getBdAccount(accountId: string): Promise<BDAccount> {
  const { data } = await apiClient.get<BDAccount>(`/api/bd-accounts/${accountId}`);
  return data;
}

export async function getBdAccountStatus(accountId: string): Promise<Partial<BDAccount>> {
  const { data } = await apiClient.get<Partial<BDAccount>>(`/api/bd-accounts/${accountId}/status`);
  return data;
}

/** Shape of GET /api/bd-accounts/:id/dialogs items. */
export interface BdAccountDialogRow {
  id: string;
  name: string;
  unreadCount?: number;
  lastMessage?: string;
  lastMessageDate?: string | null;
  isUser: boolean;
  isGroup: boolean;
  isChannel: boolean;
}

export async function getBdAccountDialogs(accountId: string): Promise<BdAccountDialogRow[]> {
  const { data } = await apiClient.get<BdAccountDialogRow[]>(`/api/bd-accounts/${accountId}/dialogs`);
  return Array.isArray(data) ? data : [];
}

export async function disconnectBdAccount(accountId: string): Promise<void> {
  await apiClient.post(`/api/bd-accounts/${accountId}/disconnect`);
}

export async function enableBdAccount(accountId: string): Promise<void> {
  await apiClient.post(`/api/bd-accounts/${accountId}/enable`);
}

export async function deleteBdAccount(accountId: string): Promise<void> {
  await apiClient.delete(`/api/bd-accounts/${accountId}`);
}

export async function patchBdAccount(accountId: string, body: Record<string, unknown>): Promise<BDAccount> {
  const { data } = await apiClient.patch<BDAccount>(`/api/bd-accounts/${accountId}`, body);
  return data;
}

/** Minimal row for pickers (id-only lists). */
export async function listBdAccountIds(): Promise<Array<{ id: string }>> {
  const { data } = await apiClient.get<Array<{ id: string }>>('/api/bd-accounts');
  return Array.isArray(data) ? data : [];
}

// ─── Sync / folders / drafts (messaging + bd detail) ─────────────────

export interface BdAccountSyncStatusResponse {
  sync_status?: string;
  sync_progress_total?: number;
  sync_progress_done?: number;
  sync_error?: string | null;
}

export async function listBdAccountSyncFolders(accountId: string): Promise<BdSyncFolder[]> {
  const { data } = await apiClient.get<unknown>(`/api/bd-accounts/${accountId}/sync-folders`);
  return Array.isArray(data) ? (data as BdSyncFolder[]) : [];
}

export async function getBdAccountSyncStatus(accountId: string): Promise<BdAccountSyncStatusResponse> {
  const { data } = await apiClient.get<BdAccountSyncStatusResponse>(`/api/bd-accounts/${accountId}/sync-status`);
  return data ?? {};
}

export async function startBdAccountSync(accountId: string, options?: { timeoutMs?: number }): Promise<void> {
  await apiClient.post(`/api/bd-accounts/${accountId}/sync-start`, {}, { timeout: options?.timeoutMs });
}

export async function saveBdAccountDraft(
  accountId: string,
  body: { channelId: string; text: string; replyToMsgId?: number }
): Promise<void> {
  await apiClient.post(`/api/bd-accounts/${accountId}/draft`, body);
}

export async function clearBdAccountDraft(accountId: string, channelId: string): Promise<void> {
  await saveBdAccountDraft(accountId, { channelId, text: '' });
}

export async function fetchBdAccountAvatarBlob(accountId: string): Promise<Blob | null> {
  try {
    const { data } = await apiClient.get<Blob>(`/api/bd-accounts/${accountId}/avatar`, { responseType: 'blob' });
    return data instanceof Blob && data.size > 0 ? data : null;
  } catch {
    return null;
  }
}

/** GET …/chats/:channelId/avatar — used by messaging / CRM / pipeline chat avatars (with blob URL cache in components). */
export async function fetchBdAccountChatAvatarBlob(accountId: string, channelId: string): Promise<Blob | null> {
  try {
    const { data } = await apiClient.get<Blob>(
      `/api/bd-accounts/${accountId}/chats/${channelId}/avatar`,
      { responseType: 'blob' }
    );
    return data instanceof Blob && data.size > 0 ? data : null;
  } catch {
    return null;
  }
}

export function isLikelyAvatarImageBlob(blob: Blob): boolean {
  return (
    blob.size > 0 &&
    (blob.type.startsWith('image/') || blob.type === 'application/octet-stream')
  );
}

export async function postBdAccountChatLoadOlderHistory(
  accountId: string,
  channelId: string
): Promise<{ added?: number; exhausted?: boolean }> {
  const { data } = await apiClient.post<{ added?: number; exhausted?: boolean }>(
    `/api/bd-accounts/${accountId}/chats/${channelId}/load-older-history`
  );
  return data ?? {};
}

export async function postBdAccountForward(
  accountId: string,
  body: { fromChatId: string; toChatId: string; telegramMessageId: number }
): Promise<void> {
  await apiClient.post(`/api/bd-accounts/${accountId}/forward`, body);
}

export async function deleteBdAccountChat(accountId: string, channelId: string): Promise<void> {
  await apiClient.delete(`/api/bd-accounts/${accountId}/chats/${channelId}`);
}

export async function patchBdAccountChatFolders(accountId: string, channelId: string, folderIds: number[]): Promise<void> {
  await apiClient.patch(`/api/bd-accounts/${accountId}/chats/${channelId}/folder`, { folder_ids: folderIds });
}

export async function createBdAccountCustomFolder(
  accountId: string,
  body: { folder_title: string; icon: string | null }
): Promise<BdSyncFolder> {
  const { data } = await apiClient.post<BdSyncFolder>(`/api/bd-accounts/${accountId}/sync-folders/custom`, body);
  return data as BdSyncFolder;
}

export async function reorderBdAccountSyncFolders(accountId: string, order: string[]): Promise<BdSyncFolder[]> {
  const { data } = await apiClient.patch<BdSyncFolder[]>(`/api/bd-accounts/${accountId}/sync-folders/order`, { order });
  return Array.isArray(data) ? data : [];
}

export async function patchBdAccountSyncFolder(
  accountId: string,
  folderRowId: string,
  body: { folder_title?: string; icon?: string | null }
): Promise<BdSyncFolder> {
  const { data } = await apiClient.patch<BdSyncFolder>(`/api/bd-accounts/${accountId}/sync-folders/${folderRowId}`, body);
  return data as BdSyncFolder;
}

export async function deleteBdAccountSyncFolder(accountId: string, folderRowId: string): Promise<void> {
  await apiClient.delete(`/api/bd-accounts/${accountId}/sync-folders/${folderRowId}`);
}

// ─── Connect wizard (phone / QR / select chats) ─────────────────────────

export const BD_ACCOUNT_DIALOGS_BY_FOLDERS_TIMEOUT_MS = 300_000;

export async function fetchBdAccountDialogsByFoldersRefresh(
  accountId: string,
  days: number,
  options?: { timeoutMs?: number; limit?: number }
): Promise<BdDialogsByFoldersResponse> {
  const limit = options?.limit ?? 1000;
  const qs = `refresh=1&limit=${limit}&days=${days}`;
  const { data } = await apiClient.get<BdDialogsByFoldersResponse>(
    `/api/bd-accounts/${accountId}/dialogs-by-folders?${qs}`,
    { timeout: options?.timeoutMs ?? BD_ACCOUNT_DIALOGS_BY_FOLDERS_TIMEOUT_MS }
  );
  return data ?? {};
}

export async function listBdAccountSyncChatsForConnect(accountId: string): Promise<SyncChatRow[]> {
  const { data } = await apiClient.get<unknown>(`/api/bd-accounts/${accountId}/sync-chats`);
  return Array.isArray(data) ? (data as SyncChatRow[]) : [];
}

export async function postBdAccountSendCode(body: {
  platform: string;
  phoneNumber: string;
  proxyConfig?: BdProxyConfigInput;
}): Promise<{ accountId: string; phoneCodeHash: string }> {
  const { data } = await apiClient.post<{ accountId: string; phoneCodeHash: string }>('/api/bd-accounts/send-code', body);
  return data;
}

export async function postBdAccountVerifyCode(body: {
  accountId: string;
  phoneNumber: string;
  phoneCode: string;
  phoneCodeHash: string;
  password?: string;
}): Promise<void> {
  await apiClient.post('/api/bd-accounts/verify-code', body);
}

export async function postBdAccountQrLoginPassword(body: { sessionId: string; password: string }): Promise<void> {
  await apiClient.post('/api/bd-accounts/qr-login-password', body);
}

export async function postBdAccountStartQrLogin(): Promise<{ sessionId: string }> {
  const { data } = await apiClient.post<{ sessionId: string }>('/api/bd-accounts/start-qr-login', {});
  return data;
}

export async function postBdAccountStartQrLoginWithProxy(body: {
  proxyConfig?: BdProxyConfigInput;
}): Promise<{ sessionId: string }> {
  const { data } = await apiClient.post<{ sessionId: string }>('/api/bd-accounts/start-qr-login', body);
  return data;
}

export interface BdQrLoginStatusResponse {
  status: string;
  loginTokenUrl?: string;
  accountId?: string;
  error?: string;
  passwordHint?: string;
}

export async function getBdAccountQrLoginStatus(sessionId: string): Promise<BdQrLoginStatusResponse> {
  const { data } = await apiClient.get<BdQrLoginStatusResponse>('/api/bd-accounts/qr-login-status', {
    params: { sessionId },
  });
  return data as BdQrLoginStatusResponse;
}

export type BdSyncChatSelectionPayload = {
  id: string;
  name: string;
  isUser: boolean;
  isGroup: boolean;
  isChannel: boolean;
  folderId?: number;
};

export async function saveBdAccountSyncChatsSelection(accountId: string, chats: BdSyncChatSelectionPayload[]): Promise<void> {
  await apiClient.post(`/api/bd-accounts/${accountId}/sync-chats`, { chats });
}

// ─── Discovery (Telegram search / resolve on a BD account) ───────────

export interface BdDiscoverySearchGroupItem {
  chatId: string;
  title: string;
  peerType: string;
  membersCount?: number;
  username?: string;
}

export type BdDiscoverySearchType = 'groups' | 'channels' | 'all';
export type BdDiscoverySearchMode = 'query' | 'hashtag';

export async function searchBdAccountTelegramGroups(
  bdAccountId: string,
  query: string,
  limit?: number,
  type: BdDiscoverySearchType = 'all',
  searchMode: BdDiscoverySearchMode = 'query'
): Promise<BdDiscoverySearchGroupItem[]> {
  const params = new URLSearchParams({ q: query.trim() });
  if (limit != null) params.set('limit', String(limit));
  params.set('type', type);
  if (searchMode === 'hashtag') params.set('searchMode', 'hashtag');
  const { data } = await apiClient.get<BdDiscoverySearchGroupItem[]>(
    `/api/bd-accounts/${bdAccountId}/search-groups?${params.toString()}`
  );
  return Array.isArray(data) ? data : [];
}

export async function listBdAccountAdminedPublicChannels(
  bdAccountId: string
): Promise<BdDiscoverySearchGroupItem[]> {
  const { data } = await apiClient.get<BdDiscoverySearchGroupItem[]>(
    `/api/bd-accounts/${bdAccountId}/admined-public-channels`
  );
  return Array.isArray(data) ? data : [];
}

export interface BdResolveChatsResultItem {
  chatId?: string;
  title?: string;
  peerType?: string;
  error?: string;
}

export async function resolveBdAccountChatInputs(
  bdAccountId: string,
  inputs: string[]
): Promise<{ results: BdResolveChatsResultItem[] }> {
  const { data } = await apiClient.post<{ results: BdResolveChatsResultItem[] }>(
    `/api/bd-accounts/${bdAccountId}/resolve-chats`,
    { inputs }
  );
  return data ?? { results: [] };
}

// ─── CRM / campaigns helpers hitting bd-accounts ─────────────────────

export async function enrichContactsViaBdAccounts(
  contactIds: string[],
  bdAccountId?: string
): Promise<{ enriched: number }> {
  const { data } = await apiClient.post<{ enriched: number }>('/api/bd-accounts/enrich-contacts', {
    contactIds,
    ...(bdAccountId ? { bdAccountId } : {}),
  });
  return data ?? { enriched: 0 };
}

export async function postBdAccountSendBulk(
  accountId: string,
  body: { channelIds: string[]; text: string }
): Promise<{ sent: number; failed: { channelId: string; error: string }[] }> {
  const { data } = await apiClient.post<{
    sent: number;
    failed: { channelId: string; error: string }[];
  }>(`/api/bd-accounts/${accountId}/send-bulk`, body);
  return data ?? { sent: 0, failed: [] };
}

/** Same-origin in browser; absolute base on server (SSR). */
export function getBdAccountMediaProxyUrl(
  bdAccountId: string,
  channelId: string,
  telegramMessageId: string
): string {
  const base = typeof window !== 'undefined' ? '' : getApiBaseUrl();
  const params = new URLSearchParams({ channelId, messageId: telegramMessageId });
  return `${base}/api/bd-accounts/${bdAccountId}/media?${params.toString()}`;
}
