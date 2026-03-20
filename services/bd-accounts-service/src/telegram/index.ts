import { Pool } from 'pg';
import type { Counter } from 'prom-client';
import { ServiceHttpClient } from '@getsale/service-core';
import { RabbitMQClient, RedisClient } from '@getsale/utils';
import { Logger } from '@getsale/logger';
import { randomUUID } from 'crypto';
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';

import type {
  TelegramManagerDeps,
  TelegramClientInfo,
  QrLoginState,
  QrSessionInternal,
  ResolvedSource,
  ProxyConfig,
} from './types';
import { formatLogArgs } from './helpers';
import { ConnectionManager } from './connection-manager';
import { SessionManager } from './session-manager';
import { AuthHandler } from './auth';
import { QrLogin } from './qr-login';
import { EventHandlerSetup } from './event-handlers';
import { MessageHandler } from './message-handler';
import { MessageDb } from './message-db';
import { ContactManager } from './contact-manager';
import { MessageSync } from './message-sync';
import { ChatSync } from './chat-sync';
import { dialogMatchesFilter, getFilterIncludeExcludePeerIds } from './chat-sync-dialogs';
import { MessageSender } from './message-sender';
import { FileHandler } from './file-handler';
import { ReactionHandler } from './reaction-handler';

export type { TelegramSourceType, ResolvedSource, QrLoginState } from './types';

/**
 * Facade that provides the same public API as the original monolithic TelegramManager,
 * delegating to focused sub-modules.
 */
export class TelegramManager {
  private readonly deps: TelegramManagerDeps;

  private readonly connectionManager: ConnectionManager;
  private readonly sessionManager: SessionManager;
  private readonly authHandler: AuthHandler;
  private readonly qrLogin: QrLogin;
  private readonly eventHandlerSetup: EventHandlerSetup;
  private readonly messageHandler: MessageHandler;
  private readonly messageDb: MessageDb;
  private readonly contactManager: ContactManager;
  private readonly messageSync: MessageSync;
  private readonly chatSync: ChatSync;
  private readonly messageSender: MessageSender;
  private readonly fileHandler: FileHandler;
  private readonly reactionHandler: ReactionHandler;

  constructor(
    pool: Pool,
    rabbitmq: RabbitMQClient,
    redis?: RedisClient | null,
    logger?: Logger,
    messagingClient?: ServiceHttpClient | null,
    messageDbSqlBypassCounter?: Counter | null
  ) {
    const svcLog: Logger = logger ?? { info() {}, warn() {}, error() {} } as Logger;
    const log = {
      info: (...args: unknown[]) => svcLog.info({ message: formatLogArgs(...args) }),
      error: (...args: unknown[]) => svcLog.error({ message: formatLogArgs(...args) }),
      warn: (...args: unknown[]) => svcLog.warn({ message: formatLogArgs(...args) }),
    };

    this.deps = {
      pool,
      rabbitmq,
      redis: redis ?? null,
      log,
      instanceId: process.env.INSTANCE_ID || `pid-${process.pid}-${randomUUID().slice(0, 8)}`,
      clients: new Map<string, TelegramClientInfo>(),
      qrSessions: new Map<string, QrSessionInternal>(),
      reconnectIntervals: new Map<string, NodeJS.Timeout>(),
      updateKeepaliveIntervals: new Map<string, NodeJS.Timeout>(),
      lockHeartbeatIntervals: new Map<string, NodeJS.Timeout>(),
      dialogFiltersCache: new Map<string, { ts: number; filters: unknown[] }>(),
    };

    // Instantiate sub-modules (messagingClient => messages/conversations via messaging-service API, A1)
    this.connectionManager = new ConnectionManager(this.deps);
    this.sessionManager = new SessionManager(this.deps);
    this.authHandler = new AuthHandler(this.deps);
    this.qrLogin = new QrLogin(this.deps);
    this.eventHandlerSetup = new EventHandlerSetup(this.deps);
    this.messageDb = new MessageDb(pool, log, messagingClient ?? null, messageDbSqlBypassCounter ?? null);
    this.contactManager = new ContactManager(this.deps);
    this.messageHandler = new MessageHandler(this.deps);
    this.messageSync = new MessageSync(this.deps);
    this.chatSync = new ChatSync(this.deps);
    this.messageSender = new MessageSender(this.deps);
    this.fileHandler = new FileHandler(this.deps);
    this.reactionHandler = new ReactionHandler(this.deps);

    // Wire cross-dependencies
    this.connectionManager.setSessionManager(this.sessionManager);
    this.connectionManager.setEventHandlerSetup(this.eventHandlerSetup);
    this.authHandler.setConnectionManager(this.connectionManager);
    this.authHandler.setSessionManager(this.sessionManager);
    this.authHandler.setEventHandlerSetup(this.eventHandlerSetup);
    this.qrLogin.setConnectionManager(this.connectionManager);
    this.eventHandlerSetup.setMessageHandler(this.messageHandler);
    this.eventHandlerSetup.setMessageDb(this.messageDb);
    this.eventHandlerSetup.setConnectionManager(this.connectionManager);
    this.messageHandler.setContactManager(this.contactManager);
    this.messageHandler.setMessageDb(this.messageDb);
    this.messageSync.setContactManager(this.contactManager);
    this.messageSync.setMessageDb(this.messageDb);
    this.chatSync.setContactManager(this.contactManager);

    // Start intervals
    this.connectionManager.startCleanupInterval();
    this.sessionManager.startSessionSaveInterval();
  }

  // --- Connection lifecycle ---
  async connectAccount(
    accountId: string, organizationId: string, userId: string,
    phoneNumber: string, apiId: number, apiHash: string, sessionString?: string
  ): Promise<TelegramClient> {
    return this.connectionManager.connectAccount(accountId, organizationId, userId, phoneNumber, apiId, apiHash, sessionString);
  }
  async disconnectAccount(accountId: string): Promise<void> { return this.connectionManager.disconnectAccount(accountId); }
  getClientInfo(accountId: string): TelegramClientInfo | undefined { return this.connectionManager.getClientInfo(accountId); }
  isConnected(accountId: string): boolean { return this.connectionManager.isConnected(accountId); }
  scheduleReconnectAllAfterTimeout(): void { this.connectionManager.scheduleReconnectAllAfterTimeout(); }
  async initializeActiveAccounts(): Promise<void> { return this.connectionManager.initializeActiveAccounts(); }

  // --- Auth (phone code flow) ---
  async sendCode(
    accountId: string, organizationId: string, userId: string,
    phoneNumber: string, apiId: number, apiHash: string, proxyConfigRaw?: ProxyConfig | null
  ): Promise<{ phoneCodeHash: string }> {
    return this.authHandler.sendCode(accountId, organizationId, userId, phoneNumber, apiId, apiHash, proxyConfigRaw);
  }
  async signIn(accountId: string, phoneNumber: string, phoneCode: string, phoneCodeHash: string): Promise<{ requiresPassword: boolean }> {
    return this.authHandler.signIn(accountId, phoneNumber, phoneCode, phoneCodeHash);
  }
  async signInWithPassword(accountId: string, password: string): Promise<void> {
    return this.authHandler.signInWithPassword(accountId, password);
  }

  // --- QR login ---
  async startQrLogin(organizationId: string, userId: string, apiId: number, apiHash: string, proxyConfigRaw?: ProxyConfig | null): Promise<{ sessionId: string }> {
    return this.qrLogin.startQrLogin(organizationId, userId, apiId, apiHash, proxyConfigRaw);
  }
  async getQrLoginStatus(sessionId: string): Promise<QrLoginState | null> { return this.qrLogin.getQrLoginStatus(sessionId); }
  async submitQrLoginPassword(sessionId: string, password: string): Promise<boolean> { return this.qrLogin.submitQrLoginPassword(sessionId, password); }

  // --- Session & profile ---
  async saveAccountProfile(accountId: string, client: TelegramClient): Promise<void> { return this.sessionManager.saveAccountProfile(accountId, client); }

  // --- Contacts ---
  async enrichContactFromDialog(organizationId: string, telegramId: string, userInfo?: { firstName?: string; lastName?: string | null; username?: string | null }): Promise<void> {
    return this.contactManager.enrichContactFromDialog(organizationId, telegramId, userInfo);
  }
  async enrichContactsFromTelegram(organizationId: string, contactIds: string[], bdAccountId?: string): Promise<{ enriched: number }> {
    return this.contactManager.enrichContactsFromTelegram(organizationId, contactIds, bdAccountId);
  }
  async enrichContactsForAccountSyncChats(organizationId: string, accountId: string, opts?: { delayMs?: number }): Promise<{ enriched: number }> {
    return this.contactManager.enrichContactsForAccountSyncChats(organizationId, accountId, opts);
  }

  // --- Message sync ---
  async syncHistory(accountId: string, organizationId: string, onProgress?: (done: number, total: number, currentChatId?: string, currentChatTitle?: string) => void): Promise<{ totalChats: number; totalMessages: number }> {
    return this.messageSync.syncHistory(accountId, organizationId, onProgress);
  }
  async syncHistoryForChat(accountId: string, organizationId: string, chatId: string): Promise<{ messagesCount: number }> {
    return this.messageSync.syncHistoryForChat(accountId, organizationId, chatId);
  }
  async fetchOlderMessagesFromTelegram(accountId: string, organizationId: string, chatId: string): Promise<{ added: number; exhausted: boolean }> {
    return this.messageSync.fetchOlderMessagesFromTelegram(accountId, organizationId, chatId);
  }

  // --- Chat sync / dialogs ---
  async getDialogsAll(accountId: string, folderId: number, options?: { maxDialogs?: number; delayEveryN?: number; delayMs?: number; yieldEveryN?: number; offsetDate?: number }): Promise<unknown[]> {
    return this.chatSync.getDialogsAll(accountId, folderId, options);
  }
  async getDialogs(accountId: string, folderId?: number): Promise<unknown[]> { return this.chatSync.getDialogs(accountId, folderId); }
  async searchGroupsByKeyword(accountId: string, query: string, limit?: number, type?: 'groups' | 'channels' | 'all', maxPages?: number) {
    return this.chatSync.searchGroupsByKeyword(accountId, query, limit, type, maxPages);
  }
  async searchPublicChannelsByKeyword(accountId: string, query: string, limit?: number, maxPages?: number, searchMode?: 'query' | 'hashtag') {
    return this.chatSync.searchPublicChannelsByKeyword(accountId, query, limit, maxPages, searchMode);
  }
  async searchByContacts(accountId: string, query: string, limit?: number) { return this.chatSync.searchByContacts(accountId, query, limit); }
  async getAdminedPublicChannels(accountId: string) { return this.chatSync.getAdminedPublicChannels(accountId); }
  async getChannelParticipants(accountId: string, channelId: string, offset: number, limit: number, excludeAdmins?: boolean) {
    return this.chatSync.getChannelParticipants(accountId, channelId, offset, limit, excludeAdmins);
  }
  async getActiveParticipants(accountId: string, chatId: string, depth: number, excludeAdmins?: boolean) {
    return this.chatSync.getActiveParticipants(accountId, chatId, depth, excludeAdmins);
  }
  async getCommentGroupParticipants(
    accountId: string,
    channelId: string,
    linkedChatId: string,
    options?: { postLimit?: number; maxRepliesPerPost?: number; excludeAdmins?: boolean }
  ) {
    return this.chatSync.getCommentGroupParticipants(accountId, channelId, linkedChatId, options);
  }
  async getReactionContributors(accountId: string, chatId: string, options?: { historyLimit?: number }) {
    return this.chatSync.getReactionContributors(accountId, chatId, options);
  }
  async leaveChat(accountId: string, chatId: string): Promise<void> { return this.chatSync.leaveChat(accountId, chatId); }
  async resolveChatFromInput(accountId: string, input: string) { return this.chatSync.resolveChatFromInput(accountId, input); }
  async resolveSourceFromInput(accountId: string, input: string): Promise<ResolvedSource> { return this.chatSync.resolveSourceFromInput(accountId, input); }
  async getDialogFilterPeerIds(accountId: string, filterId: number): Promise<Set<string>> { return this.chatSync.getDialogFilterPeerIds(accountId, filterId); }
  async getDialogFilterRaw(accountId: string, filterId: number) { return this.chatSync.getDialogFilterRaw(accountId, filterId); }
  async getDialogFilters(accountId: string) { return this.chatSync.getDialogFilters(accountId); }
  async pushFoldersToTelegram(accountId: string) { return this.chatSync.pushFoldersToTelegram(accountId); }
  async getDialogsByFolder(accountId: string, folderId: number) { return this.chatSync.getDialogsByFolder(accountId, folderId); }
  async tryAddChatFromSelectedFolders(accountId: string, chatId: string): Promise<boolean> { return this.chatSync.tryAddChatFromSelectedFolders(accountId, chatId); }
  async createSharedChat(accountId: string, params: { title: string; leadTelegramUserId?: number; leadUsername?: string; extraUsernames?: string[] }) {
    return this.chatSync.createSharedChat(accountId, params);
  }
  async deleteMessageInTelegram(accountId: string, channelId: string, telegramMessageId: number): Promise<void> {
    return this.chatSync.deleteMessageInTelegram(accountId, channelId, telegramMessageId);
  }

  // Static helpers live in chat-sync-dialogs.ts (C3)
  static dialogMatchesFilter(
    dialog: { id: string; isUser?: boolean; isGroup?: boolean; isChannel?: boolean },
    filterRaw: unknown,
    includePeerIds: Set<string>,
    excludePeerIds: Set<string>
  ): boolean {
    return dialogMatchesFilter(dialog, filterRaw, includePeerIds, excludePeerIds);
  }
  static getFilterIncludeExcludePeerIds(filterRaw: unknown): { include: Set<string>; exclude: Set<string> } {
    return getFilterIncludeExcludePeerIds(filterRaw);
  }

  // --- Sending ---
  async sendMessage(accountId: string, chatId: string, text: string, opts?: { replyTo?: number }): Promise<Api.Message> {
    return this.messageSender.sendMessage(accountId, chatId, text, opts);
  }
  async setTyping(accountId: string, chatId: string): Promise<void> { return this.messageSender.setTyping(accountId, chatId); }
  async markAsRead(accountId: string, chatId: string): Promise<void> { return this.messageSender.markAsRead(accountId, chatId); }
  async saveDraft(accountId: string, chatId: string, text: string, opts?: { replyToMsgId?: number }): Promise<void> {
    return this.messageSender.saveDraft(accountId, chatId, text, opts);
  }
  async forwardMessage(accountId: string, fromChatId: string, toChatId: string, telegramMessageId: number): Promise<Api.Message> {
    return this.messageSender.forwardMessage(accountId, fromChatId, toChatId, telegramMessageId);
  }

  // --- Files ---
  async downloadMessageMedia(accountId: string, channelId: string, messageId: string) { return this.fileHandler.downloadMessageMedia(accountId, channelId, messageId); }
  async sendFile(accountId: string, chatId: string, fileBuffer: Buffer, opts?: { caption?: string; filename?: string; replyTo?: number }): Promise<Api.Message> {
    return this.fileHandler.sendFile(accountId, chatId, fileBuffer, opts);
  }
  async downloadAccountProfilePhoto(accountId: string) { return this.fileHandler.downloadAccountProfilePhoto(accountId); }
  async downloadChatProfilePhoto(accountId: string, chatId: string) { return this.fileHandler.downloadChatProfilePhoto(accountId, chatId); }

  // --- Reactions ---
  async sendReaction(accountId: string, chatId: string, telegramMessageId: number, reactionEmojis: string[]): Promise<void> {
    return this.reactionHandler.sendReaction(accountId, chatId, telegramMessageId, reactionEmojis);
  }

  // --- Shutdown ---
  async shutdown(): Promise<void> {
    this.connectionManager.stopCleanupInterval();
    this.sessionManager.stopSessionSaveInterval();
    for (const aid of Array.from(this.deps.updateKeepaliveIntervals.keys())) {
      this.connectionManager.stopUpdateKeepalive(aid);
    }
    await this.sessionManager.saveAllSessions();
    for (const [accountId] of this.deps.clients) {
      await this.connectionManager.disconnectAccount(accountId);
    }
  }
}
