'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { getAccountDisplayName, getAccountInitials } from '@/lib/bd-account-display';
import { StatusBadges } from '@/components/bd-accounts/StatusBadges';
import { BdAccountScheduleSettings } from '@/components/bd-accounts/BdAccountScheduleSettings';
import type { BDAccount, BDAccountProxyConfig } from '@/lib/types/bd-account';
import {
  disconnectBdAccount,
  enableBdAccount,
  deleteBdAccount,
  patchBdAccount,
  getBdAccount,
  fetchBdAccountAvatarBlob,
} from '@/lib/api/bd-accounts';
import { useAuthStore } from '@/lib/stores/auth-store';
import {
  ArrowLeft,
  CheckCircle2,
  XCircle,
  Loader2,
  MessageSquare,
  Settings,
  Trash2,
  Power,
  PowerOff,
  User,
  Phone,
  AtSign,
  FileText,
  Edit2,
  Save,
  X,
  AlertTriangle,
} from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { ru } from 'date-fns/locale';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';
import {
  connectionLabelKey,
  proxyLabelKey,
  resolveConnectionState,
  resolveProxyState,
  shouldAutoRefreshAccount,
} from '@/lib/bd-account-status-display';

function FloodWaitCountdown({ untilIso }: { untilIso: string }) {
  const [secLeft, setSecLeft] = useState(0);
  useEffect(() => {
    const tick = () =>
      setSecLeft(Math.max(0, Math.ceil((new Date(untilIso).getTime() - Date.now()) / 1000)));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [untilIso]);
  if (secLeft <= 0) return null;
  const mm = Math.floor(secLeft / 60);
  const ss = secLeft % 60;
  return (
    <div className="sm:col-span-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-3 flex items-start gap-2">
      <AlertTriangle className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
      <div>
        <p className="font-medium text-amber-900 dark:text-amber-100 text-sm">FLOOD_WAIT</p>
        <p className="text-sm text-amber-800 dark:text-amber-200">
          {mm}:{ss.toString().padStart(2, '0')}
        </p>
      </div>
    </div>
  );
}

export default function BDAccountCardPage() {
  const params = useParams();
  const router = useRouter();
  const { user: currentUser } = useAuthStore();
  const id = typeof params.id === 'string' ? params.id : '';
  const { t } = useTranslation();
  const [account, setAccount] = useState<BDAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [avatarSrc, setAvatarSrc] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayNameValue, setDisplayNameValue] = useState('');
  const [savingDisplayName, setSavingDisplayName] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const [proxyType, setProxyType] = useState<'none' | 'socks5'>('none');
  const [proxyHost, setProxyHost] = useState('');
  const [proxyPort, setProxyPort] = useState('');
  const [proxyUser, setProxyUser] = useState('');
  const [proxyPass, setProxyPass] = useState('');
  const [savingProxy, setSavingProxy] = useState(false);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    getBdAccount(id)
      .then((data) => {
        setAccount(data);
        setDisplayNameValue(data.display_name ?? '');
        const pc = data.proxy_config;
        if (pc && pc.host) {
          setProxyType('socks5');
          setProxyHost(pc.host);
          setProxyPort(String(pc.port));
          setProxyUser(pc.username || '');
          setProxyPass(pc.password || '');
        }
      })
      .catch((err: unknown) => {
        const e = err as { response?: { data?: { error?: string; message?: string } }; message?: string };
        setError(e.response?.data?.error || e.response?.data?.message || e.message || 'Не удалось загрузить аккаунт');
      })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!id || !account) return;
    fetchBdAccountAvatarBlob(id).then((blob) => {
      if (blob) {
        const u = URL.createObjectURL(blob);
        blobUrlRef.current = u;
        setAvatarSrc(u);
      }
    });
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      setAvatarSrc(null);
    };
  }, [id, account?.id]);

  useEffect(() => {
    if (!id || !account) return;
    let intervalId: ReturnType<typeof setInterval> | undefined;
    if (shouldAutoRefreshAccount(account)) {
      intervalId = setInterval(() => {
        getBdAccount(id).then(setAccount).catch(() => {});
      }, 25000);
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        getBdAccount(id).then(setAccount).catch(() => {});
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      if (intervalId) clearInterval(intervalId);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [id, account]);

  const handleSaveDisplayName = async () => {
    if (!id) return;
    setSavingDisplayName(true);
    setActionError(null);
    try {
      const next = await patchBdAccount(id, { display_name: displayNameValue.trim() || null });
      setAccount(next);
      setEditingDisplayName(false);
    } catch (err: any) {
      setActionError(err.response?.data?.error || err.response?.data?.message || 'Ошибка сохранения');
    } finally {
      setSavingDisplayName(false);
    }
  };

  const handleDisconnect = async () => {
    if (!confirm('Отключить аккаунт? Получение сообщений будет приостановлено до включения.')) return;
    setActionError(null);
    try {
      await disconnectBdAccount(id);
      setAccount((prev) => (prev ? { ...prev, is_active: false, connection_state: 'disconnected' } : null));
    } catch (err: any) {
      setActionError(err.response?.data?.error || err.response?.data?.message || 'Ошибка отключения');
    }
  };

  const handleEnable = async () => {
    setActionError(null);
    try {
      await enableBdAccount(id);
      setAccount((prev) => (prev ? { ...prev, is_active: true, connection_state: 'reconnecting' } : null));
    } catch (err: any) {
      setActionError(err.response?.data?.error || err.response?.data?.message || 'Ошибка включения');
    }
  };

  const handleDelete = async () => {
    if (!confirm('Удалить аккаунт навсегда? История сообщений останется, аккаунт будет отвязан.')) return;
    setActionError(null);
    try {
      await deleteBdAccount(id);
      router.push('/dashboard/bd-accounts');
    } catch (err: any) {
      setActionError(err.response?.data?.error || err.response?.data?.message || 'Ошибка удаления');
    }
  };

  const handleSaveProxy = async () => {
    if (!id) return;
    setSavingProxy(true);
    setActionError(null);
    try {
      const payload = proxyType === 'none'
        ? { proxy_config: null }
        : { proxy_config: { type: 'socks5' as const, host: proxyHost.trim(), port: Number(proxyPort), username: proxyUser.trim() || undefined, password: proxyPass.trim() || undefined } };
      const next = await patchBdAccount(id, payload);
      setAccount(next);
    } catch (err: any) {
      setActionError(err.response?.data?.error || err.response?.data?.message || 'Error saving proxy');
    } finally {
      setSavingProxy(false);
    }
  };

  if (loading || !account) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        {loading ? (
          <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
        ) : (
          <div className="text-center">
            <p className="text-gray-500 dark:text-gray-400 mb-4">{error || 'Аккаунт не найден'}</p>
            <Link href="/dashboard/bd-accounts">
              <Button variant="outline">К списку аккаунтов</Button>
            </Link>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      <Link
        href="/dashboard/bd-accounts"
        className="inline-flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white"
      >
        <ArrowLeft className="w-4 h-4" />
        К списку аккаунтов
      </Link>

      {actionError && (
        <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
          <p className="text-red-800 dark:text-red-200 text-sm">{actionError}</p>
        </div>
      )}

      <Card className="p-6">
        <div className="flex flex-col sm:flex-row gap-6">
          <div className="shrink-0">
            {avatarSrc ? (
              <img
                src={avatarSrc}
                alt=""
                className="w-24 h-24 rounded-full object-cover bg-gray-100 dark:bg-gray-800"
              />
            ) : (
              <div className="w-24 h-24 rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-blue-700 dark:text-blue-300 font-semibold text-2xl">
                {getAccountInitials(account)}
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 mb-1">
              {editingDisplayName ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <Input
                    value={displayNameValue}
                    onChange={(e) => setDisplayNameValue(e.target.value)}
                    placeholder="Отображаемое имя"
                    className="max-w-[200px]"
                  />
                  <Button size="sm" onClick={handleSaveDisplayName} disabled={savingDisplayName}>
                    {savingDisplayName ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => { setEditingDisplayName(false); setDisplayNameValue(account.display_name ?? ''); }}>
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              ) : (
                <>
                  <h1 className="text-xl font-bold text-gray-900 dark:text-white">
                    {getAccountDisplayName(account)}
                  </h1>
                  {account.is_owner && (
                    <button
                      type="button"
                      onClick={() => setEditingDisplayName(true)}
                      className="p-1 rounded text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
                      title="Изменить отображаемое имя"
                    >
                      <Edit2 className="w-4 h-4" />
                    </button>
                  )}
                </>
              )}
            </div>
            <div className="mt-1">
              <StatusBadges account={account} />
            </div>
          </div>
        </div>

        <div className="mt-5 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
          <h3 className="text-sm font-semibold text-gray-900 dark:text-white mb-2">{t('bdAccounts.healthTitle')}</h3>
          <dl className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-gray-500 dark:text-gray-400">{t('bdAccounts.healthConnection')}</dt>
              <dd className="font-medium text-gray-900 dark:text-white">{t(connectionLabelKey(resolveConnectionState(account)))}</dd>
            </div>
            <div>
              <dt className="text-gray-500 dark:text-gray-400">{t('bdAccounts.healthProxy')}</dt>
              <dd className="font-medium text-gray-900 dark:text-white">
                {t(proxyLabelKey(resolveProxyState(account)))}
                {account.last_proxy_check_at ? ` (${new Date(account.last_proxy_check_at).toLocaleString('ru-RU')})` : ''}
              </dd>
            </div>
            {account.last_activity && (
              <div>
                <dt className="text-gray-500 dark:text-gray-400">{t('bdAccounts.healthLastActivity', { defaultValue: 'Последняя активность' })}</dt>
                <dd className="font-medium text-gray-900 dark:text-white">
                  {formatDistanceToNow(new Date(account.last_activity), { addSuffix: true, locale: ru })}
                </dd>
              </div>
            )}
            {account.flood_wait_until && new Date(account.flood_wait_until).getTime() > Date.now() && (
              <div className="sm:col-span-2">
                <dt className="text-gray-500 dark:text-gray-400 mb-1">Telegram</dt>
                <dd>
                  <FloodWaitCountdown untilIso={account.flood_wait_until} />
                </dd>
              </div>
            )}
            {account.last_error_code && (
              <div>
                <dt className="text-gray-500 dark:text-gray-400">{t('bdAccounts.healthLastError')}</dt>
                <dd className="font-medium text-red-700 dark:text-red-300">
                  {account.last_error_code}
                  {account.last_error_at ? ` (${new Date(account.last_error_at).toLocaleString('ru-RU')})` : ''}
                </dd>
              </div>
            )}
            {(account.disconnect_reason || account.last_proxy_error) && (
              <div>
                <dt className="text-gray-500 dark:text-gray-400">{t('bdAccounts.healthReason')}</dt>
                <dd className="font-medium text-gray-900 dark:text-white">{account.disconnect_reason || account.last_proxy_error}</dd>
              </div>
            )}
          </dl>
        </div>

        <dl className="mt-6 grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
          {account.username && (
            <div>
              <dt className="text-gray-500 dark:text-gray-400 flex items-center gap-2">
                <AtSign className="w-4 h-4" /> Username
              </dt>
              <dd className="font-medium text-gray-900 dark:text-white mt-0.5">@{account.username}</dd>
            </div>
          )}
          {account.phone_number && (
            <div>
              <dt className="text-gray-500 dark:text-gray-400 flex items-center gap-2">
                <Phone className="w-4 h-4" /> Номер
              </dt>
              <dd className="font-medium text-gray-900 dark:text-white mt-0.5">{account.phone_number}</dd>
            </div>
          )}
          <div>
            <dt className="text-gray-500 dark:text-gray-400 flex items-center gap-2">
              <User className="w-4 h-4" /> Telegram ID
            </dt>
            <dd className="font-medium text-gray-900 dark:text-white mt-0.5">{account.telegram_id}</dd>
          </div>
          {account.connected_at && (
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Подключён</dt>
              <dd className="font-medium text-gray-900 dark:text-white mt-0.5">
                {new Date(account.connected_at).toLocaleString('ru-RU')}
              </dd>
            </div>
          )}
          {account.last_activity && (
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Активность</dt>
              <dd className="font-medium text-gray-900 dark:text-white mt-0.5">
                {formatDistanceToNow(new Date(account.last_activity), { addSuffix: true, locale: ru })}
              </dd>
            </div>
          )}
          {account.last_error_code && (
            <div>
              <dt className="text-gray-500 dark:text-gray-400">Последняя ошибка</dt>
              <dd className="font-medium text-gray-900 dark:text-white mt-0.5">{account.last_error_code}</dd>
            </div>
          )}
        </dl>

        {account.bio?.trim() && (
          <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
            <dt className="text-gray-500 dark:text-gray-400 flex items-center gap-2 mb-1">
              <FileText className="w-4 h-4" /> О себе
            </dt>
            <dd className="text-gray-900 dark:text-white whitespace-pre-wrap">{account.bio.trim()}</dd>
          </div>
        )}

        {account.is_owner && (
          <div id="proxy-settings-block" className="mt-6 pt-4 border-t border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2 mb-3">
              <Settings className="w-4 h-4" /> Proxy
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Type</label>
                <select
                  value={proxyType}
                  onChange={(e) => setProxyType(e.target.value as 'none' | 'socks5')}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm"
                >
                  <option value="none">No proxy</option>
                  <option value="socks5">SOCKS5</option>
                </select>
                <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                  {t('bdAccounts.proxySocksOnlyHint')}
                </p>
              </div>
              {proxyType !== 'none' && (
                <>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Host</label>
                    <Input value={proxyHost} onChange={(e) => setProxyHost(e.target.value)} placeholder="1.2.3.4" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Port</label>
                    <Input value={proxyPort} onChange={(e) => setProxyPort(e.target.value)} placeholder="1080" type="number" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Username</label>
                    <Input value={proxyUser} onChange={(e) => setProxyUser(e.target.value)} placeholder="Optional" />
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Password</label>
                    <Input value={proxyPass} onChange={(e) => setProxyPass(e.target.value)} placeholder="Optional" type="password" />
                  </div>
                </>
              )}
            </div>
            <div className="mt-3">
              <Button size="sm" onClick={handleSaveProxy} disabled={savingProxy || (proxyType !== 'none' && (!proxyHost.trim() || !proxyPort.trim()))}>
                {savingProxy ? <Loader2 className="w-4 h-4 animate-spin mr-1" /> : <Save className="w-4 h-4 mr-1" />}
                Save proxy
              </Button>
            </div>
          </div>
        )}

        {account.is_owner && (
          <BdAccountScheduleSettings
            account={account}
            accountId={id}
            onPatched={(next) => setAccount(next)}
          />
        )}

        <div className="mt-6 flex flex-wrap gap-2">
          {((currentUser?.role?.toLowerCase() !== 'bidi') || account.is_owner) && (
            <Link
              href={`/dashboard/bd-accounts?accountId=${account.id}&openSelectChats=1`}
              className="inline-flex items-center justify-center font-medium rounded-lg border border-border hover:bg-accent px-3 py-1.5 text-sm transition-colors"
            >
              <MessageSquare className="w-4 h-4 mr-2" />
              Диалоги
            </Link>
          )}
          <Link
            href={`/dashboard/messaging?accountId=${account.id}`}
            className="inline-flex items-center justify-center font-medium rounded-lg border border-border hover:bg-accent px-3 py-1.5 text-sm transition-colors"
          >
            <MessageSquare className="w-4 h-4 mr-2" />
            Мессенджер
          </Link>
          {account.is_owner && (
            <>
              {resolveConnectionState(account) === 'reauth_required' ? (
                <Button variant="outline" size="sm" onClick={() => router.push('/dashboard/bd-accounts')}>
                  <Power className="w-4 h-4 mr-2" />
                  Переподключить через QR/телефон
                </Button>
              ) : resolveConnectionState(account) === 'reconnecting' ? (
                <Button variant="outline" size="sm" disabled>
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                  {t('bdAccounts.connectionReconnecting')}
                </Button>
              ) : account.is_active ? (
                <Button variant="outline" size="sm" onClick={handleDisconnect} title="Отключить (временно)">
                  <PowerOff className="w-4 h-4 mr-2" />
                  Отключить
                </Button>
              ) : (
                <Button variant="outline" size="sm" onClick={handleEnable} title="Включить">
                  <Power className="w-4 h-4 mr-2" />
                  Включить
                </Button>
              )}
              {resolveProxyState(account) === 'error' && resolveConnectionState(account) !== 'connected' && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => document.getElementById('proxy-settings-block')?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                >
                  <Settings className="w-4 h-4 mr-2" />
                  {t('bdAccounts.proxyFixCta')}
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={handleDelete}
                className="text-red-600 hover:text-red-700"
                title="Удалить аккаунт"
              >
                <Trash2 className="w-4 h-4 mr-2" />
                Удалить
              </Button>
            </>
          )}
        </div>
      </Card>
    </div>
  );
}
