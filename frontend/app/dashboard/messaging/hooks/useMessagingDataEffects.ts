'use client';

import { useEffect } from 'react';
import type { ReadonlyURLSearchParams } from 'next/navigation';
import { apiClient } from '@/lib/api/client';
import {
  listBdAccountSyncFolders,
  getBdAccountSyncStatus,
  startBdAccountSync,
  saveBdAccountDraft,
} from '@/lib/api/bd-accounts';
import { fetchContactNotes, fetchContactReminders } from '@/lib/api/crm';
import { reportError, reportWarning } from '@/lib/error-reporter';
import { setCurrentMessagingChat } from '@/lib/messaging-open-chat';
import type { LeadContext } from '../types';
import { MAX_CACHED_CHATS } from '../types';
import { getDraftKey, getMessagesCacheKey, mapRawChatsToChatList } from '../utils';
import type { MessagingState } from './useMessagingState';
import type { MessagingDataLoaders } from './useMessagingDataLoaders';

interface MessagingNavigation {
  searchParams: ReadonlyURLSearchParams;
  router: { replace: (href: string) => void };
  pathname: string;
}

export function useMessagingDataEffects(
  s: MessagingState,
  { searchParams, router, pathname }: MessagingNavigation,
  { fetchAccounts, fetchChatsImpl, fetchMessages, fetchNewLeads, markAsRead }: MessagingDataLoaders
): void {
  const urlContactId = searchParams.get('contactId');
  const urlBdAccountId = searchParams.get('bdAccountId');
  const urlOpenChannelId = searchParams.get('open');

  const convId = s.selectedChat?.conversation_id ?? null;
  const isLead = !!s.selectedChat?.lead_id;
  const isLeadPanelOpen = isLead && s.rightPanelOpen && s.rightPanelTab === 'lead_card';

  useEffect(() => {
    fetchAccounts();
  }, []);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchAccounts();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  useEffect(() => {
    if (!urlContactId || urlBdAccountId || s.contactIdResolvedRef.current) return;
    s.contactIdResolvedRef.current = true;
    apiClient
      .get<{ bd_account_id: string; channel_id: string }>('/api/messaging/resolve-contact', { params: { contactId: urlContactId } })
      .then(({ data }) => {
        const q = new URLSearchParams();
        q.set('bdAccountId', data.bd_account_id);
        q.set('open', data.channel_id);
        router.replace(`${pathname}?${q.toString()}`);
      })
      .catch(() => {
        s.contactIdResolvedRef.current = false;
      });
  }, [urlContactId, urlBdAccountId, pathname, router]);

  useEffect(() => {
    if (!urlBdAccountId || s.accounts.length === 0) return;
    if (s.accounts.some((a) => a.id === urlBdAccountId)) s.setSelectedAccountId(urlBdAccountId);
  }, [urlBdAccountId, s.accounts]);

  useEffect(() => {
    if (s.urlOpenAppliedRef.current || !urlOpenChannelId || !s.selectedAccountId || s.chats.length === 0) return;
    const chat = s.chats.find((c) => c.channel_id === urlOpenChannelId);
    if (chat) {
      s.urlOpenAppliedRef.current = true;
      s.setSelectedChat(chat);
      if (chat.lead_id) {
        s.setRightPanelTab('lead_card');
        s.setRightPanelOpen(true);
        if (chat.conversation_id) s.setLeadPanelOpenByConvId((prev) => ({ ...prev, [chat.conversation_id!]: true }));
      }
    }
  }, [urlOpenChannelId, s.selectedAccountId, s.chats]);

  useEffect(() => {
    if (!s.selectedAccountId) {
      s.setChats([]);
      s.setLoadingChats(false);
      return;
    }
    let cancelled = false;
    s.setLoadingChats(true);
    apiClient
      .get<unknown[]>('/api/messaging/chats', { params: { channel: 'telegram', bdAccountId: s.selectedAccountId } })
      .then((res) => {
        if (cancelled) return;
        const chatsFromApi = Array.isArray(res.data) ? res.data : [];
        s.setChats(mapRawChatsToChatList(chatsFromApi as Record<string, unknown>[]));
      })
      .catch((err) => {
        if (!cancelled) {
          reportError(err, { component: 'useMessagingData', action: 'autoFetchChats' });
          s.setChats([]);
        }
      })
      .finally(() => {
        if (!cancelled) s.setLoadingChats(false);
      });
    return () => {
      cancelled = true;
    };
  }, [s.selectedAccountId]);

  useEffect(() => {
    if (!s.selectedAccountId) {
      s.setFolders([]);
      s.setSelectedFolderId(0);
      return;
    }
    s.setSelectedFolderId(0);
    listBdAccountSyncFolders(s.selectedAccountId)
      .then((rows) => s.setFolders(rows))
      .catch(() => s.setFolders([]));
  }, [s.selectedAccountId]);

  useEffect(() => {
    if (!s.selectedAccountId) {
      s.setPinnedChannelIds([]);
      return;
    }
    apiClient
      .get('/api/messaging/pinned-chats', { params: { bdAccountId: s.selectedAccountId } })
      .then((res) => {
        const list = Array.isArray(res.data) ? res.data : [];
        s.setPinnedChannelIds(list.map((p: { channel_id: string }) => String(p.channel_id)));
      })
      .catch(() => s.setPinnedChannelIds([]));
  }, [s.selectedAccountId]);

  useEffect(() => {
    const checkSync = async () => {
      if (!s.selectedAccountId) return;
      const selectedAccount = s.accounts.find((a) => a.id === s.selectedAccountId);
      if (selectedAccount?.sync_status === 'completed' || selectedAccount?.is_demo === true) {
        s.setAccountSyncReady(true);
        s.setAccountSyncProgress(null);
        s.setAccountSyncError(null);
        return;
      }
      s.setAccountSyncError(null);
      s.setLoadingChats(true);
      try {
        const st = await getBdAccountSyncStatus(s.selectedAccountId);
        const status = st.sync_status;
        const total = Number(st.sync_progress_total ?? 0);
        const done = Number(st.sync_progress_done ?? 0);
        if (status === 'completed') {
          s.setAccountSyncReady(true);
          s.setAccountSyncProgress(null);
          await fetchChatsImpl();
        } else if (status === 'syncing') {
          s.setAccountSyncReady(false);
          s.setAccountSyncProgress({ done, total: total || 1 });
          try {
            await startBdAccountSync(s.selectedAccountId, { timeoutMs: 20000 });
            const st2 = await getBdAccountSyncStatus(s.selectedAccountId);
            if (st2.sync_status === 'syncing') {
              s.setAccountSyncProgress({
                done: Number(st2.sync_progress_done ?? 0),
                total: Number(st2.sync_progress_total) || 1,
              });
            }
          } catch (e: unknown) {
            const err = e as { response?: { data?: { error?: string; message?: string } }; message?: string; code?: string };
            const msg = err?.response?.data?.error || err?.response?.data?.message || err?.message || 'Ошибка синхронизации';
            s.setAccountSyncError(
              msg === 'Network Error' || err?.code === 'ECONNABORTED'
                ? 'Сервер не ответил. Проверьте, что запущены API Gateway и сервис BD Accounts.'
                : msg
            );
          }
        } else {
          s.setAccountSyncReady(false);
          s.setAccountSyncProgress(null);
        }
      } catch {
        s.setAccountSyncReady(false);
        s.setAccountSyncProgress(null);
      } finally {
        s.setLoadingChats(false);
      }
    };
    checkSync();
  }, [s.selectedAccountId, s.accounts]);

  useEffect(() => {
    if (s.accountSyncReady || !s.selectedAccountId) return;
    const accountId = s.selectedAccountId;
    const poll = async () => {
      try {
        const st = await getBdAccountSyncStatus(accountId);
        const status = st.sync_status;
        if (status === 'completed') {
          s.setAccountSyncReady(true);
          s.setAccountSyncProgress(null);
          s.setAccountSyncError(null);
          await fetchChatsImpl();
          await fetchAccounts();
          return;
        }
        if (status === 'syncing')
          s.setAccountSyncProgress({ done: Number(st.sync_progress_done ?? 0), total: Number(st.sync_progress_total) || 1 });
      } catch {
        /* ignore */
      }
    };
    const interval = setInterval(poll, 2000);
    s.pollSyncStatusRef.current = interval;
    return () => {
      if (s.pollSyncStatusRef.current) {
        clearInterval(s.pollSyncStatusRef.current);
        s.pollSyncStatusRef.current = null;
      }
    };
  }, [s.selectedAccountId, s.accountSyncReady]);

  useEffect(() => {
    if (s.selectedChat && s.selectedAccountId) {
      const key = getMessagesCacheKey(s.selectedAccountId, s.selectedChat.channel_id);
      const prevKey = s.prevChatCacheKeyRef.current;
      if (prevKey && prevKey !== key) {
        const order = s.messagesCacheOrderRef.current;
        const cache = s.messagesCacheRef.current;
        cache.set(prevKey, {
          messages: s.messages,
          messagesTotal: s.messagesTotal,
          messagesPage: s.messagesPage,
          historyExhausted: s.historyExhausted,
        });
        const idx = order.indexOf(prevKey);
        if (idx !== -1) order.splice(idx, 1);
        order.push(prevKey);
        while (order.length > MAX_CACHED_CHATS) {
          const evict = order.shift()!;
          cache.delete(evict);
        }
      }
      s.prevChatCacheKeyRef.current = key;
      const cached = s.messagesCacheRef.current.get(key);
      if (cached) {
        if (cached.messages.length === 0 && !cached.historyExhausted) {
          s.setMessages([]);
          fetchMessages(s.selectedAccountId, s.selectedChat);
        } else {
          s.setMessages(cached.messages);
          s.setMessagesTotal(cached.messagesTotal);
          s.setMessagesPage(cached.messagesPage);
          s.setHistoryExhausted(cached.historyExhausted);
          s.setLoadingMessages(false);
          s.setPrependedCount(0);
          s.setLastLoadedChannelId(s.selectedChat.channel_id);
          markAsRead();
          return;
        }
        markAsRead();
        return;
      }
      s.setMessages([]);
      fetchMessages(s.selectedAccountId, s.selectedChat);
      markAsRead();
    } else {
      s.prevChatCacheKeyRef.current = null;
      s.setMessages([]);
      s.setLastLoadedChannelId(null);
    }
  }, [s.selectedChat?.channel_id, s.selectedChat?.channel, s.selectedAccountId]);

  useEffect(() => {
    const prev = s.prevChatRef.current;
    if (prev) {
      try {
        localStorage.setItem(getDraftKey(prev.accountId, prev.chatId), s.newMessageRef.current);
      } catch {
        /* ignore */
      }
    }
    s.setReplyToMessage(null);
    if (s.selectedAccountId && s.selectedChat) {
      try {
        const draft = localStorage.getItem(getDraftKey(s.selectedAccountId, s.selectedChat.channel_id)) || '';
        s.setNewMessage(draft);
      } catch {
        /* ignore */
      }
      s.prevChatRef.current = { accountId: s.selectedAccountId, chatId: s.selectedChat.channel_id };
    } else {
      s.prevChatRef.current = null;
    }
  }, [s.selectedAccountId, s.selectedChat?.channel_id]);

  useEffect(() => {
    if (!s.selectedChat) return;
    s.setNewMessage(s.draftByChannel[s.selectedChat.channel_id]?.text ?? '');
  }, [s.selectedChat?.channel_id]);

  useEffect(() => {
    s.setChannelNeedsRefresh(null);
  }, [s.selectedAccountId]);

  useEffect(() => {
    if (s.selectedAccountId && s.selectedChat) {
      setCurrentMessagingChat(s.selectedAccountId, s.selectedChat.channel_id);
    } else {
      setCurrentMessagingChat(null, null);
    }
    return () => setCurrentMessagingChat(null, null);
  }, [s.selectedAccountId, s.selectedChat?.channel_id]);

  useEffect(() => {
    if (!s.selectedAccountId || !s.selectedChat) return;
    const accountId = s.selectedAccountId;
    const channelId = s.selectedChat.channel_id;
    const text = s.newMessage.trim();
    const replyToMsgId = s.replyToMessage?.telegram_message_id ? Number(s.replyToMessage.telegram_message_id) : undefined;
    if (s.draftSaveTimerRef.current) clearTimeout(s.draftSaveTimerRef.current);
    s.draftSaveTimerRef.current = setTimeout(() => {
      s.draftSaveTimerRef.current = null;
      saveBdAccountDraft(accountId, { channelId, text, replyToMsgId }).catch((err) => {
        reportWarning('Draft save failed', { error: err, component: 'useMessagingData', action: 'saveDraft' });
      });
    }, 1500);
    return () => {
      if (s.draftSaveTimerRef.current) {
        clearTimeout(s.draftSaveTimerRef.current);
        s.draftSaveTimerRef.current = null;
      }
    };
  }, [s.selectedAccountId, s.selectedChat?.channel_id, s.newMessage, s.replyToMessage?.telegram_message_id]);

  useEffect(() => {
    if (s.activeSidebarSection === 'new-leads') fetchNewLeads();
  }, [s.activeSidebarSection, fetchNewLeads]);

  useEffect(() => {
    const leadId = s.selectedChat?.lead_id;
    if (!leadId || !isLeadPanelOpen) {
      s.setLeadContext(null);
      s.setLeadContextError(null);
      return;
    }
    let cancelled = false;
    s.setLeadContextLoading(true);
    s.setLeadContextError(null);
    const url = convId
      ? `/api/messaging/conversations/${convId}/lead-context`
      : `/api/messaging/lead-context-by-lead/${leadId}`;
    apiClient
      .get<LeadContext>(url)
      .then((res) => {
        if (!cancelled && res.data) s.setLeadContext(res.data);
      })
      .catch((err: { response?: { data?: { error?: string } } }) => {
        if (!cancelled) s.setLeadContextError(err?.response?.data?.error ?? 'Failed to load lead context');
      })
      .finally(() => {
        if (!cancelled) s.setLeadContextLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [convId, s.selectedChat?.lead_id, isLeadPanelOpen]);

  useEffect(() => {
    if (!s.leadContext?.contact_id) {
      s.setLeadNotes([]);
      s.setLeadReminders([]);
      return;
    }
    const cid = s.leadContext.contact_id;
    fetchContactNotes(cid).then(s.setLeadNotes).catch(() => s.setLeadNotes([]));
    fetchContactReminders(cid).then(s.setLeadReminders).catch(() => s.setLeadReminders([]));
  }, [s.leadContext?.contact_id]);

  useEffect(() => {
    const el = s.messageInputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 40), 120)}px`;
  }, [s.newMessage]);
}
