'use client';

import { create } from 'zustand';
import type { BDAccount } from '../types';
import { STORAGE_KEYS } from '../types';

function getInitialPanelCollapsed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return localStorage.getItem(STORAGE_KEYS.accountsPanel) === 'true';
  } catch {
    return false;
  }
}

export interface MessagingAccountsState {
  accounts: BDAccount[];
  selectedAccountId: string | null;
  accountSearch: string;
  accountSyncReady: boolean;
  accountSyncProgress: { done: number; total: number } | null;
  accountSyncError: string | null;
  accountsPanelCollapsed: boolean;
  loading: boolean;
}

type SetState = (partial: Partial<MessagingAccountsState> | ((prev: MessagingAccountsState) => Partial<MessagingAccountsState>)) => void;

export type MessagingAccountsSetters = {
  [K in keyof MessagingAccountsState as K extends 'accountsPanelCollapsed' ? never : `set${Capitalize<K & string>}`]: (
    v: MessagingAccountsState[K] | ((prev: MessagingAccountsState[K]) => MessagingAccountsState[K])
  ) => void;
};

function createSetters(set: SetState): MessagingAccountsSetters {
  const keys: (keyof MessagingAccountsState)[] = [
    'accounts', 'selectedAccountId', 'accountSearch', 'accountSyncReady', 'accountSyncProgress',
    'accountSyncError', 'loading',
  ];
  const out = {} as Record<string, (v: unknown) => void>;
  for (const k of keys) {
    const name = 'set' + (k.charAt(0).toUpperCase() + k.slice(1));
    out[name] = (v: unknown) =>
      set((s) => ({ [k]: typeof v === 'function' ? (v as (p: unknown) => unknown)(s[k]) : v }));
  }
  return out as MessagingAccountsSetters;
}

const initialState: MessagingAccountsState = {
  accounts: [],
  selectedAccountId: null,
  accountSearch: '',
  accountSyncReady: true,
  accountSyncProgress: null,
  accountSyncError: null,
  accountsPanelCollapsed: getInitialPanelCollapsed(),
  loading: true,
};

export const useMessagingAccountsStore = create<MessagingAccountsState & MessagingAccountsSetters>((set) => ({
  ...initialState,
  ...createSetters(set),
}));

export function setAccountsCollapsed(v: boolean): void {
  try {
    localStorage.setItem(STORAGE_KEYS.accountsPanel, String(v));
  } catch {}
  useMessagingAccountsStore.setState({ accountsPanelCollapsed: v });
}
