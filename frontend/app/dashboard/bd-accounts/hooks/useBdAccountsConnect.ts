'use client';

import { useEffect, useState, useCallback, useRef } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { reportError } from '@/lib/error-reporter';
import {
  fetchBdAccountDialogsByFoldersRefresh,
  listBdAccountSyncChatsForConnect,
  postBdAccountSendCode,
  postBdAccountVerifyCode,
  postBdAccountQrLoginPassword,
  postBdAccountStartQrLogin,
  postBdAccountStartQrLoginWithProxy,
  getBdAccountQrLoginStatus,
  getBdAccountSyncStatus,
  startBdAccountSync,
  saveBdAccountSyncChatsSelection,
} from '@/lib/api/bd-accounts';
import type { BdProxyConfigInput } from '@/lib/api/bd-accounts';
import type { FolderWithDialogs, SyncChatRow } from '../types';

/** Allowed "days" options for dialogs refresh (filter by last N days). Default 90. */
export const SYNC_DAYS_OPTIONS = [30, 90, 180, 360] as const;
export const SYNC_DAYS_DEFAULT = 90;

function getDialogsLoadErrorMessage(e: unknown): string {
  const err = e as { code?: string; response?: { status?: number; data?: { error?: string; message?: string } } };
  if (err?.code === 'ECONNABORTED') {
    return 'Загрузка заняла слишком много времени. Нажмите «Повторить».';
  }
  if (err?.response?.status === 503 && (err?.response?.data?.error === 'TELEGRAM_UPDATE_TIMEOUT' || err?.response?.data?.message)) {
    return err.response.data.message || 'Таймаут Telegram. Нажмите «Повторить» или обновите папки позже.';
  }
  return err?.response?.data?.message || err?.response?.data?.error || 'Ошибка загрузки';
}

export type ConnectStep = 'credentials' | 'qr' | 'code' | 'password' | 'select-chats';

export interface UseBdAccountsConnectOptions {
  onAccountsRefresh: () => void;
  subscribe: (room: string) => void;
  unsubscribe: (room: string) => void;
  on: (event: string, handler: (payload: unknown) => void) => void;
  off: (event: string, handler: (payload: unknown) => void) => void;
  isConnected: boolean;
}

export type ConnectModalProps = ReturnType<typeof useBdAccountsConnect>;

export function useBdAccountsConnect({
  onAccountsRefresh,
  subscribe,
  unsubscribe,
  on,
  off,
  isConnected,
}: UseBdAccountsConnectOptions) {
  const searchParams = useSearchParams();
  const router = useRouter();

  const [showConnectModal, setShowConnectModal] = useState(false);
  const [connectStep, setConnectStep] = useState<ConnectStep>('credentials');
  const [loginMethod, setLoginMethod] = useState<'phone' | 'qr'>('phone');
  const [connectForm, setConnectForm] = useState({ phoneNumber: '', phoneCode: '', password: '' });
  const [useProxy, setUseProxy] = useState(false);
  const [proxyForm, setProxyForm] = useState<{ type: 'socks5' | 'http'; host: string; port: string; username: string; password: string }>({
    type: 'socks5',
    host: '',
    port: '',
    username: '',
    password: '',
  });
  const [connectingAccountId, setConnectingAccountId] = useState<string | null>(null);
  const [phoneCodeHash, setPhoneCodeHash] = useState<string | null>(null);
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
  const [startingSync, setStartingSync] = useState(false);
  const [dialogsByFolders, setDialogsByFolders] = useState<FolderWithDialogs[]>([]);
  const [syncChatsList, setSyncChatsList] = useState<SyncChatRow[]>([]);
  const [loadingDialogs, setLoadingDialogs] = useState(false);
  const [dialogsTruncated, setDialogsTruncated] = useState(false);
  const [dialogsDays, setDialogsDays] = useState<number | undefined>(undefined);
  const [maxDialogsPerFolder, setMaxDialogsPerFolder] = useState<number | undefined>(undefined);
  const [syncDaysFilter, setSyncDaysFilter] = useState<number>(SYNC_DAYS_DEFAULT);
  const [sendingCode, setSendingCode] = useState(false);
  const [verifyingCode, setVerifyingCode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCloseModal = useCallback(() => {
    setShowConnectModal(false);
    setConnectStep('credentials');
    setLoginMethod('phone');
    setConnectForm({ phoneNumber: '', phoneCode: '', password: '' });
    setUseProxy(false);
    setProxyForm({ type: 'socks5', host: '', port: '', username: '', password: '' });
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
  }, []);

  const fetchAccounts = onAccountsRefresh;

  // Open select-chats by URL
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
    router.replace('/dashboard/bd-accounts');
    Promise.all([
      fetchBdAccountDialogsByFoldersRefresh(accountId, syncDaysFilter),
      listBdAccountSyncChatsForConnect(accountId),
    ])
      .then(([data, syncList]) => {
        const folders = data?.folders ?? [];
        setDialogsByFolders(folders);
        setDialogsTruncated(Boolean(data?.truncated));
        setDialogsDays(data?.days);
        setMaxDialogsPerFolder(data?.maxDialogsPerFolder);
        setSyncChatsList(syncList);
        setExpandedFolderId(null);
        setSelectedChatIds(new Set(syncList.map((c) => String(c.telegram_chat_id))));
      })
      .catch((e) => {
        reportError(e, { component: 'useBdAccountsConnect', action: 'loadDialogsOrSyncChats' });
        setDialogsByFolders([]);
        setSyncChatsList([]);
        setSelectedChatIds(new Set());
        setDialogsTruncated(false);
        setError(getDialogsLoadErrorMessage(e));
      })
      .finally(() => setLoadingDialogs(false));
  }, [searchParams, router, syncDaysFilter]);

  // WebSocket sync progress
  useEffect(() => {
    if (connectStep !== 'select-chats' || !connectingAccountId || !isConnected) return;
    const room = `bd-account:${connectingAccountId}`;
    subscribe(room);
    const handler = (payload: unknown) => {
      const p = payload as { type: string; data?: { bdAccountId?: string; totalChats?: number; done?: number; total?: number; currentChatTitle?: string; error?: string } };
      if (p.type === 'bd_account.sync.started' && p.data?.bdAccountId === connectingAccountId) {
        setSyncProgress({ done: 0, total: p.data?.totalChats ?? 0 });
      }
      if (p.type === 'bd_account.sync.progress' && p.data?.bdAccountId === connectingAccountId) {
        setSyncProgress({
          done: p.data?.done ?? 0,
          total: p.data?.total ?? 0,
          currentTitle: p.data?.currentChatTitle,
        });
      }
      if (p.type === 'bd_account.sync.completed' && p.data?.bdAccountId === connectingAccountId) {
        setSyncProgress(null);
        setStartingSync(false);
        fetchAccounts();
        handleCloseModal();
      }
      if (p.type === 'bd_account.sync.failed' && p.data?.bdAccountId === connectingAccountId) {
        setSyncProgress(null);
        setStartingSync(false);
        setError(p.data?.error ?? 'Синхронизация не удалась');
      }
    };
    on('event', handler);
    return () => {
      off('event', handler);
      unsubscribe(room);
    };
  }, [connectStep, connectingAccountId, isConnected, subscribe, unsubscribe, on, off, fetchAccounts, handleCloseModal]);

  // Poll sync status fallback
  useEffect(() => {
    if (syncProgress === null || !connectingAccountId) return;
    const t = setInterval(async () => {
      try {
        const d = await getBdAccountSyncStatus(connectingAccountId);
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
      } catch {
        // ignore
      }
    }, 2000);
    return () => clearInterval(t);
  }, [connectingAccountId, syncProgress, fetchAccounts, handleCloseModal]);

  const handleSendCode = useCallback(async () => {
    if (!connectForm.phoneNumber) {
      setError('Введите номер телефона');
      return;
    }
    setSendingCode(true);
    setError(null);
    try {
      let proxyConfig: BdProxyConfigInput | undefined;
      if (useProxy) {
        const host = proxyForm.host.trim();
        const port = Number(proxyForm.port);
        if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
          setError('Проверьте прокси: host и порт (1-65535) обязательны');
          setSendingCode(false);
          return;
        }
        if (proxyForm.type !== 'socks5') {
          setError('Для подключения Telegram сейчас поддерживается только SOCKS5 прокси');
          setSendingCode(false);
          return;
        }
        proxyConfig = {
          type: proxyForm.type,
          host,
          port,
          ...(proxyForm.username.trim() ? { username: proxyForm.username.trim() } : {}),
          ...(proxyForm.password.trim() ? { password: proxyForm.password.trim() } : {}),
        };
      }
      const response = await postBdAccountSendCode({
        platform: 'telegram',
        phoneNumber: connectForm.phoneNumber,
        ...(proxyConfig ? { proxyConfig } : {}),
      });
      setConnectingAccountId(response.accountId);
      setPhoneCodeHash(response.phoneCodeHash);
      setConnectStep('code');
    } catch (err: unknown) {
      const res = err as { response?: { data?: { message?: string; error?: string } } };
      setError(res.response?.data?.message || res.response?.data?.error || 'Ошибка отправки кода');
    } finally {
      setSendingCode(false);
    }
  }, [connectForm.phoneNumber, proxyForm.host, proxyForm.password, proxyForm.port, proxyForm.type, proxyForm.username, useProxy]);

  const handleVerifyCode = useCallback(async () => {
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
      await postBdAccountVerifyCode({
        accountId: connectingAccountId,
        phoneNumber: connectForm.phoneNumber,
        phoneCode: connectForm.phoneCode,
        phoneCodeHash,
        password: connectForm.password || undefined,
      });
      onAccountsRefresh();
      setConnectStep('select-chats');
      setSelectedChatIds(new Set());
      setSyncProgress(null);
      setLoadingDialogs(true);
      try {
        const [data, syncList] = await Promise.all([
          fetchBdAccountDialogsByFoldersRefresh(connectingAccountId, syncDaysFilter),
          listBdAccountSyncChatsForConnect(connectingAccountId),
        ]);
        const folders = data?.folders ?? [];
        setDialogsByFolders(folders);
        setDialogsTruncated(Boolean(data?.truncated));
        setDialogsDays(data?.days);
        setMaxDialogsPerFolder(data?.maxDialogsPerFolder);
        setSyncChatsList(syncList);
        setExpandedFolderId(null);
      } catch (e) {
        setDialogsByFolders([]);
        setSyncChatsList([]);
        setDialogsTruncated(false);
        setError(getDialogsLoadErrorMessage(e));
      } finally {
        setLoadingDialogs(false);
      }
    } catch (err: unknown) {
      const res = err as { response?: { data?: { message?: string; error?: string; requiresPassword?: boolean } } };
      if (res.response?.data?.requiresPassword) {
        setConnectStep('password');
        setError(null);
      } else {
        setError(res.response?.data?.message || res.response?.data?.error || 'Ошибка верификации');
      }
    } finally {
      setVerifyingCode(false);
    }
  }, [connectForm.phoneNumber, connectForm.phoneCode, connectForm.password, connectingAccountId, phoneCodeHash, onAccountsRefresh, syncDaysFilter]);

  const handleSubmitQr2faPassword = useCallback(async () => {
    if (!qrSessionId || !qr2faPassword.trim()) return;
    setSubmittingQrPassword(true);
    setError(null);
    setQrPendingReason('password');
    qrPasswordSubmittedRef.current = true;
    setQrState((prev) => (prev ? { ...prev, status: 'pending' } : null));
    try {
      await postBdAccountQrLoginPassword({ sessionId: qrSessionId, password: qr2faPassword.trim() });
      setQr2faPassword('');
    } catch (err: unknown) {
      qrPasswordSubmittedRef.current = false;
      setQrPendingReason(null);
      const res = err as { response?: { data?: { error?: string } } };
      setError(res.response?.data?.error || 'Не удалось отправить пароль');
    } finally {
      setSubmittingQrPassword(false);
    }
  }, [qrSessionId, qr2faPassword]);

  const handleStartQrLogin = useCallback(async () => {
    setStartingQr(true);
    setError(null);
    try {
      let proxyConfig: BdProxyConfigInput | undefined;
      if (useProxy) {
        const host = proxyForm.host.trim();
        const port = Number(proxyForm.port);
        if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
          setError('Проверьте прокси: host и порт (1-65535) обязательны');
          setStartingQr(false);
          return;
        }
        if (proxyForm.type !== 'socks5') {
          setError('Для подключения Telegram сейчас поддерживается только SOCKS5 прокси');
          setStartingQr(false);
          return;
        }
        proxyConfig = {
          type: proxyForm.type,
          host,
          port,
          ...(proxyForm.username.trim() ? { username: proxyForm.username.trim() } : {}),
          ...(proxyForm.password.trim() ? { password: proxyForm.password.trim() } : {}),
        };
      }
      const res = proxyConfig
        ? await postBdAccountStartQrLoginWithProxy({ proxyConfig })
        : await postBdAccountStartQrLogin();
      setQrSessionId(res.sessionId);
      setConnectStep('qr');
      setQrState({ status: 'pending' });
    } catch (err: unknown) {
      const res = err as { response?: { data?: { message?: string; error?: string } } };
      setError(res.response?.data?.message || res.response?.data?.error || 'Ошибка запуска QR-входа');
    } finally {
      setStartingQr(false);
    }
  }, [proxyForm.host, proxyForm.password, proxyForm.port, proxyForm.type, proxyForm.username, useProxy]);

  // QR polling
  useEffect(() => {
    if (connectStep !== 'qr' || !qrSessionId) return;
    const t = setInterval(async () => {
      try {
        const data = await getBdAccountQrLoginStatus(qrSessionId);
        if (data.status === 'need_password' && qrPasswordSubmittedRef.current) return;
        if (data.status === 'success' || data.status === 'error') qrPasswordSubmittedRef.current = false;
        setQrState({ status: data.status, loginTokenUrl: data.loginTokenUrl, accountId: data.accountId, error: data.error, passwordHint: data.passwordHint });
        if (data.status === 'success' && data.accountId) {
          const qrConnectedAccountId = data.accountId;
          setQrPendingReason(null);
          setConnectingAccountId(qrConnectedAccountId);
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
            fetchBdAccountDialogsByFoldersRefresh(qrConnectedAccountId, syncDaysFilter)
              .then((payload) => {
                const folders = payload?.folders ?? [];
                setDialogsByFolders(folders);
                setDialogsTruncated(Boolean(payload?.truncated));
                setDialogsDays(payload?.days);
                setMaxDialogsPerFolder(payload?.maxDialogsPerFolder);
                setSyncChatsList([]);
                setExpandedFolderId(null);
                setSelectedChatIds(new Set());
              })
              .catch((e) => {
                setDialogsByFolders([]);
                setSyncChatsList([]);
                setExpandedFolderId(null);
                setSelectedChatIds(new Set());
                setDialogsTruncated(false);
                setError(getDialogsLoadErrorMessage(e));
              })
              .finally(() => setLoadingDialogs(false));
          }, 1800);
        }
        if (data.status === 'error') setQrPendingReason(null);
      } catch {
        qrPasswordSubmittedRef.current = false;
        setQrState((prev) => (prev ? { ...prev, status: 'error', error: 'Сессия истекла' } : null));
      }
    }, 1500);
    return () => clearInterval(t);
  }, [connectStep, qrSessionId, fetchAccounts, syncDaysFilter]);

  const toggleFolderExpanded = useCallback((folderId: number) => {
    const id = Number(folderId);
    setExpandedFolderId((prev) => (prev === id ? null : id));
  }, []);

  const toggleChatSelection = useCallback((id: string) => {
    setSelectedChatIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleFolderSelection = useCallback((folder: FolderWithDialogs) => {
    setSelectedChatIds((prev) => {
      const ids = folder.dialogs.map((d) => String(d.id));
      const allSelected = ids.every((id) => prev.has(id));
      const next = new Set(prev);
      if (allSelected) ids.forEach((id) => next.delete(id));
      else ids.forEach((id) => next.add(id));
      return next;
    });
  }, []);

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
        dialogs: f.title?.toLowerCase().includes(qq) ? f.dialogs : f.dialogs.filter((d) => d.name?.toLowerCase().includes(qq)),
      }))
      .filter((f) => f.dialogs.length > 0);
  }, []);

  const handleSaveAndSync = useCallback(async () => {
    if (!connectingAccountId || selectedChatIds.size === 0) {
      setError('Выберите хотя бы один чат');
      return;
    }
    setStartingSync(true);
    setError(null);
    try {
      const allDialogsFromFolders = dialogsByFolders.flatMap((f) => f.dialogs);
      const idToDialog = new Map<string, (typeof allDialogsFromFolders)[0]>();
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
      await saveBdAccountSyncChatsSelection(connectingAccountId, chatsToSave);
      await startBdAccountSync(connectingAccountId);
      setSyncProgress({ done: 0, total: chatsToSave.length });
    } catch (err: unknown) {
      const res = err as { response?: { data?: { message?: string; error?: string } } };
      setError(res.response?.data?.message ?? res.response?.data?.error ?? 'Ошибка запуска синхронизации');
      setStartingSync(false);
    }
  }, [connectingAccountId, selectedChatIds, dialogsByFolders, syncChatsList]);

  const handleBackFromQr = useCallback(() => {
    setConnectStep('credentials');
    setQrSessionId(null);
    setQrState(null);
    setQr2faPassword('');
    qrPasswordSubmittedRef.current = false;
  }, []);

  const handleRetryQr = useCallback(() => {
    setQrSessionId(null);
    setQrState({ status: 'pending' });
    setError(null);
    qrPasswordSubmittedRef.current = false;
    handleStartQrLogin();
  }, [handleStartQrLogin]);

  const handleRefetchFolders = useCallback(async () => {
    if (!connectingAccountId) return;
    setRefetchFoldersLoading(true);
    setError(null);
    try {
      const data = await fetchBdAccountDialogsByFoldersRefresh(connectingAccountId, syncDaysFilter);
      setDialogsByFolders((data?.folders ?? []) as FolderWithDialogs[]);
      setDialogsTruncated(Boolean(data?.truncated));
      setDialogsDays(data?.days);
      setMaxDialogsPerFolder(data?.maxDialogsPerFolder);
    } catch (err: unknown) {
      setError(getDialogsLoadErrorMessage(err));
    } finally {
      setRefetchFoldersLoading(false);
    }
  }, [connectingAccountId, syncDaysFilter]);

  const handleRetryLoadDialogs = useCallback(() => {
    if (!connectingAccountId) return;
    setError(null);
    setLoadingDialogs(true);
    Promise.all([
      fetchBdAccountDialogsByFoldersRefresh(connectingAccountId, syncDaysFilter),
      listBdAccountSyncChatsForConnect(connectingAccountId),
    ])
      .then(([data, syncList]) => {
        const folders = data?.folders ?? [];
        setDialogsByFolders(folders);
        setDialogsTruncated(Boolean(data?.truncated));
        setDialogsDays(data?.days);
        setMaxDialogsPerFolder(data?.maxDialogsPerFolder);
        setSyncChatsList(syncList);
        setExpandedFolderId(null);
        setSelectedChatIds(new Set(syncList.map((c) => String(c.telegram_chat_id))));
      })
      .catch((e) => {
        reportError(e, { component: 'useBdAccountsConnect', action: 'retryLoadDialogs' });
        setDialogsTruncated(false);
        setError(getDialogsLoadErrorMessage(e));
      })
      .finally(() => setLoadingDialogs(false));
  }, [connectingAccountId, syncDaysFilter]);

  return {
    showConnectModal,
    setShowConnectModal,
    connectStep,
    setConnectStep,
    connectForm,
    setConnectForm,
    useProxy,
    setUseProxy,
    proxyForm,
    setProxyForm,
    loginMethod,
    setLoginMethod,
    connectingAccountId,
    qrSessionId,
    qrState,
    qr2faPassword,
    setQr2faPassword,
    submittingQrPassword,
    qrPendingReason,
    qrJustConnected,
    startingQr,
    selectedChatIds,
    setSelectedChatIds,
    selectChatsSearch,
    setSelectChatsSearch,
    expandedFolderId,
    chatTypeFilter,
    setChatTypeFilter,
    syncProgress,
    loadingDialogs,
    refetchFoldersLoading,
    startingSync,
    dialogsByFolders,
    setDialogsByFolders,
    dialogsTruncated,
    dialogsDays,
    maxDialogsPerFolder,
    syncDaysFilter,
    setSyncDaysFilter,
    syncChatsList,
    sendingCode,
    verifyingCode,
    error,
    setError,
    handleCloseModal,
    handleSendCode,
    handleVerifyCode,
    handleStartQrLogin,
    handleSubmitQr2faPassword,
    handleSaveAndSync,
    toggleFolderExpanded,
    toggleChatSelection,
    toggleFolderSelection,
    getFolderCheckState,
    filterFoldersBySearch,
    handleBackFromQr,
    handleRetryQr,
    handleRefetchFolders,
    handleRetryLoadDialogs,
  };
}
