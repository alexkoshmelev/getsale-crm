'use client';

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useAuthStore } from '@/lib/stores/auth-store';
import {
  Loader2, Filter,
  Settings, Trash2, Pin, PinOff, Reply, Forward, Copy, Heart, Check,
} from 'lucide-react';
import { ContextMenu, ContextMenuSection, ContextMenuItem } from '@/components/ui/ContextMenu';
import { MediaViewer } from '@/components/messaging/MediaViewer';
import { FolderManageModal } from '@/components/messaging/FolderManageModal';
import { AddToFunnelModal } from '@/components/crm/AddToFunnelModal';
import { LeadCardModal } from '@/components/pipeline/LeadCardModal';
import { RightWorkspacePanel } from '@/components/messaging/RightWorkspacePanel';
import { AccountList } from '@/components/messaging/AccountList';
import { ChatList } from '@/components/messaging/ChatList';
import { BroadcastToGroupsModal } from '@/components/messaging/BroadcastToGroupsModal';
import { ForwardMessageModal } from '@/components/messaging/ForwardMessageModal';
import { AddNoteModal } from '@/components/messaging/AddNoteModal';
import { AddReminderModal } from '@/components/messaging/AddReminderModal';
import { SharedChatModal } from '@/components/messaging/SharedChatModal';
import { MarkDealWonModal } from '@/components/messaging/MarkDealWonModal';
import { MarkDealLostModal } from '@/components/messaging/MarkDealLostModal';
import { LeadCardPanelContent } from '@/components/messaging/LeadCardPanelContent';
import { ChatView } from '@/components/messaging/ChatView';
import dynamic from 'next/dynamic';
import { fetchLeadContextByLeadId } from '@/lib/api/messaging';
import { fetchContactNotes, fetchContactReminders } from '@/lib/api/crm';
import type { LeadContext, Message } from './types';
import { REACTION_EMOJI } from './types';
import { getAccountDisplayName } from './utils';
import { useMessagingState } from './hooks/useMessagingState';
import { useMessagingData } from './hooks/useMessagingData';
import { useMessagingWebSocket } from './hooks/useMessagingWebSocket';
import { useMessagingActions } from './hooks/useMessagingActions';
import { safeGetItem } from '@/lib/safe-storage';

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

  const handleSelectChat = useCallback((chat: Parameters<typeof s.setSelectedChat>[0]) => {
    s.setSelectedChat(chat);
    const chatObj = typeof chat === 'function' ? null : chat;
    if (chatObj && s.selectedAccountId) {
      const q = new URLSearchParams(searchParams?.toString() ?? '');
      q.set('bdAccountId', s.selectedAccountId);
      q.set('open', chatObj.channel_id);
      router.replace(`${pathname}?${q.toString()}`, { scroll: false });
    }
  }, [s.setSelectedChat, s.selectedAccountId, pathname, router, searchParams]);

  const { convId, isLead, isLeadPanelOpen } = data;
  const canWriteFromSelectedAccount = currentUser?.role?.toLowerCase() !== 'bidi' || actions.isSelectedAccountMine === true;
  const selectedAccountDisplayName = s.selectedAccountId && s.accounts.length > 0
    ? (() => { const a = s.accounts.find((ac) => ac.id === s.selectedAccountId); return a ? getAccountDisplayName(a) : null; })()
    : null;

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
          <ChatView
            s={s}
            actions={actions}
            isLead={isLead}
            isLeadPanelOpen={isLeadPanelOpen}
            convId={convId}
            canWriteFromSelectedAccount={canWriteFromSelectedAccount}
            currentUserRole={currentUser?.role?.toLowerCase()}
            onContextMenuMessage={handleContextMenuMessage}
          />
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
            <LeadCardPanelContent
              leadContext={s.leadContext}
              loading={s.leadContextLoading}
              error={s.leadContextError}
              selectedAccountId={s.selectedAccountId}
              chatName={s.selectedChat ? actions.getChatNameWithOverrides(s.selectedChat) : ''}
              notes={s.leadNotes}
              reminders={s.leadReminders}
              onNotesChange={s.setLeadNotes}
              onRemindersChange={s.setLeadReminders}
              onCreateSharedChat={() => s.setCreateSharedChatModalOpen(true)}
              onMarkWon={() => s.setMarkWonModalOpen(true)}
              onMarkLost={() => s.setMarkLostModalOpen(true)}
              onAddNote={() => s.setLeadNoteModalOpen(true)}
              onAddReminder={() => s.setLeadReminderModalOpen(true)}
              onOpenLeadCard={() => s.setLeadCardModalOpen(true)}
            />
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

      <SharedChatModal
        isOpen={s.createSharedChatModalOpen}
        onClose={() => s.setCreateSharedChatModalOpen(false)}
        leadContext={s.leadContext}
        selectedAccountId={s.selectedAccountId}
        selectedAccountName={selectedAccountDisplayName}
        onSuccess={(ctx) => { s.setLeadContext(ctx); s.setCreateSharedChatModalOpen(false); data.fetchChats(); }}
      />
      <MarkDealWonModal isOpen={s.markWonModalOpen} onClose={() => s.setMarkWonModalOpen(false)} leadContext={s.leadContext} onSuccess={(ctx) => { s.setLeadContext(ctx); s.setMarkWonModalOpen(false); }} />
      <MarkDealLostModal isOpen={s.markLostModalOpen} onClose={() => s.setMarkLostModalOpen(false)} leadContext={s.leadContext} onSuccess={(ctx) => { s.setLeadContext(ctx); s.setMarkLostModalOpen(false); }} />

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
      <AddToFunnelModal isOpen={!!s.addToFunnelFromChat} onClose={() => s.setAddToFunnelFromChat(null)} contactId={s.addToFunnelFromChat?.contactId ?? ''} contactName={s.addToFunnelFromChat?.contactName} leadTitle={s.addToFunnelFromChat?.leadTitle} defaultPipelineId={safeGetItem('pipeline.selectedPipelineId')} onSuccess={() => { const channelId = s.addToFunnelFromChat?.channelId; data.getChats().then((chats) => { if (!chats?.length || !channelId) return; const updated = chats.find((c) => c.channel_id === channelId); if (updated) { if (s.selectedChat?.channel_id === channelId) s.setSelectedChat(updated); s.setChatContextMenu((prev) => (prev?.chat.channel_id === channelId ? { ...prev, chat: updated } : prev)); } s.setRightPanelTab('lead_card'); s.setRightPanelOpen(true); const cid = updated?.conversation_id ?? s.selectedChat?.conversation_id; if (cid) s.setLeadPanelOpenByConvId((prev) => ({ ...prev, [cid]: true })); }); }} />

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
