'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Loader2, MessageSquare, MoreVertical, Paperclip, Send, Mic, Bot,
  X, ChevronDown, UserCircle, Filter, Image, Video, File,
  FileText, Sparkles,
} from 'lucide-react';
import { Virtuoso } from 'react-virtuoso';
import { Button } from '@/components/ui/Button';
import { MessageBubble } from '@/components/messaging/MessageBubble';
import { EditContactNameModal } from '@/components/messaging/EditContactNameModal';
import { EmptyMessagingState } from '@/components/messaging/EmptyMessagingState';
import type { MessagingState } from '@/app/dashboard/messaging/hooks/useMessagingState';
import type { Message } from '@/app/dashboard/messaging/types';
import { VIRTUAL_LIST_THRESHOLD, INITIAL_FIRST_ITEM_INDEX } from '@/app/dashboard/messaging/types';
import { isBdAgentRole } from '@/lib/permissions';

interface ChatViewProps {
  s: MessagingState;
  actions: {
    getChatNameWithOverrides: (chat: NonNullable<MessagingState['selectedChat']>) => string;
    setLeadPanelOpen: (open: boolean) => void;
    openEditNameModal: () => void;
    saveDisplayName: () => Promise<void>;
    loadOlderMessages: () => Promise<void>;
    hasMoreMessages: boolean;
    scrollToLastMessage: () => void;
    scrollToMessageByTelegramId: (id: string) => void;
    handleSendMessage: () => Promise<void>;
    handleVoiceMessage: () => void;
    handleAttachFile: () => void;
    handleFileSelect: (e: React.ChangeEvent<HTMLInputElement>) => void;
  };
  isLead: boolean;
  isLeadPanelOpen: boolean;
  convId: string | null;
  canWriteFromSelectedAccount: boolean;
  currentUserRole: string | undefined;
  onContextMenuMessage: (e: React.MouseEvent, msg: Message) => void;
}

export function ChatView({
  s, actions, isLead, isLeadPanelOpen, convId,
  canWriteFromSelectedAccount, currentUserRole, onContextMenuMessage,
}: ChatViewProps) {
  const { t } = useTranslation();

  if (!s.selectedChat) return <EmptyMessagingState />;

  return (
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
                    onContextMenu={onContextMenuMessage}
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
                    onContextMenu={onContextMenuMessage}
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
            <button disabled={!convId} onClick={() => { s.setShowCommandsMenu(false); if (s.rightPanelOpen !== true) s.setRightPanelOpen(true); }} className="flex items-center gap-2 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed">
              <FileText className="w-4 h-4 text-blue-600" />{t('messaging.aiCmdSummaryShort', 'Summarize')}
            </button>
            <button disabled={!convId || !isLead} onClick={() => { s.setShowCommandsMenu(false); if (s.rightPanelOpen !== true) s.setRightPanelOpen(true); }} className="flex items-center gap-2 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed">
              <Sparkles className="w-4 h-4 text-yellow-600" />{t('messaging.aiCmdDraftShort', 'Suggest reply')}
            </button>
            {s.selectedChat?.contact_id && s.selectedChat?.peer_type === 'user' && (
              <button onClick={() => { s.setShowCommandsMenu(false); s.setAddToFunnelFromChat({ contactId: s.selectedChat!.contact_id!, contactName: actions.getChatNameWithOverrides(s.selectedChat!), leadTitle: actions.getChatNameWithOverrides(s.selectedChat!), bdAccountId: s.selectedAccountId ?? undefined, channel: s.selectedChat!.channel, channelId: s.selectedChat!.channel_id }); }} className="flex items-center gap-2 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-accent">
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
              placeholder={canWriteFromSelectedAccount ? t('messaging.writeMessage') : (isBdAgentRole(currentUserRole) ? t('messaging.agentViewOnly', 'View only — you can send only from accounts you connected') : t('messaging.colleagueViewOnly'))}
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
          <Button onClick={actions.handleSendMessage} disabled={!canWriteFromSelectedAccount || (!s.newMessage.trim() && !s.pendingFile) || s.sendingMessage} className="px-4" title={!canWriteFromSelectedAccount ? (isBdAgentRole(currentUserRole) ? t('messaging.agentViewOnly', 'View only — you can send only from accounts you connected') : t('messaging.onlyOwnerCanSend')) : undefined}>
            {s.sendingMessage ? <Loader2 className="w-5 h-5 animate-spin" /> : <Send className="w-5 h-5" />}
          </Button>
        </div>
        {s.isRecording && (
          <div className="mt-2 flex items-center gap-2 text-sm text-red-600">
            <div className="w-2 h-2 bg-red-600 rounded-full animate-pulse" /><span>{t('messaging.recordingVoice')}</span>
            <button onClick={() => s.setIsRecording(false)} className="ml-auto text-xs text-muted-foreground hover:text-foreground">{t('messaging.cancelRecording')}</button>
          </div>
        )}
        {!s.showCommandsMenu && (
          <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground"><Bot className="w-3 h-3" /><span>{t('messaging.aiCommandsHint', 'AI commands')}</span></div>
        )}
      </div>
    </>
  );
}
