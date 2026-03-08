import { useCallback, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@/lib/api/client';
import { useToast } from '@/lib/contexts/toast-context';
import type { Chat, Message, SyncFolder, LeadContext } from '../types';
import { MESSAGES_PAGE_SIZE, VIRTUAL_LIST_THRESHOLD, LOAD_OLDER_COOLDOWN_MS } from '../types';
import { getChatName, getChatNameUniqueInList, getDraftKey, fileToBase64 } from '../utils';
import type { MessagingState } from './useMessagingState';

export function useMessagingActions(
  s: MessagingState,
  fetchChats: () => Promise<void>,
  fetchMessages: (accountId: string, chat: Chat) => Promise<void>,
) {
  const { t } = useTranslation();
  const toast = useToast();

  const hasMoreMessages = s.messagesPage * MESSAGES_PAGE_SIZE < s.messagesTotal || !s.historyExhausted;
  const selectedAccount = s.selectedAccountId ? s.accounts.find((a) => a.id === s.selectedAccountId) : null;
  const isSelectedAccountMine = selectedAccount?.is_owner === true;

  const getChatNameWithOverrides = useCallback(
    (chat: Chat) => {
      const overrides =
        chat.peer_type === 'user' ? s.contactDisplayOverrides[chat.channel_id] : undefined;
      return getChatName(chat, overrides);
    },
    [s.contactDisplayOverrides],
  );

  // ─── Scroll helpers ──────────────────────────────────────────────
  const scrollToBottom = useCallback(() => {
    s.messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, []);
  s.scrollToBottomRef.current = scrollToBottom;

  const scrollToLastMessage = useCallback(() => {
    if (s.messages.length === 0) return;
    if (s.messages.length > VIRTUAL_LIST_THRESHOLD && s.virtuosoRef.current) {
      (s.virtuosoRef.current as { scrollToIndex: (opts: Record<string, unknown>) => void }).scrollToIndex({ index: s.messages.length - 1, align: 'end', behavior: 'auto' });
      s.setShowScrollToBottomButton(false);
      return;
    }
    s.messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    s.setShowScrollToBottomButton(false);
  }, [s.messages.length]);

  const scrollToMessageByTelegramId = useCallback((telegramMessageId: string) => {
    const id = String(telegramMessageId).trim();
    if (!id) return;
    const index = s.messages.findIndex((m) => String(m.telegram_message_id) === id);
    if (index < 0) return;
    if (s.messages.length > VIRTUAL_LIST_THRESHOLD && s.virtuosoRef.current) {
      (s.virtuosoRef.current as { scrollToIndex: (opts: Record<string, unknown>) => void }).scrollToIndex({ index, align: 'center', behavior: 'auto' });
      return;
    }
    const container = s.messagesScrollRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-telegram-message-id="${id}"]`);
    if (el) (el as HTMLElement).scrollIntoView({ behavior: 'auto', block: 'center' });
  }, [s.messages]);

  // ─── Load older messages ─────────────────────────────────────────
  const loadOlderMessages = useCallback(async () => {
    if (!s.selectedAccountId || !s.selectedChat || s.loadingOlder || !hasMoreMessages) return;
    const scrollEl = s.messagesScrollRef.current;
    if (scrollEl) s.scrollRestoreRef.current = { height: scrollEl.scrollHeight, top: scrollEl.scrollTop };
    s.setLoadingOlder(true);
    const nextPage = s.messagesPage + 1;
    try {
      if (s.selectedChat.channel === 'telegram' && !s.historyExhausted) {
        try {
          const loadRes = await apiClient.post<{ added?: number; exhausted?: boolean }>(
            `/api/bd-accounts/${s.selectedAccountId}/chats/${s.selectedChat.channel_id}/load-older-history`,
          );
          if (loadRes.data?.exhausted === true) s.setHistoryExhausted(true);
        } catch { /* continue */ }
      }
      const response = await apiClient.get('/api/messaging/messages', {
        params: { channel: s.selectedChat.channel, channelId: s.selectedChat.channel_id, bdAccountId: s.selectedAccountId, page: nextPage, limit: MESSAGES_PAGE_SIZE },
      });
      const list = response.data.messages || [];
      s.skipScrollToBottomAfterPrependRef.current = true;
      s.setMessages((prev) => [...list, ...prev]);
      s.setPrependedCount((prev) => prev + list.length);
      s.setMessagesPage(nextPage);
      s.setMessagesTotal(response.data.pagination?.total ?? s.messagesTotal + list.length);
      s.setHistoryExhausted(response.data.historyExhausted === true);
    } catch (error) { console.error('Error loading older messages:', error); }
    finally { s.setLoadingOlder(false); }
  }, [s.selectedAccountId, s.selectedChat, s.loadingOlder, hasMoreMessages, s.messagesPage, s.messagesTotal, s.historyExhausted]);

  // ─── Send message ────────────────────────────────────────────────
  const handleSendMessage = useCallback(async () => {
    if (!(s.newMessage.trim() || s.pendingFile) || !s.selectedChat || !s.selectedAccountId) return;
    if (!isSelectedAccountMine) return;
    const messageText = s.newMessage.trim();
    const fileToSend = s.pendingFile;
    const replyTo = s.replyToMessage;
    s.setNewMessage(''); s.setPendingFile(null); s.setReplyToMessage(null);
    if (s.fileInputRef.current) s.fileInputRef.current.value = '';
    if (s.selectedAccountId && s.selectedChat) { try { localStorage.removeItem(getDraftKey(s.selectedAccountId, s.selectedChat.channel_id)); } catch {} }
    s.setSendingMessage(true);
    const displayContent = messageText || (fileToSend ? `[Файл: ${fileToSend.name}]` : '');
    const tempMessage: Message = {
      id: `temp-${Date.now()}`, content: displayContent, direction: 'outbound',
      created_at: new Date().toISOString(), status: 'pending', contact_id: s.selectedChat.contact_id,
      channel: s.selectedChat.channel, channel_id: s.selectedChat.channel_id,
    };
    s.setMessages((prev) => [...prev, tempMessage]);
    scrollToBottom();
    try {
      const body: Record<string, string> = {
        contactId: s.selectedChat.contact_id ?? '', channel: s.selectedChat.channel,
        channelId: s.selectedChat.channel_id, content: messageText, bdAccountId: s.selectedAccountId,
      };
      if (fileToSend) { body.fileBase64 = await fileToBase64(fileToSend); body.fileName = fileToSend.name; }
      if (replyTo?.telegram_message_id) body.replyToMessageId = replyTo.telegram_message_id;
      const response = await apiClient.post('/api/messaging/send', body);
      const serverMessage = response.data as Record<string, unknown>;
      const tgDate = serverMessage.telegram_date;
      const telegramDateStr = tgDate != null ? (typeof tgDate === 'string' ? tgDate : typeof tgDate === 'number' ? new Date(tgDate * 1000).toISOString() : undefined) : undefined;
      const merged: Message = {
        ...tempMessage, id: String(serverMessage.id ?? tempMessage.id), status: String(serverMessage.status ?? tempMessage.status),
        created_at: String(serverMessage.created_at ?? tempMessage.created_at),
        telegram_message_id: serverMessage.telegram_message_id != null ? String(serverMessage.telegram_message_id) : tempMessage.telegram_message_id,
        telegram_date: telegramDateStr ?? tempMessage.telegram_date,
        reply_to_telegram_id: serverMessage.reply_to_telegram_id != null ? String(serverMessage.reply_to_telegram_id) : (tempMessage.reply_to_telegram_id ?? replyTo?.telegram_message_id ?? undefined),
        telegram_media: serverMessage.telegram_media != null && typeof serverMessage.telegram_media === 'object' ? serverMessage.telegram_media as Record<string, unknown> : tempMessage.telegram_media,
        telegram_entities: Array.isArray(serverMessage.telegram_entities) ? serverMessage.telegram_entities as Array<Record<string, unknown>> : tempMessage.telegram_entities,
      };
      s.setMessages((prev) => {
        const next = prev.map((m) => m.id === tempMessage.id ? merged : m);
        const seen = new Set<string>();
        return next.filter((m) => { if (seen.has(m.id)) return false; seen.add(m.id); return true; });
      });
      if (s.selectedAccountId && s.selectedChat) apiClient.post(`/api/bd-accounts/${s.selectedAccountId}/draft`, { channelId: s.selectedChat.channel_id, text: '' }).catch(() => {});
      if (s.selectedChat.conversation_id) s.setNewLeads((prev) => prev.filter((c) => c.conversation_id !== s.selectedChat!.conversation_id));
      await fetchChats();
    } catch (error: unknown) {
      console.error('Error sending message:', error);
      s.setMessages((prev) => prev.filter((m) => m.id !== tempMessage.id));
      const err = error as { response?: { status?: number; data?: { message?: string; error?: string } } };
      if (err.response?.status === 413) { toast.error(err.response.data?.message || 'Файл слишком большой. Максимальный размер 2 ГБ.'); }
      else { toast.error(err.response?.data?.message || err.response?.data?.error || 'Ошибка отправки сообщения'); }
      if (fileToSend) s.setPendingFile(fileToSend);
    } finally { s.setSendingMessage(false); }
  }, [s.newMessage, s.pendingFile, s.selectedChat, s.selectedAccountId, isSelectedAccountMine, s.replyToMessage, scrollToBottom, fetchChats, toast]);

  // ─── Reactions & Delete ──────────────────────────────────────────
  const handleReaction = useCallback(async (messageId: string, emoji: string) => {
    s.setMessageContextMenu(null);
    try {
      const res = await apiClient.patch<Message>(`/api/messaging/messages/${messageId}/reaction`, { emoji });
      s.setMessages((prev) => prev.map((m) => m.id === messageId ? { ...m, reactions: res.data.reactions ?? m.reactions } : m));
    } catch (err: unknown) {
      console.error('Error adding reaction:', err);
      toast.error((err as { response?: { data?: { error?: string } } })?.response?.data?.error || t('messaging.reactionError'));
    }
  }, [t, toast]);

  const handleDeleteMessage = useCallback(async (messageId: string) => {
    s.setDeletingMessageId(messageId); s.setMessageContextMenu(null);
    try { await apiClient.delete(`/api/messaging/messages/${messageId}`); s.setMessages((prev) => prev.filter((m) => m.id !== messageId)); }
    catch (err: unknown) {
      console.error('Error deleting message:', err);
      toast.error((err as { response?: { data?: { message?: string; error?: string } } })?.response?.data?.message || (err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Не удалось удалить сообщение');
    } finally { s.setDeletingMessageId(null); }
  }, [toast]);

  const handleCopyMessageText = useCallback((msg: Message) => {
    s.setMessageContextMenu(null);
    const text = (msg.content ?? '').trim();
    if (text) navigator.clipboard.writeText(text).then(() => toast.success(t('messaging.copySuccess', 'Скопировано')), () => toast.error(t('messaging.copyFailed')));
  }, [t, toast]);

  const handleReplyToMessage = useCallback((msg: Message) => {
    s.setMessageContextMenu(null); s.setReplyToMessage(msg); s.messageInputRef.current?.focus();
  }, []);

  const handleForwardMessage = useCallback((msg: Message) => {
    s.setMessageContextMenu(null); s.setForwardModal(msg);
  }, []);

  const handleForwardToChat = useCallback(async (toChatId: string) => {
    if (!s.forwardModal || !s.selectedAccountId || !s.selectedChat) return;
    const telegramId = s.forwardModal.telegram_message_id ? Number(s.forwardModal.telegram_message_id) : null;
    if (telegramId == null) { toast.error(t('messaging.forwardError')); return; }
    s.setForwardingToChatId(toChatId);
    try {
      await apiClient.post(`/api/bd-accounts/${s.selectedAccountId}/forward`, { fromChatId: s.selectedChat.channel_id, toChatId, telegramMessageId: telegramId });
      s.setForwardModal(null); s.setForwardingToChatId(null);
      if (toChatId === s.selectedChat.channel_id) await fetchMessages(s.selectedAccountId, s.selectedChat);
    } catch (err: unknown) {
      console.error('Error forwarding message:', err);
      toast.error((err as { response?: { data?: { message?: string; error?: string } } })?.response?.data?.message || (err as { response?: { data?: { error?: string } } })?.response?.data?.error || t('messaging.forwardError'));
    } finally { s.setForwardingToChatId(null); }
  }, [s.forwardModal, s.selectedAccountId, s.selectedChat, fetchMessages, t, toast]);

  // ─── Chat actions ────────────────────────────────────────────────
  const handlePinChat = useCallback(async (chat: Chat) => {
    if (!s.selectedAccountId) return;
    s.setChatContextMenu(null);
    try {
      await apiClient.post('/api/messaging/pinned-chats', { bdAccountId: s.selectedAccountId, channelId: chat.channel_id });
      const res = await apiClient.get('/api/messaging/pinned-chats', { params: { bdAccountId: s.selectedAccountId } });
      const list = Array.isArray(res.data) ? res.data : [];
      s.setPinnedChannelIds(list.map((p: { channel_id: string }) => String(p.channel_id)));
    } catch (err: unknown) { console.error('Error pinning chat:', err); }
  }, [s.selectedAccountId]);

  const handleUnpinChat = useCallback(async (chat: Chat) => {
    if (!s.selectedAccountId) return;
    s.setChatContextMenu(null);
    try {
      await apiClient.delete(`/api/messaging/pinned-chats/${chat.channel_id}`, { params: { bdAccountId: s.selectedAccountId } });
      s.setPinnedChannelIds((prev) => prev.filter((id) => id !== chat.channel_id));
    } catch (err: unknown) { console.error('Error unpinning chat:', err); }
  }, [s.selectedAccountId]);

  const handleRemoveChat = useCallback(async (chat: Chat) => {
    if (!s.selectedAccountId) return;
    if (!window.confirm(t('messaging.deleteChatConfirm'))) return;
    s.setChatContextMenu(null);
    try {
      await apiClient.delete(`/api/bd-accounts/${s.selectedAccountId}/chats/${chat.channel_id}`);
      s.setChats((prev) => prev.filter((c) => c.channel_id !== chat.channel_id));
      s.setPinnedChannelIds((prev) => prev.filter((id) => id !== chat.channel_id));
      if (s.selectedChat?.channel_id === chat.channel_id) { s.setSelectedChat(null); s.setMessages([]); }
    } catch (err: unknown) {
      console.error('Error removing chat:', err);
      toast.error((err as { response?: { data?: { message?: string; error?: string } } })?.response?.data?.message || (err as { response?: { data?: { error?: string } } })?.response?.data?.error || t('messaging.deleteChatError'));
    }
  }, [s.selectedAccountId, s.selectedChat, t, toast]);

  // ─── Folder actions ──────────────────────────────────────────────
  const chatFolderIds = useCallback((c: Chat) => (c.folder_ids && c.folder_ids.length > 0 ? c.folder_ids : (c.folder_id != null ? [Number(c.folder_id)] : [])), []);

  const handleChatFoldersToggle = useCallback(async (chat: Chat, folderId: number) => {
    if (!s.selectedAccountId) return;
    const current = chatFolderIds(chat);
    const hasFolder = current.includes(folderId);
    const newIds = hasFolder ? current.filter((id) => id !== folderId) : [...current, folderId];
    try {
      await apiClient.patch(`/api/bd-accounts/${s.selectedAccountId}/chats/${chat.channel_id}/folder`, { folder_ids: newIds });
      const updated = { ...chat, folder_ids: newIds, folder_id: newIds[0] ?? null };
      s.setChats((prev) => prev.map((c) => c.channel_id === chat.channel_id ? updated : c));
      s.setChatContextMenu((prev) =>
        prev?.chat.channel_id === chat.channel_id ? { ...prev, chat: updated } : prev
      );
    } catch (err: unknown) { console.error('Error updating chat folders:', err); }
  }, [s.selectedAccountId, chatFolderIds]);

  const handleChatFoldersClear = useCallback(async (chat: Chat) => {
    if (!s.selectedAccountId) return;
    try {
      await apiClient.patch(`/api/bd-accounts/${s.selectedAccountId}/chats/${chat.channel_id}/folder`, { folder_ids: [] });
      const updated = { ...chat, folder_ids: [], folder_id: null };
      s.setChats((prev) => prev.map((c) => c.channel_id === chat.channel_id ? updated : c));
      s.setChatContextMenu((prev) =>
        prev?.chat.channel_id === chat.channel_id ? { ...prev, chat: updated } : prev
      );
    } catch (err: unknown) { console.error('Error clearing chat folders:', err); }
  }, [s.selectedAccountId]);

  const handleCreateFolder = useCallback(async (folder_title: string, icon: string | null) => {
    if (!s.selectedAccountId) return null;
    const res = await apiClient.post<SyncFolder>(`/api/bd-accounts/${s.selectedAccountId}/sync-folders/custom`, { folder_title: folder_title.trim().slice(0, 12) || t('messaging.folderNewDefault'), icon });
    return res.data ?? null;
  }, [s.selectedAccountId, t]);

  const handleReorderFolders = useCallback(async (order: string[]) => {
    if (!s.selectedAccountId) return null;
    const res = await apiClient.patch<SyncFolder[]>(`/api/bd-accounts/${s.selectedAccountId}/sync-folders/order`, { order });
    return Array.isArray(res.data) ? res.data : null;
  }, [s.selectedAccountId]);

  const handleUpdateFolder = useCallback(async (folderRowId: string, data: { folder_title?: string; icon?: string | null }) => {
    if (!s.selectedAccountId) return null;
    const res = await apiClient.patch<SyncFolder>(`/api/bd-accounts/${s.selectedAccountId}/sync-folders/${folderRowId}`, data);
    return res.data ?? null;
  }, [s.selectedAccountId]);

  const handleDeleteFolder = useCallback(async (folderRowId: string) => {
    if (!s.selectedAccountId) return;
    await apiClient.delete(`/api/bd-accounts/${s.selectedAccountId}/sync-folders/${folderRowId}`);
  }, [s.selectedAccountId]);

  const handleFolderDeleted = useCallback((folderId: number) => { s.setSelectedFolderId((prev) => prev === folderId ? 0 : prev); }, []);

  const handleFolderDrop = useCallback((folderId: number, e: React.DragEvent) => {
    e.preventDefault(); s.setDragOverFolderId(null);
    try {
      const raw = e.dataTransfer.getData('application/json');
      if (!raw) return;
      const { bdAccountId, chat } = JSON.parse(raw) as { bdAccountId: string; chat: Chat };
      if (bdAccountId !== s.selectedAccountId) return;
      if (!chatFolderIds(chat).includes(folderId)) handleChatFoldersToggle(chat, folderId);
    } catch {}
  }, [s.selectedAccountId, chatFolderIds, handleChatFoldersToggle]);

  // ─── Display name ────────────────────────────────────────────────
  const openEditNameModal = useCallback(() => {
    if (!s.selectedChat) return;
    s.setEditDisplayNameValue(s.selectedChat.display_name ?? getChatNameWithOverrides(s.selectedChat) ?? '');
    s.setShowEditNameModal(true); s.setShowChatHeaderMenu(false);
  }, [s.selectedChat, getChatNameWithOverrides]);

  const saveDisplayName = useCallback(async () => {
    if (!s.selectedChat?.contact_id) return;
    s.setSavingDisplayName(true);
    try {
      await apiClient.patch(`/api/crm/contacts/${s.selectedChat.contact_id}`, { displayName: s.editDisplayNameValue.trim() || null });
      const newName = s.editDisplayNameValue.trim() || null;
      s.setChats((prev) => prev.map((c) => c.channel_id === s.selectedChat!.channel_id ? { ...c, display_name: newName } : c));
      s.setSelectedChat((prev) => prev ? { ...prev, display_name: newName } : null);
      s.setShowEditNameModal(false);
    } catch (err: unknown) {
      console.error('Error updating contact name:', err);
      toast.error((err as { response?: { data?: { error?: string } } })?.response?.data?.error || 'Не удалось сохранить имя');
    } finally { s.setSavingDisplayName(false); }
  }, [s.selectedChat, s.editDisplayNameValue, toast]);

  // ─── Lead panel ──────────────────────────────────────────────────
  const setLeadPanelOpen = useCallback((open: boolean) => {
    if (open) {
      s.setRightPanelTab('lead_card'); s.setRightPanelOpen(true);
      const convId = s.selectedChat?.conversation_id ?? null;
      if (convId) s.setLeadPanelOpenByConvId((prev) => ({ ...prev, [convId]: true }));
    } else { s.setRightPanelOpen(false); s.setLeadContext(null); }
  }, [s.selectedChat]);

  const handleLeadStageChange = useCallback(async (stageId: string) => {
    if (!s.leadContext?.lead_id || s.leadStagePatching) return;
    s.setLeadStagePatching(true);
    try {
      const res = await apiClient.patch<{ stage: { id: string; name: string } }>(`/api/pipeline/leads/${s.leadContext.lead_id}/stage`, { stage_id: stageId });
      if (res.data?.stage) s.setLeadContext((prev) => prev ? { ...prev, stage: res.data!.stage } : null);
    } finally { s.setLeadStagePatching(false); }
  }, [s.leadContext?.lead_id, s.leadStagePatching]);

  // ─── Stub handlers ───────────────────────────────────────────────
  const handleVoiceMessage = useCallback(() => {
    s.setIsRecording(true);
    setTimeout(() => { s.setIsRecording(false); toast.info('Голосовое сообщение записано (заглушка)'); }, 2000);
  }, [toast]);
  const handleAttachFile = useCallback(() => { s.setShowAttachMenu(false); s.fileInputRef.current?.click(); }, []);
  const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files?.length) s.setPendingFile(files[0]);
    e.target.value = '';
  }, []);

  // ─── Scroll restoration effects ──────────────────────────────────
  useEffect(() => {
    const restore = s.scrollRestoreRef.current;
    if (!restore || !s.messagesScrollRef.current) return;
    s.scrollRestoreRef.current = null;
    const el = s.messagesScrollRef.current;
    requestAnimationFrame(() => { requestAnimationFrame(() => { el.scrollTop = el.scrollHeight - restore.height + restore.top; }); });
  }, [s.messages.length]);

  useEffect(() => { s.hasUserScrolledUpRef.current = false; s.setPrependedCount(0); s.isAtBottomRef.current = true; s.setShowScrollToBottomButton(false); s.scrollRestoreRef.current = null; }, [s.selectedChat?.channel_id]);

  useEffect(() => {
    if (s.messages.length > VIRTUAL_LIST_THRESHOLD || s.messages.length === 0) return;
    if (s.skipScrollToBottomAfterPrependRef.current) { s.skipScrollToBottomAfterPrependRef.current = false; return; }
    requestAnimationFrame(() => scrollToBottom());
  }, [s.messages, s.selectedChat?.channel_id, scrollToBottom]);

  useEffect(() => { scrollToBottom(); }, [s.messages]);

  // ─── Scroll tracking ────────────────────────────────────────────
  useEffect(() => {
    const container = s.messagesScrollRef.current;
    if (!container) return;
    const onScroll = () => {
      if (container.scrollTop < 150) s.hasUserScrolledUpRef.current = true;
      s.isAtBottomRef.current = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    const sentinel = s.messagesTopSentinelRef.current;
    const scrollRoot = s.messagesScrollRef.current;
    if (!sentinel || !scrollRoot || !s.selectedChat || !hasMoreMessages || s.loadingOlder) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const [e] = entries;
        if (!e?.isIntersecting || !hasMoreMessages || s.loadingOlder) return;
        const now = Date.now();
        if (now - s.loadOlderLastCallRef.current < LOAD_OLDER_COOLDOWN_MS) return;
        s.loadOlderLastCallRef.current = now;
        loadOlderMessages();
      },
      { root: scrollRoot, rootMargin: '80px 0px 0px 0px', threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [s.selectedChat?.channel_id, hasMoreMessages, s.loadingOlder, loadOlderMessages]);

  // ─── Virtuoso scroll-to-end ──────────────────────────────────────
  useEffect(() => {
    if (s.messages.length <= VIRTUAL_LIST_THRESHOLD || s.messages.length === 0) return;
    if (s.lastLoadedChannelId !== s.selectedChat?.channel_id) return;
    const scrollToEnd = () => (s.virtuosoRef.current as { scrollToIndex?: (opts: Record<string, unknown>) => void })?.scrollToIndex?.({ index: s.messages.length - 1, align: 'end', behavior: 'auto' });
    const raf1 = requestAnimationFrame(() => { scrollToEnd(); requestAnimationFrame(scrollToEnd); });
    return () => cancelAnimationFrame(raf1);
  }, [s.lastLoadedChannelId, s.selectedChat?.channel_id, s.messages.length]);

  useEffect(() => {
    if (s.messages.length > VIRTUAL_LIST_THRESHOLD || s.messages.length === 0) return;
    const el = s.messagesScrollRef.current;
    if (!el) return;
    const SCROLL_THRESHOLD_PX = 400;
    const check = () => {
      const fromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (fromBottom > SCROLL_THRESHOLD_PX) s.setShowScrollToBottomButton(true);
      else if (fromBottom < 50) s.setShowScrollToBottomButton(false);
    };
    el.addEventListener('scroll', check, { passive: true });
    check();
    return () => el.removeEventListener('scroll', check);
  }, [s.messages.length]);

  // ─── Context menu & menu close ───────────────────────────────────
  useEffect(() => {
    if (!s.messageContextMenu && !s.chatContextMenu && !s.accountContextMenu) return;
    const close = () => { s.setMessageContextMenu(null); s.setChatContextMenu(null); s.setAccountContextMenu(null); };
    const handleWindowClick = (e: MouseEvent) => { if (e.button === 2) return; if ((e.target as HTMLElement)?.closest?.('[role="menu"]')) return; close(); };
    window.addEventListener('click', handleWindowClick, true);
    window.addEventListener('scroll', close, true);
    return () => { window.removeEventListener('click', handleWindowClick, true); window.removeEventListener('scroll', close, true); };
  }, [s.messageContextMenu, s.chatContextMenu, s.accountContextMenu]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.commands-menu') && !target.closest('.attach-menu')) { s.setShowCommandsMenu(false); s.setShowAttachMenu(false); }
      if (s.chatHeaderMenuRef.current && !s.chatHeaderMenuRef.current.contains(target)) s.setShowChatHeaderMenu(false);
    };
    if (s.showCommandsMenu || s.showAttachMenu || s.showChatHeaderMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [s.showCommandsMenu, s.showAttachMenu, s.showChatHeaderMenu]);

  // ─── Computed values ─────────────────────────────────────────────
  const unreadByFolder = useMemo(() => {
    const all = s.chats.reduce((sum, c) => sum + (c.unread_count || 0), 0);
    const byId: Record<number, number> = {};
    s.folders.forEach((f) => {
      byId[f.folder_id] = f.folder_id === 0 ? all : s.chats.filter((c) => chatFolderIds(c).includes(f.folder_id)).reduce((sum, c) => sum + (c.unread_count || 0), 0);
    });
    byId[0] = all;
    return { all, byId };
  }, [s.chats, s.folders, chatFolderIds]);

  const nonEmptyFolderIds = useMemo(() => {
    const set = new Set<number>([0]);
    s.chats.forEach((c) => chatFolderIds(c).forEach((fid) => set.add(fid)));
    return set;
  }, [s.chats, chatFolderIds]);

  const displayFolders = useMemo(() => {
    const hasZero = s.folders.some((f) => f.folder_id === 0);
    const zero: SyncFolder = hasZero ? s.folders.find((f) => f.folder_id === 0)! : { id: '0', folder_id: 0, folder_title: t('messaging.folderAll'), order_index: -1, icon: '📋' };
    const rest = s.folders.filter((f) => f.folder_id !== 0);
    const list = [zero, ...rest];
    if (s.hideEmptyFolders) return list.filter((f) => nonEmptyFolderIds.has(f.folder_id));
    return list;
  }, [s.folders, t, s.hideEmptyFolders, nonEmptyFolderIds]);

  const filteredChats = useMemo(() => {
    return s.chats.filter((chat) => {
      if (s.selectedFolderId !== null && s.selectedFolderId !== 0) {
        if (!chatFolderIds(chat).includes(s.selectedFolderId)) return false;
      }
      return true;
    });
  }, [s.chats, s.selectedFolderId, chatFolderIds]);

  const pinnedSet = useMemo(() => new Set(s.pinnedChannelIds), [s.pinnedChannelIds]);
  const pinnedChatsOrdered = useMemo(() => s.pinnedChannelIds.map((id) => filteredChats.find((c) => c.channel_id === id)).filter((c): c is Chat => c != null), [s.pinnedChannelIds, filteredChats]);
  const unpinnedChats = useMemo(() => filteredChats.filter((c) => !pinnedSet.has(c.channel_id)), [filteredChats, pinnedSet]);
  const displayChats = useMemo(() => [...pinnedChatsOrdered, ...unpinnedChats], [pinnedChatsOrdered, unpinnedChats]);

  const getChatNameDisplay = useCallback(
    (chat: Chat) => getChatNameUniqueInList(chat, displayChats, getChatNameWithOverrides),
    [displayChats, getChatNameWithOverrides],
  );

  const filteredAccounts = useMemo(() => {
    const q = s.accountSearch.toLowerCase().trim();
    if (!q) return s.accounts;
    return s.accounts.filter((account) => {
      const name = (account.display_name ?? account.first_name ?? '').toLowerCase();
      const phone = (account.phone_number ?? '').toLowerCase();
      const username = (account.username ?? '').toLowerCase();
      const tgId = (account.telegram_id ?? '').toLowerCase();
      return name.includes(q) || phone.includes(q) || username.includes(q) || tgId.includes(q);
    });
  }, [s.accounts, s.accountSearch]);

  return {
    hasMoreMessages, selectedAccount, isSelectedAccountMine, getChatNameWithOverrides, getChatNameDisplay,
    scrollToBottom, scrollToLastMessage, scrollToMessageByTelegramId,
    loadOlderMessages, handleSendMessage,
    handleReaction, handleDeleteMessage, handleCopyMessageText,
    handleReplyToMessage, handleForwardMessage, handleForwardToChat,
    handlePinChat, handleUnpinChat, handleRemoveChat,
    chatFolderIds, handleChatFoldersToggle, handleChatFoldersClear,
    handleCreateFolder, handleReorderFolders, handleUpdateFolder, handleDeleteFolder,
    handleFolderDeleted, handleFolderDrop,
    openEditNameModal, saveDisplayName, setLeadPanelOpen, handleLeadStageChange,
    handleVoiceMessage, handleAttachFile, handleFileSelect,
    unreadByFolder, nonEmptyFolderIds, displayFolders,
    filteredChats, pinnedSet, pinnedChatsOrdered, unpinnedChats, displayChats,
    filteredAccounts,
  };
}
