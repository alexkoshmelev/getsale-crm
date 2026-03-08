'use client';

import { create } from 'zustand';
import type { Message } from '../types';

export interface MessagingMessagesState {
  messages: Message[];
  newMessage: string;
  loadingMessages: boolean;
  sendingMessage: boolean;
  loadingOlder: boolean;
  messagesPage: number;
  messagesTotal: number;
  historyExhausted: boolean;
  lastLoadedChannelId: string | null;
  prependedCount: number;
  messageContextMenu: { x: number; y: number; message: Message } | null;
  replyToMessage: Message | null;
  deletingMessageId: string | null;
  draftByChannel: Record<string, { text: string; replyToMsgId?: number }>;
}

type SetState = (partial: Partial<MessagingMessagesState> | ((prev: MessagingMessagesState) => Partial<MessagingMessagesState>)) => void;

export type MessagingMessagesSetters = {
  [K in keyof MessagingMessagesState as `set${Capitalize<K & string>}`]: (
    v: MessagingMessagesState[K] | ((prev: MessagingMessagesState[K]) => MessagingMessagesState[K])
  ) => void;
};

function createSetters(set: SetState): MessagingMessagesSetters {
  const keys: (keyof MessagingMessagesState)[] = [
    'messages', 'newMessage', 'loadingMessages', 'sendingMessage', 'loadingOlder', 'messagesPage',
    'messagesTotal', 'historyExhausted', 'lastLoadedChannelId', 'prependedCount', 'messageContextMenu',
    'replyToMessage', 'deletingMessageId', 'draftByChannel',
  ];
  const out = {} as Record<string, (v: unknown) => void>;
  for (const k of keys) {
    const name = 'set' + (k.charAt(0).toUpperCase() + k.slice(1));
    out[name] = (v: unknown) =>
      set((s) => ({ [k]: typeof v === 'function' ? (v as (p: unknown) => unknown)(s[k]) : v }));
  }
  return out as MessagingMessagesSetters;
}

const initialState: MessagingMessagesState = {
  messages: [],
  newMessage: '',
  loadingMessages: false,
  sendingMessage: false,
  loadingOlder: false,
  messagesPage: 1,
  messagesTotal: 0,
  historyExhausted: false,
  lastLoadedChannelId: null,
  prependedCount: 0,
  messageContextMenu: null,
  replyToMessage: null,
  deletingMessageId: null,
  draftByChannel: {},
};

export const useMessagingMessagesStore = create<MessagingMessagesState & MessagingMessagesSetters>((set) => ({
  ...initialState,
  ...createSetters(set),
}));
