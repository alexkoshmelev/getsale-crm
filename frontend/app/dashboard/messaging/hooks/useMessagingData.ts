'use client';

import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import type { MessagingState } from './useMessagingState';
import { useMessagingDataLoaders } from './useMessagingDataLoaders';
import { useMessagingDataEffects } from './useMessagingDataEffects';

export function useMessagingData(s: MessagingState) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const convId = s.selectedChat?.conversation_id ?? null;
  const isLead = !!s.selectedChat?.lead_id;
  const isLeadPanelOpen = isLead && s.rightPanelOpen && s.rightPanelTab === 'lead_card';

  const loaders = useMessagingDataLoaders(s);
  useMessagingDataEffects(s, { searchParams, router, pathname }, loaders);

  return {
    convId,
    isLead,
    isLeadPanelOpen,
    fetchAccounts: loaders.fetchAccounts,
    fetchChats: loaders.fetchChats,
    getChats: loaders.fetchChatsImpl,
    fetchMessages: loaders.fetchMessages,
    fetchNewLeads: loaders.fetchNewLeads,
    markAsRead: loaders.markAsRead,
  };
}
