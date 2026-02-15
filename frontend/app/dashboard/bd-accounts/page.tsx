'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import Link from 'next/link';
import { useSearchParams, useRouter } from 'next/navigation';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@/lib/api/client';
import { useWebSocketContext } from '@/lib/contexts/websocket-context';
import { Plus, CheckCircle2, XCircle, Loader2, MessageSquare, Settings, Trash2, Power, PowerOff, Search, FolderOpen, ChevronRight, ChevronDown, User, RefreshCw, ShieldCheck } from 'lucide-react';
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
  is_owner?: boolean;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  bio?: string | null;
  photo_file_id?: string | null;
  display_name?: string | null;
}

function getAccountDisplayName(account: BDAccount): string {
  if (account.display_name?.trim()) return account.display_name.trim();
  const first = (account.first_name ?? '').trim();
  const last = (account.last_name ?? '').trim();
  if (first || last) return [first, last].filter(Boolean).join(' ');
  if (account.username?.trim()) return account.username.trim();
  if (account.phone_number?.trim()) return account.phone_number.trim();
  return account.telegram_id || account.id;
}

function getAccountInitials(account: BDAccount): string {
  const name = getAccountDisplayName(account);
  const parts = name.replace(/@/g, '').trim().split(/\s+/);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase().slice(0, 2);
  if (name.length >= 2) return name.slice(0, 2).toUpperCase();
  return name.slice(0, 1).toUpperCase() || '?';
}

function AccountAvatar({ accountId, account, className = 'w-12 h-12' }: { accountId: string; account: BDAccount; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const mounted = useRef(true);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    mounted.current = true;
    apiClient
      .get(`/api/bd-accounts/${accountId}/avatar`, { responseType: 'blob' })
      .then((res) => {
        if (mounted.current && res.data instanceof Blob && res.data.size > 0) {
          const u = URL.createObjectURL(res.data);
          blobUrlRef.current = u;
          setSrc(u);
        }
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
      setSrc(null);
    };
  }, [accountId]);

  const initials = getAccountInitials(account);

  if (src) {
    return <img src={src} alt="" className={`rounded-full object-cover bg-gray-100 dark:bg-gray-800 ${className}`} />;
  }
  return (
    <div className={`rounded-full bg-blue-100 dark:bg-blue-900/30 flex items-center justify-center text-blue-700 dark:text-blue-300 font-semibold text-sm ${className}`}>
      {initials}
    </div>
  );
}

interface Dialog {
  id: string;
  name: string;
  unreadCount?: number;
  lastMessage?: string;
  lastMessageDate?: string;
  isUser: boolean;
  isGroup: boolean;
  isChannel: boolean;
}

interface FolderWithDialogs {
  id: number;
  title: string;
  emoticon?: string;
  dialogs: Dialog[];
}

interface SyncChatRow {
  telegram_chat_id: string;
  folder_id: number | null;
  title?: string;
  peer_type?: string;
}

export default function BDAccountsPage() {
  const { t } = useTranslation();
  const searchParams = useSearchParams();
  const router = useRouter();
  const { subscribe, unsubscribe, on, off, isConnected } = useWebSocketContext();
  const [accounts, setAccounts] = useState<BDAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [showConnectModal, setShowConnectModal] = useState(false);
  const [selectedAccount, setSelectedAccount] = useState<string | null>(null);
  const [dialogs, setDialogs] = useState<Dialog[]>([]);
  const [dialogsByFolders, setDialogsByFolders] = useState<FolderWithDialogs[]>([]);
  const [syncChatsList, setSyncChatsList] = useState<SyncChatRow[]>([]);
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
  const qrPasswordSubmittedRef = useRef(false);
  const [selectedChatIds, setSelectedChatIds] = useState<Set<string>>(new Set());
  const [selectChatsSearch, setSelectChatsSearch] = useState('');
  const [expandedFolderId, setExpandedFolderId] = useState<number | null>(null);
  const [chatTypeFilter, setChatTypeFilter] = useState<'all' | 'personal' | 'groups'>('all');
  const [syncProgress, setSyncProgress] = useState<{ done: number; total: number; currentTitle?: string } | null>(null);
  const [refetchFoldersLoading, setRefetchFoldersLoading] = useState(false);

  const toggleFolderExpanded = useCallback((folderId: number) => {
    const id = Number(folderId);
    setExpandedFolderId((prev) => (prev === id ? null : id));
  }, []);
  const [startingSync, setStartingSync] = useState(false);
  const [connectForm, setConnectForm] = useState({
    phoneNumber: '',
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

  // После долгого простоя при возврате на вкладку перезапросить аккаунты (токен мог обновиться в другой вкладке или данные устареть)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchAccounts();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Открыть модалку «Выбор чатов» по ссылке с Мессенджера (?accountId=...&openSelectChats=1)
  // Сначала грузим из БД; при первом открытии (пустой список) один раз подтягиваем папки и чаты из Telegram
  useEffect(() => {
    const accountId = searchParams.get('accountId');
    const openSelectChats = searchParams.get('openSelectChats');
    if (!accountId || openSelectChats !== '1') return;
    setShowConnectModal(true);
    setConnectStep('select-chats');
    setConnectingAccountId(accountId);
    setSyncProgress(null);
    setError(null);
    setSelectChatsSearch('');
    setLoadingDialogs(true);
    router.replace('/dashboard/bd-accounts'); // убрать query из URL
    let skipOuterFinally = false;
    Promise.all([
      apiClient.get(`/api/bd-accounts/${accountId}/dialogs-by-folders`, { timeout: 120000 }).then((res) => (res.data?.folders ?? []) as FolderWithDialogs[]),
      apiClient.get(`/api/bd-accounts/${accountId}/sync-chats`).then((res) => (Array.isArray(res.data) ? res.data : []) as SyncChatRow[]),
    ])
      .then(([folders, syncList]) => {
        const totalDialogs = folders.reduce((sum, f) => sum + (f.dialogs?.length ?? 0), 0);
        const needInitialLoad = folders.length === 0 || totalDialogs === 0;
        if (needInitialLoad) {
          skipOuterFinally = true;
          apiClient.post(`/api/bd-accounts/${accountId}/folders-refetch`, {}, { timeout: 300000 })
            .then(() => Promise.all([
              apiClient.get(`/api/bd-accounts/${accountId}/dialogs-by-folders`, { timeout: 120000 }),
              apiClient.get(`/api/bd-accounts/${accountId}/sync-chats`),
            ]))
            .then(([foldersRes, syncRes]) => {
              const newFolders = (foldersRes.data?.folders ?? []) as FolderWithDialogs[];
              const newSyncList = (Array.isArray(syncRes.data) ? syncRes.data : []) as SyncChatRow[];
              setDialogsByFolders(newFolders);
              setSyncChatsList(newSyncList);
              setExpandedFolderId(null);
              setSelectedChatIds(new Set(newSyncList.map((c) => String(c.telegram_chat_id))));
            })
            .catch((e) => {
              console.error('Initial folders refetch failed:', e);
              setError(e?.response?.data?.message || e?.response?.data?.error || 'Не удалось загрузить папки и чаты');
            })
            .finally(() => setLoadingDialogs(false));
          return;
        }
        setDialogsByFolders(folders);
        setSyncChatsList(syncList);
        setExpandedFolderId(null);
        const alreadySelected = new Set(syncList.map((c) => String(c.telegram_chat_id)));
        setSelectedChatIds(alreadySelected);
      })
      .catch((e) => {
        console.error('Failed to load dialogs-by-folders or sync-chats:', e);
        setDialogsByFolders([]);
        setSyncChatsList([]);
        setSelectedChatIds(new Set());
        setError(e?.response?.data?.error || 'Ошибка загрузки');
      })
      .finally(() => { if (!skipOuterFinally) setLoadingDialogs(false); });
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
    if (!connectForm.phoneNumber) {
      setError('Введите номер телефона');
      return;
    }

    setSendingCode(true);
    setError(null);

    try {
      const response = await apiClient.post('/api/bd-accounts/send-code', {
        platform: 'telegram',
        phoneNumber: connectForm.phoneNumber,
      });

      setConnectingAccountId(response.data.accountId);
      setPhoneCodeHash(response.data.phoneCodeHash);
      setConnectStep('code');
    } catch (error: any) {
      console.error('Error sending code:', error);
      setError(error.response?.data?.message || error.response?.data?.error || 'Ошибка отправки кода');
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
      phoneCode: '',
      password: '',
    });
    setConnectingAccountId(null);
    setPhoneCodeHash(null);
    setQrSessionId(null);
    setQrState(null);
    setQr2faPassword('');
    setQrPendingReason(null);
    qrPasswordSubmittedRef.current = false;
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
    qrPasswordSubmittedRef.current = true;
    setQrState((prev) => (prev ? { ...prev, status: 'pending' } : null));
    try {
      await apiClient.post('/api/bd-accounts/qr-login-password', { sessionId: qrSessionId, password: qr2faPassword.trim() });
      setQr2faPassword('');
    } catch (err: any) {
      qrPasswordSubmittedRef.current = false;
      setQrPendingReason(null);
      setError(err?.response?.data?.error || 'Не удалось отправить пароль');
    } finally {
      setSubmittingQrPassword(false);
    }
  };

  const handleStartQrLogin = async () => {
    setStartingQr(true);
    setError(null);
    try {
      const res = await apiClient.post('/api/bd-accounts/start-qr-login', {});
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
        if (data.status === 'need_password' && qrPasswordSubmittedRef.current) {
          return;
        }
        if (data.status === 'success' || data.status === 'error') {
          qrPasswordSubmittedRef.current = false;
        }
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
            setSelectChatsSearch('');
            const accountId = data.accountId;
            apiClient.get(`/api/bd-accounts/${accountId}/dialogs-by-folders`, { timeout: 120000 })
              .then((res) => {
                const folders = (res.data?.folders ?? []) as FolderWithDialogs[];
                const totalDialogs = folders.reduce((sum, f) => sum + (f.dialogs?.length ?? 0), 0);
                const needInitialLoad = folders.length === 0 || totalDialogs === 0;
                if (needInitialLoad) {
                  return apiClient.post(`/api/bd-accounts/${accountId}/folders-refetch`, {}, { timeout: 300000 })
                    .then(() => apiClient.get(`/api/bd-accounts/${accountId}/dialogs-by-folders`, { timeout: 120000 }))
                    .then((r) => (r.data?.folders ?? []) as FolderWithDialogs[]);
                }
                return folders;
              })
              .then((folders) => {
                setDialogsByFolders(folders);
                setSyncChatsList([]);
                setExpandedFolderId(null);
                setSelectedChatIds(new Set());
              })
              .catch(() => { setDialogsByFolders([]); setSyncChatsList([]); setExpandedFolderId(null); setSelectedChatIds(new Set()); })
              .finally(() => setLoadingDialogs(false));
          }, 1800);
        }
        if (data.status === 'error') setQrPendingReason(null);
      } catch (_) {
        qrPasswordSubmittedRef.current = false;
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

  const toggleFolderSelection = useCallback((folder: FolderWithDialogs) => {
    const ids = folder.dialogs.map((d) => String(d.id));
    const allSelected = ids.every((id) => selectedChatIds.has(id));
    setSelectedChatIds((prev) => {
      const next = new Set(prev);
      if (allSelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }, [selectedChatIds]);

  const getFolderCheckState = useCallback((folder: FolderWithDialogs) => {
    const ids = folder.dialogs.map((d) => String(d.id));
    const selected = ids.filter((id) => selectedChatIds.has(id)).length;
    if (selected === 0) return { checked: false, indeterminate: false };
    if (selected === ids.length) return { checked: true, indeterminate: false };
    return { checked: false, indeterminate: true };
  }, [selectedChatIds]);

  const filterFoldersBySearch = useCallback((folders: FolderWithDialogs[], q: string) => {
    const qq = q.trim().toLowerCase();
    if (!qq) return folders;
    return folders
      .map((f) => ({
        ...f,
        dialogs: f.title?.toLowerCase().includes(qq)
          ? f.dialogs
          : f.dialogs.filter((d) => d.name?.toLowerCase().includes(qq)),
      }))
      .filter((f) => f.dialogs.length > 0);
  }, []);

  const handleSaveAndSync = async () => {
    if (!connectingAccountId || selectedChatIds.size === 0) {
      setError('Выберите хотя бы один чат');
      return;
    }
    setStartingSync(true);
    setError(null);
    try {
      const allDialogsFromFolders: Dialog[] = dialogsByFolders.flatMap((f) => f.dialogs);
      const idToDialog = new Map<string, Dialog>();
      const idToFolderId = new Map<string, number>();
      for (const folder of dialogsByFolders) {
        for (const d of folder.dialogs) {
          const sid = String(d.id);
          idToDialog.set(sid, d);
          idToFolderId.set(sid, folder.id);
        }
      }
      const chatsToSave: { id: string; name: string; isUser: boolean; isGroup: boolean; isChannel: boolean; folderId?: number }[] = [];
      for (const id of selectedChatIds) {
        const d = idToDialog.get(id);
        const folderId = idToFolderId.get(id);
        if (d) {
          chatsToSave.push({ id: d.id, name: d.name, isUser: d.isUser, isGroup: d.isGroup, isChannel: d.isChannel, folderId });
        } else {
          const row = syncChatsList.find((c) => String(c.telegram_chat_id) === id);
          if (row) {
            const pt = (row.peer_type ?? 'user').toLowerCase();
            chatsToSave.push({
              id: String(row.telegram_chat_id),
              name: (row.title ?? '').trim() || id,
              isUser: pt === 'user',
              isGroup: pt === 'chat',
              isChannel: pt === 'channel',
              folderId: row.folder_id != null ? row.folder_id : folderId,
            });
          }
        }
      }
      await apiClient.post(`/api/bd-accounts/${connectingAccountId}/sync-chats`, { chats: chatsToSave });
      await apiClient.post(`/api/bd-accounts/${connectingAccountId}/sync-start`);
      setSyncProgress({ done: 0, total: chatsToSave.length });
    } catch (err: any) {
      setError(err.response?.data?.message ?? err.response?.data?.error ?? 'Ошибка запуска синхронизации');
      setStartingSync(false);
    }
  };

  const handleDisconnect = async (accountId: string) => {
    if (!confirm('Отключить аккаунт? Получение сообщений будет приостановлено до включения.')) return;

    try {
      setError('');
      await apiClient.post(`/api/bd-accounts/${accountId}/disconnect`);
      await fetchAccounts();
    } catch (error: any) {
      console.error('Error disconnecting account:', error);
      setError(error.response?.data?.error || error.response?.data?.message || 'Ошибка отключения');
    }
  };

  const handleEnable = async (accountId: string) => {
    try {
      setError('');
      await apiClient.post(`/api/bd-accounts/${accountId}/enable`);
      await fetchAccounts();
    } catch (error: any) {
      console.error('Error enabling account:', error);
      setError(error.response?.data?.error || error.response?.data?.message || 'Ошибка включения');
    }
  };

  const handleDelete = async (accountId: string) => {
    if (!confirm('Удалить аккаунт навсегда? История сообщений останется, аккаунт будет отвязан.')) return;

    try {
      setError('');
      await apiClient.delete(`/api/bd-accounts/${accountId}`);
      await fetchAccounts();
    } catch (error: any) {
      console.error('Error deleting account:', error);
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
              {account.is_active ? (
                <CheckCircle2 className="w-5 h-5 text-green-500 shrink-0" />
              ) : (
                <XCircle className="w-5 h-5 text-gray-400 shrink-0" />
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
              {account.is_active ? (
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
              <Button
                variant="outline"
                size="sm"
                onClick={() => handleDelete(account.id)}
                className="text-red-600 hover:text-red-700"
                title="Удалить аккаунт"
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
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className={`w-full p-6 m-4 flex flex-col ${connectStep === 'select-chats' ? 'max-w-2xl max-h-[88vh]' : 'max-w-md'}`}>
            <div className="flex items-center justify-between mb-4 shrink-0">
              <h2 className="text-xl font-bold text-gray-900 dark:text-white">
                {connectStep === 'credentials' && 'Подключить Telegram аккаунт'}
                {connectStep === 'qr' && 'Вход по QR-коду'}
                {connectStep === 'code' && 'Введите код из SMS'}
                {connectStep === 'password' && 'Введите пароль 2FA'}
                {connectStep === 'select-chats' && 'Чаты для синхронизации'}
              </h2>
              <Button variant="outline" size="sm" onClick={handleCloseModal}>
                ✕
              </Button>
            </div>

            {error && (
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 mb-4 shrink-0">
                <p className="text-sm text-red-800 dark:text-red-200">{error}</p>
              </div>
            )}

            <div className={`flex flex-col ${connectStep === 'select-chats' ? 'flex-1 min-h-0 overflow-hidden' : ''} space-y-4`}>
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
                </>
              )}

              {/* Step QR: показать QR и ждать сканирования */}
              {connectStep === 'qr' && qrState && (
                <>
                  {(qrState.status === 'pending' || (qrState.status === 'need_password' && (submittingQrPassword || qrPendingReason === 'password'))) && !qrJustConnected && (
                    <div className="flex flex-col items-center justify-center py-8">
                      <Loader2 className="w-12 h-12 animate-spin text-blue-600 mb-4" />
                      <p className="text-sm text-gray-600 dark:text-gray-400">
                        {qrPendingReason === 'password' || submittingQrPassword ? 'Проверка пароля и подключение аккаунта…' : 'Генерация QR-кода…'}
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
                  {qrState.status === 'need_password' && !submittingQrPassword && qrPendingReason !== 'password' && (
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

              {/* Step 4: Select chats for sync — папки с галочкой «все в папке», поиск, удобный список */}
              {connectStep === 'select-chats' && (
                <div className="flex flex-col min-h-0 flex-1">
                  {connectingAccountId && (
                    <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-xl p-4 mb-3 shrink-0">
                      <p className="text-sm text-green-800 dark:text-green-200 font-medium">{t('bdAccounts.accountConnected')}</p>
                      <p className="text-xs text-green-700 dark:text-green-300 mt-1">
                        {t('bdAccounts.accountConnectedHint')}
                      </p>
                    </div>
                  )}
                  {connectingAccountId && !loadingDialogs && syncProgress === null && (
                    <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-xl p-4 mb-4 shrink-0">
                      <div className="flex items-start gap-3">
                        <div className="p-1.5 rounded-lg bg-blue-100 dark:bg-blue-800/50 shrink-0">
                          <ShieldCheck className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                        </div>
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-blue-900 dark:text-blue-100">{t('bdAccounts.syncSafetyTitle')}</p>
                          <p className="text-xs text-blue-800 dark:text-blue-200 mt-1">{t('bdAccounts.syncSafetyIntro')}</p>
                          <ul className="mt-2 space-y-1 text-xs text-blue-700 dark:text-blue-300 list-disc list-inside">
                            <li>{t('bdAccounts.syncSafetyOnlySelected')}</li>
                            <li>{t('bdAccounts.syncSafetyNoChangesInTg')}</li>
                            <li>{t('bdAccounts.syncSafetyDataSecure')}</li>
                            <li>{t('bdAccounts.syncSafetyChangeAnytime')}</li>
                          </ul>
                        </div>
                      </div>
                    </div>
                  )}
                  {syncProgress !== null ? (
                    <div className="space-y-3 py-4 shrink-0">
                      <p className="text-sm text-gray-700 dark:text-gray-300">
                        Синхронизация… {syncProgress.currentTitle && <span className="text-muted-foreground">({syncProgress.currentTitle})</span>}
                      </p>
                      <div className="flex items-center gap-3">
                        <div className="flex-1 h-2.5 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-primary transition-all duration-300 rounded-full"
                            style={{ width: syncProgress.total ? `${(100 * syncProgress.done) / syncProgress.total}%` : '0%' }}
                          />
                        </div>
                        <span className="text-sm font-medium tabular-nums">{syncProgress.done} / {syncProgress.total}</span>
                      </div>
                    </div>
                  ) : loadingDialogs ? (
                    <div className="flex flex-col items-center justify-center py-12 flex-1">
                      <Loader2 className="w-10 h-10 animate-spin text-primary mb-3" />
                      <p className="text-sm text-muted-foreground">Загружаем папки и чаты…</p>
                      <p className="text-xs text-muted-foreground mt-1">При большом числе чатов загрузка может занять 1–2 минуты</p>
                    </div>
                  ) : (
                    <>
                      <div className="mb-3 shrink-0">
                        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">Поиск по чатам и папкам</label>
                        <div className="relative">
                          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
                          <Input
                            type="text"
                            placeholder="Введите название чата или папки…"
                            value={selectChatsSearch}
                            onChange={(e) => setSelectChatsSearch(e.target.value)}
                            className="pl-9 rounded-lg border-gray-300 dark:border-gray-600"
                          />
                          {selectChatsSearch.trim() && (
                            <button
                              type="button"
                              onClick={() => setSelectChatsSearch('')}
                              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-700"
                              aria-label="Очистить поиск"
                            >
                              <XCircle className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center gap-2 mb-2 shrink-0 flex-wrap">
                        <span className="text-xs text-muted-foreground">Тип чатов:</span>
                        <div className="flex rounded-lg border border-gray-200 dark:border-gray-700 p-0.5 bg-gray-100 dark:bg-gray-800">
                          {(['all', 'personal', 'groups'] as const).map((key) => (
                            <button
                              key={key}
                              type="button"
                              onClick={() => setChatTypeFilter(key)}
                              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                                chatTypeFilter === key
                                  ? 'bg-card text-foreground shadow-sm'
                                  : 'text-muted-foreground hover:text-foreground'
                              }`}
                            >
                              {key === 'all' ? 'Все' : key === 'personal' ? 'Личные' : 'Группы'}
                            </button>
                          ))}
                        </div>
                        <button
                          type="button"
                          onClick={async () => {
                            if (!connectingAccountId) return;
                            setRefetchFoldersLoading(true);
                            setError(null);
                            try {
                              await apiClient.post(`/api/bd-accounts/${connectingAccountId}/folders-refetch`);
                              const res = await apiClient.get(`/api/bd-accounts/${connectingAccountId}/dialogs-by-folders`, { timeout: 120000 });
                              setDialogsByFolders((res.data?.folders ?? []) as FolderWithDialogs[]);
                            } catch (err: any) {
                              setError(err?.response?.data?.message || err?.response?.data?.error || 'Не удалось обновить папки и чаты');
                            } finally {
                              setRefetchFoldersLoading(false);
                            }
                          }}
                          disabled={refetchFoldersLoading}
                          className="ml-auto flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50"
                        >
                          {refetchFoldersLoading ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="w-3.5 h-3.5" />
                          )}
                          Обновить папки и чаты
                        </button>
                      </div>
                      <p className="text-xs text-muted-foreground mb-2 shrink-0">
                        Отметьте папку — выберутся все чаты в ней. Или отметьте только нужные чаты.
                      </p>
                      <div className="flex-1 min-h-0 overflow-y-auto rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-900/30 p-3 space-y-4">
                        {(() => {
                          const filteredFolders = filterFoldersBySearch(dialogsByFolders, selectChatsSearch);
                          return (
                            <>
                              {filteredFolders.map((folder) => {
                                const folderState = getFolderCheckState(folder);
                                const folderIdNum = Number(folder.id);
                                const isExpanded = expandedFolderId === folderIdNum;
                                const displayedDialogs =
                                  chatTypeFilter === 'all'
                                    ? folder.dialogs
                                    : chatTypeFilter === 'personal'
                                      ? folder.dialogs.filter((d) => d.isUser)
                                      : folder.dialogs.filter((d) => d.isGroup);
                                return (
                                  <div key={folder.id} className="rounded-lg border border-gray-200 dark:border-gray-700 bg-card overflow-hidden">
                                    <div className="flex items-center gap-2 p-3 hover:bg-gray-50 dark:hover:bg-gray-800/50 border-b border-gray-100 dark:border-gray-800">
                                      <label className="flex items-center shrink-0 cursor-pointer" onClick={(e) => e.stopPropagation()}>
                                        <input
                                          type="checkbox"
                                          ref={(el) => { if (el) el.indeterminate = folderState.indeterminate; }}
                                          checked={folderState.checked}
                                          onChange={() => toggleFolderSelection(folder)}
                                          className="rounded border-gray-300 w-4 h-4"
                                        />
                                      </label>
                                      <button
                                        type="button"
                                        onClick={() => toggleFolderExpanded(folderIdNum)}
                                        className="flex items-center gap-2 flex-1 min-w-0 text-left cursor-pointer"
                                      >
                                        {folder.emoticon ? (
                                          <span className="text-lg shrink-0 w-6 text-center leading-none" aria-hidden>{folder.emoticon}</span>
                                        ) : (
                                          <FolderOpen className="w-4 h-4 text-muted-foreground shrink-0" />
                                        )}
                                        <span className="font-semibold text-sm text-foreground truncate">{folder.title}</span>
                                        <span className="text-xs text-muted-foreground shrink-0">{displayedDialogs.length}</span>
                                        {isExpanded ? (
                                          <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0 ml-auto" />
                                        ) : (
                                          <ChevronRight className="w-4 h-4 text-muted-foreground shrink-0 ml-auto" />
                                        )}
                                      </button>
                                    </div>
                                    {isExpanded && (
                                      <div className="max-h-48 overflow-y-auto">
                                        {displayedDialogs.map((dialog) => (
                                          <label
                                            key={`${folder.id}-${dialog.id}`}
                                            className="flex items-center gap-3 px-3 py-2 pl-10 hover:bg-gray-50 dark:hover:bg-gray-800/30 cursor-pointer border-t border-gray-100 dark:border-gray-800/50 first:border-t-0"
                                          >
                                            <input
                                              type="checkbox"
                                              checked={selectedChatIds.has(String(dialog.id))}
                                              onChange={() => toggleChatSelection(String(dialog.id))}
                                              className="rounded border-gray-300 w-4 h-4"
                                            />
                                            <span className="font-medium text-sm truncate flex-1">{dialog.name}</span>
                                            {dialog.isUser && <span className="text-xs text-blue-600 dark:text-blue-400 shrink-0">Личный</span>}
                                            {dialog.isGroup && <span className="text-xs text-green-600 dark:text-green-400 shrink-0">Группа</span>}
                                            {dialog.isChannel && <span className="text-xs text-purple-600 dark:text-purple-400 shrink-0">Канал</span>}
                                          </label>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                );
                              })}
                              {filteredFolders.length === 0 && selectChatsSearch.trim() && (
                                <p className="text-sm text-muted-foreground py-4 text-center">Ничего не найдено по запросу «{selectChatsSearch.trim()}»</p>
                              )}
                              {filteredFolders.length === 0 && !selectChatsSearch.trim() && dialogsByFolders.length === 0 && (
                                <p className="text-sm text-muted-foreground py-6 text-center">Нет папок и чатов. Подождите загрузки или проверьте подключение.</p>
                              )}
                            </>
                          );
                        })()}
                        {(() => {
                          const idsInFolders = new Set(dialogsByFolders.flatMap((f) => f.dialogs.map((d) => String(d.id))));
                          const otherSyncChats = syncChatsList.filter((c) => !idsInFolders.has(String(c.telegram_chat_id)));
                          if (otherSyncChats.length === 0) return null;
                          const q = selectChatsSearch.trim().toLowerCase();
                          const filteredOther = q ? otherSyncChats.filter((r) => (r.title ?? r.telegram_chat_id).toLowerCase().includes(q)) : otherSyncChats;
                          if (filteredOther.length === 0 && q) return null;
                          const byFolder = new Map<number | null, SyncChatRow[]>();
                          for (const row of filteredOther) {
                            const fid = row.folder_id ?? null;
                            if (!byFolder.has(fid)) byFolder.set(fid, []);
                            byFolder.get(fid)!.push(row);
                          }
                          const folderTitles = new Map<number | null, string>();
                          folderTitles.set(null, 'Без папки');
                          for (const f of dialogsByFolders) folderTitles.set(f.id, f.title);
                          return (
                            <div className="rounded-lg border border-dashed border-gray-300 dark:border-gray-600 bg-card/50 p-3 mt-2">
                              <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2 flex items-center gap-1.5">
                                <MessageSquare className="w-3.5 h-3.5" /> Другие выбранные чаты
                              </div>
                              {Array.from(byFolder.entries()).map(([folderId, rows]) => (
                                <div key={folderId ?? 'null'} className="space-y-0.5">
                                  {folderId !== null && (
                                    <div className="text-xs text-muted-foreground pl-6 mt-1.5">{folderTitles.get(folderId) ?? `Папка ${folderId}`}</div>
                                  )}
                                  {rows.map((row) => (
                                    <label
                                      key={row.telegram_chat_id}
                                      className="flex items-center gap-3 pl-6 py-1.5 hover:bg-gray-50 dark:hover:bg-gray-800/30 rounded cursor-pointer"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={selectedChatIds.has(String(row.telegram_chat_id))}
                                        onChange={() => toggleChatSelection(String(row.telegram_chat_id))}
                                        className="rounded border-gray-300 w-4 h-4"
                                      />
                                      <span className="font-medium text-sm truncate">{row.title || row.telegram_chat_id}</span>
                                    </label>
                                  ))}
                                </div>
                              ))}
                            </div>
                          );
                        })()}
                      </div>
                      <p className="text-sm text-muted-foreground mt-3 shrink-0">
                        Выбрано чатов: <strong className="text-foreground">{selectedChatIds.size}</strong>
                      </p>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="flex gap-2 mt-6 shrink-0">
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
                    onClick={() => { setConnectStep('credentials'); setQrSessionId(null); setQrState(null); setQr2faPassword(''); qrPasswordSubmittedRef.current = false; }}
                    className="flex-1"
                  >
                    Назад
                  </Button>
                  {qrPendingReason === 'password' ? (
                    <Button disabled className="flex-1">
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                      Проверка пароля…
                    </Button>
                  ) : qrState?.status === 'need_password' ? (
                    <Button
                      onClick={handleSubmitQr2faPassword}
                      disabled={submittingQrPassword || !qr2faPassword.trim()}
                      className="flex-1"
                    >
                      {submittingQrPassword ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Подтвердить'}
                    </Button>
                  ) : qrState?.status === 'error' ? (
                    <Button
                      onClick={() => { setQrSessionId(null); setQrState({ status: 'pending' }); setError(null); qrPasswordSubmittedRef.current = false; handleStartQrLogin(); }}
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

