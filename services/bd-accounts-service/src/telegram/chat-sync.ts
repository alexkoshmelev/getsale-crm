// @ts-nocheck — GramJS types are incomplete
import { getErrorMessage } from '../helpers';
import type { TelegramManagerDeps, TelegramClientInfo, StructuredLog, ResolvedSource, SearchResultChat } from './types';
import type { ContactManager } from './contact-manager';
import type { Pool } from 'pg';
import {
  searchGroupsByKeywordGlobal,
  searchPublicChannelsByKeywordGlobal,
  searchByContactsGlobal,
  getAdminedPublicChannelsGlobal,
} from './chat-sync-search';
import { getChannelParticipantsGlobal, getActiveParticipantsGlobal } from './chat-sync-participants';
import { getCommentGroupParticipantsGlobal } from './chat-sync-comment-participants';
import { getReactionContributorsGlobal } from './chat-sync-reaction-users';
import {
  resolveChatFromInputGlobal,
  enrichResolvedSourceFromBasic,
  resolvedSourceFromBasicInput,
} from './chat-sync-resolve';
import {
  mapDialogToItem,
  getDialogsGlobal,
  getDialogsAllGlobal,
  inputPeerToDialogIds,
  dialogIdToVariants,
  dialogMatchesFilter,
  getFilterIncludeExcludePeerIds,
  fetchDialogFiltersRaw,
  collectDialogFilterPeerIds,
  findDialogFilterRaw,
  formatDialogFiltersList,
  pushFoldersToTelegramGlobal,
  getDialogsByFolderGlobal,
} from './chat-sync-dialogs';
import { leaveChatGlobal, deleteMessageInTelegramGlobal } from './chat-sync-channel-actions';
import { createSharedChatGlobal } from './chat-sync-shared-chat';

export class ChatSync {
  private readonly pool: Pool;
  private readonly log: StructuredLog;
  private readonly clients: Map<string, TelegramClientInfo>;
  private readonly dialogFiltersCache: Map<string, { ts: number; filters: unknown[] }>;
  private readonly DIALOG_FILTERS_CACHE_TTL_MS = 90 * 1000;
  private contactManager!: ContactManager;

  constructor(private readonly deps: TelegramManagerDeps) {
    this.pool = deps.pool;
    this.log = deps.log;
    this.clients = deps.clients;
    this.dialogFiltersCache = deps.dialogFiltersCache;
  }

  setContactManager(cm: ContactManager): void {
    this.contactManager = cm;
  }

  static mapDialogToItem = mapDialogToItem;
  static inputPeerToDialogIds = inputPeerToDialogIds;
  static dialogIdToVariants = dialogIdToVariants;
  static dialogMatchesFilter = dialogMatchesFilter;
  static getFilterIncludeExcludePeerIds = getFilterIncludeExcludePeerIds;

  /**
   * Yields to the event loop every yieldEveryN dialogs so other accounts' update loops and keepalive can run (reduces TIMEOUT on other accounts).
   * Optional offsetDate (unix timestamp): only include dialogs whose last message is >= this date. We iterate from newest and stop when dialog date < offsetDate.
   */
  async getDialogsAll(
    accountId: string,
    folderId: number,
    options?: { maxDialogs?: number; delayEveryN?: number; delayMs?: number; yieldEveryN?: number; offsetDate?: number }
  ): Promise<any[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const client = clientInfo.client;
    return getDialogsAllGlobal(this.log, accountId, client, folderId, options, () =>
      getDialogsGlobal(this.log, accountId, client, folderId)
    );
  }

  async getDialogs(accountId: string, folderId?: number): Promise<any[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    return getDialogsGlobal(this.log, accountId, clientInfo.client, folderId);
  }

  async searchGroupsByKeyword(
    accountId: string,
    query: string,
    limit: number = 50,
    type: 'groups' | 'channels' | 'all' = 'all',
    maxPages: number = 10
  ): Promise<SearchResultChat[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    return searchGroupsByKeywordGlobal(this.log, accountId, clientInfo.client, query, limit, type, maxPages);
  }

  async searchPublicChannelsByKeyword(
    accountId: string,
    query: string,
    limit: number = 50,
    maxPages: number = 10,
    searchMode: 'query' | 'hashtag' = 'query'
  ): Promise<SearchResultChat[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    return searchPublicChannelsByKeywordGlobal(
      this.log,
      accountId,
      clientInfo.client,
      query,
      limit,
      maxPages,
      searchMode
    );
  }

  async searchByContacts(
    accountId: string,
    query: string,
    limit: number = 50
  ): Promise<SearchResultChat[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    return searchByContactsGlobal(this.log, accountId, clientInfo.client, query, limit);
  }

  async getAdminedPublicChannels(accountId: string): Promise<SearchResultChat[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    return getAdminedPublicChannelsGlobal(this.log, accountId, clientInfo.client);
  }

  async getChannelParticipants(
    accountId: string,
    channelId: string,
    offset: number,
    limit: number,
    excludeAdmins: boolean = false
  ): Promise<{ users: Array<{ telegram_id: string; username?: string; first_name?: string; last_name?: string }>; nextOffset: number | null }> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    return getChannelParticipantsGlobal(
      this.log,
      accountId,
      clientInfo.client,
      channelId,
      offset,
      limit,
      excludeAdmins
    );
  }

  async getActiveParticipants(
    accountId: string,
    chatId: string,
    depth: number,
    excludeAdmins: boolean = false
  ): Promise<{ users: Array<{ telegram_id: string; username?: string; first_name?: string; last_name?: string }> }> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    return getActiveParticipantsGlobal(this.log, accountId, clientInfo.client, chatId, depth, excludeAdmins);
  }

  async getCommentGroupParticipants(
    accountId: string,
    channelId: string,
    linkedChatId: string,
    options?: { postLimit?: number; maxRepliesPerPost?: number; excludeAdmins?: boolean }
  ): Promise<{ users: Array<{ telegram_id: string; username?: string; first_name?: string; last_name?: string }> }> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    return getCommentGroupParticipantsGlobal(
      this.log,
      accountId,
      clientInfo.client,
      channelId,
      linkedChatId,
      options ?? {}
    );
  }

  async getReactionContributors(
    accountId: string,
    chatId: string,
    options?: { historyLimit?: number }
  ): Promise<{ users: Array<{ telegram_id: string; username?: string; first_name?: string; last_name?: string }> }> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    return getReactionContributorsGlobal(this.log, accountId, clientInfo.client, chatId, options ?? {});
  }

  async leaveChat(accountId: string, chatId: string): Promise<void> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    return leaveChatGlobal(this.log, accountId, clientInfo.client, chatId);
  }

  async resolveChatFromInput(
    accountId: string,
    input: string
  ): Promise<{ chatId: string; title: string; peerType: string }> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    return resolveChatFromInputGlobal(this.log, accountId, clientInfo.client, input);
  }

  async resolveSourceFromInput(accountId: string, input: string): Promise<ResolvedSource> {
    const basic = await this.resolveChatFromInput(accountId, input);
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo?.isConnected) {
      return resolvedSourceFromBasicInput(basic, input);
    }
    return enrichResolvedSourceFromBasic(this.log, accountId, clientInfo.client, input, basic);
  }

  private async getDialogFiltersRaw(accountId: string): Promise<any[]> {
    return fetchDialogFiltersRaw(this.clients, this.dialogFiltersCache, this.DIALOG_FILTERS_CACHE_TTL_MS, accountId);
  }

  async getDialogFilterPeerIds(accountId: string, filterId: number): Promise<Set<string>> {
    const filters = await this.getDialogFiltersRaw(accountId);
    return collectDialogFilterPeerIds(filters, filterId);
  }

  async getDialogFilterRaw(accountId: string, filterId: number): Promise<any | null> {
    const filters = await this.getDialogFiltersRaw(accountId);
    return findDialogFilterRaw(filters, filterId);
  }

  async getDialogFilters(accountId: string): Promise<{ id: number; title: string; isCustom: boolean; emoticon?: string }[]> {
    try {
      const filters = await this.getDialogFiltersRaw(accountId);
      return formatDialogFiltersList(filters);
    } catch (error: any) {
      this.log.error({ message: `Error getting dialog filters for ${accountId}`, error: error?.message || String(error) });
      throw error;
    }
  }

  async pushFoldersToTelegram(accountId: string): Promise<{ updated: number; errors: string[] }> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    return pushFoldersToTelegramGlobal(this.pool, clientInfo.client, accountId);
  }

  async getDialogsByFolder(accountId: string, folderId: number): Promise<any[]> {
    return getDialogsByFolderGlobal(accountId, folderId, {
      getDialogsAll: (a, f, o) => this.getDialogsAll(a, f, o),
      getDialogFilterRaw: (a, f) => this.getDialogFilterRaw(a, f),
    });
  }

  async tryAddChatFromSelectedFolders(accountId: string, chatId: string): Promise<boolean> {
    const foldersRows = await this.pool.query(
      'SELECT folder_id FROM bd_account_sync_folders WHERE bd_account_id = $1 LIMIT 1',
      [accountId]
    );
    if (foldersRows.rows.length === 0) return false;

    const clientInfo = this.clients.get(accountId);
    if (!clientInfo?.isConnected) return false;

    const accRow = await this.pool.query(
      'SELECT organization_id, display_name, username, first_name FROM bd_accounts WHERE id = $1 LIMIT 1',
      [accountId]
    );
    const row = accRow.rows[0] as
      | { organization_id?: string; display_name?: string | null; username?: string | null; first_name?: string | null }
      | undefined;
    const organizationId = row?.organization_id;
    const account = row;

    let title = chatId;
    let peerType = 'user';
    const isAccountName = (t: string) => {
      const s = (t || '').trim();
      if (!s) return false;
      const d = (account?.display_name || '').trim();
      const u = (account?.username || '').trim();
      const f = (account?.first_name || '').trim();
      return (d && d === s) || (u && u === s) || (f && f === s);
    };
    try {
      const peerIdNum = Number(chatId);
      const peerInput = Number.isNaN(peerIdNum) ? chatId : peerIdNum;
      const peer = await clientInfo.client.getInputEntity(peerInput);
      const entity = await clientInfo.client.getEntity(peer);
      if (entity) {
        const c = (entity as any).className;
        if (c === 'User') {
          const u = entity as any;
          title = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || title;
          if (account && isAccountName(title)) title = chatId;
          peerType = 'user';
          if (organizationId && this.contactManager) {
            await this.contactManager.upsertContactFromTelegramUser(organizationId, chatId, {
              firstName: (u.firstName ?? '').trim(),
              lastName: (u.lastName ?? '').trim() || null,
              username: (u.username ?? '').trim() || null,
            });
          }
        } else if (c === 'Chat') {
          title = (entity as any).title?.trim() || title;
          if (account && isAccountName(title)) title = chatId;
          peerType = 'chat';
        } else if (c === 'Channel') {
          title = (entity as any).title?.trim() || title;
          if (account && isAccountName(title)) title = chatId;
          peerType = 'channel';
        }
      }
    } catch (err: unknown) {
      const em = getErrorMessage(err);
      if (em !== 'TIMEOUT' && !em.includes('builder.resolve')) {
        this.log.warn({ message: `tryAddChatFromSelectedFolders getEntity ${chatId}`, error: em });
      }
      return false;
    }

    const folderId = 0;
    await this.pool.query(
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
    await this.pool.query(
      `INSERT INTO bd_account_sync_chat_folders (bd_account_id, telegram_chat_id, folder_id)
       VALUES ($1, $2, $3) ON CONFLICT (bd_account_id, telegram_chat_id, folder_id) DO NOTHING`,
      [accountId, chatId, folderId]
    );
    this.log.info({ message: `Auto-added chat ${chatId} (${title}) for account ${accountId} via getEntity` });
    return true;
  }

  async createSharedChat(
    accountId: string,
    params: { title: string; leadTelegramUserId?: number; leadUsername?: string; extraUsernames?: string[] }
  ): Promise<{ channelId: string; title: string; inviteLink?: string; accessHash?: string }> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo?.isConnected || !clientInfo.client) {
      throw new Error('BD account not connected');
    }
    return createSharedChatGlobal(this.log, accountId, clientInfo.client, params);
  }

  async deleteMessageInTelegram(accountId: string, channelId: string, telegramMessageId: number): Promise<void> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo?.client) throw new Error('Account not connected');
    return deleteMessageInTelegramGlobal(clientInfo.client, channelId, telegramMessageId);
  }
}
