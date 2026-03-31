'use client';

import { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { useTranslation } from 'react-i18next';
import {
  listBdAccounts,
  getBdAccountStatus,
  getBdAccountDialogs,
  disconnectBdAccount,
  enableBdAccount,
  deleteBdAccount,
} from '@/lib/api/bd-accounts';
import { useAuthStore } from '@/lib/stores/auth-store';
import { useWebSocketContext } from '@/lib/contexts/websocket-context';
import { Plus, CheckCircle2, XCircle, Loader2, MessageSquare, Settings, Trash2, Power, PowerOff, ChevronRight, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { AccountAvatar } from './components/AccountAvatar';
import { StatusBadges } from '@/components/bd-accounts/StatusBadges';
import { ConnectModal } from './components/ConnectModal';
import { useBdAccountsConnect } from './hooks/useBdAccountsConnect';
import { getAccountDisplayName } from './utils';
import { formatRelativeDateTime, resolveConnectionState } from '@/lib/bd-account-status-display';
import { reportError } from '@/lib/error-reporter';
import type { BDAccount, Dialog } from './types';

export default function BDAccountsPage() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuthStore();
  const { subscribe, unsubscribe, on, off, isConnected } = useWebSocketContext();
  const [accounts, setAccounts] = useState<BDAccount[]>([]);
  const canManageAccount = (account: BDAccount) =>
    (currentUser?.role?.toLowerCase() !== 'bidi') || account.is_owner === true;
  const [loading, setLoading] = useState(true);
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [dialogs, setDialogs] = useState<Dialog[]>([]);
  const [loadingDialogs, setLoadingDialogs] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAccounts = useCallback(async () => {
    try {
      const rows = await listBdAccounts();
      setAccounts(rows);
    } catch (err: unknown) {
      const e = err as { response?: { data?: { error?: string } } };
      reportError(err, { component: 'BDAccountsPage', action: 'fetchAccounts' });
      setError(e.response?.data?.error || 'Ошибка загрузки аккаунтов');
    } finally {
      setLoading(false);
    }
  }, []);

  const connect = useBdAccountsConnect({
    onAccountsRefresh: fetchAccounts,
    subscribe,
    unsubscribe,
    on,
    off,
    isConnected,
  });

  useEffect(() => {
    fetchAccounts();
  }, [fetchAccounts]);

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchAccounts();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [fetchAccounts]);

  const fetchAccountStatus = async (accountId: string) => {
    try {
      const data = await getBdAccountStatus(accountId);
      setAccounts((prev) =>
        prev.map((acc) => (acc.id === accountId ? { ...acc, ...data } : acc))
      );
      return data;
    } catch (error) {
      reportError(error, { component: 'BDAccountsPage', action: 'fetchAccountStatus' });
    }
  };

  const fetchDialogs = async (accountId: string) => {
    setLoadingDialogs(true);
    try {
      const data = await getBdAccountDialogs(accountId);
      setDialogs(data as Dialog[]);
      setSelectedAccount(accountId);
    } catch (error: any) {
      reportError(error, { component: 'BDAccountsPage', action: 'fetchDialogs' });
      setError(error.response?.data?.error || 'Ошибка загрузки диалогов');
    } finally {
      setLoadingDialogs(false);
    }
  };

  const handleDisconnect = async (accountId: string) => {
    if (!confirm('Отключить аккаунт? Получение сообщений будет приостановлено до включения.')) return;

    try {
      setError('');
      await disconnectBdAccount(accountId);
      await fetchAccounts();
    } catch (error: any) {
      reportError(error, { component: 'BDAccountsPage', action: 'disconnect' });
      setError(error.response?.data?.error || error.response?.data?.message || 'Ошибка отключения');
    }
  };

  const handleEnable = async (accountId: string) => {
    try {
      setError('');
      await enableBdAccount(accountId);
      await fetchAccounts();
    } catch (error: any) {
      reportError(error, { component: 'BDAccountsPage', action: 'enable' });
      setError(error.response?.data?.error || error.response?.data?.message || 'Ошибка включения');
    }
  };

  const handleDelete = async (accountId: string) => {
    if (!confirm('Удалить аккаунт навсегда? История сообщений останется, аккаунт будет отвязан.')) return;

    try {
      setError('');
      await deleteBdAccount(accountId);
      await fetchAccounts();
    } catch (error: any) {
      reportError(error, { component: 'BDAccountsPage', action: 'delete' });
      setError(error.response?.data?.error || error.response?.data?.message || 'Ошибка удаления');
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white">BD Аккаунты</h1>
          <p className="text-gray-500 dark:text-gray-400 mt-1">
            Управление Telegram аккаунтами для отправки сообщений
          </p>
        </div>
        <Button onClick={() => connect.setShowConnectModal(true)}>
          <Plus className="w-4 h-4 mr-2" />
          Подключить аккаунт
        </Button>
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
          <p className="text-red-800 dark:text-red-200">{error}</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {accounts.map((account) => (
          <Card key={account.id} className="p-6">
            <div className="flex items-start justify-between mb-4">
              <Link href={`/dashboard/bd-accounts/${account.id}`} className="flex items-center gap-3 min-w-0 flex-1 hover:opacity-90 transition-opacity">
                <AccountAvatar accountId={account.id} account={account} className="w-12 h-12 shrink-0" />
                <div className="min-w-0">
                  <h3 className="font-semibold text-gray-900 dark:text-white truncate">
                    {getAccountDisplayName(account)}
                  </h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400">
                    {account.username ? `@${account.username}` : account.phone_number || 'Telegram'}
                  </p>
                </div>
                <ChevronRight className="w-5 h-5 text-gray-400 shrink-0" />
              </Link>
              {(() => {
                const floodUntil = account.flood_wait_until ? new Date(account.flood_wait_until).getTime() : 0;
                const inFlood = floodUntil > Date.now();
                const conn = resolveConnectionState(account);
                if (inFlood) {
                  return <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" title="FLOOD_WAIT" />;
                }
                if (conn === 'connected') {
                  return <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0" />;
                }
                if (conn === 'reauth_required') {
                  return <XCircle className="w-5 h-5 text-red-500 shrink-0" />;
                }
                return <XCircle className="w-5 h-5 text-gray-400 shrink-0" />;
              })()}
            </div>

            <div className="space-y-2 mb-4">
              <StatusBadges account={account} compact />
              <div className="flex items-center gap-2 flex-wrap">
                {(account.unread_count ?? 0) > 0 && (
                  <span className="inline-flex items-center rounded-full bg-blue-100 px-2 py-0.5 text-xs font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-300">
                    {t('messaging.unread')}: {account.unread_count ?? 0}
                  </span>
                )}
                {account.last_error_code && (
                  <span className="inline-flex items-center rounded-full bg-red-100 px-2 py-0.5 text-xs font-medium text-red-700 dark:bg-red-900/30 dark:text-red-300">
                    {account.last_error_code}
                  </span>
                )}
              </div>
              {account.connected_at && (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Подключен: {new Date(account.connected_at).toLocaleDateString('ru-RU')}
                </p>
              )}
              {account.last_activity && (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Активность: {new Date(account.last_activity).toLocaleString('ru-RU')}
                  {formatRelativeDateTime(account.last_activity) ? ` (${formatRelativeDateTime(account.last_activity)})` : ''}
                </p>
              )}
            </div>

            <div className="flex gap-2 flex-wrap">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchDialogs(account.id)}
                className="flex-1 min-w-0"
              >
                <MessageSquare className="w-4 h-4 mr-2" />
                Диалоги
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchAccountStatus(account.id)}
                title="Статус"
              >
                <Settings className="w-4 h-4" />
              </Button>
              {canManageAccount(account) && (
                <>
                  {resolveConnectionState(account) === 'reauth_required' ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => connect.setShowConnectModal(true)}
                      title="Переподключить"
                    >
                      <Power className="w-4 h-4" />
                    </Button>
                  ) : account.is_active ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleDisconnect(account.id)}
                      title="Отключить (временно)"
                    >
                      <PowerOff className="w-4 h-4" />
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleEnable(account.id)}
                      title="Включить"
                    >
                      <Power className="w-4 h-4" />
                    </Button>
                  )}
                  {resolveConnectionState(account) === 'reconnecting' && (
                    <Button variant="outline" size="sm" disabled title="Ожидание завершения переподключения">
                      <Loader2 className="w-4 h-4 animate-spin" />
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => handleDelete(account.id)}
                    className="text-red-600 hover:text-red-700"
                    title="Удалить аккаунт"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </>
              )}
            </div>
          </Card>
        ))}
      </div>

      {accounts.length === 0 && (
        <Card className="p-12 text-center">
          <MessageSquare className="w-16 h-16 text-gray-400 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
            Нет подключенных аккаунтов
          </h3>
          <p className="text-gray-500 dark:text-gray-400 mb-4">
            Подключите Telegram аккаунт для начала работы
          </p>
          <Button onClick={() => connect.setShowConnectModal(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Подключить аккаунт
          </Button>
        </Card>
      )}

      {connect.showConnectModal && <ConnectModal {...connect} />}

      {/* Dialogs Modal */}
      {selectedAccount && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-full max-w-2xl p-6 m-4 max-h-[80vh] overflow-y-auto">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">Диалоги</h2>
              <Button variant="outline" size="sm" onClick={() => setSelectedAccount(null)}>
                Закрыть
              </Button>
            </div>

            {loadingDialogs ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
              </div>
            ) : (
              <div className="space-y-2">
                {dialogs.map((dialog) => (
                  <div
                    key={dialog.id}
                    className="p-4 border border-gray-200 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <h3 className="font-semibold text-gray-900 dark:text-white">
                            {dialog.name}
                          </h3>
                          {dialog.isUser && (
                            <span className="text-xs bg-blue-100 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 px-2 py-0.5 rounded">
                              User
                            </span>
                          )}
                          {dialog.isGroup && (
                            <span className="text-xs bg-green-100 dark:bg-green-900/20 text-green-600 dark:text-green-400 px-2 py-0.5 rounded">
                              Group
                            </span>
                          )}
                          {dialog.isChannel && (
                            <span className="text-xs bg-purple-100 dark:bg-purple-900/20 text-purple-600 dark:text-purple-400 px-2 py-0.5 rounded">
                              Channel
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-gray-600 dark:text-gray-400 truncate">
                          {dialog.lastMessage || 'Нет сообщений'}
                        </p>
                        {dialog.lastMessageDate && (
                          <p className="text-xs text-gray-500 dark:text-gray-500 mt-1">
                            {new Date(dialog.lastMessageDate).toLocaleString('ru-RU')}
                          </p>
                        )}
                      </div>
                      {(dialog.unreadCount ?? 0) > 0 && (
                        <span className="bg-blue-600 text-white text-xs px-2 py-1 rounded-full">
                          {dialog.unreadCount ?? 0}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {dialogs.length === 0 && (
                  <p className="text-center py-12 text-gray-500 dark:text-gray-400">
                    Нет диалогов
                  </p>
                )}
              </div>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}

