'use client';

import { useEffect, useState, useCallback } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { apiClient } from '@/lib/api/client';
import { useWebSocketContext } from '@/lib/contexts/websocket-context';
import { Plus, CheckCircle2, XCircle, Loader2, MessageSquare, Settings, Trash2 } from 'lucide-react';
import Button from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input } from '@/components/ui/Input';

interface BDAccount {
  id: string;
  phone_number: string;
  telegram_id: string;
  is_active: boolean;
  connected_at?: string;
  last_activity?: string;
  created_at: string;
  sync_status?: string;
  sync_progress_done?: number;
  sync_progress_total?: number;
  sync_error?: string;
  is_owner?: boolean; // только свои аккаунты показываем на этой странице
}

interface Dialog {
  id: string;
  name: string;
  unreadCount: number;
  lastMessage: string;
  lastMessageDate?: string;
  isUser: boolean;
  isGroup: boolean;
  isChannel: boolean;
}

export default function BDAccountsPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { subscribe, unsubscribe, on, off, isConnected } = useWebSocketContext();
  const [accounts, setAccounts] = useState<BDAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [dialogs, setDialogs] = useState<Dialog[]>([]);
  const [loadingDialogs, setLoadingDialogs] = useState(false);
  const [connectStep, setConnectStep] = useState<'credentials' | 'qr' | 'code' | 'password' | 'select-chats'>('credentials');
  const [loginMethod, setLoginMethod] = useState<'phone' | 'qr'>('phone');
  const [qrSessionId, setQrSessionId] = useState<string | null>(null);
  const [qrState, setQrState] = useState<{ status: string; loginTokenUrl?: string; accountId?: string; error?: string; passwordHint?: string } | null>(null);
  const [qr2faPassword, setQr2faPassword] = useState('');
  const [submittingQrPassword, setSubmittingQrPassword] = useState(false);
  const [qrPendingReason, setQrPendingReason] = useState<'password' | null>(null);
  const [qrJustConnected, setQrJustConnected] = useState(false);
  const [startingQr, setStartingQr] = useState(false);
  const [selectedChatIds, setSelectedChatIds] = useState<Set<string>>(new Set());
  const [syncProgress, setSyncProgress] = useState<{ done: number; total: number; currentTitle?: string } | null>(null);
  const [startingSync, setStartingSync] = useState(false);
  const [connectForm, setConnectForm] = useState({
    phoneNumber: '',
    apiId: '',
    apiHash: '',
    phoneCode: '',
    password: '',
  });
  const [connectingAccountId, setConnectingAccountId] = useState<string | null>(null);
  const [phoneCodeHash, setPhoneCodeHash] = useState<string | null>(null);
  const [sendingCode, setSendingCode] = useState(false);
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAccounts();
  }, []);

  // Открыть модалку «Выбор чатов» по ссылке с Мессенджера (?accountId=...&openSelectChats=1)
  useEffect(() => {
    const accountId = searchParams.get('accountId');
    const openSelectChats = searchParams.get('openSelectChats');
    if (!accountId || openSelectChats !== '1') return;
    setShowConnectModal(true);
    setConnectStep('select-chats');
    setConnectingAccountId(accountId);
    setSyncProgress(null);
    setError(null);
    setLoadingDialogs(true);
    router.replace('/dashboard/bd-accounts'); // убрать query из URL
    Promise.all([
      apiClient.get(`/api/bd-accounts/${accountId}/dialogs`).then((res) => Array.isArray(res.data) ? res.data : []),
      apiClient.get(`/api/bd-accounts/${accountId}/sync-chats`).then((res) => (Array.isArray(res.data) ? res.data : []) as { telegram_chat_id: string }[]),
    ])
      .then(([dialogsList, syncChatsList]) => {
        setDialogs(dialogsList);
        const alreadySelected = new Set(syncChatsList.map((c) => String(c.telegram_chat_id)));
        setSelectedChatIds(alreadySelected);
      })
      .catch((e) => {
        console.error('Failed to load dialogs or sync-chats:', e);
        setDialogs([]);
        setSelectedChatIds(new Set());
        setError(e?.response?.data?.error || 'Ошибка загрузки');
      })
      .finally(() => setLoadingDialogs(false));
  }, [searchParams, router]);

  // Subscribe to bd-account room for sync progress when in select-chats step
  useEffect(() => {
    if (connectStep !== 'select-chats' || !connectingAccountId || !isConnected) return;
    const room = `bd-account:${connectingAccountId}`;
    subscribe(room);
    const handler = (payload: { type: string; data?: any }) => {
      if (payload.type === 'bd_account.sync.started' && payload.data?.bdAccountId === connectingAccountId) {
        setSyncProgress({ done: 0, total: payload.data?.totalChats ?? 0 });
      }
      if (payload.type === 'bd_account.sync.progress' && payload.data?.bdAccountId === connectingAccountId) {
        setSyncProgress({
          done: payload.data?.done ?? 0,
          total: payload.data?.total ?? 0,
          currentTitle: payload.data?.currentChatTitle,
        });
      }
      if (payload.type === 'bd_account.sync.completed' && payload.data?.bdAccountId === connectingAccountId) {
        setSyncProgress(null);
        setStartingSync(false);
        fetchAccounts();
        handleCloseModal();
      }
      if (payload.type === 'bd_account.sync.failed' && payload.data?.bdAccountId === connectingAccountId) {
        setSyncProgress(null);
        setStartingSync(false);
        setError(payload.data?.error ?? 'Синхронизация не удалась');
      }
    };
    on('event', handler);
    return () => {
      off('event', handler);
      unsubscribe(room);
    };
  }, [connectStep, connectingAccountId, isConnected, subscribe, unsubscribe, on, off]);

  // Опрос прогресса синхронизации (fallback, если WebSocket не доставляет события)
  useEffect(() => {
    if (syncProgress === null || !connectingAccountId) return;
    const t = setInterval(async () => {
      try {
        const res = await apiClient.get(`/api/bd-accounts/${connectingAccountId}/sync-status`);
        const d = res.data;
        const status = d.sync_status ?? 'idle';
        const done = Number(d.sync_progress_done ?? 0);
        const total = Number(d.sync_progress_total ?? 0);
        setSyncProgress((prev) => (prev ? { ...prev, done, total } : { done, total }));
        if (status === 'completed') {
          setSyncProgress(null);
          setStartingSync(false);
          fetchAccounts();
          handleCloseModal();
        } else if (status === 'idle' && d.sync_error) {
          setSyncProgress(null);
          setStartingSync(false);
          setError(d.sync_error);
        }
      } catch (_) {}
    }, 2000);
    return () => clearInterval(t);
  }, [connectingAccountId, syncProgress]);

  const fetchAccounts = async () => {
    try {
      const response = await apiClient.get('/api/bd-accounts');
      // На странице BD Аккаунтов показываем только свои (управление своими Telegram-аккаунтами)
      const myAccounts = Array.isArray(response.data) ? response.data.filter((a: BDAccount) => a.is_owner === true) : [];
      setAccounts(myAccounts);
    } catch (error: any) {
      console.error('Error fetching accounts:', error);
      setError(error.response?.data?.error || 'Ошибка загрузки аккаунтов');
    } finally {
      setLoading(false);
    }
  };

  const fetchAccountStatus = async (accountId: string) => {
    try {
      const response = await apiClient.get(`/api/bd-accounts/${accountId}/status`);
      // Update account in list
      setAccounts((prev) =>
        prev.map((acc) => (acc.id === accountId ? { ...acc, ...response.data } : acc))
      );
      return response.data;
    } catch (error) {
      console.error('Error fetching account status:', error);
    }
  };

  const fetchDialogs = async (accountId: string) => {
    setLoadingDialogs(true);
    try {
      const response = await apiClient.get(`/api/bd-accounts/${accountId}/dialogs`);
      setDialogs(response.data);
      setSelectedAccount(accountId);
    } catch (error: any) {
      console.error('Error fetching dialogs:', error);
      setError(error.response?.data?.error || 'Ошибка загрузки диалогов');
    } finally {
      setLoadingDialogs(false);
    }
  };

  const handleSendCode = async () => {
    if (!connectForm.phoneNumber || !connectForm.apiId || !connectForm.apiHash) {
      setError('Заполните все обязательные поля');
      return;
    }

    setSendingCode(true);
    setError(null);

    try {
      const response = await apiClient.post('/api/bd-accounts/send-code', {
        platform: 'telegram',
        phoneNumber: connectForm.phoneNumber,
        apiId: parseInt(connectForm.apiId),
        apiHash: connectForm.apiHash,
      });

      setConnectingAccountId(response.data.accountId);
      setPhoneCodeHash(response.data.phoneCodeHash);
      setConnectStep('code');
    } catch (error: any) {
      console.error('Error sending code:', error);
      setError(error.response?.data?.error || error.response?.data?.message || 'Ошибка отправки кода');
    } finally {
      setSendingCode(false);
    }
  };

  const handleVerifyCode = async () => {
    if (!connectForm.phoneCode) {
      setError('Введите код из SMS');
      return;
    }

    if (!connectingAccountId || !phoneCodeHash) {
      setError('Ошибка: отсутствуют данные для верификации');
      return;
    }

    setVerifyingCode(true);
    setError(null);

    try {
      const response = await apiClient.post('/api/bd-accounts/verify-code', {
        accountId: connectingAccountId,
        phoneNumber: connectForm.phoneNumber,
        phoneCode: connectForm.phoneCode,
        phoneCodeHash: phoneCodeHash,
        password: connectForm.password || undefined,
      });

      setAccounts((prev) => [response.data, ...prev]);
      setConnectStep('select-chats');
      setSelectedChatIds(new Set());
      setSyncProgress(null);
      if (connectingAccountId) {
        setLoadingDialogs(true);
        try {
          const dialogsRes = await apiClient.get(`/api/bd-accounts/${connectingAccountId}/dialogs`);
          setDialogs(Array.isArray(dialogsRes.data) ? dialogsRes.data : []);
        } catch (e) {
          console.error('Failed to load dialogs:', e);
          setDialogs([]);
        } finally {
          setLoadingDialogs(false);
        }
      }
    } catch (error: any) {
      console.error('Error verifying code:', error);
      const errorMessage = error.response?.data?.message || error.response?.data?.error || 'Ошибка верификации';
      
      // Check if password is required
      if (error.response?.data?.requiresPassword) {
        setConnectStep('password');
        setError(null); // Clear error, password step will show
      } else {
        setError(errorMessage);
      }
    } finally {
      setVerifyingCode(false);
    }
  };

  const handleCloseModal = () => {
    setShowConnectModal(false);
    setConnectStep('credentials');
    setLoginMethod('phone');
    setConnectForm({
      phoneNumber: '',
      apiId: '',
      apiHash: '',
      phoneCode: '',
      password: '',
    });
    setConnectingAccountId(null);
    setPhoneCodeHash(null);
    setQrSessionId(null);
    setQrState(null);
    setQr2faPassword('');
    setQrPendingReason(null);
    setQrJustConnected(false);
    setError(null);
    setSelectedChatIds(new Set());
    setSyncProgress(null);
    setStartingSync(false);
  };

  const handleSubmitQr2faPassword = async () => {
    if (!qrSessionId || !qr2faPassword.trim()) return;
    setSubmittingQrPassword(true);
    setError(null);
    setQrPendingReason('password');
    try {
      await apiClient.post('/api/bd-accounts/qr-login-password', { sessionId: qrSessionId, password: qr2faPassword.trim() });
      setQr2faPassword('');
      setQrState((prev) => (prev ? { ...prev, status: 'pending' } : null));
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Не удалось отправить пароль');
    } finally {
      setSubmittingQrPassword(false);
    }
  };

  const handleStartQrLogin = async () => {
    if (!connectForm.apiId || !connectForm.apiHash) {
      setError('Введите API ID и API Hash (получите на my.telegram.org/apps)');
      return;
    }
    setStartingQr(true);
    setError(null);
    try {
      const res = await apiClient.post('/api/bd-accounts/start-qr-login', {
        apiId: parseInt(connectForm.apiId),
        apiHash: connectForm.apiHash,
      });
      setQrSessionId(res.data.sessionId);
      setConnectStep('qr');
      setQrState({ status: 'pending' });
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.response?.data?.error || 'Ошибка запуска QR-входа');
    } finally {
      setStartingQr(false);
    }
  };

  useEffect(() => {
    if (connectStep !== 'qr' || !qrSessionId) return;
    const t = setInterval(async () => {
      try {
        const res = await apiClient.get('/api/bd-accounts/qr-login-status', { params: { sessionId: qrSessionId } });
        const data = res.data;
        setQrState({ status: data.status, loginTokenUrl: data.loginTokenUrl, accountId: data.accountId, error: data.error, passwordHint: data.passwordHint });
        if (data.status === 'success' && data.accountId) {
          setQrPendingReason(null);
          setConnectingAccountId(data.accountId);
          setQrJustConnected(true);
          setQrState({ ...data, status: 'success' });
          setQrSessionId(null);
          fetchAccounts();
          setTimeout(() => {
            setQrJustConnected(false);
            setQrState(null);
            setConnectStep('select-chats');
            setLoadingDialogs(true);
            apiClient.get(`/api/bd-accounts/${data.accountId}/dialogs`).then((dialogsRes) => {
              setDialogs(Array.isArray(dialogsRes.data) ? dialogsRes.data : []);
            }).catch(() => setDialogs([])).finally(() => setLoadingDialogs(false));
          }, 1800);
        }
        if (data.status === 'error') setQrPendingReason(null);
      } catch (_) {
        setQrState((prev) => (prev ? { ...prev, status: 'error', error: 'Сессия истекла' } : null));
      }
    }, 1500);
    return () => clearInterval(t);
  }, [connectStep, qrSessionId]);

  const toggleChatSelection = (id: string) => {
    setSelectedChatIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleSaveAndSync = async () => {
    if (!connectingAccountId || selectedChatIds.size === 0) {
      setError('Выберите хотя бы один чат');
      return;
    }
    setStartingSync(true);
    setError(null);
    try {
      const chatsToSave = dialogs.filter((d) => selectedChatIds.has(String(d.id))).map((d) => ({
        id: d.id,
        name: d.name,
        isUser: d.isUser,
        isGroup: d.isGroup,
        isChannel: d.isChannel,
      }));
      await apiClient.post(`/api/bd-accounts/${connectingAccountId}/sync-chats`, { chats: chatsToSave });
      await apiClient.post(`/api/bd-accounts/${connectingAccountId}/sync-start`);
      setSyncProgress({ done: 0, total: chatsToSave.length });
    } catch (err: any) {
      setError(err.response?.data?.message ?? err.response?.data?.error ?? 'Ошибка запуска синхронизации');
      setStartingSync(false);
    }
  };

  const handleDisconnect = async (accountId: string) => {
    if (!confirm('Вы уверены, что хотите отключить этот аккаунт?')) return;

    try {
      await apiClient.post(`/api/bd-accounts/${accountId}/disconnect`);
      await fetchAccounts();
    } catch (error: any) {
      console.error('Error disconnecting account:', error);
      setError(error.response?.data?.error || 'Ошибка отключения');
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
        <Button onClick={() => setShowConnectModal(true)}>
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
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 bg-blue-100 dark:bg-blue-900/20 rounded-full flex items-center justify-center">
                  <MessageSquare className="w-6 h-6 text-blue-600 dark:text-blue-400" />
                </div>
                <div>
                  <h3 className="font-semibold text-gray-900 dark:text-white">
                    {account.phone_number || account.telegram_id}
                  </h3>
                  <p className="text-sm text-gray-500 dark:text-gray-400">Telegram</p>
                </div>
              </div>
              {account.is_active ? (
                <CheckCircle2 className="w-5 h-5 text-green-500" />
              ) : (
                <XCircle className="w-5 h-5 text-gray-400" />
              )}
            </div>

            <div className="space-y-2 mb-4">
              {account.connected_at && (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Подключен: {new Date(account.connected_at).toLocaleDateString('ru-RU')}
                </p>
              )}
              {account.last_activity && (
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  Активность: {new Date(account.last_activity).toLocaleString('ru-RU')}
                </p>
              )}
            </div>

            <div className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchDialogs(account.id)}
                className="flex-1"
              >
                <MessageSquare className="w-4 h-4 mr-2" />
                Диалоги
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => fetchAccountStatus(account.id)}
              >
                <Settings className="w-4 h-4" />
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDisconnect(account.id)}
                className="text-red-600 hover:text-red-700"
              >
                <Trash2 className="w-4 h-4" />
              </Button>
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
          <Button onClick={() => setShowConnectModal(true)}>
            <Plus className="w-4 h-4 mr-2" />
            Подключить аккаунт
          </Button>
        </Card>
      )}

      {/* Connect Modal */}
      {showConnectModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <Card className="w-full max-w-md p-6 m-4">
            <div className="flex items-center justify-between mb-4">
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">
                {connectStep === 'credentials' && 'Подключить Telegram аккаунт'}
                {connectStep === 'qr' && 'Вход по QR-коду'}
                {connectStep === 'code' && 'Введите код из SMS'}
                {connectStep === 'password' && 'Введите пароль 2FA'}
                {connectStep === 'select-chats' && 'Выберите чаты для синхронизации'}
              </h2>
              <Button variant="outline" size="sm" onClick={handleCloseModal}>
                ✕
              </Button>
            </div>

            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 mb-4">
                <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
              </div>
            )}

            <div className="space-y-4">
              {/* Step 1: Credentials — выбор способа: по номеру или по QR */}
              {connectStep === 'credentials' && (
                <>
                  <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 p-1 bg-gray-50 dark:bg-gray-800">
                    <button
                      type="button"
                      onClick={() => setLoginMethod('phone')}
                      className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
                        loginMethod === 'phone'
                          ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow'
                          : 'text-gray-600 dark:text-gray-400 hover:text-gray-900'
                      }`}
                    >
                      По номеру телефона
                    </button>
                    <button
                      type="button"
                      onClick={() => setLoginMethod('qr')}
                      className={`flex-1 py-2 px-3 rounded-md text-sm font-medium transition-colors ${
                        loginMethod === 'qr'
                          ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow'
                          : 'text-gray-600 dark:text-gray-400 hover:text-gray-900'
                      }`}
                    >
                      По QR-коду
                    </button>
                  </div>

                  {loginMethod === 'phone' && (
                    <div>
                      <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                        Номер телефона
                      </label>
                      <Input
                        type="tel"
                        value={connectForm.phoneNumber}
                        onChange={(e) =>
                          setConnectForm({ ...connectForm, phoneNumber: e.target.value })
                        }
                        placeholder="+1234567890"
                      />
                    </div>
                  )}

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      API ID
                    </label>
                    <Input
                      type="text"
                      value={connectForm.apiId}
                      onChange={(e) => setConnectForm({ ...connectForm, apiId: e.target.value })}
                      placeholder="12345"
                    />
                    <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                      Получите на{' '}
                      <a
                        href="https://my.telegram.org/apps"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 hover:underline"
                      >
                        my.telegram.org/apps
                      </a>
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      API Hash
                    </label>
                    <Input
                      type="text"
                      value={connectForm.apiHash}
                      onChange={(e) => setConnectForm({ ...connectForm, apiHash: e.target.value })}
                      placeholder="abcdef1234567890"
                    />
                  </div>
                </>
              )}

              {/* Step QR: показать QR и ждать сканирования */}
              {connectStep === 'qr' && qrState && (
                <>
                  {qrState.status === 'pending' && !qrJustConnected && (
                    <div className="flex flex-col items-center justify-center py-8">
                      <Loader2 className="w-12 h-12 animate-spin text-blue-600 mb-4" />
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {qrPendingReason === 'password' ? 'Проверка пароля и подключение аккаунта…' : 'Генерация QR-кода…'}
                      </p>
                    </div>
                  )}
                  {qrJustConnected && (
                    <div className="flex flex-col items-center justify-center py-10">
                      <div className="w-16 h-16 rounded-full bg-green-100 dark:bg-green-900/30 flex items-center justify-center mb-4">
                        <CheckCircle2 className="w-10 h-10 text-green-600 dark:text-green-400" />
                      </div>
                      <p className="text-lg font-semibold text-green-800 dark:text-green-200">Аккаунт подключён</p>
                      <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">Переход к выбору чатов…</p>
                    </div>
                  )}
                  {qrState.status === 'qr' && qrState.loginTokenUrl && (
                    <div className="flex flex-col items-center py-4">
                      <div className="bg-white p-4 rounded-xl shadow-inner">
                        <img
                          src={`https://api.qrserver.com/v1/create-qr-code/?size=256x256&data=${encodeURIComponent(qrState.loginTokenUrl)}`}
                          alt="QR для входа в Telegram"
                          className="w-64 h-64"
                        />
                      </div>
                      <p className="text-sm text-gray-600 dark:text-gray-400 mt-4 text-center max-w-xs">
                        Откройте Telegram на телефоне → Настройки → Устройства → Подключить устройство и отсканируйте QR-код
                      </p>
                      <p className="text-xs text-gray-500 mt-2">Код обновляется автоматически каждые ~30 сек.</p>
                    </div>
                  )}
                  {qrState.status === 'need_password' && (
                    <div className="py-4 space-y-3">
                      <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-3">
                        <p className="text-sm text-amber-800 dark:text-amber-200 font-medium">Требуется пароль 2FA</p>
                        <p className="text-xs text-amber-700 dark:text-amber-300 mt-0.5">
                          У этого аккаунта включена двухфакторная аутентификация. Введите пароль облачного пароля Telegram.
                        </p>
                        {qrState.passwordHint && (
                          <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">Подсказка: {qrState.passwordHint}</p>
                        )}
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                          Пароль 2FA
                        </label>
                        <Input
                          type="password"
                          value={qr2faPassword}
                          onChange={(e) => setQr2faPassword(e.target.value)}
                          placeholder="••••••••"
                          autoFocus
                          onKeyDown={(e) => e.key === 'Enter' && handleSubmitQr2faPassword()}
                        />
                      </div>
                    </div>
                  )}
                  {qrState.status === 'expired' && (
                    <div className="flex flex-col items-center justify-center py-8">
                      <Loader2 className="w-12 h-12 animate-spin text-blue-600 mb-4" />
                      <p className="text-sm text-gray-600 dark:text-gray-400">Обновление QR-кода…</p>
                      <p className="text-xs text-gray-500 mt-1">Новый код появится через пару секунд.</p>
                    </div>
                  )}
                  {qrState.status === 'error' && qrState.error && (
                    <div className="py-4 space-y-3">
                      <p className="text-sm text-red-600 dark:text-red-400">{qrState.error}</p>
                      <p className="text-xs text-gray-500">Нажмите «Попробовать снова», чтобы показать новый QR-код.</p>
                    </div>
                  )}
                </>
              )}

              {/* Step 2: Code */}
              {connectStep === 'code' && (
                <>
                  <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-4 mb-4">
                    <p className="text-sm text-blue-800 dark:text-blue-200">
                      Код подтверждения отправлен на номер <strong>{connectForm.phoneNumber}</strong>
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Код из SMS
                    </label>
                    <Input
                      type="text"
                      value={connectForm.phoneCode}
                      onChange={(e) => setConnectForm({ ...connectForm, phoneCode: e.target.value })}
                      placeholder="12345"
                      autoFocus
                    />
                  </div>
                </>
              )}

              {/* Step 3: Password */}
              {connectStep === 'password' && (
                <>
                  <div className="bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4 mb-4">
                    <p className="text-sm text-yellow-800 dark:text-yellow-200">
                      Для этого аккаунта требуется двухфакторная аутентификация
                    </p>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                      Пароль 2FA
                    </label>
                    <Input
                      type="password"
                      value={connectForm.password}
                      onChange={(e) => setConnectForm({ ...connectForm, password: e.target.value })}
                      placeholder="••••••••"
                      autoFocus
                    />
                  </div>
                </>
              )}

              {/* Step 4: Select chats for sync */}
              {connectStep === 'select-chats' && (
                <>
                  {connectingAccountId && (
                    <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-3 mb-4">
                      <p className="text-sm text-green-800 dark:text-green-200 font-medium">Аккаунт подключён</p>
                      <p className="text-xs text-green-700 dark:text-green-300 mt-0.5">
                        Выберите чаты для синхронизации или пропустите и настройте позже в разделе «Мессенджер».
                      </p>
                    </div>
                  )}
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-3">
                    Выберите папки или чаты для синхронизации. Только выбранные чаты будут отображаться в Мессенджере.
                  </p>
                  {syncProgress !== null ? (
                    <div className="space-y-2">
                      <div className="flex justify-between text-sm">
                        <span>Синхронизация… {syncProgress.currentTitle && `(${syncProgress.currentTitle})`}</span>
                        <span>{syncProgress.done} / {syncProgress.total}</span>
                      </div>
                      <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-blue-600 transition-all duration-300"
                          style={{ width: syncProgress.total ? `${(100 * syncProgress.done) / syncProgress.total}%` : '0%' }}
                        />
                      </div>
                    </div>
                  ) : loadingDialogs ? (
                    <div className="flex items-center justify-center py-8">
                      <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
                    </div>
                  ) : (
                    <div className="max-h-64 overflow-y-auto space-y-2 border border-gray-200 dark:border-gray-700 rounded-lg p-2">
                      {dialogs.map((dialog) => (
                        <label
                          key={dialog.id}
                          className="flex items-center gap-3 p-2 hover:bg-gray-50 dark:hover:bg-gray-800 rounded cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={selectedChatIds.has(String(dialog.id))}
                            onChange={() => toggleChatSelection(String(dialog.id))}
                            className="rounded border-gray-300"
                          />
                          <span className="font-medium text-sm truncate">{dialog.name}</span>
                          {dialog.isUser && <span className="text-xs text-blue-600">User</span>}
                          {dialog.isGroup && <span className="text-xs text-green-600">Group</span>}
                          {dialog.isChannel && <span className="text-xs text-purple-600">Channel</span>}
                        </label>
                      ))}
                      {dialogs.length === 0 && (
                        <p className="text-sm text-gray-500 py-4 text-center">Нет диалогов</p>
                      )}
                    </div>
                  )}
                </>
              )}
            </div>

            <div className="flex gap-2 mt-6">
              {connectStep === 'credentials' && (
                <>
                  <Button
                    variant="outline"
                    onClick={handleCloseModal}
                    className="flex-1"
                  >
                    Отмена
                  </Button>
                  {loginMethod === 'phone' ? (
                    <Button onClick={handleSendCode} disabled={sendingCode} className="flex-1">
                      {sendingCode ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Отправка...
                        </>
                      ) : (
                        'Отправить код'
                      )}
                    </Button>
                  ) : (
                    <Button onClick={handleStartQrLogin} disabled={startingQr} className="flex-1">
                      {startingQr ? (
                        <>
                          <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                          Загрузка...
                        </>
                      ) : (
                        'Показать QR-код'
                      )}
                    </Button>
                  )}
                </>
              )}

              {connectStep === 'qr' && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => { setConnectStep('credentials'); setQrSessionId(null); setQrState(null); setQr2faPassword(''); }}
                    className="flex-1"
                  >
                    Назад
                  </Button>
                  {qrState?.status === 'need_password' ? (
                    <Button
                      onClick={handleSubmitQr2faPassword}
                      disabled={submittingQrPassword || !qr2faPassword.trim()}
                      className="flex-1"
                    >
                      {submittingQrPassword ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Подтвердить'}
                    </Button>
                  ) : qrState?.status === 'error' ? (
                    <Button
                      onClick={() => { setQrSessionId(null); setQrState({ status: 'pending' }); setError(null); handleStartQrLogin(); }}
                      disabled={startingQr}
                      className="flex-1"
                    >
                      {startingQr ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Попробовать снова'}
                    </Button>
                  ) : (
                    <Button variant="outline" onClick={handleCloseModal} className="flex-1">
                      Отмена
                    </Button>
                  )}
                </>
              )}

              {connectStep === 'code' && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => setConnectStep('credentials')}
                    className="flex-1"
                  >
                    Назад
                  </Button>
                  <Button onClick={handleVerifyCode} disabled={verifyingCode} className="flex-1">
                    {verifyingCode ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Проверка...
                      </>
                    ) : (
                      'Подтвердить'
                    )}
                  </Button>
                </>
              )}

              {connectStep === 'password' && (
                <>
                  <Button
                    variant="outline"
                    onClick={() => setConnectStep('code')}
                    className="flex-1"
                  >
                    Назад
                  </Button>
                  <Button onClick={handleVerifyCode} disabled={verifyingCode} className="flex-1">
                    {verifyingCode ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Подключение...
                      </>
                    ) : (
                      'Подключить'
                    )}
                  </Button>
                </>
              )}

              {connectStep === 'select-chats' && !syncProgress && (
                <>
                  <Button variant="outline" onClick={handleCloseModal} className="flex-1">
                    Пропустить
                  </Button>
                  <Button
                    onClick={handleSaveAndSync}
                    disabled={startingSync || selectedChatIds.size === 0 || loadingDialogs}
                    className="flex-1"
                  >
                    {startingSync ? (
                      <>
                        <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                        Запуск…
                      </>
                    ) : (
                      'Сохранить и синхронизировать'
                    )}
                  </Button>
                </>
              )}
            </div>
          </Card>
        </div>
      )}

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
                      {dialog.unreadCount > 0 && (
                        <span className="bg-blue-600 text-white text-xs px-2 py-1 rounded-full">
                          {dialog.unreadCount}
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

