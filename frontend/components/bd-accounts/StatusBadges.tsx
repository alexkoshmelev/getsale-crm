'use client';

import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import {
  connectionLabelKey,
  proxyLabelKey,
  resolveConnectionState,
  resolveProxyState,
} from '@/lib/bd-account-status-display';
import type { BDAccount } from '@/lib/types/bd-account';

type Props = {
  account: Pick<BDAccount, 'connection_state' | 'is_active' | 'proxy_status' | 'proxy_config' | 'last_proxy_error'>;
  compact?: boolean;
};

export function StatusBadges({ account, compact = false }: Props) {
  const { t } = useTranslation();
  const connectionState = resolveConnectionState(account);
  const proxyState = resolveProxyState(account);

  return (
    <div className={clsx('flex items-center gap-2', compact && 'flex-wrap')}>
      <span
        className={clsx(
          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
          connectionState === 'connected' && 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
          connectionState === 'reconnecting' && 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
          connectionState === 'reauth_required' && 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
          connectionState === 'disconnected' && 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
        )}
      >
        {t(connectionLabelKey(connectionState))}
      </span>
      <span
        title={account.last_proxy_error || undefined}
        className={clsx(
          'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
          proxyState === 'ok' && 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300',
          proxyState === 'configured' && 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
          proxyState === 'error' && 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300',
          proxyState === 'none' && 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'
        )}
      >
        {t(proxyLabelKey(proxyState))}
      </span>
    </div>
  );
}
