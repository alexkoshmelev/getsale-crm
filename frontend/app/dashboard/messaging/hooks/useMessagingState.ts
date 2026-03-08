'use client';

import { useRef, useEffect, type MutableRefObject } from 'react';
import {
  useMessagingAccountsStore,
  setAccountsCollapsed as setAccountsCollapsedStore,
  type MessagingAccountsState,
  type MessagingAccountsSetters,
} from '../stores/messaging-accounts-store';
import {
  useMessagingChatsStore,
  setChatsCollapsed as setChatsCollapsedStore,
  setHideEmptyFolders as setHideEmptyFoldersStore,
  type MessagingChatsState,
  type MessagingChatsSetters,
} from '../stores/messaging-chats-store';
import {
  useMessagingMessagesStore,
  type MessagingMessagesState,
  type MessagingMessagesSetters,
} from '../stores/messaging-messages-store';
import {
  useMessagingUIStore,
  initRightPanelTab,
  type MessagingUIState,
  type MessagingUISetters,
} from '../stores/messaging-ui-store';
import type { MessagesCacheEntry } from '../types';

export interface MessagingStateRefs {
  messagesEndRef: MutableRefObject<HTMLDivElement | null>;
  messagesTopSentinelRef: MutableRefObject<HTMLDivElement | null>;
  messagesScrollRef: MutableRefObject<HTMLDivElement | null>;
  scrollRestoreRef: MutableRefObject<{ height: number; top: number } | null>;
  hasUserScrolledUpRef: MutableRefObject<boolean>;
  loadOlderLastCallRef: MutableRefObject<number>;
  skipScrollToBottomAfterPrependRef: MutableRefObject<boolean>;
  isAtBottomRef: MutableRefObject<boolean>;
  scrollToBottomRef: MutableRefObject<() => void>;
  virtuosoRef: MutableRefObject<unknown>;
  messagesCacheRef: MutableRefObject<Map<string, MessagesCacheEntry>>;
  messagesCacheOrderRef: MutableRefObject<string[]>;
  fileInputRef: MutableRefObject<HTMLInputElement | null>;
  chatHeaderMenuRef: MutableRefObject<HTMLDivElement | null>;
  messageInputRef: MutableRefObject<HTMLTextAreaElement | null>;
  prevChatRef: MutableRefObject<{ accountId: string; chatId: string } | null>;
  newMessageRef: MutableRefObject<string>;
  fetchChatsRef: MutableRefObject<(() => Promise<void>) | null>;
  urlOpenAppliedRef: MutableRefObject<boolean>;
  contactIdResolvedRef: MutableRefObject<boolean>;
  typingClearTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  draftSaveTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  pollSyncStatusRef: MutableRefObject<NodeJS.Timeout | null>;
  prevChatCacheKeyRef: MutableRefObject<string | null>;
}

export type MessagingState = MessagingAccountsState &
  MessagingAccountsSetters &
  MessagingChatsState &
  MessagingChatsSetters &
  MessagingMessagesState &
  MessagingMessagesSetters &
  MessagingUIState &
  MessagingUISetters &
  MessagingStateRefs & {
    setAccountsCollapsed: (v: boolean) => void;
    setChatsCollapsed: (v: boolean) => void;
    setHideEmptyFolders: (v: boolean) => void;
  };

/**
 * Returns combined messaging state from 4 stores (accounts, chats, messages, UI) + refs.
 * For fewer re-renders, use the individual stores with selectors, e.g.:
 *   useMessagingAccountsStore(s => ({ accounts: s.accounts, selectedAccountId: s.selectedAccountId }))
 *   useMessagingChatsStore(s => s.chats)
 */
export function useMessagingState(): MessagingState {
  const accountsState = useMessagingAccountsStore();
  const chatsState = useMessagingChatsStore();
  const messagesState = useMessagingMessagesStore();
  const uiState = useMessagingUIStore();
  const newMessage = useMessagingMessagesStore((s) => s.newMessage);

  useEffect(() => {
    initRightPanelTab();
  }, []);

  // ─── Refs (must stay in hook; Zustand doesn't own refs) ─────────────
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesTopSentinelRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const scrollRestoreRef = useRef<{ height: number; top: number } | null>(null);
  const hasUserScrolledUpRef = useRef(false);
  const loadOlderLastCallRef = useRef<number>(0);
  const skipScrollToBottomAfterPrependRef = useRef(false);
  const isAtBottomRef = useRef(true);
  const scrollToBottomRef = useRef<() => void>(() => {});
  const virtuosoRef = useRef<unknown>(null);
  const messagesCacheRef = useRef<Map<string, MessagesCacheEntry>>(new Map());
  const messagesCacheOrderRef = useRef<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatHeaderMenuRef = useRef<HTMLDivElement>(null);
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const prevChatRef = useRef<{ accountId: string; chatId: string } | null>(null);
  const newMessageRef = useRef(newMessage);
  newMessageRef.current = newMessage;
  const fetchChatsRef = useRef<(() => Promise<void>) | null>(null);
  const urlOpenAppliedRef = useRef(false);
  const contactIdResolvedRef = useRef(false);
  const typingClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollSyncStatusRef = useRef<NodeJS.Timeout | null>(null);
  const prevChatCacheKeyRef = useRef<string | null>(null);

  const setAccountsCollapsed = (v: boolean) => setAccountsCollapsedStore(v);
  const setChatsCollapsed = (v: boolean) => setChatsCollapsedStore(v);
  const setHideEmptyFolders = (v: boolean) => setHideEmptyFoldersStore(v);

  return {
    ...accountsState,
    ...chatsState,
    ...messagesState,
    ...uiState,
    setAccountsCollapsed,
    setChatsCollapsed,
    setHideEmptyFolders,
    messagesEndRef,
    messagesTopSentinelRef,
    messagesScrollRef,
    scrollRestoreRef,
    hasUserScrolledUpRef,
    loadOlderLastCallRef,
    skipScrollToBottomAfterPrependRef,
    isAtBottomRef,
    scrollToBottomRef,
    virtuosoRef,
    messagesCacheRef,
    messagesCacheOrderRef,
    fileInputRef,
    chatHeaderMenuRef,
    messageInputRef,
    prevChatRef,
    newMessageRef,
    fetchChatsRef,
    urlOpenAppliedRef,
    contactIdResolvedRef,
    typingClearTimerRef,
    draftSaveTimerRef,
    pollSyncStatusRef,
    prevChatCacheKeyRef,
  };
}
