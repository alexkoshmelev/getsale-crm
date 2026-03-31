import type { BDAccount } from '@/lib/types/bd-account';
import {
  resolveConnectionState,
  resolveProxyState,
  type ConnectionState,
  type ProxyState,
} from '@/lib/bd-account-status-display';

export type AccountHealthLevel = 'ok' | 'attention' | 'critical';

export type HealthTileVariant = 'ok' | 'warning' | 'error' | 'neutral';

export interface AccountHealthTile {
  id: 'connection' | 'sync' | 'proxy' | 'flood' | 'autoresponder';
  variant: HealthTileVariant;
}

/** True when Telegram FLOOD_WAIT window is still active (PEER_FLOOD). */
export function isFloodActive(account: Pick<BDAccount, 'flood_wait_until'>): boolean {
  if (!account.flood_wait_until) return false;
  const d = new Date(account.flood_wait_until);
  return !Number.isNaN(d.getTime()) && d.getTime() > Date.now();
}

function syncTileVariant(account: Pick<BDAccount, 'sync_error' | 'sync_status'>): HealthTileVariant {
  if (account.sync_error?.trim()) return 'error';
  const s = (account.sync_status || '').toLowerCase();
  if (s === 'error' || s === 'failed') return 'error';
  if (s === 'syncing' || s === 'in_progress') return 'warning';
  return 'ok';
}

function connectionTileVariant(
  state: ConnectionState,
  account: Pick<BDAccount, 'is_active'>
): HealthTileVariant {
  if (state === 'connected') return 'ok';
  if (state === 'reconnecting') return 'warning';
  if (state === 'reauth_required') return 'error';
  if (state === 'disconnected' && !account.is_active) return 'neutral';
  return 'warning';
}

function proxyTileVariant(state: ProxyState): HealthTileVariant {
  if (state === 'ok' || state === 'none') return state === 'ok' ? 'ok' : 'neutral';
  if (state === 'error') return 'error';
  return 'warning';
}

function floodTileVariant(account: Pick<BDAccount, 'flood_wait_until'>): HealthTileVariant {
  return isFloodActive(account) ? 'error' : 'ok';
}

function autoresponderTileVariant(account: Pick<BDAccount, 'auto_responder_enabled'>): HealthTileVariant {
  if (account.auto_responder_enabled === true) return 'ok';
  return 'neutral';
}

/**
 * Derives overall health level and per-axis tiles for the BD account card (no API calls).
 */
export function computeAccountHealth(account: BDAccount): {
  level: AccountHealthLevel;
  tiles: AccountHealthTile[];
  runtimeDeferred: boolean;
  hasErrorDetails: boolean;
} {
  const conn = resolveConnectionState(account);
  const proxy = resolveProxyState(account);
  const floodOn = isFloodActive(account);
  const runtimeDeferred = account.gramjs_runtime_enabled === false;

  const tiles: AccountHealthTile[] = [
    { id: 'connection', variant: connectionTileVariant(conn, account) },
    { id: 'sync', variant: syncTileVariant(account) },
    { id: 'proxy', variant: proxyTileVariant(proxy) },
    { id: 'flood', variant: floodTileVariant(account) },
    { id: 'autoresponder', variant: autoresponderTileVariant(account) },
  ];

  let level: AccountHealthLevel = 'ok';

  if (
    floodOn ||
    conn === 'reauth_required' ||
    proxy === 'error' ||
    tiles.find((tile) => tile.id === 'sync')!.variant === 'error'
  ) {
    level = 'critical';
  } else if (
    conn === 'reconnecting' ||
    (account.is_active && conn === 'disconnected') ||
    proxy === 'configured' ||
    tiles.find((tile) => tile.id === 'sync')!.variant === 'warning' ||
    Boolean(account.last_error_code) ||
    Boolean(account.disconnect_reason?.trim()) ||
    Boolean(account.last_proxy_error?.trim()) ||
    runtimeDeferred
  ) {
    level = 'attention';
  }

  const hasErrorDetails = Boolean(
    account.last_error_code || account.disconnect_reason?.trim() || account.last_proxy_error?.trim()
  );

  return { level, tiles, runtimeDeferred, hasErrorDetails };
}

/** Ring color for campaign UI: yellow = flood, red = other issues, green = ok. */
export function getAccountStatusRingVariant(account: BDAccount): 'green' | 'yellow' | 'red' {
  if (isFloodActive(account)) return 'yellow';
  const { level } = computeAccountHealth(account);
  if (level === 'ok') return 'green';
  return 'red';
}
