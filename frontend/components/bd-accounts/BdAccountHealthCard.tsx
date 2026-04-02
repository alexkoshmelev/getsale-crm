'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import { clsx } from 'clsx';
import { HeartPulse, Link2, RefreshCw, ShieldAlert, Wifi, ChevronDown, Bot, Ban } from 'lucide-react';
import type { BDAccount } from '@/lib/types/bd-account';
import { computeAccountHealth, type AccountHealthTile } from '@/lib/bd-account-health';
import { FloodStatusPanel } from '@/components/bd-accounts/FloodStatusPanel';
import { SpamStatusPanel } from '@/components/bd-accounts/SpamStatusPanel';

export type BdAccountHealthCardLayout = 'default' | 'sidebar';

type Props = {
  account: BDAccount;
  onRuntimeActivate?: () => void;
  runtimeActivating?: boolean;
  onSpamUpdated?: () => void;
  className?: string;
  layout?: BdAccountHealthCardLayout;
};

function tileIcon(id: AccountHealthTile['id']) {
  switch (id) {
    case 'connection':
      return Wifi;
    case 'sync':
      return RefreshCw;
    case 'proxy':
      return Link2;
    case 'flood':
      return ShieldAlert;
    case 'spam':
      return Ban;
    case 'autoresponder':
      return Bot;
    default:
      return Wifi;
  }
}

function tileRing(variant: AccountHealthTile['variant']): string {
  switch (variant) {
    case 'ok':
      return 'border-emerald-200 bg-emerald-50/80 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/30 dark:text-emerald-100';
    case 'warning':
      return 'border-amber-200 bg-amber-50/80 text-amber-950 dark:border-amber-900/40 dark:bg-amber-950/30 dark:text-amber-100';
    case 'error':
      return 'border-red-200 bg-red-50/80 text-red-950 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-100';
    default:
      return 'border-gray-200 dark:border-gray-600 bg-gray-50/80 dark:bg-gray-900/40 text-gray-600 dark:text-gray-400';
  }
}

export function BdAccountHealthCard({
  account,
  onRuntimeActivate,
  runtimeActivating,
  onSpamUpdated,
  className,
  layout = 'default',
}: Props) {
  const { t } = useTranslation();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const { level, tiles, runtimeDeferred, hasErrorDetails } = computeAccountHealth(account);

  const headerClass =
    level === 'critical'
      ? 'border-red-200/80 bg-red-50/50 dark:border-red-900/40 dark:bg-red-950/20'
      : level === 'attention'
        ? 'border-amber-200/80 bg-amber-50/50 dark:border-amber-900/40 dark:bg-amber-950/20'
        : 'border-emerald-200/70 bg-emerald-50/40 dark:border-emerald-900/35 dark:bg-emerald-950/15';

  return (
    <div className={clsx('rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden', className)}>
      <div className={clsx('flex flex-wrap items-center gap-3 px-4 py-3 border-b border-gray-200 dark:border-gray-700', headerClass)}>
        <HeartPulse className="w-5 h-5 shrink-0 opacity-90" aria-hidden />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold text-gray-900 dark:text-white tracking-tight">
            {t('bdAccountCard.healthSectionTitle')}
          </h2>
          <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5 break-words [overflow-wrap:anywhere]">
            {level === 'critical' && t('bdAccountCard.healthLevelCritical')}
            {level === 'attention' && t('bdAccountCard.healthLevelAttention')}
            {level === 'ok' && t('bdAccountCard.healthLevelOk')}
          </p>
        </div>
        <Link
          href="/dashboard/bd-accounts/health"
          className="text-xs font-medium text-primary hover:underline shrink-0"
        >
          {t('bdAccountCard.teamHealthLink')}
        </Link>
      </div>

      <div className="p-4 space-y-4 bg-white dark:bg-gray-900/30">
        <div
          className={clsx(
            'grid gap-3',
            layout === 'sidebar' ? 'grid-cols-1' : 'grid-cols-2 sm:grid-cols-3 xl:grid-cols-6'
          )}
        >
          {tiles.map((tile) => {
            const Icon = tileIcon(tile.id);
            return (
              <div
                key={tile.id}
                className={clsx(
                  'min-w-0 rounded-lg border px-3 py-2.5 flex flex-col gap-1 break-words [overflow-wrap:anywhere]',
                  tileRing(tile.variant)
                )}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Icon className="w-4 h-4 shrink-0 opacity-80" aria-hidden />
                  <span className="text-xs font-medium leading-tight min-w-0">
                    {t(`bdAccountCard.tile.${tile.id}.label`)}
                  </span>
                </div>
                <span
                  className={clsx(
                    'leading-snug opacity-90',
                    layout === 'sidebar' ? 'text-xs' : 'text-[11px]'
                  )}
                >
                  {t(`bdAccountCard.tile.${tile.id}.hint.${tile.variant}`)}
                </span>
              </div>
            );
          })}
        </div>

        {runtimeDeferred && onRuntimeActivate && (
          <div className="rounded-lg border border-sky-200 dark:border-sky-900/50 bg-sky-50/90 dark:bg-sky-950/30 px-3 py-3 text-sm text-sky-950 dark:text-sky-100">
            <p className="font-medium">{t('bdAccounts.runtimeDeferredTitle')}</p>
            <p className="text-sky-900/80 dark:text-sky-200/90 mt-1 text-xs">{t('bdAccounts.runtimeDeferredBody')}</p>
            <button
              type="button"
              className="mt-3 inline-flex items-center justify-center rounded-lg bg-primary text-primary-foreground px-3 py-1.5 text-sm font-medium disabled:opacity-50"
              onClick={() => void onRuntimeActivate()}
              disabled={runtimeActivating}
            >
              {runtimeActivating ? t('common.loading', { defaultValue: 'Loading…' }) : t('bdAccounts.runtimeDeferredCta')}
            </button>
          </div>
        )}

        <FloodStatusPanel
          flood_wait_until={account.flood_wait_until}
          flood_reason={account.flood_reason}
          flood_last_at={account.flood_last_at}
        />

        <SpamStatusPanel account={account} accountId={account.id} onUpdated={onSpamUpdated} />

        {hasErrorDetails && (
          <div className="rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50/50 dark:bg-gray-900/20">
            <button
              type="button"
              onClick={() => setDetailsOpen((o) => !o)}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left text-xs font-medium text-gray-900 dark:text-white hover:bg-gray-100/80 dark:hover:bg-gray-800/50 rounded-lg"
            >
              {t('bdAccountCard.errorDetailsToggle')}
              <ChevronDown className={clsx('w-4 h-4 shrink-0 transition-transform', detailsOpen && 'rotate-180')} />
            </button>
            {detailsOpen && (
              <div className="px-3 pb-3 pt-0 text-xs text-amber-950 dark:text-amber-100 space-y-1 border-t border-gray-200/60 dark:border-gray-600 bg-amber-50/50 dark:bg-amber-950/20">
                {account.last_error_code && (
                  <p>
                    <span className="font-medium">{t('bdAccounts.healthLastError')}:</span> {account.last_error_code}
                    {account.last_error_at
                      ? ` (${new Date(account.last_error_at).toLocaleString()})`
                      : ''}
                  </p>
                )}
                {(account.disconnect_reason || account.last_proxy_error) && (
                  <p className="opacity-90 whitespace-pre-wrap break-words">
                    {account.disconnect_reason || account.last_proxy_error}
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
