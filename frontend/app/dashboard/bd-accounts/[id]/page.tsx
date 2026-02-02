'use client';

import { useEffect, useState, useRef } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api/client';
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
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';

interface BDAccountDetail {
  id: string;
  organization_id: string;
  telegram_id: string;
  phone_number: string | null;
  is_active: boolean;
  connected_at: string | null;
  last_activity: string | null;
  created_at: string;
  sync_status?: string;
  sync_progress_done?: number;
  sync_progress_total?: number;
  sync_error?: string | null;
  is_owner?: boolean;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  bio?: string | null;
  photo_file_id?: string | null;
  display_name?: string | null;
}

function getDisplayName(account: BDAccountDetail): string {
  if (account.display_name?.trim()) return account.display_name.trim();
  const first = (account.first_name ?? '').trim();
  const last = (account.last_name ?? '').trim();
  if (first || last) return [first, last].filter(Boolean).join(' ');
  if (account.username?.trim()) return account.username.trim();
  if (account.phone_number?.trim()) return account.phone_number.trim();
  return account.telegram_id || account.id;
}

function getInitials(account: BDAccountDetail): string {
  const name = getDisplayName(account);
  const parts = name.replace(/@/g, '').trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase().slice(0, 2);
  if (name.length >= 2) return name.slice(0, 2).toUpperCase();
  return name.slice(0, 1).toUpperCase() || '?';
}

export default function BDAccountCardPage() {
  const params = useParams();
  const router = useRouter();
  const id = typeof params.id === 'string' ? params.id : '';
  const [account, setAccount] = useState<BDAccountDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [avatarSrc, setAvatarSrc] = useState<string | null>(null);
  const blobUrlRef = useRef<string | null>(null);
  const [editingDisplayName, setEditingDisplayName] = useState(false);
  const [displayNameValue, setDisplayNameValue] = useState('');
  const [savingDisplayName, setSavingDisplayName] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setLoading(true);
    setError(null);
    apiClient
      .get(`/api/bd-accounts/${id}`)
      .then((res) => {
        setAccount(res.data);
        setDisplayNameValue(res.data.display_name ?? '');
      })
      .catch((err: any) => {
        setError(err.response?.data?.error || err.message || 'Не удалось загрузить аккаунт');
      })
      .finally(() => setLoading(false));
  }, [id]);

  useEffect(() => {
    if (!id || !account) return;
    apiClient
      .get(`/api/bd-accounts/${id}/avatar`, { responseType: 'blob' })
      .then((res) => {
        if (res.data instanceof Blob && res.data.size > 0) {
          const u = URL.createObjectURL(res.data);
          blobUrlRef.current = u;
          setAvatarSrc(u);
        }
      })
      .catch(() => {});
    return () => {
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      setAvatarSrc(null);
    };
  }, [id, account?.id]);

  const handleSaveDisplayName = async () => {
    if (!id) return;
    setSavingDisplayName(true);
    setActionError(null);
    try {
      await apiClient.patch(`/api/bd-accounts/${id}`, { display_name: displayNameValue.trim() || null });
      setAccount((prev) => (prev ? { ...prev, display_name: displayNameValue.trim() || null } : null));
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
      await apiClient.post(`/api/bd-accounts/${id}/disconnect`);
      setAccount((prev) => (prev ? { ...prev, is_active: false } : null));
    } catch (err: any) {
      setActionError(err.response?.data?.error || err.response?.data?.message || 'Ошибка отключения');
    }
  };

  const handleEnable = async () => {
    setActionError(null);
    try {
      await apiClient.post(`/api/bd-accounts/${id}/enable`);
      setAccount((prev) => (prev ? { ...prev, is_active: true } : null));
    } catch (err: any) {
      setActionError(err.response?.data?.error || err.response?.data?.message || 'Ошибка включения');
    }
  };

  const handleDelete = async () => {
    if (!confirm('Удалить аккаунт навсегда? История сообщений останется, аккаунт будет отвязан.')) return;
    setActionError(null);
    try {
      await apiClient.delete(`/api/bd-accounts/${id}`);
      router.push('/dashboard/bd-accounts');
    } catch (err: any) {
      setActionError(err.response?.data?.error || err.response?.data?.message || 'Ошибка удаления');
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
                {getInitials(account)}
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
                    {getDisplayName(account)}
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
            <p className="text-sm text-gray-500 dark:text-gray-400 flex items-center gap-1">
              {account.is_active ? (
                <><CheckCircle2 className="w-4 h-4 text-green-500" /> Подключён</>
              ) : (
                <><XCircle className="w-4 h-4 text-gray-400" /> Отключён</>
              )}
            </p>
          </div>
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
                {new Date(account.last_activity).toLocaleString('ru-RU')}
              </dd>
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

        <div className="mt-6 flex flex-wrap gap-2">
          <Link
            href={`/dashboard/bd-accounts?accountId=${account.id}&openSelectChats=1`}
            className="inline-flex items-center justify-center font-medium rounded-lg border border-border hover:bg-accent px-3 py-1.5 text-sm transition-colors"
          >
            <MessageSquare className="w-4 h-4 mr-2" />
            Диалоги
          </Link>
          <Link
            href={`/dashboard/messaging?accountId=${account.id}`}
            className="inline-flex items-center justify-center font-medium rounded-lg border border-border hover:bg-accent px-3 py-1.5 text-sm transition-colors"
          >
            <MessageSquare className="w-4 h-4 mr-2" />
            Мессенджер
          </Link>
          {account.is_owner && (
            <>
              {account.is_active ? (
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
