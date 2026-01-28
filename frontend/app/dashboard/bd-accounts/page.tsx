'use client';

import { useEffect, useState } from 'react';
import { apiClient } from '@/lib/api/client';
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
  const [accounts, setAccounts] = useState<BDAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [dialogs, setDialogs] = useState<Dialog[]>([]);
  const [loadingDialogs, setLoadingDialogs] = useState(false);
  const [connectStep, setConnectStep] = useState<'credentials' | 'code' | 'password'>('credentials');
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

  const fetchAccounts = async () => {
    try {
      const response = await apiClient.get('/api/bd-accounts');
      setAccounts(response.data);
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
      handleCloseModal();
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
    setConnectForm({
      phoneNumber: '',
      apiId: '',
      apiHash: '',
      phoneCode: '',
      password: '',
    });
    setConnectingAccountId(null);
    setPhoneCodeHash(null);
    setError(null);
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
                {connectStep === 'code' && 'Введите код из SMS'}
                {connectStep === 'password' && 'Введите пароль 2FA'}
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
              {/* Step 1: Credentials */}
              {connectStep === 'credentials' && (
                <>
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

