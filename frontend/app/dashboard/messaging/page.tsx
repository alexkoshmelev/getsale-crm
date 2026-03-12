'use client';

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useAuthStore } from '@/lib/stores/auth-store';
import {
  Loader2, MessageSquare, MoreVertical, Paperclip, Send, Mic, Bot,
  X, ChevronDown, UserCircle, Filter, Image, Video, File,
  FileText, Sparkles,
  Settings, Trash2, Pin, PinOff, Reply, Forward, Copy, Heart,
  Check, User, StickyNote, Bell, ExternalLink,
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ContextMenu, ContextMenuSection, ContextMenuItem } from '@/components/ui/ContextMenu';
import { Virtuoso } from 'react-virtuoso';
import { Modal } from '@/components/ui/Modal';
import { MediaViewer } from '@/components/messaging/MediaViewer';
import { FolderManageModal } from '@/components/messaging/FolderManageModal';
import { AddToFunnelModal } from '@/components/crm/AddToFunnelModal';
import { LeadCardModal } from '@/components/pipeline/LeadCardModal';
import { RightWorkspacePanel } from '@/components/messaging/RightWorkspacePanel';
import { AccountList } from '@/components/messaging/AccountList';
import { ChatList } from '@/components/messaging/ChatList';
import { ChatAvatar } from '@/components/messaging/ChatAvatar';
import { LeadContextAvatarFromContext } from '@/components/messaging/LeadContextAvatar';
import { MessageBubble } from '@/components/messaging/MessageBubble';
import { BroadcastToGroupsModal } from '@/components/messaging/BroadcastToGroupsModal';
import { ForwardMessageModal } from '@/components/messaging/ForwardMessageModal';
import { EditContactNameModal } from '@/components/messaging/EditContactNameModal';
import { AddNoteModal } from '@/components/messaging/AddNoteModal';
import { AddReminderModal } from '@/components/messaging/AddReminderModal';
import dynamic from 'next/dynamic';
import { clsx } from 'clsx';
import { apiClient } from '@/lib/api/client';
import { fetchLeadContextByLeadId } from '@/lib/api/messaging';
import {
  fetchContactNotes, deleteNote,
  fetchContactReminders, updateReminder, deleteReminder,
} from '@/lib/api/crm';
import { formatDealAmount } from '@/lib/format/currency';
import type { LeadContext, Message } from './types';
import { VIRTUAL_LIST_THRESHOLD, INITIAL_FIRST_ITEM_INDEX, REACTION_EMOJI } from './types';
import { getAccountDisplayName, formatTime, formatLeadPanelDate, getChatName } from './utils';
import { useMessagingState } from './hooks/useMessagingState';
import { useMessagingData } from './hooks/useMessagingData';
import { useMessagingWebSocket } from './hooks/useMessagingWebSocket';
import { useMessagingActions } from './hooks/useMessagingActions';

const AIAssistantTabContent = dynamic(
  () => import('@/components/messaging/AIAssistantTabContent').then((m) => m.AIAssistantTabContent),
  { ssr: false, loading: () => <div className="p-3 text-sm text-muted-foreground">Loading…</div> },
);

export default function MessagingPage() {
  const { t } = useTranslation();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { user: currentUser } = useAuthStore();
  const s = useMessagingState();
  const data = useMessagingData(s);
  useMessagingWebSocket(s, data.fetchChats, data.fetchAccounts);
  const actions = useMessagingActions(s, data.fetchChats, data.fetchMessages);

  const handleSelectChat = useCallback(
    (chat: Parameters<typeof s.setSelectedChat>[0]) => {
      s.setSelectedChat(chat);
      const chatObj = typeof chat === 'function' ? null : chat;
      if (chatObj && s.selectedAccountId) {
        const q = new URLSearchParams(searchParams?.toString() ?? '');
        q.set('bdAccountId', s.selectedAccountId);
        q.set('open', chatObj.channel_id);
        router.replace(`${pathname}?${q.toString()}`, { scroll: false });
      }
    },
    [s.setSelectedChat, s.selectedAccountId, pathname, router, searchParams]
  );

  const convId = data.convId;
  const isLead = data.isLead;
  const isLeadPanelOpen = data.isLeadPanelOpen;
  // Agent (bidi): can write only from accounts they connected; other roles can write from any org account
  const canWriteFromSelectedAccount =
    (currentUser?.role?.toLowerCase() !== 'bidi') || (actions.isSelectedAccountMine === true);

  const handleContextMenuMessage = useCallback((e: React.MouseEvent, msg: Message) => {
    s.setChatContextMenu(null);
    s.setAccountContextMenu(null);
    s.setMessageContextMenu({ x: e.clientX, y: e.clientY, message: msg });
  }, []);

  if (s.loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-0 w-full rounded-lg border border-border bg-card">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="relative flex flex-1 items-stretch h-full min-h-full w-full min-w-0 bg-card rounded-lg border border-border overflow-hidden isolate">
      {/* ─── Account List Panel ─── */}
      <div className={`h-full min-h-0 self-stretch bg-muted/40 dark:bg-muted/20 border-r border-border flex flex-col transition-[width] duration-200 shrink-0 ${s.accountsPanelCollapsed ? 'w-16' : 'w-64'}`}>
        <AccountList
          accounts={s.accounts}
          filteredAccounts={actions.filteredAccounts}
          selectedAccountId={s.selectedAccountId}
          collapsed={s.accountsPanelCollapsed}
          accountSearch={s.accountSearch}
          onSelectAccount={(id) => { s.setSelectedAccountId(id); s.setSelectedChat(null); s.setMessages([]); }}
          onCollapse={s.setAccountsCollapsed}
          onSearchChange={s.setAccountSearch}
          onAccountContextMenu={(e, account) => { s.setChatContextMenu(null); s.setMessageContextMenu(null); s.setAccountContextMenu({ x: e.clientX, y: e.clientY, account }); }}
        />
      </div>

      {/* ─── Chat List Panel ─── */}
      <div className={`h-full min-h-0 self-stretch bg-card border-r border-border flex flex-col transition-[width] duration-200 shrink-0 ${s.chatsPanelCollapsed ? 'w-32' : 'w-[320px]'}`}>
        <ChatList
          selectedAccountId={s.selectedAccountId}
          selectedChat={s.selectedChat}
          collapsed={s.chatsPanelCollapsed}
          loadingChats={s.loadingChats}
          accountSyncReady={s.accountSyncReady}
          accountSyncProgress={s.accountSyncProgress}
          isSelectedAccountMine={actions.isSelectedAccountMine}
          syncFoldersPushing={s.syncFoldersPushing}
          displayFolders={actions.displayFolders}
          displayChats={actions.displayChats}
          pinnedChatsOrdered={actions.pinnedChatsOrdered}
          selectedFolderId={s.selectedFolderId}
          dragOverFolderId={s.dragOverFolderId}
          unreadByFolder={actions.unreadByFolder}
          activeSidebarSection={s.activeSidebarSection}
          newLeads={s.newLeads}
          newLeadsLoading={s.newLeadsLoading}
          getChatNameWithOverrides={actions.getChatNameWithOverrides}
          getChatNameDisplay={actions.getChatNameDisplay}
          onSelectChat={handleSelectChat}
          onSelectAccount={s.setSelectedAccountId}
          onCollapse={s.setChatsCollapsed}
          onSelectFolder={s.setSelectedFolderId}
          onSetActiveSidebarSection={s.setActiveSidebarSection}
          onShowFolderManageModal={() => s.setShowFolderManageModal(true)}
          onSetBroadcastModalOpen={s.setBroadcastModalOpen}
          onSetSyncFoldersPushing={s.setSyncFoldersPushing}
          onSetDragOverFolderId={s.setDragOverFolderId}
          onFolderDrop={actions.handleFolderDrop}
          onChatContextMenu={(e, chat) => { s.setAccountContextMenu(null); s.setMessageContextMenu(null); s.setChatContextMenu({ x: e.clientX, y: e.clientY, chat }); }}
          onAccountContextMenu={() => {}}
        />
      </div>

      {/* ─── Chat Area + Right Panel ─── */}
      <div className="flex flex-1 min-h-0 min-w-0 self-stretch h-full overflow-hidden">
        <div className="flex-1 min-h-0 min-w-0 flex flex-col bg-background overflow-hidden">
          {s.selectedChat ? (
            <>
              {/* Chat Header */}
              <div className="relative z-10 px-4 py-3 border-b border-border bg-card/95 backdrop-blur-sm shrink-0 min-h-[3.5rem] flex flex-col justify-center">
                <div className="flex items-center justify-between gap-2 min-h-[2rem]">
                  <div className="min-w-0 flex-1">
                    <div className="font-semibold truncate flex items-center gap-2">
                      {actions.getChatNameWithOverrides(s.selectedChat)}
                      {isLead && !isLeadPanelOpen && (
                        <button type="button" onClick={() => actions.setLeadPanelOpen(true)} className="shrink-0 text-[10px] font-normal px-1.5 py-0.5 rounded bg-primary/15 text-primary hover:bg-primary/25" title={t('messaging.leadPanelOpen')}>{t('messaging.badgeLead')}</button>
                      )}
                      {s.selectedChat.peer_type === 'user' && (() => {
                        const st = s.userStatusByUserId[s.selectedChat!.channel_id];
                        if (st?.status === 'UserStatusOnline') return <span className="inline-block w-2 h-2 rounded-full bg-green-500 shrink-0" title={t('messaging.online')} />;
                        if (st?.status === 'UserStatusOffline' && st?.expires && st.expires > 0) return <span className="text-xs text-muted-foreground">{t('messaging.recently')}</span>;
                        return null;
                      })()}
                    </div>
                    {s.selectedChat.telegram_id && <div className="text-xs text-muted-foreground truncate">ID: {s.selectedChat.telegram_id}</div>}
                    {s.typingChannelId === s.selectedChat.channel_id && <div className="text-xs text-primary mt-0.5 animate-pulse">{t('messaging.typing')}</div>}
                  </div>
                  <div className="relative" ref={s.chatHeaderMenuRef}>
                    <button type="button" onClick={() => s.setShowChatHeaderMenu((v) => !v)} className="p-2 hover:bg-accent rounded"><MoreVertical className="w-5 h-5" /></button>
                    {s.showChatHeaderMenu && (
                      <div className="absolute right-0 top-full mt-1 py-1 bg-card border border-border rounded-lg shadow-lg min-w-[180px] z-[100]" role="menu">
                        <button type="button" onClick={() => { s.setShowChatHeaderMenu(false); actions.openEditNameModal(); }} disabled={!s.selectedChat.contact_id} className="w-full px-4 py-2 text-left text-sm hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2" role="menuitem">
                          <UserCircle className="w-4 h-4 shrink-0" />{s.selectedChat.contact_id ? t('messaging.changeContactName') : t('messaging.noContact')}
                        </button>
                        {s.selectedChat.contact_id && s.selectedChat.peer_type === 'user' && (
                          <button type="button" onClick={() => { s.setShowChatHeaderMenu(false); s.setAddToFunnelFromChat({ contactId: s.selectedChat!.contact_id!, contactName: actions.getChatNameWithOverrides(s.selectedChat!), leadTitle: actions.getChatNameWithOverrides(s.selectedChat!), bdAccountId: s.selectedAccountId ?? undefined, channel: s.selectedChat!.channel, channelId: s.selectedChat!.channel_id }); }} className="w-full px-4 py-2 text-left text-sm hover:bg-accent flex items-center gap-2" role="menuitem">
                            <Filter className="w-4 h-4 shrink-0" />{t('pipeline.addToFunnel')}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <EditContactNameModal
                open={s.showEditNameModal}
                onClose={() => !s.savingDisplayName && s.setShowEditNameModal(false)}
                value={s.editDisplayNameValue}
                onChange={(v) => s.setEditDisplayNameValue(v)}
                onSave={actions.saveDisplayName}
                saving={s.savingDisplayName}
              />

              {/* Message List */}
              <div className="relative flex-1 min-h-0 flex flex-col">
                <div ref={s.messagesScrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pl-4 pt-4 pb-4 pr-[10px] bg-muted/20 flex flex-col scroll-thin">
                  {s.channelNeedsRefresh === s.selectedChat?.channel_id && (
                    <div className="flex items-center justify-between gap-2 py-2 px-3 mb-2 rounded-lg bg-amber-500/15 border border-amber-500/40 text-sm">
                      <span className="text-foreground">{t('messaging.channelTooLongBanner')}</span>
                      <Button variant="outline" size="sm" onClick={() => { s.setChannelNeedsRefresh(null); actions.loadOlderMessages(); }}>{t('messaging.refreshHistory')}</Button>
                    </div>
                  )}
                  {s.selectedChat && s.lastLoadedChannelId !== s.selectedChat.channel_id ? (
                    <div className="flex items-center justify-center h-full"><Loader2 className="w-6 h-6 animate-spin text-blue-600" /></div>
                  ) : s.loadingMessages ? (
                    <div className="flex items-center justify-center h-full"><Loader2 className="w-6 h-6 animate-spin text-blue-600" /></div>
                  ) : s.messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                      <MessageSquare className="w-12 h-12 mb-3 text-muted-foreground" />
                      <p className="text-sm">{t('messaging.noMessages')}</p>
                      <p className="text-xs mt-1 text-muted-foreground">{t('messaging.startConversation')}</p>
                    </div>
                  ) : s.messages.length > VIRTUAL_LIST_THRESHOLD ? (
                    <div key={`virtuoso-${s.selectedChat?.channel_id ?? 'none'}-${s.lastLoadedChannelId ?? 'none'}`} className="flex-1 min-h-0 flex flex-col w-full max-w-3xl mx-auto">
                      {s.loadingOlder && <div className="flex justify-center py-2 flex-shrink-0"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>}
                      <Virtuoso
                        ref={s.virtuosoRef as React.RefObject<never>}
                        style={{ height: '100%', flex: 1 }}
                        data={s.messages}
                        firstItemIndex={INITIAL_FIRST_ITEM_INDEX - s.prependedCount}
                        startReached={() => {
                          const now = Date.now();
                          if (now - s.loadOlderLastCallRef.current < 2500) return;
                          if (!actions.hasMoreMessages || s.loadingOlder) return;
                          s.loadOlderLastCallRef.current = now;
                          actions.loadOlderMessages();
                        }}
                        itemContent={(_index, msg) => (
                          <MessageBubble
                            msg={msg}
                            index={s.messages.indexOf(msg)}
                            messages={s.messages}
                            selectedAccountId={s.selectedAccountId}
                            selectedChat={s.selectedChat}
                            readOutboxMaxIdByChannel={s.readOutboxMaxIdByChannel}
                            leadContext={s.leadContext}
                            onContextMenu={handleContextMenuMessage}
                            onOpenMedia={(url, type) => s.setMediaViewer({ url, type })}
                            onScrollToMessage={actions.scrollToMessageByTelegramId}
                          />
                        )}
                        followOutput="auto"
                        initialTopMostItemIndex={{ index: Math.max(0, s.messages.length - 1), align: 'end' }}
                        atBottomStateChange={(atBottom) => { if (atBottom) s.setShowScrollToBottomButton(false); }}
                        rangeChanged={(range) => { if (range.endIndex < s.messages.length - 10) s.setShowScrollToBottomButton(true); }}
                        className="space-y-3"
                      />
                    </div>
                  ) : (
                    <div className="space-y-3 w-full max-w-3xl mx-auto">
                      <div ref={s.messagesTopSentinelRef} className="h-2 flex-shrink-0" aria-hidden />
                      {s.loadingOlder && <div className="flex justify-center py-2"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>}
                      {s.messages.map((msg, index) => (
                        <React.Fragment key={msg.id}>
                          <MessageBubble
                            msg={msg}
                            index={index}
                            messages={s.messages}
                            selectedAccountId={s.selectedAccountId}
                            selectedChat={s.selectedChat}
                            readOutboxMaxIdByChannel={s.readOutboxMaxIdByChannel}
                            leadContext={s.leadContext}
                            onContextMenu={handleContextMenuMessage}
                            onOpenMedia={(url, type) => s.setMediaViewer({ url, type })}
                            onScrollToMessage={actions.scrollToMessageByTelegramId}
                          />
                        </React.Fragment>
                      ))}
                      <div ref={s.messagesEndRef} />
                    </div>
                  )}
                </div>
                {s.showScrollToBottomButton && s.messages.length > 0 && (
                  <button type="button" onClick={actions.scrollToLastMessage} className="absolute bottom-4 right-6 z-10 p-2 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors" title={t('messaging.scrollToBottom', 'Вниз к последнему сообщению')}>
                    <ChevronDown className="w-5 h-5" />
                  </button>
                )}
              </div>

              {/* AI Commands Menu */}
              {s.showCommandsMenu && (
                <div className="commands-menu px-4 pt-2 pb-2 bg-muted/30 border-t border-border">
                  <div className="flex items-center gap-2">
                    <button
                      disabled={!convId}
                      onClick={() => { s.setShowCommandsMenu(false); if (s.rightPanelOpen !== true) s.setRightPanelOpen(true); }}
                      className="flex items-center gap-2 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <FileText className="w-4 h-4 text-blue-600" />{t('messaging.aiCmdSummaryShort', 'Summarize')}
                    </button>
                    <button
                      disabled={!convId || !isLead}
                      onClick={() => { s.setShowCommandsMenu(false); if (s.rightPanelOpen !== true) s.setRightPanelOpen(true); }}
                      className="flex items-center gap-2 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Sparkles className="w-4 h-4 text-yellow-600" />{t('messaging.aiCmdDraftShort', 'Suggest reply')}
                    </button>
                    {s.selectedChat?.contact_id && s.selectedChat?.peer_type === 'user' && (
                      <button
                        onClick={() => { s.setShowCommandsMenu(false); s.setAddToFunnelFromChat({ contactId: s.selectedChat!.contact_id!, contactName: actions.getChatNameWithOverrides(s.selectedChat!), leadTitle: actions.getChatNameWithOverrides(s.selectedChat!), bdAccountId: s.selectedAccountId ?? undefined, channel: s.selectedChat!.channel, channelId: s.selectedChat!.channel_id }); }}
                        className="flex items-center gap-2 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-accent"
                      >
                        <Filter className="w-4 h-4 text-green-600" />{t('pipeline.addToFunnel')}
                      </button>
                    )}
                    <button onClick={() => s.setShowCommandsMenu(false)} className="ml-auto p-1.5 text-muted-foreground hover:text-foreground"><X className="w-4 h-4" /></button>
                  </div>
                </div>
              )}

              {/* Message Composer */}
              <div className="p-4 bg-card border-t border-border">
                {s.pendingFile && (
                  <div className="flex items-center gap-2 mb-2 py-1.5 px-2 rounded-lg bg-muted/60 text-sm">
                    <Paperclip className="w-4 h-4 text-muted-foreground shrink-0" />
                    <span className="truncate flex-1" title={s.pendingFile.name}>{s.pendingFile.name}</span>
                    <button type="button" onClick={() => { s.setPendingFile(null); if (s.fileInputRef.current) s.fileInputRef.current.value = ''; }} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground" title={t('messaging.removeFile')}><X className="w-4 h-4" /></button>
                  </div>
                )}
                {s.replyToMessage && (
                  <div className="flex items-center gap-2 mb-2 py-1.5 px-3 rounded-lg bg-muted/60 border-l-2 border-primary text-sm min-h-0">
                    <Reply className="w-4 h-4 text-primary shrink-0" />
                    <span className="text-muted-foreground truncate flex-1 min-w-0 break-words">{(s.replyToMessage.content ?? '').trim().slice(0, 50) || t('messaging.replyPreviewMedia')}{(s.replyToMessage.content ?? '').trim().length > 50 ? '…' : ''}</span>
                    <button type="button" onClick={() => s.setReplyToMessage(null)} className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground shrink-0" title={t('common.close')}><X className="w-4 h-4" /></button>
                  </div>
                )}
                <div className="flex items-end gap-2">
                  <div className="relative attach-menu">
                    <button onClick={() => canWriteFromSelectedAccount && s.setShowAttachMenu(!s.showAttachMenu)} disabled={!canWriteFromSelectedAccount} className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed" title={t('messaging.attachFile')}><Paperclip className="w-5 h-5" /></button>
                    {s.showAttachMenu && (
                      <div className="absolute bottom-full left-0 mb-2 bg-card border border-border rounded-lg shadow-lg p-2 z-10 min-w-[180px]">
                        <button onClick={actions.handleAttachFile} className="w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-accent rounded-lg"><Image className="w-4 h-4 text-blue-600" />{t('messaging.photo')}</button>
                        <button onClick={actions.handleAttachFile} className="w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-accent rounded-lg"><Video className="w-4 h-4 text-red-600" />{t('messaging.video')}</button>
                        <button onClick={actions.handleAttachFile} className="w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-accent rounded-lg"><File className="w-4 h-4 text-muted-foreground" />{t('messaging.file')}</button>
                      </div>
                    )}
                    <input ref={s.fileInputRef} type="file" className="hidden" accept="image/*,video/*,.pdf,.doc,.docx,.txt,*/*" onChange={actions.handleFileSelect} />
                  </div>
                  <button onClick={actions.handleVoiceMessage} disabled={!canWriteFromSelectedAccount} className={`p-2 rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${s.isRecording ? 'bg-red-100 text-red-600 animate-pulse' : 'text-muted-foreground hover:text-foreground hover:bg-accent'}`} title={t('messaging.voiceMessage')}><Mic className="w-5 h-5" /></button>
                  <div className="flex-1 relative flex items-end min-h-[40px]">
                    <textarea
                      ref={s.messageInputRef}
                      placeholder={canWriteFromSelectedAccount ? t('messaging.writeMessage') : (currentUser?.role?.toLowerCase() === 'bidi' ? t('messaging.agentViewOnly', 'View only — you can send only from accounts you connected') : t('messaging.colleagueViewOnly'))}
                      value={s.newMessage}
                      onChange={(e) => s.setNewMessage(e.target.value)}
                      onPaste={(e) => {
                        const items = e.clipboardData?.items;
                        if (!items?.length || !canWriteFromSelectedAccount) return;
                        for (let i = 0; i < items.length; i++) {
                          if (items[i].kind === 'file') { const file = items[i].getAsFile(); if (file?.type.startsWith('image/')) { e.preventDefault(); s.setPendingFile(file); return; } }
                        }
                      }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); actions.handleSendMessage(); } }}
                      disabled={!canWriteFromSelectedAccount}
                      rows={1}
                      className="w-full min-h-[40px] max-h-[120px] py-2.5 px-3 pr-10 rounded-xl resize-none border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-hidden focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                    />
                    <button onClick={() => s.setShowCommandsMenu(!s.showCommandsMenu)} className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg transition-colors ${s.showCommandsMenu ? 'bg-blue-100 text-blue-600' : 'text-muted-foreground hover:text-foreground hover:bg-accent'}`} title={t('messaging.crmCommands')}><Bot className="w-4 h-4" /></button>
                  </div>
                  <Button onClick={actions.handleSendMessage} disabled={!canWriteFromSelectedAccount || (!s.newMessage.trim() && !s.pendingFile) || s.sendingMessage} className="px-4" title={!canWriteFromSelectedAccount ? (currentUser?.role?.toLowerCase() === 'bidi' ? t('messaging.agentViewOnly', 'View only — you can send only from accounts you connected') : t('messaging.onlyOwnerCanSend')) : undefined}>
                    {s.sendingMessage ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
                  </Button>
                </div>
                {s.isRecording && (
                  <div className="mt-2 flex items-center gap-2 text-sm text-red-600">
                    <div className="w-2 h-2 bg-red-600 rounded-full animate-pulse" /><span>{t('messaging.recordingVoice')}</span>
                    <button onClick={() => s.setIsRecording(false)} className="ml-auto text-xs text-muted-foreground hover:text-foreground">Отменить</button>
                  </div>
                )}
                {!s.showCommandsMenu && (
                  <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><Bot className="w-3 h-3" /><span>{t('messaging.aiCommandsHint', 'AI commands')}</span></div>
                )}
              </div>
            </>
          ) : (
            <div className="flex-1 min-h-0 flex items-center justify-center bg-muted/20">
              <div className="text-center px-4">
                <MessageSquare className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
                <h3 className="text-lg font-semibold text-foreground mb-2">Выберите чат</h3>
                <p className="text-muted-foreground text-sm">Выберите чат из списка, чтобы начать переписку</p>
              </div>
            </div>
          )}
        </div>

        {/* Right Workspace Panel */}
        <RightWorkspacePanel
          hasChat={!!s.selectedChat}
          isLead={isLead}
          isOpen={s.rightPanelOpen}
          onClose={() => s.setRightPanelOpen(false)}
          activeTab={s.rightPanelTab}
          onTabChange={(tab) => { s.setRightPanelTab(tab); s.setRightPanelOpen(true); if (tab === 'lead_card' && convId) s.setLeadPanelOpenByConvId((prev) => ({ ...prev, [convId]: true })); }}
          tabLabels={{ ai: t('messaging.aiAssistantTitle', 'ИИ-помощник'), lead: t('messaging.leadCard') }}
          leadCardContent={
            <div className="flex-1 min-h-0 overflow-y-auto">
              {s.leadContextLoading ? <div className="flex items-center justify-center p-6"><Loader2 className="w-6 h-6 animate-spin text-muted-foreground" /></div>
              : s.leadContextError ? <div className="p-4 text-sm text-destructive">{s.leadContextError}</div>
              : s.leadContext ? (
                <div className="space-y-4 px-4 py-4">
                  <div className="flex items-start gap-3">
                    <LeadContextAvatarFromContext leadContext={s.leadContext} bdAccountId={s.selectedAccountId} className="w-10 h-10 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <h3 className="font-heading text-base font-semibold text-foreground truncate">{s.leadContext.contact_name || (s.selectedChat && actions.getChatNameWithOverrides(s.selectedChat)) || '—'}</h3>
                      <p className="text-sm text-muted-foreground mt-0.5 truncate">{s.leadContext.company_name || (s.leadContext.contact_username ? `@${String(s.leadContext.contact_username).replace(/^@/, '')}` : null) || '—'}</p>
                      <span className="inline-block mt-1.5 text-[10px] font-medium px-2 py-0.5 rounded-md bg-primary/15 text-primary">{t('messaging.badgeLead')}</span>
                    </div>
                  </div>
                  <dl className="grid grid-cols-1 gap-2 text-sm">
                    <div><dt className="text-muted-foreground text-xs">{t('crm.pipelineStage', 'Воронка / Стадия')}</dt><dd className="font-medium text-foreground truncate mt-0.5">{s.leadContext.pipeline.name} → {s.leadContext.stage.name}</dd></div>
                    <div><dt className="text-muted-foreground text-xs">{t('crm.amount', 'Сумма')}</dt><dd className="font-medium text-foreground mt-0.5">{s.leadContext.won_at && s.leadContext.revenue_amount != null && s.leadContext.revenue_amount > 0 ? formatDealAmount(s.leadContext.revenue_amount, 'EUR') : '—'}</dd></div>
                  </dl>
                  <div className="border-t border-border pt-3 space-y-2">
                    {s.leadContext.campaign != null && !s.leadContext.shared_chat_created_at && (
                      <Button variant="primary" size="sm" className="w-full justify-center" onClick={() => { const template = s.leadContext!.shared_chat_settings?.titleTemplate ?? 'Чат: {{contact_name}}'; s.setCreateSharedChatTitle(template.replace(/\{\{\s*contact_name\s*\}\}/gi, (s.leadContext!.contact_name || 'Контакт').trim()).trim()); s.setCreateSharedChatExtraUsernames(s.leadContext!.shared_chat_settings?.extraUsernames ?? []); s.setCreateSharedChatNewUsername(''); s.setCreateSharedChatModalOpen(true); }}>{t('messaging.createSharedChat')}</Button>
                    )}
                    {s.leadContext.campaign != null && s.leadContext.shared_chat_created_at && (
                      <div className="flex flex-col gap-1.5">
                        <div className="text-xs font-medium text-emerald-600 dark:text-emerald-400">✓ {t('messaging.sharedChatCreated', 'Общий чат создан')}</div>
                        {(s.leadContext.shared_chat_invite_link?.trim() || s.leadContext.shared_chat_channel_id != null) && (
                          <a href={s.leadContext.shared_chat_invite_link?.trim() || (() => { const raw = Number(s.leadContext!.shared_chat_channel_id); const id = Number.isNaN(raw) ? String(s.leadContext!.shared_chat_channel_id).replace(/^-100/, '') : String(Math.abs(raw)); return `https://t.me/c/${id}`; })()} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline">{t('messaging.openInTelegram', 'Открыть в Telegram')}<ExternalLink className="w-3.5 h-3.5" /></a>
                        )}
                      </div>
                    )}
                    {s.leadContext.shared_chat_created_at && !s.leadContext.won_at && !s.leadContext.lost_at && (
                      <div className="flex gap-2">
                        <Button variant="primary" size="sm" className="flex-1 bg-emerald-600 hover:bg-emerald-700" onClick={() => { s.setMarkWonRevenue(''); s.setMarkWonModalOpen(true); }}>✓ {t('messaging.markWon', 'Закрыть сделку')}</Button>
                        <Button variant="outline" size="sm" className="flex-1 text-muted-foreground hover:text-destructive hover:border-destructive/50" onClick={() => { s.setMarkLostReason(''); s.setMarkLostModalOpen(true); }}>✕ {t('messaging.markLost', 'Потеряно')}</Button>
                      </div>
                    )}
                    {s.leadContext.won_at && <div className="text-xs font-medium text-emerald-600 dark:text-emerald-400">✓ {t('messaging.dealWon', 'Сделка закрыта')}{s.leadContext.revenue_amount != null && s.leadContext.revenue_amount > 0 ? ` — ${formatDealAmount(s.leadContext.revenue_amount, 'EUR')}` : ''}</div>}
                    {s.leadContext.lost_at && <div className="text-xs text-muted-foreground">✕ {t('messaging.dealLost', 'Сделка потеряна')}</div>}
                  </div>
                  {s.leadContext.contact_id && (
                    <div className="grid grid-cols-3 gap-2">
                      <Button variant="outline" size="sm" className="justify-center gap-1.5" onClick={() => s.setLeadNoteModalOpen(true)}>
                        <StickyNote className="w-4 h-4" />
                        <span className="text-xs">{t('pipeline.dealFormAddNote', 'Добавить заметку')}</span>
                      </Button>
                      <Button variant="outline" size="sm" className="justify-center gap-1.5" onClick={() => s.setLeadReminderModalOpen(true)}>
                        <Bell className="w-4 h-4" />
                        <span className="text-xs">{t('pipeline.dealFormAddReminder', 'Добавить напоминание')}</span>
                      </Button>
                      <a href={`/dashboard/messaging?contactId=${s.leadContext.contact_id}`} className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium hover:bg-accent hover:text-accent-foreground transition-colors">
                        <MessageSquare className="w-4 h-4" />
                        <span className="text-xs">{t('pipeline.dealFormOpenChat', 'Открыть чат')}</span>
                      </a>
                    </div>
                  )}
                  <Button variant="outline" size="sm" className="w-full justify-center gap-2" onClick={() => s.setLeadCardModalOpen(true)}><User className="w-4 h-4" />{t('messaging.openLeadCard', 'Открыть карточку лида')}</Button>
                </div>
              ) : null}
            </div>
          }
          aiAssistantContent={<AIAssistantTabContent conversationId={convId} bdAccountId={s.selectedAccountId} onInsertDraft={(text) => s.setNewMessage(text)} isLead={isLead} />}
        />

        {/* Lead Card Modal — same as on Pipeline */}
        <LeadCardModal
          leadId={s.leadContext?.lead_id ?? null}
          open={s.leadCardModalOpen}
          onClose={() => s.setLeadCardModalOpen(false)}
          onLeadUpdated={() => {
            const leadId = s.leadContext?.lead_id;
            if (leadId) fetchLeadContextByLeadId(leadId).then((data) => s.setLeadContext(data as LeadContext)).catch(() => {});
          }}
        />
      </div>

      {/* ─── Shared Chat Modal ─── */}
      <Modal isOpen={s.createSharedChatModalOpen} onClose={() => !s.createSharedChatSubmitting && s.setCreateSharedChatModalOpen(false)} title={t('messaging.createSharedChatModalTitle', 'Создать общий чат в Telegram')} size="md">
        <div className="px-6 py-4 space-y-5">
          <p className="text-sm text-muted-foreground">{t('messaging.createSharedChatModalDesc', 'Будет создана группа в Telegram.')}</p>
          <div className="space-y-2"><label className="block text-sm font-medium text-foreground">{t('messaging.sharedChatTitle', 'Название чата')}</label><Input value={s.createSharedChatTitle} onChange={(e) => s.setCreateSharedChatTitle(e.target.value)} placeholder={t('messaging.sharedChatTitlePlaceholder', 'Чат: Имя контакта')} className="w-full" maxLength={255} /></div>
          <div className="space-y-2"><label className="block text-sm font-medium text-foreground">{t('messaging.sharedChatParticipants', 'Участники')}</label><div className="rounded-lg border border-border bg-muted/20 p-3 space-y-2"><div className="flex items-center gap-2 text-sm"><span className="text-muted-foreground shrink-0">{t('messaging.sharedChatLeadParticipant', 'Лид')}:</span><span className="font-medium text-foreground truncate">{s.leadContext?.contact_username ? `@${s.leadContext.contact_username}` : s.leadContext?.contact_name || '—'}</span></div>{s.createSharedChatExtraUsernames.length > 0 && <div className="flex flex-wrap gap-2 pt-1 border-t border-border">{s.createSharedChatExtraUsernames.map((u, i) => <span key={i} className="inline-flex items-center gap-1.5 rounded-md bg-background border border-border px-2.5 py-1 text-sm">@{u}<button type="button" onClick={() => s.setCreateSharedChatExtraUsernames((prev) => prev.filter((_, j) => j !== i))} className="text-muted-foreground hover:text-destructive rounded p-0.5"><X className="w-3.5 h-3.5" /></button></span>)}</div>}<div className="flex gap-2 pt-1"><input type="text" value={s.createSharedChatNewUsername} onChange={(e) => s.setCreateSharedChatNewUsername(e.target.value)} placeholder={t('messaging.sharedChatAddUsername', 'Добавить @username')} className="flex-1 min-w-0 rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); const v = s.createSharedChatNewUsername.trim().replace(/^@/, ''); if (v) { s.setCreateSharedChatExtraUsernames((prev) => prev.includes(v) ? prev : [...prev, v]); s.setCreateSharedChatNewUsername(''); } } }} /><Button type="button" variant="secondary" size="sm" onClick={() => { const v = s.createSharedChatNewUsername.trim().replace(/^@/, ''); if (v) { s.setCreateSharedChatExtraUsernames((prev) => prev.includes(v) ? prev : [...prev, v]); s.setCreateSharedChatNewUsername(''); } }}>{t('common.add', 'Добавить')}</Button></div></div></div>
          <div className="flex justify-end gap-3 pt-2"><Button variant="outline" onClick={() => s.setCreateSharedChatModalOpen(false)} disabled={s.createSharedChatSubmitting}>{t('global.cancel', 'Отмена')}</Button><Button onClick={async () => { if (!s.leadContext) return; s.setCreateSharedChatSubmitting(true); try { await apiClient.post('/api/messaging/create-shared-chat', { conversation_id: s.leadContext.conversation_id, title: s.createSharedChatTitle.trim() || undefined, participant_usernames: s.createSharedChatExtraUsernames }); const res = await apiClient.get<LeadContext>(`/api/messaging/conversations/${s.leadContext.conversation_id}/lead-context`); s.setLeadContext(res.data); s.setCreateSharedChatModalOpen(false); } catch (e: unknown) { const status = (e as { response?: { status?: number } })?.response?.status; if (status === 409) { const res = await apiClient.get<LeadContext>(`/api/messaging/conversations/${s.leadContext!.conversation_id}/lead-context`); s.setLeadContext(res.data); s.setCreateSharedChatModalOpen(false); } else console.error('create-shared-chat failed', e); } finally { s.setCreateSharedChatSubmitting(false); } }} disabled={s.createSharedChatSubmitting || !s.createSharedChatTitle.trim()}>{s.createSharedChatSubmitting ? <Loader2 className="w-4 h-4 animate-spin shrink-0" /> : null}{s.createSharedChatSubmitting ? t('messaging.creating', 'Создание…') : t('messaging.createSharedChat', 'Создать общий чат')}</Button></div>
        </div>
      </Modal>

      {/* ─── Won / Lost Modals ─── */}
      <Modal isOpen={s.markWonModalOpen} onClose={() => !s.markWonSubmitting && s.setMarkWonModalOpen(false)} title={t('messaging.markWonModalTitle', 'Закрыть сделку')} size="sm">
        <div className="px-6 py-4 space-y-4"><p className="text-sm text-muted-foreground">{t('messaging.markWonConfirm', 'Действие необратимо.')}</p><div><label className="block text-sm font-medium text-foreground mb-1.5">{t('messaging.revenueAmount', 'Сумма сделки')}</label><input type="number" min="0" step="0.01" value={s.markWonRevenue} onChange={(e) => s.setMarkWonRevenue(e.target.value)} placeholder="0" className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground" /><p className="text-xs text-muted-foreground mt-1">€</p></div><div className="flex justify-end gap-2 pt-2"><Button variant="outline" onClick={() => s.setMarkWonModalOpen(false)} disabled={s.markWonSubmitting}>{t('common.cancel')}</Button><Button onClick={async () => { if (!s.leadContext) return; const amount = s.markWonRevenue.trim() ? parseFloat(s.markWonRevenue.replace(',', '.')) : null; if (amount != null && (Number.isNaN(amount) || amount < 0)) return; s.setMarkWonSubmitting(true); try { await apiClient.post('/api/messaging/mark-won', { conversation_id: s.leadContext.conversation_id, ...(amount != null && !Number.isNaN(amount) ? { revenue_amount: amount } : {}) }); const res = await apiClient.get<LeadContext>(`/api/messaging/conversations/${s.leadContext.conversation_id}/lead-context`); s.setLeadContext(res.data); s.setMarkWonModalOpen(false); } catch (e) { console.error('mark-won failed', e); } finally { s.setMarkWonSubmitting(false); } }} disabled={s.markWonSubmitting}>{s.markWonSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}{s.markWonSubmitting ? t('common.saving') : t('messaging.closeDeal', 'Закрыть сделку')}</Button></div></div>
      </Modal>
      <Modal isOpen={s.markLostModalOpen} onClose={() => !s.markLostSubmitting && s.setMarkLostModalOpen(false)} title={t('messaging.markLostModalTitle', 'Отметить как потеряно')} size="sm">
        <div className="px-6 py-4 space-y-4"><p className="text-sm text-muted-foreground">{t('messaging.markLostConfirm', 'Действие необратимо.')}</p><div><label className="block text-sm font-medium text-foreground mb-1.5">{t('messaging.lossReason', 'Причина (необязательно)')}</label><textarea value={s.markLostReason} onChange={(e) => s.setMarkLostReason(e.target.value)} placeholder={t('messaging.lossReasonPlaceholder', 'Например: отказ')} rows={3} className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground resize-none" /></div><div className="flex justify-end gap-2 pt-2"><Button variant="outline" onClick={() => s.setMarkLostModalOpen(false)} disabled={s.markLostSubmitting}>{t('common.cancel')}</Button><Button variant="danger" onClick={async () => { if (!s.leadContext) return; s.setMarkLostSubmitting(true); try { await apiClient.post('/api/messaging/mark-lost', { conversation_id: s.leadContext.conversation_id, reason: s.markLostReason.trim() || undefined }); const res = await apiClient.get<LeadContext>(`/api/messaging/conversations/${s.leadContext.conversation_id}/lead-context`); s.setLeadContext(res.data); s.setMarkLostModalOpen(false); } catch (e) { console.error('mark-lost failed', e); } finally { s.setMarkLostSubmitting(false); } }} disabled={s.markLostSubmitting}>{s.markLostSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}{s.markLostSubmitting ? t('common.saving') : t('messaging.markAsLost', 'Отметить как потеряно')}</Button></div></div>
      </Modal>

      {/* ─── Context Menus ─── */}
      <ContextMenu open={!!(s.chatContextMenu && s.selectedAccountId)} onClose={() => s.setChatContextMenu(null)} x={s.chatContextMenu?.x ?? 0} y={s.chatContextMenu?.y ?? 0} className="min-w-[180px]" estimatedHeight={320}>
        {s.chatContextMenu && s.selectedAccountId && (<>
          {actions.pinnedSet.has(s.chatContextMenu.chat.channel_id)
            ? <ContextMenuItem icon={<PinOff className="w-4 h-4" />} label={t('messaging.unpinChat')} onClick={() => actions.handleUnpinChat(s.chatContextMenu!.chat)} />
            : <ContextMenuItem icon={<Pin className="w-4 h-4" />} label={t('messaging.pinChat')} onClick={() => actions.handlePinChat(s.chatContextMenu!.chat)} />}
          {s.chatContextMenu.chat.contact_id && s.chatContextMenu.chat.peer_type === 'user' && <ContextMenuItem icon={<Filter className="w-4 h-4" />} label={t('pipeline.addToFunnel')} onClick={() => { s.setChatContextMenu(null); s.setAddToFunnelFromChat({ contactId: s.chatContextMenu!.chat.contact_id!, contactName: actions.getChatNameWithOverrides(s.chatContextMenu!.chat), leadTitle: actions.getChatNameWithOverrides(s.chatContextMenu!.chat), bdAccountId: s.selectedAccountId ?? undefined, channel: s.chatContextMenu!.chat.channel, channelId: s.chatContextMenu!.chat.channel_id }); }} />}
          <ContextMenuSection label={t('messaging.addToFolder')}>
            <ContextMenuItem label={t('messaging.folderNone')} onClick={() => actions.handleChatFoldersClear(s.chatContextMenu!.chat)} />
            {actions.displayFolders.filter((f) => f.folder_id !== 0).length === 0 ? <ContextMenuItem label={t('messaging.folderNoFolders')} disabled /> : actions.displayFolders.filter((f) => f.folder_id !== 0).map((f) => { const isIn = actions.chatFolderIds(s.chatContextMenu!.chat).includes(f.folder_id); return <ContextMenuItem key={f.id} icon={isIn ? <Check className="w-4 h-4 text-primary" /> : undefined} label={<><span className="truncate flex-1">{f.folder_title}</span><span className="text-[10px] text-muted-foreground shrink-0">{f.is_user_created ? 'CRM' : 'TG'}</span></>} onClick={() => actions.handleChatFoldersToggle(s.chatContextMenu!.chat, f.folder_id)} />; })}
          </ContextMenuSection>
          {actions.isSelectedAccountMine && (<><div className="border-t border-border my-1" /><ContextMenuItem icon={<Trash2 className="w-4 h-4" />} label={t('messaging.deleteChat')} destructive onClick={() => actions.handleRemoveChat(s.chatContextMenu!.chat)} /></>)}
        </>)}
      </ContextMenu>

      <FolderManageModal open={s.showFolderManageModal} onClose={() => s.setShowFolderManageModal(false)} folders={s.folders} onFoldersChange={s.setFolders} selectedAccountId={s.selectedAccountId} isAccountOwner={!!actions.isSelectedAccountMine} hideEmptyFolders={s.hideEmptyFolders} onHideEmptyFoldersChange={s.setHideEmptyFolders} onCreateFolder={actions.handleCreateFolder} onReorder={actions.handleReorderFolders} onUpdateFolder={actions.handleUpdateFolder} onDeleteFolder={actions.handleDeleteFolder} onFolderDeleted={actions.handleFolderDeleted} />
      <AddToFunnelModal
        isOpen={!!s.addToFunnelFromChat}
        onClose={() => s.setAddToFunnelFromChat(null)}
        contactId={s.addToFunnelFromChat?.contactId ?? ''}
        contactName={s.addToFunnelFromChat?.contactName}
        leadTitle={s.addToFunnelFromChat?.leadTitle}
        defaultPipelineId={typeof window !== 'undefined' ? window.localStorage.getItem('pipeline.selectedPipelineId') : null}
        onSuccess={() => {
          const channelId = s.addToFunnelFromChat?.channelId;
          data.getChats().then((chats) => {
            if (!chats?.length || !channelId) return;
            const updated = chats.find((c) => c.channel_id === channelId);
            if (updated) {
              if (s.selectedChat?.channel_id === channelId) s.setSelectedChat(updated);
              s.setChatContextMenu((prev) => (prev?.chat.channel_id === channelId ? { ...prev, chat: updated } : prev));
            }
            s.setRightPanelTab('lead_card');
            s.setRightPanelOpen(true);
            const cid = updated?.conversation_id ?? s.selectedChat?.conversation_id;
            if (cid) s.setLeadPanelOpenByConvId((prev) => ({ ...prev, [cid]: true }));
          });
        }}
      />

      {s.broadcastModalOpen && s.selectedAccountId && <BroadcastToGroupsModal accountId={s.selectedAccountId} accountName={s.accounts.find((a) => a.id === s.selectedAccountId) ? getAccountDisplayName(s.accounts.find((a) => a.id === s.selectedAccountId)!) : ''} onClose={() => s.setBroadcastModalOpen(false)} />}

      <ContextMenu open={!!s.accountContextMenu} onClose={() => s.setAccountContextMenu(null)} x={s.accountContextMenu?.x ?? 0} y={s.accountContextMenu?.y ?? 0} className="min-w-[160px]">
        {s.accountContextMenu && <ContextMenuItem icon={<Settings className="w-4 h-4" />} label={t('messaging.accountSettings')} onClick={() => { s.setAccountContextMenu(null); window.location.href = `/dashboard/bd-accounts?accountId=${s.accountContextMenu!.account.id}`; }} />}
      </ContextMenu>

      <ContextMenu open={!!s.messageContextMenu} onClose={() => s.setMessageContextMenu(null)} x={s.messageContextMenu?.x ?? 0} y={s.messageContextMenu?.y ?? 0} className="min-w-[180px]" estimatedHeight={320}>
        {s.messageContextMenu && (<>
          <ContextMenuItem icon={<Reply className="w-4 h-4" />} label={t('messaging.reply')} onClick={() => actions.handleReplyToMessage(s.messageContextMenu!.message)} />
          <ContextMenuItem icon={<Forward className="w-4 h-4" />} label={t('messaging.forward')} onClick={() => actions.handleForwardMessage(s.messageContextMenu!.message)} />
          <ContextMenuItem icon={<Copy className="w-4 h-4" />} label={t('messaging.copyText')} onClick={() => actions.handleCopyMessageText(s.messageContextMenu!.message)} />
          <ContextMenuItem icon={<Heart className="w-4 h-4" />} label={s.messageContextMenu.message.reactions?.['❤️'] ? t('messaging.unlike') : t('messaging.like')} onClick={() => actions.handleReaction(s.messageContextMenu!.message.id, '❤️')} />
          <ContextMenuSection label={t('messaging.reaction')}>
            <div className="flex flex-wrap gap-1 px-2 pb-2">{REACTION_EMOJI.map((emoji) => <button key={emoji} type="button" className="p-1.5 rounded hover:bg-accent text-lg leading-none" onClick={() => actions.handleReaction(s.messageContextMenu!.message.id, emoji)} title={emoji}>{emoji}</button>)}</div>
          </ContextMenuSection>
          <div className="border-t border-border my-1" />
          <ContextMenuItem icon={s.deletingMessageId === s.messageContextMenu.message.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />} label={t('messaging.deleteMessage')} destructive onClick={() => actions.handleDeleteMessage(s.messageContextMenu!.message.id)} disabled={s.deletingMessageId === s.messageContextMenu.message.id} />
        </>)}
      </ContextMenu>

      {s.leadContext?.contact_id && (
        <>
          <AddNoteModal
            open={s.leadNoteModalOpen}
            onClose={() => s.setLeadNoteModalOpen(false)}
            contactId={s.leadContext.contact_id}
            onSuccess={() => fetchContactNotes(s.leadContext!.contact_id!).then(s.setLeadNotes)}
          />
          <AddReminderModal
            open={s.leadReminderModalOpen}
            onClose={() => s.setLeadReminderModalOpen(false)}
            contactId={s.leadContext.contact_id}
            onSuccess={() => fetchContactReminders(s.leadContext!.contact_id!).then(s.setLeadReminders)}
          />
        </>
      )}

      {s.mediaViewer && <MediaViewer url={s.mediaViewer.url} type={s.mediaViewer.type} onClose={() => s.setMediaViewer(null)} />}
      {s.forwardModal && s.selectedAccountId && <ForwardMessageModal selectedAccountId={s.selectedAccountId} displayChats={actions.displayChats} currentChannelId={s.selectedChat?.channel_id ?? null} forwardingToChatId={s.forwardingToChatId} getChatNameWithOverrides={actions.getChatNameWithOverrides} onForward={actions.handleForwardToChat} onClose={() => { s.setForwardModal(null); s.setForwardingToChatId(null); }} />}
    </div>
  );
}
