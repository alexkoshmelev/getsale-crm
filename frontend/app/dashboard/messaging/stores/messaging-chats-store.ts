'use client';

import { create } from 'zustand';
import type { Chat, SyncFolder, BDAccount } from '../types';
import { STORAGE_KEYS } from '../types';

function getInitialChatsPanel(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(STORAGE_KEYS.chatsPanel) === 'true';
  } catch {
    return false;
  }
}

function getInitialHideEmptyFolders(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return localStorage.getItem(STORAGE_KEYS.hideEmptyFolders) !== 'false';
  } catch {
    return true;
  }
}

export interface MessagingChatsState {
  chats: Chat[];
  selectedChat: Chat | null;
  chatSearch: string;
  folders: SyncFolder[];
  selectedFolderId: number;
  pinnedChannelIds: string[];
  chatTypeFilter: 'all' | 'personal' | 'groups';
  chatsPanelCollapsed: boolean;
  hideEmptyFolders: boolean;
  loadingChats: boolean;
  chatContextMenu: { x: number; y: number; chat: Chat } | null;
  accountContextMenu: { x: number; y: number; account: BDAccount } | null;
}

type SetState = (partial: Partial<MessagingChatsState> | ((prev: MessagingChatsState) => Partial<MessagingChatsState>)) => void;

export type MessagingChatsSetters = {
  [K in keyof MessagingChatsState as K extends 'chatsPanelCollapsed' | 'hideEmptyFolders' ? never : `set${Capitalize<K & string>}`]: (
    v: MessagingChatsState[K] | ((prev: MessagingChatsState[K]) => MessagingChatsState[K])
  ) => void;
};

function createSetters(set: SetState): MessagingChatsSetters {
  const keys: (keyof MessagingChatsState)[] = [
    'chats', 'selectedChat', 'chatSearch', 'folders', 'selectedFolderId', 'pinnedChannelIds',
    'chatTypeFilter', 'loadingChats', 'chatContextMenu', 'accountContextMenu',
  ];
  const out = {} as Record<string, (v: unknown) => void>;
  for (const k of keys) {
    const name = 'set' + (k.charAt(0).toUpperCase() + k.slice(1));
    out[name] = (v: unknown) =>
      set((s) => ({ [k]: typeof v === 'function' ? (v as (p: unknown) => unknown)(s[k]) : v }));
  }
  return out as MessagingChatsSetters;
}

const initialState: MessagingChatsState = {
  chats: [],
  selectedChat: null,
  chatSearch: '',
  folders: [],
  selectedFolderId: 0,
  pinnedChannelIds: [],
  chatTypeFilter: 'all',
  chatsPanelCollapsed: getInitialChatsPanel(),
  hideEmptyFolders: getInitialHideEmptyFolders(),
  loadingChats: false,
  chatContextMenu: null,
  accountContextMenu: null,
};

export const useMessagingChatsStore = create<MessagingChatsState & MessagingChatsSetters>((set) => ({
  ...initialState,
  ...createSetters(set),
}));

export function setChatsCollapsed(v: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEYS.chatsPanel, String(v));
  } catch {}
  useMessagingChatsStore.setState({ chatsPanelCollapsed: v });
}

export function setHideEmptyFolders(v: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEYS.hideEmptyFolders, String(v));
  } catch {}
  useMessagingChatsStore.setState({ hideEmptyFolders: v });
}
