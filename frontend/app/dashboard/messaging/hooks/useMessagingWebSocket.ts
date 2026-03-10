import { useEffect } from 'react';
import { useWebSocketContext } from '@/lib/contexts/websocket-context';
import { useEventsStream } from '@/lib/contexts/events-stream-context';
import type { BDAccount } from '../types';
import type { MessagingState } from './useMessagingState';

export function useMessagingWebSocket(
  s: MessagingState,
  fetchChats: () => Promise<void>,
  fetchAccounts: () => Promise<void>,
) {
  const { on, off, subscribe, unsubscribe, isConnected } = useWebSocketContext();
  const { subscribe: subscribeEvents } = useEventsStream();

  // ─── Sync progress via SSE (unified events stream) ─────────────────
  useEffect(() => {
    const unsub = subscribeEvents('sync_progress', (data: Record<string, unknown>) => {
      const bdAccountId = data.bdAccountId as string | undefined;
      if (!bdAccountId || bdAccountId !== s.selectedAccountId) return;
      const done = Number(data.done ?? 0);
      const total = Number(data.total ?? 0);
      s.setAccountSyncReady(false);
      s.setAccountSyncProgress({ done, total: total || 1 });
      if (data.completed === true || (total > 0 && done >= total)) {
        s.setAccountSyncReady(true);
        s.setAccountSyncProgress(null);
        s.setAccountSyncError(null);
        fetchChats();
        fetchAccounts();
      }
    });
    return unsub;
  }, [s.selectedAccountId, subscribeEvents, fetchChats, fetchAccounts]);

  // ─── Sync events for selected account (WebSocket fallback) ────────────────────────────
  useEffect(() => {
    if (!s.selectedAccountId || !isConnected) return;
    subscribe(`bd-account:${s.selectedAccountId}`);
    const handler = (payload: { type?: string; data?: Record<string, unknown> }) => {
      if (!payload?.type || payload.data?.bdAccountId !== s.selectedAccountId) return;
      if (payload.type === 'bd_account.sync.started') {
        s.setAccountSyncReady(false);
        s.setAccountSyncProgress({ done: 0, total: (payload.data?.totalChats as number) ?? 0 });
      }
      if (payload.type === 'bd_account.sync.progress') {
        s.setAccountSyncReady(false);
        s.setAccountSyncProgress({ done: (payload.data?.done as number) ?? 0, total: (payload.data?.total as number) ?? 0 });
      }
      if (payload.type === 'bd_account.sync.completed') {
        s.setAccountSyncReady(true); s.setAccountSyncProgress(null); s.setAccountSyncError(null);
        fetchChats(); fetchAccounts();
      }
      if (payload.type === 'bd_account.sync.failed') {
        s.setAccountSyncReady(false); s.setAccountSyncProgress(null);
        s.setAccountSyncError((payload.data?.error as string) ?? 'Синхронизация не удалась');
      }
    };
    on('event', handler);
    return () => { off('event', handler); unsubscribe(`bd-account:${s.selectedAccountId}`); };
  }, [s.selectedAccountId, isConnected, subscribe, unsubscribe, on, off]);

  // ─── New messages across all accounts ────────────────────────────
  useEffect(() => {
    if (!s.accounts.length || !isConnected) return;
    const accountRooms = s.accounts.map((a: BDAccount) => `bd-account:${a.id}`);
    accountRooms.forEach((room: string) => subscribe(room));
    const handler = (payload: { message?: Record<string, unknown>; timestamp?: string }) => {
      const msg = payload?.message;
      if (!msg?.bdAccountId) return;
      const isOutbound = msg?.direction === 'outbound';
      const ts = (payload?.timestamp ?? msg?.createdAt ?? new Date().toISOString()) as string;
      const contentPreview = (msg?.content && String(msg.content).trim()) ? String(msg.content).trim().slice(0, 200) : null;
      const isCurrentChat = s.selectedAccountId === msg.bdAccountId && s.selectedChat?.channel_id === String(msg.channelId ?? '');
      if (!isCurrentChat && !isOutbound) {
        s.setAccounts((prev) => prev.map((a) => a.id === msg.bdAccountId ? { ...a, unread_count: (a.unread_count ?? 0) + 1 } : a));
      }
      if (msg.bdAccountId === s.selectedAccountId && msg.channelId) {
        const isCurrentChatForChat = s.selectedChat?.channel_id === String(msg.channelId);
        s.setChats((prev) => {
          const chatId = String(msg.channelId);
          const idx = prev.findIndex((c) => c.channel_id === chatId);
          if (idx < 0) return prev;
          const updated = prev.map((c, i) => {
            if (i !== idx) return c;
            const unread = isCurrentChatForChat ? 0 : (c.unread_count || 0) + (isOutbound ? 0 : 1);
            return { ...c, last_message_at: ts, last_message: (contentPreview?.trim()) ? contentPreview.trim().slice(0, 200) : '[Media]', unread_count: Math.max(0, unread) };
          });
          return [...updated].sort((a, b) => {
            const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
            const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
            return Number.isNaN(ta) ? 1 : Number.isNaN(tb) ? -1 : tb - ta;
          });
        });
      }
      if (msg.bdAccountId === s.selectedAccountId && s.selectedChat && (msg.channelId === s.selectedChat.channel_id || msg.channelId == null)) {
        s.setMessages((prev) => {
          const existingById = prev.find((m) => m.id === (msg.messageId as string));
          if (existingById) {
            if (msg.telegramMessageId != null && !existingById.telegram_message_id)
              return prev.map((m) => m.id === (msg.messageId as string) ? { ...m, telegram_message_id: String(msg.telegramMessageId), status: 'delivered' } : m);
            return prev;
          }
          const tgId = msg.telegramMessageId != null ? String(msg.telegramMessageId) : null;
          if (tgId && prev.some((m) => m.telegram_message_id === tgId && m.channel_id === s.selectedChat!.channel_id)) return prev;
          return [...prev, {
            id: (msg.messageId as string) ?? '', content: (msg.content as string) ?? '',
            direction: msg.direction === 'outbound' ? 'outbound' : 'inbound',
            created_at: ts, status: 'delivered', contact_id: (msg.contactId as string) ?? null,
            channel: s.selectedChat!.channel, channel_id: s.selectedChat!.channel_id,
            telegram_message_id: tgId, reply_to_telegram_id: msg.replyToTelegramId != null ? String(msg.replyToTelegramId) : null,
            telegram_media: (msg.telegramMedia as Record<string, unknown>) ?? null,
            telegram_entities: (msg.telegramEntities as Array<Record<string, unknown>>) ?? null, telegram_date: ts,
          }];
        });
        if (s.isAtBottomRef.current) s.scrollToBottomRef.current();
      }
    };
    on('new-message', handler);
    return () => { off('new-message', handler); accountRooms.forEach((room: string) => unsubscribe(room)); };
  }, [s.accounts, isConnected, s.selectedAccountId, s.selectedChat, subscribe, unsubscribe, on, off]);

  // ─── Message edited / deleted ────────────────────────────────────
  useEffect(() => {
    const handler = (payload: { type?: string; data?: { messageId?: string; channelId?: string; bdAccountId?: string; content?: string } }) => {
      const d = payload?.data;
      if (!d?.messageId) return;
      if (s.selectedAccountId && d.bdAccountId !== s.selectedAccountId) return;
      if (payload?.type === 'message.deleted') {
        if (s.selectedChat && d.channelId === s.selectedChat.channel_id) s.setMessages((prev) => prev.filter((m) => m.id !== d.messageId));
        return;
      }
      if (payload?.type === 'message.edited' && d.content !== undefined) {
        if (s.selectedChat && d.channelId === s.selectedChat.channel_id)
          s.setMessages((prev) => prev.map((m) => m.id === d.messageId ? { ...m, content: d.content ?? m.content } : m));
      }
    };
    on('event', handler);
    return () => off('event', handler);
  }, [on, off, s.selectedChat, s.selectedAccountId]);

  // ─── Telegram presence updates ───────────────────────────────────
  useEffect(() => {
    const handler = (payload: { type?: string; data?: Record<string, unknown> }) => {
      if (payload?.type !== 'bd_account.telegram_update' || !payload?.data) return;
      const d = payload.data;
      if (s.selectedAccountId && d.bdAccountId !== s.selectedAccountId) return;
      switch (d.updateKind as string) {
        case 'typing':
          if (d.channelId) {
            s.setTypingChannelId(d.channelId as string);
            if (s.typingClearTimerRef.current) clearTimeout(s.typingClearTimerRef.current);
            s.typingClearTimerRef.current = setTimeout(() => {
              s.setTypingChannelId((prev) => (prev === (d.channelId as string) ? null : prev));
              s.typingClearTimerRef.current = null;
            }, 6000);
          }
          break;
        case 'user_status':
          if (d.userId != null) s.setUserStatusByUserId((prev) => ({ ...prev, [d.userId as string]: { status: (d.status as string) ?? '', expires: d.expires as number | undefined } }));
          break;
        case 'read_inbox': case 'read_channel_inbox':
          if (d.channelId) s.setChats((prev) => prev.map((c) => c.channel_id === d.channelId ? { ...c, unread_count: 0 } : c));
          break;
        case 'read_outbox': case 'read_channel_outbox':
          if (d.channelId != null && typeof d.maxId === 'number')
            s.setReadOutboxMaxIdByChannel((prev) => ({ ...prev, [d.channelId as string]: Math.max(prev[d.channelId as string] ?? 0, d.maxId as number) }));
          break;
        case 'draft':
          if (d.channelId != null) s.setDraftByChannel((prev) => ({ ...prev, [d.channelId as string]: { text: (d.draftText as string) ?? '', replyToMsgId: d.replyToMsgId as number | undefined } }));
          break;
        case 'dialog_pinned':
          if (d.channelId != null) s.setPinnedChannelIds((prev) => d.pinned ? (prev.includes(d.channelId as string) ? prev : [...prev, d.channelId as string]) : prev.filter((id) => id !== (d.channelId as string)));
          break;
        case 'pinned_dialogs':
          if (Array.isArray(d.order) && d.order.length >= 0) s.setPinnedChannelIds(d.order as string[]);
          break;
        case 'user_name':
          if (d.userId != null) s.setContactDisplayOverrides((prev) => ({ ...prev, [d.userId as string]: { ...prev[d.userId as string], firstName: (d.firstName as string) ?? prev[d.userId as string]?.firstName, lastName: (d.lastName as string) ?? prev[d.userId as string]?.lastName, usernames: (d.usernames as string[]) ?? prev[d.userId as string]?.usernames } }));
          break;
        case 'user_phone':
          if (d.userId != null) s.setContactDisplayOverrides((prev) => ({ ...prev, [d.userId as string]: { ...prev[d.userId as string], phone: (d.phone as string) ?? prev[d.userId as string]?.phone } }));
          break;
        case 'chat_participant_add': case 'chat_participant_delete':
          s.fetchChatsRef.current?.();
          break;
        case 'channel_too_long':
          if (d.channelId) s.setChannelNeedsRefresh(d.channelId as string);
          break;
      }
    };
    on('event', handler);
    return () => {
      off('event', handler);
      if (s.typingClearTimerRef.current) { clearTimeout(s.typingClearTimerRef.current); s.typingClearTimerRef.current = null; }
    };
  }, [on, off, s.selectedAccountId]);

  return { isConnected };
}
