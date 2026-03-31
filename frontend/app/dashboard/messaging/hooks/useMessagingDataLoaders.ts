'use client';

import { useCallback } from 'react';
import { useAuthStore } from '@/lib/stores/auth-store';
import { apiClient } from '@/lib/api/client';
import { listBdAccounts } from '@/lib/api/bd-accounts';
import { reportError, reportWarning } from '@/lib/error-reporter';
import { isBdAgentRole } from '@/lib/permissions';
import type { BDAccount, Chat } from '../types';
import { MESSAGES_PAGE_SIZE } from '../types';
import { mapRawChatsToChatList, mapNewLeadRowToChat } from '../utils';
import type { MessagingState } from './useMessagingState';

export interface MessagingDataLoaders {
  fetchAccounts: () => Promise<void>;
  fetchChatsImpl: () => Promise<Chat[]>;
  fetchChats: () => Promise<void>;
  fetchMessages: (accountId: string, chat: Chat) => Promise<void>;
  fetchNewLeads: () => Promise<void>;
  markAsRead: () => Promise<void>;
}

export function useMessagingDataLoaders(s: MessagingState): MessagingDataLoaders {
  const fetchAccounts = useCallback(async () => {
    try {
      const user = useAuthStore.getState().user;
      let list: BDAccount[] = await listBdAccounts();
      if (isBdAgentRole(user?.role)) list = list.filter((a) => a.is_owner === true);
      const sorted = [...list].sort((a, b) => (b.is_owner ? 1 : 0) - (a.is_owner ? 1 : 0));
      s.setAccounts(sorted);
      if (sorted.length > 0 && (!s.selectedAccountId || !sorted.some((a) => a.id === s.selectedAccountId))) {
        s.setSelectedAccountId(sorted[0].id);
      }
    } catch (error) {
      reportError(error, { component: 'useMessagingData', action: 'fetchAccounts' });
    } finally {
      s.setLoading(false);
    }
  }, [s.selectedAccountId]);

  const fetchChatsImpl = useCallback(async (): Promise<Chat[]> => {
    if (!s.selectedAccountId) return [];
    s.setLoadingChats(true);
    try {
      let chatsFromApi: unknown[] = [];
      try {
        const chatsResponse = await apiClient.get('/api/messaging/chats', {
          params: { channel: 'telegram', bdAccountId: s.selectedAccountId },
        });
        chatsFromApi = chatsResponse.data || [];
      } catch (chatsError) {
        reportWarning('Could not fetch chats from messaging service', { error: chatsError });
      }
      const formattedChats = mapRawChatsToChatList(chatsFromApi as Record<string, unknown>[]);
      s.setChats(formattedChats);
      return formattedChats;
    } catch (error) {
      reportError(error, { component: 'useMessagingData', action: 'fetchChats' });
      s.setChats([]);
      return [];
    } finally {
      s.setLoadingChats(false);
    }
  }, [s.selectedAccountId]);

  const fetchChats = useCallback(async (): Promise<void> => {
    await fetchChatsImpl();
  }, [fetchChatsImpl]);

  s.fetchChatsRef.current = fetchChats;

  const fetchMessages = useCallback(async (accountId: string, chat: Chat) => {
    s.setLoadingMessages(true);
    s.setMessagesPage(1);
    s.setMessagesTotal(0);
    s.setHistoryExhausted(false);
    try {
      const response = await apiClient.get('/api/messaging/messages', {
        params: { channel: chat.channel, channelId: chat.channel_id, bdAccountId: accountId, page: 1, limit: MESSAGES_PAGE_SIZE },
      });
      const list = response.data.messages || [];
      s.setMessages(list);
      s.setMessagesTotal(response.data.pagination?.total ?? list.length);
      s.setHistoryExhausted(response.data.historyExhausted === true);
      s.setLastLoadedChannelId(chat.channel_id);
    } catch (error) {
      reportError(error, { component: 'useMessagingData', action: 'fetchMessages' });
      s.setMessages([]);
      s.setMessagesTotal(0);
      s.setHistoryExhausted(false);
      s.setLastLoadedChannelId(chat.channel_id);
    } finally {
      s.setLoadingMessages(false);
    }
  }, []);

  const fetchNewLeads = useCallback(async () => {
    s.setNewLeadsLoading(true);
    try {
      const res = await apiClient.get<Record<string, unknown>[]>('/api/messaging/new-leads');
      const rows = Array.isArray(res.data) ? res.data : [];
      s.setNewLeads(rows.map((r) => mapNewLeadRowToChat(r)));
    } catch {
      s.setNewLeads([]);
    } finally {
      s.setNewLeadsLoading(false);
    }
  }, []);

  const markAsRead = useCallback(async () => {
    if (!s.selectedChat || !s.selectedAccountId) return;
    const chatUnread = s.selectedChat.unread_count ?? 0;
    try {
      await apiClient.post(`/api/messaging/chats/${s.selectedChat.channel_id}/mark-all-read?channel=${s.selectedChat.channel}`);
      s.setChats((prev) => prev.map((c) => (c.channel_id === s.selectedChat!.channel_id ? { ...c, unread_count: 0 } : c)));
      if (chatUnread > 0) {
        s.setAccounts((prev) =>
          prev.map((a) =>
            a.id === s.selectedAccountId ? { ...a, unread_count: Math.max(0, (a.unread_count ?? 0) - chatUnread) } : a
          )
        );
      }
    } catch (error) {
      reportWarning('Error marking as read', { error });
    }
  }, [s.selectedChat, s.selectedAccountId]);

  return {
    fetchAccounts,
    fetchChatsImpl,
    fetchChats,
    fetchMessages,
    fetchNewLeads,
    markAsRead,
  };
}
