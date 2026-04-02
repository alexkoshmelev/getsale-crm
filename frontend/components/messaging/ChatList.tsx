'use client';

import React from 'react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import {
  MessageSquare, Loader2, ChevronRight, ChevronLeft,
  RefreshCw, Pencil, Users, Inbox,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { ChatAvatar } from '@/components/messaging/ChatAvatar';
import type { BDAccount, Chat, SyncFolder } from '@/app/dashboard/messaging/types';
import { SHOW_SYNC_FOLDERS_TO_TELEGRAM } from '@/app/dashboard/messaging/types';
import { getChatDisplayName, formatTime } from '@/app/dashboard/messaging/utils';

interface ChatListProps {
  selectedAccountId: string | null;
  selectedChat: Chat | null;
  collapsed: boolean;
  loadingChats: boolean;
  accountSyncReady: boolean;
  accountSyncProgress: { done: number; total: number } | null;
  isSelectedAccountMine: boolean;
  syncFoldersPushing: boolean;
  displayFolders: SyncFolder[];
  displayChats: Chat[];
  pinnedChatsOrdered: Chat[];
  selectedFolderId: number;
  dragOverFolderId: number | null;
  unreadByFolder: { all: number; byId: Record<number, number> };
  activeSidebarSection: 'new-leads' | 'telegram';
  newLeads: Chat[];
  newLeadsLoading: boolean;
  getChatNameWithOverrides: (chat: Chat) => string;
  /** Unique display name for list items (disambiguates when multiple chats share the same name). */
  getChatNameDisplay?: (chat: Chat) => string;
  onSelectChat: (chat: Chat) => void;
  onSelectAccount: (id: string) => void;
  onCollapse: (v: boolean) => void;
  onSelectFolder: (id: number) => void;
  onSetActiveSidebarSection: (section: 'new-leads' | 'telegram') => void;
  onShowFolderManageModal: () => void;
  onSetBroadcastModalOpen: (v: boolean) => void;
  onSetSyncFoldersPushing: (v: boolean) => void;
  onSetDragOverFolderId: (id: number | null) => void;
  onFolderDrop: (folderId: number, e: React.DragEvent) => void;
  onChatContextMenu: (e: React.MouseEvent, chat: Chat) => void;
  onAccountContextMenu: (e: React.MouseEvent) => void;
}

export const ChatList = React.memo(function ChatList(props: ChatListProps) {
  const { t } = useTranslation();
  const {
    selectedAccountId, selectedChat, collapsed, loadingChats,
    accountSyncReady, accountSyncProgress, isSelectedAccountMine,
    syncFoldersPushing, displayFolders, displayChats,
    pinnedChatsOrdered, selectedFolderId, dragOverFolderId,
    unreadByFolder, activeSidebarSection, newLeads, newLeadsLoading,
    getChatNameWithOverrides, getChatNameDisplay, onSelectChat, onCollapse,
    onSelectFolder, onSetActiveSidebarSection, onShowFolderManageModal,
    onSetBroadcastModalOpen, onSetDragOverFolderId,
    onFolderDrop, onChatContextMenu,
  } = props;

  const renderFolderButton = (f: SyncFolder, onClick: () => void) => (
    <button
      key={f.id}
      type="button"
      onClick={onClick}
      title={f.folder_title}
      onDragOver={(e) => { e.preventDefault(); onSetDragOverFolderId(f.folder_id); }}
      onDragLeave={() => onSetDragOverFolderId(null)}
      onDrop={(e) => onFolderDrop(f.folder_id, e)}
      className={`flex flex-col items-center justify-center py-2 px-1 gap-0.5 min-h-[48px] w-full rounded-none border-b border-border/30 transition-colors ${
        selectedFolderId === f.folder_id ? 'bg-primary/10 dark:bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
      } ${dragOverFolderId === f.folder_id ? 'ring-2 ring-primary bg-primary/20' : ''}`}
    >
      <span className="text-lg shrink-0 leading-none">{f.icon || '📁'}</span>
      <span className="text-[10px] font-medium truncate w-full text-center leading-tight">{f.folder_title}</span>
      {(unreadByFolder.byId[f.folder_id] ?? 0) > 0 && (
        <span className={`min-w-[1rem] rounded-full px-1 text-[9px] tabular-nums leading-none ${selectedFolderId === f.folder_id ? 'bg-primary/30 text-primary-foreground' : 'bg-primary/20'}`}>
          {unreadByFolder.byId[f.folder_id]! > 99 ? '99+' : unreadByFolder.byId[f.folder_id]}
        </span>
      )}
    </button>
  );

  const renderFolderSidebar = () => (
    <div className="w-16 flex-shrink-0 flex flex-col border-r border-border bg-muted/30 min-h-0">
      <button
        type="button"
        onClick={() => onSetActiveSidebarSection('new-leads')}
        className={`shrink-0 flex flex-col items-center justify-center py-2 px-1 gap-0.5 min-h-[48px] w-full rounded-none border-b border-border transition-colors ${
          activeSidebarSection === 'new-leads' ? 'bg-primary/10 dark:bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
        }`}
        title={t('messaging.newLeadsFolder')}
      >
        <Inbox className="w-5 h-5 shrink-0" aria-hidden />
        <span className="text-[10px] font-medium truncate w-full text-center leading-tight">{t('messaging.newLeadsFolder')}</span>
        {newLeads.length > 0 && (
          <span className={`min-w-[1rem] rounded-full px-1 text-[9px] tabular-nums ${activeSidebarSection === 'new-leads' ? 'bg-primary/30 text-primary-foreground' : 'bg-primary/20'}`}>
            {newLeads.length > 99 ? '99+' : newLeads.length}
          </span>
        )}
      </button>
      <div className="shrink-0 h-px bg-border" aria-hidden />
      <div className="shrink-0 border-b border-border/50 flex items-center justify-center gap-0.5 py-2">
        <button type="button" onClick={() => window.location.href = `/dashboard/bd-accounts?accountId=${selectedAccountId}&openSelectChats=1`} className="p-2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors" title={t('messaging.syncChatsTitle')}>
          <RefreshCw className="w-4 h-4" />
        </button>
        <button type="button" onClick={() => onSetBroadcastModalOpen(true)} className="p-2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors" title={t('messaging.broadcastToGroups', 'Рассылка в группы')}>
          <Users className="w-4 h-4" />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto pt-2 pb-1 flex flex-col scroll-thin-overlay">
        {displayFolders.map((f) => renderFolderButton(f, () => { onSetActiveSidebarSection('telegram'); onSelectFolder(f.folder_id); }))}
      </div>
      {isSelectedAccountMine && (
        <>
          {SHOW_SYNC_FOLDERS_TO_TELEGRAM && (
            <button type="button" disabled={syncFoldersPushing} className="py-1.5 px-1 text-[10px] text-muted-foreground hover:text-foreground border-t border-border/50 disabled:opacity-50 truncate w-full" title={t('messaging.syncFoldersToTelegram')}>
              {syncFoldersPushing ? '…' : t('messaging.syncFoldersToTelegramShort')}
            </button>
          )}
          <button type="button" onClick={onShowFolderManageModal} className="flex flex-col items-center justify-center py-2 px-1 gap-0.5 text-muted-foreground hover:bg-accent hover:text-foreground border-t border-border shrink-0" title={t('messaging.folderEdit')}>
            <Pencil className="w-4 h-4 shrink-0" />
            <span className="text-[10px] font-medium">{t('messaging.folderEdit')}</span>
          </button>
        </>
      )}
    </div>
  );

  const chatNameForList = (chat: Chat) => (getChatNameDisplay ?? getChatNameWithOverrides)(chat);

  const renderChatItem = (chat: Chat, idx: number) => {
    const isFirstPinned = idx === 0 && pinnedChatsOrdered.length > 0;
    const isFirstUnpinned = pinnedChatsOrdered.length > 0 && idx === pinnedChatsOrdered.length;
    const stageLabel = [chat.lead_pipeline_name, chat.lead_stage_name].filter(Boolean).join(' · ');
    return (
      <React.Fragment key={`${chat.channel}-${chat.channel_id}`}>
        {isFirstPinned && <div className="px-3 py-1 text-[11px] font-medium text-muted-foreground bg-muted/30">{t('messaging.pinnedSection')}</div>}
        {isFirstUnpinned && <div className="px-3 py-1 text-[11px] font-medium text-muted-foreground border-t border-border bg-muted/30">{t('messaging.chatsSection')}</div>}
        <div
          draggable
          onDragStart={(e) => { e.dataTransfer.setData('application/json', JSON.stringify({ bdAccountId: selectedAccountId, chat })); e.dataTransfer.effectAllowed = 'move'; }}
          onClick={() => onSelectChat(chat)}
          onContextMenu={(e) => { e.preventDefault(); onChatContextMenu(e, chat); }}
          className={`px-3 py-2 cursor-pointer border-b border-border transition-colors flex gap-2.5 items-center ${selectedChat?.channel_id === chat.channel_id ? 'bg-primary/10 dark:bg-primary/20' : 'hover:bg-accent'}`}
        >
          <ChatAvatar bdAccountId={selectedAccountId ?? ''} chatId={chat.channel_id} chat={chat} className="w-9 h-9 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-1.5">
              <div className="flex items-center gap-1.5 min-w-0 truncate">
                <span className="font-medium text-sm truncate" title={getChatNameWithOverrides(chat)}>{chatNameForList(chat)}</span>
                <span className={`shrink-0 text-[10px] leading-none px-1.5 py-0.5 rounded ${chat.lead_id ? 'bg-primary/15 text-primary' : 'text-muted-foreground/60'}`}>
                  {chat.lead_id
                  ? t('messaging.badgeLead')
                  : chat.peer_type === 'chat' || chat.peer_type === 'channel'
                    ? t('messaging.badgeGroup')
                    : t('messaging.badgeContact')}
                </span>
              </div>
              <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">{formatTime(chat.last_message_at)}</span>
            </div>
            <div className="flex items-center justify-between gap-1.5 mt-0.5">
              <p className="text-[13px] text-muted-foreground truncate min-w-0">
                {stageLabel && <span className="text-primary/70 font-medium">{stageLabel} · </span>}
                {chat.last_message === '[Media]' ? t('messaging.mediaPreview') : (chat.last_message || t('messaging.noMessages'))}
              </p>
              {chat.unread_count > 0 && (
                <span className="bg-primary text-primary-foreground text-[11px] rounded-full min-w-[1.125rem] h-[1.125rem] px-1 flex items-center justify-center shrink-0 leading-none">
                  {chat.unread_count}
                </span>
              )}
            </div>
          </div>
        </div>
      </React.Fragment>
    );
  };

  const renderNewLeadItem = (chat: Chat) => {
    const stageLabel = [chat.lead_pipeline_name, chat.lead_stage_name].filter(Boolean).join(' · ');
    return (
      <div
        key={chat.conversation_id ?? `${chat.channel}-${chat.channel_id}`}
        onClick={() => { if (chat.bd_account_id) props.onSelectAccount(chat.bd_account_id); onSelectChat(chat); }}
        onContextMenu={(e) => { e.preventDefault(); onChatContextMenu(e, chat); }}
        className={`px-3 py-2 cursor-pointer border-b border-border transition-colors flex gap-2.5 items-center ${selectedChat?.channel_id === chat.channel_id ? 'bg-primary/10 dark:bg-primary/20' : 'hover:bg-accent'}`}
      >
        <ChatAvatar bdAccountId={chat.bd_account_id ?? selectedAccountId ?? ''} chatId={chat.channel_id} chat={chat} className="w-9 h-9 shrink-0" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-1.5">
            <div className="flex items-center gap-1.5 min-w-0 truncate">
              <span className="font-medium text-sm truncate">{getChatDisplayName(chat)}</span>
              <span className="shrink-0 text-[10px] leading-none px-1.5 py-0.5 rounded bg-primary/15 text-primary">{t('messaging.badgeLead')}</span>
            </div>
            <span className="text-[11px] text-muted-foreground shrink-0 tabular-nums">{formatTime(chat.last_message_at)}</span>
          </div>
          <div className="flex items-center justify-between gap-1.5 mt-0.5">
            <p className="text-[13px] text-muted-foreground truncate min-w-0">
              {stageLabel && <span className="text-primary/70 font-medium">{stageLabel} · </span>}
              {chat.last_message === '[Media]' ? t('messaging.mediaPreview') : (chat.last_message || t('messaging.noMessages'))}
            </p>
            {chat.unread_count > 0 && (
              <span className="bg-primary text-primary-foreground text-[11px] rounded-full min-w-[1.125rem] h-[1.125rem] px-1 flex items-center justify-center shrink-0 leading-none">
                {chat.unread_count}
              </span>
            )}
          </div>
        </div>
      </div>
    );
  };

  if (collapsed) {
    return (
      <div className="flex flex-col flex-1 min-h-0 w-full min-w-0">
        <button type="button" onClick={() => onCollapse(false)} className="p-2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground flex flex-col items-center gap-0.5 w-full shrink-0 border-b border-border" title={t('messaging.chatsPanelTitle') + ' — развернуть'}>
          <MessageSquare className="w-5 h-5 shrink-0" aria-hidden />
          <ChevronRight className="w-4 h-4 shrink-0" aria-hidden />
        </button>
        {selectedAccountId && (
          <div className="flex flex-1 min-h-0 min-w-0">
            {renderFolderSidebar()}
            <div className="w-16 flex-shrink-0 flex flex-col min-h-0">
              <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center pt-2 pb-1 gap-1 scroll-thin-overlay">
                {!loadingChats && accountSyncReady && displayChats.length > 0 && displayChats.map((chat) => (
                  <button
                    key={`${chat.channel}-${chat.channel_id}`}
                    type="button"
                    onClick={() => onSelectChat(chat)}
                    onContextMenu={(e) => { e.preventDefault(); onChatContextMenu(e, chat); }}
                    title={getChatNameWithOverrides(chat)}
                    aria-label={chatNameForList(chat)}
                    className={`relative shrink-0 rounded-full p-0.5 transition-colors hover:ring-2 hover:ring-primary/50 ${selectedChat?.channel_id === chat.channel_id ? 'ring-2 ring-primary' : ''}`}
                  >
                    <ChatAvatar bdAccountId={selectedAccountId ?? ''} chatId={chat.channel_id} chat={chat} className="w-8 h-8" />
                    {chat.unread_count > 0 && (
                      <span className="absolute -top-0.5 -right-0.5 min-w-[0.875rem] h-3.5 px-0.5 rounded-full bg-primary text-primary-foreground text-[10px] flex items-center justify-center leading-none">{chat.unread_count}</span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <div className="flex items-center gap-2 p-3 border-b border-border shrink-0 min-w-0 flex-none">
        <h3 className="font-semibold text-foreground truncate flex-1 min-w-0">{t('messaging.chatsPanelTitle')}</h3>
        <button type="button" onClick={() => onCollapse(true)} className="p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground shrink-0" title={t('messaging.collapseChatsPanel')}>
          <ChevronLeft className="w-4 h-4" />
        </button>
      </div>
      <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
        {selectedAccountId && renderFolderSidebar()}
        <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {activeSidebarSection === 'new-leads' ? (
            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col relative scroll-thin-overlay">
              {newLeadsLoading ? (
                <div className="absolute inset-0 flex items-center justify-center"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
              ) : newLeads.length === 0 ? (
                <div className="flex-1 min-h-0 flex flex-col items-center justify-center p-4 text-center">
                  <p className="text-sm font-medium text-foreground">{t('messaging.newLeadsEmptyTitle')}</p>
                  <p className="text-xs text-muted-foreground mt-1">{t('messaging.newLeadsEmptyDesc')}</p>
                </div>
              ) : newLeads.map(renderNewLeadItem)}
            </div>
          ) : (
            <>
              {!accountSyncReady && (
                <div className="text-xs text-muted-foreground bg-amber-500/10 dark:bg-amber-500/20 border border-amber-500/30 rounded-md mx-3 mt-2 px-2.5 py-1.5 flex items-center gap-2 overflow-hidden shrink-0">
                  {accountSyncProgress ? (
                    <span className="truncate">Синхронизация: {accountSyncProgress.done} / {accountSyncProgress.total}</span>
                  ) : isSelectedAccountMine ? (
                    <div className="flex flex-col gap-1 min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="truncate flex-1 min-w-0">{t('messaging.selectChatsSync')}</span>
                        <button type="button" onClick={() => window.location.href = `/dashboard/bd-accounts?accountId=${selectedAccountId}&openSelectChats=1`} className="text-primary font-medium shrink-0 hover:underline">{t('messaging.configure')}</button>
                      </div>
                      <span className="text-[11px] text-muted-foreground/90">{t('messaging.syncSafetyShort')}</span>
                    </div>
                  ) : (
                    <span className="truncate">{t('messaging.colleagueAccountHint')}</span>
                  )}
                </div>
              )}
              <div className="flex-1 min-h-0 overflow-y-auto flex flex-col relative scroll-thin-overlay">
                {loadingChats && (
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none"><Loader2 className="w-6 h-6 animate-spin text-blue-600 shrink-0" aria-hidden /></div>
                )}
                {!loadingChats && !accountSyncReady ? (
                  <div className="p-4 flex flex-1 min-h-0 flex-col items-center justify-center text-center text-sm text-muted-foreground">
                    {accountSyncProgress ? <span>{t('messaging.waitingSync')}</span> : isSelectedAccountMine ? (
                      <>
                        <p className="mb-2">{t('messaging.accountNeedsSync')}</p>
                        <p className="text-xs text-muted-foreground mb-3 max-w-xs">{t('messaging.syncSafetyShort')}</p>
                        <Button size="sm" onClick={() => window.location.href = `/dashboard/bd-accounts?accountId=${selectedAccountId}&openSelectChats=1`}>{t('messaging.selectChatsAndStartSync')}</Button>
                      </>
                    ) : <p>{t('messaging.colleagueSyncOwner')}</p>}
                  </div>
                ) : !loadingChats && displayChats.length === 0 ? (
                  <div className="flex-1 min-h-0 flex items-center justify-center p-4">
                    <EmptyState icon={MessageSquare} title={t('messaging.noChats')} description={t('messaging.noChatsDesc')} action={<Link href="/dashboard/bd-accounts"><Button>{t('messaging.noChatsCta')}</Button></Link>} />
                  </div>
                ) : !loadingChats ? displayChats.map(renderChatItem) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
});
