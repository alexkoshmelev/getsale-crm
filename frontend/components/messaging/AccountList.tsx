'use client';

import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Search, Plus, ChevronRight, ChevronLeft, UserCircle,
  CheckCircle2, XCircle,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { BDAccountAvatar } from '@/components/messaging/BDAccountAvatar';
import type { BDAccount } from '@/app/dashboard/messaging/types';
import { getAccountDisplayName } from '@/app/dashboard/messaging/utils';

interface AccountListProps {
  accounts: BDAccount[];
  filteredAccounts: BDAccount[];
  selectedAccountId: string | null;
  collapsed: boolean;
  accountSearch: string;
  onSelectAccount: (id: string) => void;
  onCollapse: (v: boolean) => void;
  onSearchChange: (v: string) => void;
  onAccountContextMenu: (e: React.MouseEvent, account: BDAccount) => void;
}

export function AccountList({
  accounts, filteredAccounts, selectedAccountId, collapsed,
  accountSearch, onSelectAccount, onCollapse, onSearchChange,
  onAccountContextMenu,
}: AccountListProps) {
  const { t } = useTranslation();

  if (collapsed) {
    return (
      <div className="flex flex-col flex-1 min-h-0 w-full">
        <button
          type="button"
          onClick={() => onCollapse(false)}
          className="p-2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground flex flex-col items-center gap-0.5 w-full shrink-0 border-b border-border"
          title={t('messaging.bdAccounts') + ' — развернуть'}
        >
          <UserCircle className="w-5 h-5 shrink-0" aria-hidden />
          <ChevronRight className="w-4 h-4 shrink-0" aria-hidden />
        </button>
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center pt-2 pb-1 gap-1 scroll-thin-overlay">
          {filteredAccounts.map((account) => (
            <button
              key={account.id}
              type="button"
              onClick={() => onSelectAccount(account.id)}
              onContextMenu={(e) => { e.preventDefault(); onAccountContextMenu(e, account); }}
              title={getAccountDisplayName(account)}
              className={`relative shrink-0 rounded-full p-0.5 transition-colors hover:ring-2 hover:ring-primary/50 ${
                selectedAccountId === account.id ? 'ring-2 ring-primary' : ''
              }`}
            >
              <BDAccountAvatar accountId={account.id} account={account} className="w-8 h-8" />
              {(account.unread_count ?? 0) > 0 && (
                <span className="absolute -top-0.5 -right-0.5 min-w-[0.875rem] h-3.5 px-0.5 rounded-full bg-primary text-primary-foreground text-[10px] flex items-center justify-center leading-none">
                  {account.unread_count! > 99 ? '99+' : account.unread_count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="p-3 border-b border-border flex flex-col gap-2 shrink-0">
        <div className="flex items-center justify-between gap-2 min-h-[2rem]">
          <h3 className="font-semibold text-foreground truncate">{t('messaging.bdAccounts')}</h3>
          <button type="button" onClick={() => onCollapse(true)} className="p-1.5 rounded-md text-muted-foreground hover:bg-accent shrink-0" title={t('messaging.collapseAccountsPanel')}>
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative flex-1 min-w-0">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-muted-foreground" />
            <Input type="text" placeholder={t('common.search')} value={accountSearch} onChange={(e) => onSearchChange(e.target.value)} className="pl-9 text-sm" />
          </div>
          <Button size="sm" onClick={() => window.location.href = '/dashboard/bd-accounts'} className="p-1.5 shrink-0" title={t('messaging.addAccount')}>
            <Plus className="w-4 h-4" />
          </Button>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col scroll-thin-overlay">
        {filteredAccounts.length === 0 ? (
          <div className="p-4 text-center text-sm text-muted-foreground flex-1 min-h-0 flex items-center justify-center">
            {t('messaging.noAccounts')}
          </div>
        ) : (
          filteredAccounts.map((account) => (
            <div
              key={account.id}
              onClick={() => onSelectAccount(account.id)}
              onContextMenu={(e) => { e.preventDefault(); onAccountContextMenu(e, account); }}
              className={`p-3 cursor-pointer border-b border-border hover:bg-accent flex gap-3 ${
                selectedAccountId === account.id ? 'bg-primary/10 border-l-4 border-l-primary' : ''
              }`}
            >
              <BDAccountAvatar accountId={account.id} account={account} className="w-10 h-10 shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="font-medium text-sm truncate">{getAccountDisplayName(account)}</div>
                <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                  <span className="text-xs text-muted-foreground truncate">
                    {account.username ? `@${account.username}` : account.phone_number || 'Telegram'}
                  </span>
                  {account.is_owner ? (
                    <span className="text-xs text-primary font-medium shrink-0">{t('messaging.yourAccount')}</span>
                  ) : (
                    <span className="text-xs text-muted-foreground shrink-0">{t('messaging.colleague')}</span>
                  )}
                  {account.sync_status === 'completed' ? (
                    <span className="text-xs text-green-600 dark:text-green-400 font-medium shrink-0">{t('messaging.ready')}</span>
                  ) : (
                    <span className="text-xs text-amber-600 dark:text-amber-400 font-medium shrink-0">{t('messaging.syncing')}</span>
                  )}
                  <span
                    className={`inline-flex w-2 h-2 rounded-full shrink-0 ${
                      account.proxy_status === 'ok' ? 'bg-green-500' :
                      account.proxy_status === 'error' ? 'bg-red-500' :
                      account.proxy_status === 'configured' ? 'bg-amber-500' :
                      'bg-gray-400'
                    }`}
                    title={
                      account.proxy_status === 'ok' ? 'Proxy OK' :
                      account.proxy_status === 'error' ? (account.last_proxy_error || 'Proxy Error') :
                      account.proxy_status === 'configured' ? 'Proxy Configured' :
                      'No Proxy'
                    }
                  />
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {(account.unread_count ?? 0) > 0 && (
                  <span className="min-w-[1.25rem] h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center tabular-nums">
                    {account.unread_count! > 99 ? '99+' : account.unread_count}
                  </span>
                )}
                {account.connection_state === 'reauth_required' ? (
                  <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />
                ) : account.is_active ? (
                  <CheckCircle2 className="w-4 h-4 text-green-500 dark:text-green-400 flex-shrink-0" />
                ) : (
                  <XCircle className="w-4 h-4 text-muted-foreground flex-shrink-0" />
                )}
              </div>
            </div>
          ))
        )}
      </div>
    </>
  );
}
