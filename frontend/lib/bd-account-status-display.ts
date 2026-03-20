import type { BDAccount } from '@/lib/types/bd-account';

export type ConnectionState = 'connected' | 'reconnecting' | 'disconnected' | 'reauth_required';
export type ProxyState = 'none' | 'configured' | 'ok' | 'error';

export function resolveConnectionState(account: Pick<BDAccount, 'connection_state' | 'is_active'>): ConnectionState {
  return account.connection_state ?? (account.is_active ? 'connected' : 'disconnected');
}

export function resolveProxyState(account: Pick<BDAccount, 'proxy_status' | 'proxy_config'>): ProxyState {
  if (account.proxy_status) return account.proxy_status;
  return account.proxy_config?.host ? 'configured' : 'none';
}

export function connectionLabelKey(state: ConnectionState): string {
  if (state === 'connected') return 'bdAccounts.connectionConnected';
  if (state === 'reconnecting') return 'bdAccounts.connectionReconnecting';
  if (state === 'reauth_required') return 'bdAccounts.connectionReauthRequired';
  return 'bdAccounts.connectionDisconnected';
}

export function proxyLabelKey(state: ProxyState): string {
  if (state === 'ok') return 'bdAccounts.proxyOk';
  if (state === 'error') return 'bdAccounts.proxyError';
  if (state === 'configured') return 'bdAccounts.proxyConfigured';
  return 'bdAccounts.proxyNone';
}

export function shouldAutoRefreshAccount(account: Pick<BDAccount, 'connection_state' | 'proxy_status' | 'is_active'>): boolean {
  const connection = resolveConnectionState(account);
  const proxy = resolveProxyState(account as Pick<BDAccount, 'proxy_status' | 'proxy_config'>);
  return connection === 'reconnecting' || connection === 'reauth_required' || proxy === 'error';
}

export function formatRelativeDateTime(input?: string | null): string | null {
  if (!input) return null;
  const date = new Date(input);
  const ts = date.getTime();
  if (!Number.isFinite(ts)) return null;

  const diffMs = ts - Date.now();
  const absSec = Math.abs(diffMs) / 1000;
  if (absSec < 60) return 'just now';
  if (absSec < 3600) return `${Math.round(diffMs / 60000)}m`;
  if (absSec < 86400) return `${Math.round(diffMs / 3600000)}h`;
  return `${Math.round(diffMs / 86400000)}d`;
}
