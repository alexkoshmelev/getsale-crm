'use client';

import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { apiClient } from '@/lib/api/client';
import { useAuthStore } from '@/lib/stores/auth-store';
import { useWebSocketContext } from '@/lib/contexts/websocket-context';
import { setCurrentMessagingChat } from '@/lib/messaging-open-chat';
import { 
  Plus, Search, Send, MoreVertical, MessageSquare, 
  CheckCircle2, XCircle, Loader2, Settings, Trash2,
  Mic, Paperclip, FileText, Image, Video, File,
  Sparkles, Zap, History, FileCode, Bot, Workflow,
  ChevronDown, ChevronRight, ChevronLeft, X, Clock, UserCircle, Tag, BarChart3,
  Music, Film, Users, Check, CheckCheck, RefreshCw, Pin, PinOff, Smile, Pencil
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ContextMenu, ContextMenuSection, ContextMenuItem } from '@/components/ui/ContextMenu';
import { Virtuoso } from 'react-virtuoso';
import { LinkifyText } from '@/components/messaging/LinkifyText';
import { MediaViewer } from '@/components/messaging/MediaViewer';
import { FolderManageModal } from '@/components/messaging/FolderManageModal';
import { blobUrlCache, avatarAccountKey, avatarChatKey, mediaKey } from '@/lib/cache/blob-url-cache';

interface BDAccount {
  id: string;
  phone_number: string;
  telegram_id: string;
  is_active: boolean;
  connected_at?: string;
  last_activity?: string;
  created_at: string;
  sync_status?: string;
  owner_id?: string | null;
  is_owner?: boolean;
  first_name?: string | null;
  last_name?: string | null;
  username?: string | null;
  display_name?: string | null;
  /** Суммарное количество непрочитанных по аккаунту (только по чатам из sync) */
  unread_count?: number;
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

function BDAccountAvatar({ accountId, account, className = 'w-10 h-10' }: { accountId: string; account: BDAccount; className?: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const mounted = useRef(true);
  const key = avatarAccountKey(accountId);

  useEffect(() => {
    mounted.current = true;
    const cached = blobUrlCache.get(key);
    if (cached) {
      setSrc(cached);
      return () => {
        mounted.current = false;
        setSrc(null);
      };
    }
    apiClient
      .get(`/api/bd-accounts/${accountId}/avatar`, { responseType: 'blob' })
      .then((res) => {
        if (mounted.current && res.data instanceof Blob && res.data.size > 0) {
          const u = URL.createObjectURL(res.data);
          blobUrlCache.set(key, u);
          setSrc(u);
        }
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
      setSrc(null);
    };
  }, [accountId, key]);

  const initials = getAccountInitials(account);
  if (src) {
    return <img src={src} alt="" className={`rounded-full object-cover bg-muted shrink-0 ${className}`} />;
  }
  return (
    <div className={`rounded-full bg-primary/15 flex items-center justify-center text-primary font-semibold text-sm shrink-0 ${className}`}>
      {initials}
    </div>
  );
}

interface SyncFolder {
  id: string;
  folder_id: number;
  folder_title: string;
  order_index: number;
  is_user_created?: boolean;
  icon?: string | null;
}

interface Chat {
  channel: string;
  channel_id: string;
  folder_id?: number | null;
  folder_ids?: number[];
  contact_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  telegram_id: string | null;
  display_name: string | null;  // кастомное имя контакта/лида
  username: string | null;       // Telegram @username
  name: string | null;
  peer_type?: string | null;    // 'user' | 'chat' | 'channel' — для фильтра Личные/Группы
  unread_count: number;
  last_message_at: string;
  last_message: string | null;
}

interface Message {
  id: string;
  content: string;
  direction: string;
  created_at: string;
  status: string;
  contact_id: string | null;
  channel: string;
  channel_id: string;
  telegram_message_id?: string | null;  // id сообщения в Telegram (для прокси медиа)
  telegram_media?: Record<string, unknown> | null;
  telegram_entities?: Array<Record<string, unknown>> | null;
  telegram_date?: string | null;  // оригинальное время отправки в Telegram
  reactions?: Record<string, number> | null;  // { "👍": 2, "❤️": 1 }
}

/** Тип медиа из telegram_media (GramJS: messageMediaPhoto, messageMediaDocument и т.д.) */
type MessageMediaType = 'text' | 'photo' | 'voice' | 'audio' | 'video' | 'document' | 'sticker' | 'unknown';

function getMessageMediaType(msg: Message): MessageMediaType {
  const media = msg.telegram_media;
  if (!media || typeof media !== 'object') return 'text';
  const type = (media as any)._ ?? (media as any).className;
  if (type === 'messageMediaPhoto' || type === 'MessageMediaPhoto') return 'photo';
  if (type === 'messageMediaDocument' || type === 'MessageMediaDocument') {
    const doc = (media as any).document;
    if (doc && Array.isArray(doc.attributes)) {
      for (const a of doc.attributes) {
        const attr = (a as any)._ ?? (a as any).className;
        if (attr === 'documentAttributeAudio' || attr === 'DocumentAttributeAudio') {
          return (a as any).voice ? 'voice' : 'audio';
        }
        if (attr === 'documentAttributeVideo' || attr === 'DocumentAttributeVideo') return 'video';
      }
    }
    return 'document';
  }
  if (type === 'messageMediaSticker' || type === 'MessageMediaSticker') return 'sticker';
  if (type === 'messageMediaContact' || type === 'MessageMediaContact') return 'unknown';
  return 'text';
}

const mediaLabels: Record<MessageMediaType, string> = {
  text: '',
  photo: 'Фото',
  voice: 'Голосовое сообщение',
  audio: 'Аудио',
  video: 'Видео',
  document: 'Документ',
  sticker: 'Стикер',
  unknown: 'Вложение',
};

function getChatDisplayName(chat: Chat): string {
  if (chat.display_name?.trim()) return chat.display_name.trim();
  const firstLast = `${chat.first_name || ''} ${chat.last_name || ''}`.trim();
  if (firstLast && !/^Telegram\s+\d+$/.test(firstLast)) return firstLast;
  if (chat.username) return chat.username.startsWith('@') ? chat.username : `@${chat.username}`;
  if (chat.name?.trim()) return chat.name.trim();
  if (chat.email?.trim()) return chat.email.trim();
  if (chat.telegram_id) return chat.telegram_id;
  return '?';
}

function getChatInitials(chat: Chat): string {
  const name = getChatDisplayName(chat).replace(/^@/, '').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase().slice(0, 2);
  if (name.length >= 2) return name.slice(0, 2).toUpperCase();
  return name.slice(0, 1).toUpperCase() || '?';
}

function ChatAvatar({
  bdAccountId,
  chatId,
  chat,
  className = 'w-10 h-10',
}: {
  bdAccountId: string;
  chatId: string;
  chat: Chat;
  className?: string;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const mounted = useRef(true);
  const key = avatarChatKey(bdAccountId, chatId);

  useEffect(() => {
    if (!bdAccountId || !chatId) return;
    mounted.current = true;
    const cached = blobUrlCache.get(key);
    if (cached) {
      setSrc(cached);
      return () => {
        mounted.current = false;
        setSrc(null);
      };
    }
    apiClient
      .get(`/api/bd-accounts/${bdAccountId}/chats/${chatId}/avatar`, { responseType: 'blob' })
      .then((res) => {
        if (mounted.current && res.data instanceof Blob && res.data.size > 0) {
          const u = URL.createObjectURL(res.data);
          blobUrlCache.set(key, u);
          setSrc(u);
        }
      })
      .catch(() => {});
    return () => {
      mounted.current = false;
      setSrc(null);
    };
  }, [bdAccountId, chatId, key]);

  const initials = getChatInitials(chat);
  const isGroup = chat.peer_type === 'chat' || chat.peer_type === 'channel';

  if (src) {
    return <img src={src} alt="" className={`rounded-full object-cover bg-muted shrink-0 ${className}`} />;
  }
  return (
    <div
      className={`rounded-full bg-primary/15 flex items-center justify-center text-primary font-semibold text-sm shrink-0 ${className}`}
      title={getChatDisplayName(chat)}
    >
      {isGroup ? <Users className="w-1/2 h-1/2" /> : initials}
    </div>
  );
}

function DownloadLink({ url, className }: { url: string; className?: string }) {
  const [loading, setLoading] = useState(false);
  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    if (loading) return;
    setLoading(true);
    try {
      const authStorage = typeof window !== 'undefined' ? localStorage.getItem('auth-storage') : null;
      const token = authStorage ? (JSON.parse(authStorage)?.state?.accessToken as string) : null;
      const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
      if (!res.ok) throw new Error('Failed to download');
      const blob = await res.blob();
      const u = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = u;
      a.download = 'document';
      a.click();
      URL.revokeObjectURL(u);
    } catch (_) {
      // fallback: open in new tab (may 401)
      window.open(url, '_blank');
    } finally {
      setLoading(false);
    }
  };
  return (
    <button type="button" onClick={handleClick} className={className} disabled={loading}>
      {loading ? '…' : 'Скачать'}
    </button>
  );
}

function getMediaProxyUrl(bdAccountId: string, channelId: string, telegramMessageId: string): string {
  const base = typeof window !== 'undefined' ? (process.env.NEXT_PUBLIC_API_URL || '') : '';
  const params = new URLSearchParams({ channelId, messageId: telegramMessageId });
  return `${base}/api/bd-accounts/${bdAccountId}/media?${params.toString()}`;
}

/** Загружает медиа с токеном и отдаёт blob URL для img/video/audio (браузер не шлёт Authorization в src). Использует LRU-кэш. */
function useMediaUrl(mediaUrl: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!mediaUrl) {
      setUrl(null);
      return;
    }
    const key = mediaKey(mediaUrl);
    const cached = blobUrlCache.get(key);
    if (cached) {
      setUrl(cached);
      return () => setUrl(null);
    }
    let cancelled = false;
    const authStorage = typeof window !== 'undefined' ? localStorage.getItem('auth-storage') : null;
    const token = authStorage ? (JSON.parse(authStorage)?.state?.accessToken as string) : null;
    fetch(mediaUrl, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('Failed to load media'))))
      .then((blob) => {
        const u = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(u);
          return;
        }
        blobUrlCache.set(key, u);
        setUrl(u);
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
      setUrl(null);
    };
  }, [mediaUrl]);
  return url;
}

function MessageContent({
  msg,
  isOutbound,
  bdAccountId,
  channelId,
  onOpenMedia,
}: {
  msg: Message;
  isOutbound: boolean;
  bdAccountId: string | null;
  channelId: string;
  onOpenMedia?: (url: string, type: 'image' | 'video') => void;
}) {
  const { t } = useTranslation();
  const mediaType = getMessageMediaType(msg);
  const label = mediaLabels[mediaType];
  const hasCaption = !!((msg.content ?? (msg as any).body ?? '')?.trim());
  const textCls = 'text-sm leading-relaxed whitespace-pre-wrap break-words';
  const iconCls = isOutbound ? 'text-primary-foreground/80' : 'text-muted-foreground';
  const canLoadMedia =
    bdAccountId && channelId && msg.telegram_message_id && mediaType !== 'text' && mediaType !== 'unknown';

  const mediaApiUrl = canLoadMedia
    ? getMediaProxyUrl(bdAccountId!, channelId, msg.telegram_message_id!)
    : null;
  const mediaUrl = useMediaUrl(mediaApiUrl);

  const contentText = (msg.content ?? (msg as any).body ?? '') || '';

  const textBlock = (
    <div className={textCls}>
      {contentText.trim() ? (
        <LinkifyText text={contentText} className="break-words" />
      ) : mediaType === 'text' ? '\u00A0' : null}
    </div>
  );

  if (mediaType === 'text') {
    return textBlock;
  }

  return (
    <div className="space-y-1">
      {mediaType === 'photo' && mediaUrl && (
        <button
          type="button"
          onClick={() => onOpenMedia?.(mediaUrl, 'image')}
          className="block rounded-lg overflow-hidden max-w-full min-h-[120px] text-left w-full"
        >
          <img src={mediaUrl} alt="" className="max-h-64 object-contain rounded w-full" />
        </button>
      )}
      {mediaType === 'photo' && !mediaUrl && canLoadMedia && (
        <div className="min-h-[120px] flex items-center justify-center rounded-lg bg-muted/50 max-w-[200px]">
          <Image className="w-8 h-8 text-muted-foreground animate-pulse" />
        </div>
      )}
      {mediaType === 'video' && mediaUrl && (
        <div className="relative group">
          <video src={mediaUrl} controls className="max-h-64 min-h-[120px] rounded-lg w-full" />
          <button
            type="button"
            onClick={() => onOpenMedia?.(mediaUrl, 'video')}
            className="absolute right-2 top-2 p-1.5 rounded-md bg-black/50 text-white hover:bg-black/70 transition-colors"
            title={t('messaging.openFullscreen')}
          >
            <Film className="w-4 h-4" />
          </button>
        </div>
      )}
      {mediaType === 'video' && !mediaUrl && canLoadMedia && (
        <div className="min-h-[120px] flex items-center justify-center rounded-lg bg-muted/50 max-w-[200px]">
          <Film className="w-8 h-8 text-muted-foreground animate-pulse" />
        </div>
      )}
      {(mediaType === 'voice' || mediaType === 'audio') && mediaUrl && (
        <audio src={mediaUrl} controls className="max-w-full" />
      )}
      {/* Иконка и подпись для типов без превью или когда медиа ещё не загружено (не показывать для photo/video с canLoadMedia — там уже плейсхолдер) */}
      {(!mediaUrl || mediaType === 'document' || mediaType === 'sticker') &&
        !(mediaType === 'photo' && canLoadMedia) &&
        !(mediaType === 'video' && canLoadMedia) && (
        <div className={`flex items-center gap-2 ${iconCls}`}>
          {mediaType === 'photo' && <Image className="w-4 h-4 shrink-0" />}
          {(mediaType === 'voice' || mediaType === 'audio') && !mediaUrl && <Music className="w-4 h-4 shrink-0" />}
          {mediaType === 'video' && !mediaUrl && <Film className="w-4 h-4 shrink-0" />}
          {(mediaType === 'document' || mediaType === 'unknown') && <File className="w-4 h-4 shrink-0" />}
          {mediaType === 'sticker' && mediaUrl && (
            <img src={mediaUrl} alt="" className="max-h-24 object-contain" />
          )}
          {mediaType === 'sticker' && !mediaUrl && <Image className="w-4 h-4 shrink-0" />}
          <span className="text-xs font-medium">{label}</span>
        </div>
      )}
      {mediaType === 'document' && mediaApiUrl && (
        <DownloadLink url={mediaApiUrl} className="text-xs underline" />
      )}
      {hasCaption && textBlock}
    </div>
  );
}

export default function MessagingPage() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuthStore();
  const { on, off, subscribe, unsubscribe, isConnected } = useWebSocketContext();
  const [accounts, setAccounts] = useState<BDAccount[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadingChats, setLoadingChats] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [messagesPage, setMessagesPage] = useState(1);
  const [messagesTotal, setMessagesTotal] = useState(0);
  const [historyExhausted, setHistoryExhausted] = useState(false);
  const [accountSearch, setAccountSearch] = useState('');
  const [chatSearch, setChatSearch] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesTopSentinelRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const scrollRestoreRef = useRef<{ height: number; top: number } | null>(null);
  const hasUserScrolledUpRef = useRef(false);
  const loadOlderLastCallRef = useRef<number>(0);
  const LOAD_OLDER_COOLDOWN_MS = 2500;
  const MESSAGES_PAGE_SIZE = 50;
  const VIRTUAL_LIST_THRESHOLD = 200;
  const INITIAL_FIRST_ITEM_INDEX = 1000000;
  const [prependedCount, setPrependedCount] = useState(0);
  const virtuosoRef = useRef<any>(null);
  const virtuosoScrollAfterChatChangeRef = useRef(false);
  const hasMoreMessages = messagesPage * MESSAGES_PAGE_SIZE < messagesTotal || !historyExhausted;
  const [showCommandsMenu, setShowCommandsMenu] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [accountSyncReady, setAccountSyncReady] = useState<boolean>(true);
  const [accountSyncProgress, setAccountSyncProgress] = useState<{ done: number; total: number } | null>(null);
  const [accountSyncError, setAccountSyncError] = useState<string | null>(null);
  const [messageContextMenu, setMessageContextMenu] = useState<{ x: number; y: number; messageId: string } | null>(null);
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);
  const [folders, setFolders] = useState<SyncFolder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<number>(0); // 0 = «все чаты» (одна папка из Telegram или дефолт)
  const [folderIconPickerId, setFolderIconPickerId] = useState<string | null>(null);
  const [syncFoldersPushing, setSyncFoldersPushing] = useState(false);
  const [showFolderManageModal, setShowFolderManageModal] = useState(false);
  const FOLDER_ICON_OPTIONS = ['📁', '📂', '💬', '⭐', '🔴', '📥', '📤', '✏️'];
  const [pinnedChannelIds, setPinnedChannelIds] = useState<string[]>([]);
  const [chatContextMenu, setChatContextMenu] = useState<{ x: number; y: number; chat: Chat } | null>(null);
  const [accountContextMenu, setAccountContextMenu] = useState<{ x: number; y: number; account: BDAccount } | null>(null);
  const [showEditNameModal, setShowEditNameModal] = useState(false);
  const [editDisplayNameValue, setEditDisplayNameValue] = useState('');
  const [savingDisplayName, setSavingDisplayName] = useState(false);
  const [showChatHeaderMenu, setShowChatHeaderMenu] = useState(false);
  const chatHeaderMenuRef = useRef<HTMLDivElement>(null);
  const [mediaViewer, setMediaViewer] = useState<{ url: string; type: 'image' | 'video' } | null>(null);
  const STORAGE_KEYS = {
    accountsPanel: 'messaging.accountsPanelCollapsed',
    chatsPanel: 'messaging.chatsPanelCollapsed',
    aiPanel: 'messaging.aiPanelExpanded',
  };
  const getDraftKey = (accountId: string, chatId: string) =>
    `messaging.draft.${accountId}.${chatId}`;
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const prevChatRef = useRef<{ accountId: string; chatId: string } | null>(null);
  const newMessageRef = useRef(newMessage);
  newMessageRef.current = newMessage;

  useEffect(() => {
    const el = messageInputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(Math.max(el.scrollHeight, 40), 120)}px`;
  }, [newMessage]);

  const [accountsPanelCollapsed, setAccountsPanelCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return localStorage.getItem(STORAGE_KEYS.accountsPanel) === 'true';
    } catch { return false; }
  });
  const [chatsPanelCollapsed, setChatsPanelCollapsed] = useState(() => {
    if (typeof window === 'undefined') return false;
    try {
      return localStorage.getItem(STORAGE_KEYS.chatsPanel) === 'true';
    } catch { return false; }
  });

  const [aiPanelExpanded, setAiPanelExpanded] = useState(() => {
    if (typeof window === 'undefined') return true;
    try {
      return localStorage.getItem(STORAGE_KEYS.aiPanel) !== 'false';
    } catch { return true; }
  });

  const setAccountsCollapsed = useCallback((v: boolean) => {
    setAccountsPanelCollapsed(v);
    try { localStorage.setItem(STORAGE_KEYS.accountsPanel, String(v)); } catch {}
  }, []);
  const setChatsCollapsed = useCallback((v: boolean) => {
    setChatsPanelCollapsed(v);
    try { localStorage.setItem(STORAGE_KEYS.chatsPanel, String(v)); } catch {}
  }, []);

  const setAiPanelExpandedStored = useCallback((v: boolean) => {
    setAiPanelExpanded(v);
    try { localStorage.setItem(STORAGE_KEYS.aiPanel, String(v)); } catch {}
  }, []);

  const [chatTypeFilter, setChatTypeFilter] = useState<'all' | 'personal' | 'groups'>('all');

  useEffect(() => {
    fetchAccounts();
  }, []);

  // Проверяем статус синхронизации выбранного аккаунта. Синхронизацию не запускаем без выбора чатов — показываем CTA.
  useEffect(() => {
    const checkSync = async () => {
      if (!selectedAccountId) return;
      setAccountSyncError(null);
      setLoadingChats(true);
      try {
        const res = await apiClient.get(`/api/bd-accounts/${selectedAccountId}/sync-status`);
        const status = res.data?.sync_status;
        const total = Number(res.data?.sync_progress_total ?? 0);
        const done = Number(res.data?.sync_progress_done ?? 0);

        if (status === 'completed') {
          setAccountSyncReady(true);
          setAccountSyncProgress(null);
          await fetchChats();
        } else if (status === 'syncing') {
          setAccountSyncReady(false);
          // Сразу показываем прогресс из API (на случай если WS ещё не подключён или события уже прошли)
          setAccountSyncProgress({ done, total: total || 1 });
          try {
            await apiClient.post(`/api/bd-accounts/${selectedAccountId}/sync-start`, {}, { timeout: 20000 });
            // После sync-start повторно запрашиваем статус — бэкенд мог уже обновить прогресс
            const res2 = await apiClient.get(`/api/bd-accounts/${selectedAccountId}/sync-status`);
            if (res2.data?.sync_status === 'syncing') {
              setAccountSyncProgress({
                done: Number(res2.data?.sync_progress_done ?? 0),
                total: Number(res2.data?.sync_progress_total) || 1,
              });
            }
          } catch (e: any) {
            const msg = e?.response?.data?.error || e?.response?.data?.message || e?.message || 'Ошибка синхронизации';
            setAccountSyncError(msg === 'Network Error' || e?.code === 'ECONNABORTED'
              ? 'Сервер не ответил. Проверьте, что запущены API Gateway и сервис BD Accounts.'
              : msg);
          }
        } else {
          setAccountSyncReady(false);
          setAccountSyncProgress(null);
        }
      } catch (err: any) {
        setAccountSyncReady(false);
        setAccountSyncProgress(null);
      } finally {
        setLoadingChats(false);
      }
    };
    checkSync();
  }, [selectedAccountId]);

  // Опрос sync-status во время синхронизации: прогресс и завершение не зависят только от WebSocket
  const pollSyncStatusRef = useRef<NodeJS.Timeout | null>(null);
  useEffect(() => {
    if (accountSyncReady || !selectedAccountId) return;

    const poll = async () => {
      try {
        const res = await apiClient.get(`/api/bd-accounts/${selectedAccountId}/sync-status`);
        const status = res.data?.sync_status;
        const total = Number(res.data?.sync_progress_total ?? 0);
        const done = Number(res.data?.sync_progress_done ?? 0);

        if (status === 'completed') {
          setAccountSyncReady(true);
          setAccountSyncProgress(null);
          setAccountSyncError(null);
          await fetchChats();
          await fetchAccounts();
          return;
        }
        if (status === 'syncing') {
          setAccountSyncProgress({ done, total: total || 1 });
        }
      } catch (_) {
        // Игнорируем ошибки опроса
      }
    };

    const interval = setInterval(poll, 2000);
    pollSyncStatusRef.current = interval;

    return () => {
      if (pollSyncStatusRef.current) {
        clearInterval(pollSyncStatusRef.current);
        pollSyncStatusRef.current = null;
      }
    };
  }, [selectedAccountId, accountSyncReady]);

  // Загрузка папок при выборе аккаунта (для фильтра и «Добавить в папку»)
  useEffect(() => {
    if (!selectedAccountId) {
      setFolders([]);
      setSelectedFolderId(0);
      return;
    }
    setSelectedFolderId(0);
    apiClient.get(`/api/bd-accounts/${selectedAccountId}/sync-folders`).then((res) => {
      setFolders(Array.isArray(res.data) ? res.data : []);
    }).catch(() => setFolders([]));
  }, [selectedAccountId]);

  // Загрузка закреплённых чатов при выборе аккаунта
  useEffect(() => {
    if (!selectedAccountId) {
      setPinnedChannelIds([]);
      return;
    }
    apiClient.get('/api/messaging/pinned-chats', { params: { bdAccountId: selectedAccountId } }).then((res) => {
      const list = Array.isArray(res.data) ? res.data : [];
      setPinnedChannelIds(list.map((p: { channel_id: string }) => String(p.channel_id)));
    }).catch(() => setPinnedChannelIds([]));
  }, [selectedAccountId]);

  useEffect(() => {
    if (selectedChat && selectedAccountId) {
      setMessages([]);
      fetchMessages(selectedAccountId, selectedChat);
      markAsRead();
    } else {
      setMessages([]);
    }
  }, [selectedChat, selectedAccountId]);

  // Черновики: при смене чата сохраняем текущий текст в localStorage, подставляем черновик нового чата
  useEffect(() => {
    const prev = prevChatRef.current;
    if (prev) {
      try {
        localStorage.setItem(getDraftKey(prev.accountId, prev.chatId), newMessageRef.current);
      } catch (_) {}
    }
    if (selectedAccountId && selectedChat) {
      try {
        const draft = localStorage.getItem(getDraftKey(selectedAccountId, selectedChat.channel_id)) || '';
        setNewMessage(draft);
      } catch (_) {}
      prevChatRef.current = { accountId: selectedAccountId, chatId: selectedChat.channel_id };
    } else {
      prevChatRef.current = null;
    }
  }, [selectedAccountId, selectedChat?.channel_id]);

  // Сообщаем глобально, какой чат открыт — чтобы не играть звук уведомления, когда новое сообщение в этом же чате
  useEffect(() => {
    if (selectedAccountId && selectedChat) {
      setCurrentMessagingChat(selectedAccountId, selectedChat.channel_id);
    } else {
      setCurrentMessagingChat(null, null);
    }
    return () => setCurrentMessagingChat(null, null);
  }, [selectedAccountId, selectedChat?.channel_id]);

  // Load messages from DB only (no Telegram API for history)
  // Real-time new messages via WebSocket
  useEffect(() => {
    if (!selectedAccountId || !isConnected) return;
    subscribe(`bd-account:${selectedAccountId}`);
    // слушаем события синхронизации аккаунта
    const handler = (payload: { type?: string; data?: any }) => {
      if (!payload?.type || payload.data?.bdAccountId !== selectedAccountId) return;
      if (payload.type === 'bd_account.sync.started') {
        setAccountSyncReady(false);
        setAccountSyncProgress({ done: 0, total: payload.data?.totalChats ?? 0 });
      }
      if (payload.type === 'bd_account.sync.progress') {
        setAccountSyncReady(false);
        setAccountSyncProgress({
          done: payload.data?.done ?? 0,
          total: payload.data?.total ?? 0,
        });
      }
      if (payload.type === 'bd_account.sync.completed') {
        setAccountSyncReady(true);
        setAccountSyncProgress(null);
        setAccountSyncError(null);
        fetchChats();
        fetchAccounts(); // обновить бейдж «Готов» в списке аккаунтов
      }
      if (payload.type === 'bd_account.sync.failed') {
        setAccountSyncReady(false);
        setAccountSyncProgress(null);
        setAccountSyncError(payload.data?.error ?? 'Синхронизация не удалась');
      }
    };
    on('event', handler);
    return () => {
      off('event', handler);
      unsubscribe(`bd-account:${selectedAccountId}`);
    };
  }, [selectedAccountId, isConnected, subscribe, unsubscribe, on, off]);

  // Подписка на все аккаунты — пуши по любому аккаунту/чату
  useEffect(() => {
    if (!accounts.length || !isConnected) return;
    const accountRooms = accounts.map((a: BDAccount) => `bd-account:${a.id}`);
    accountRooms.forEach((room: string) => subscribe(room));
    const handler = (payload: { message?: any; timestamp?: string }) => {
      const msg = payload?.message;
      if (!msg?.bdAccountId) return;
      const ts = payload?.timestamp ?? new Date().toISOString();
      const contentPreview = (msg?.content && String(msg.content).trim()) ? String(msg.content).trim().slice(0, 200) : null;
      const isCurrentChat = selectedAccountId === msg.bdAccountId && selectedChat?.channel_id === String(msg.channelId);
      // Суммарный непрочитанный по аккаунту: +1 если сообщение не в открытом чате
      if (!isCurrentChat) {
        setAccounts((prev) =>
          prev.map((a) =>
            a.id === msg.bdAccountId ? { ...a, unread_count: (a.unread_count ?? 0) + 1 } : a
          )
        );
      }
      // Обновить только нужный чат в списке: превью, время, счётчик непрочитанных. Не перезагружать весь список.
      if (msg.bdAccountId === selectedAccountId && msg.channelId) {
        const isCurrentChat = selectedChat?.channel_id === String(msg.channelId);
        setChats((prev) => {
          const chatId = String(msg.channelId);
          const idx = prev.findIndex((c) => c.channel_id === chatId);
          if (idx < 0) return prev;
          const updated = prev.map((c, i) => {
            if (i !== idx) return c;
            const unread = isCurrentChat ? 0 : (c.unread_count || 0) + 1;
            return { ...c, last_message_at: ts, last_message: contentPreview ?? c.last_message, unread_count: unread };
          });
          return [...updated].sort((a, b) => {
            const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
            const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
            if (Number.isNaN(ta)) return 1;
            if (Number.isNaN(tb)) return -1;
            return tb - ta;
          });
        });
      }
      if (msg.bdAccountId === selectedAccountId && selectedChat && msg.channelId === selectedChat.channel_id) {
        setMessages((prev) => {
          const existing = prev.find((m) => m.id === msg.messageId);
          if (existing) return prev;
          return [
            ...prev,
            {
              id: msg.messageId ?? '',
              content: msg.content ?? '',
              direction: (msg.direction === 'outbound' ? 'outbound' : 'inbound') as 'inbound' | 'outbound',
              created_at: ts,
              status: 'delivered',
              contact_id: msg.contactId ?? null,
              channel: selectedChat.channel,
              channel_id: selectedChat.channel_id,
              telegram_message_id: msg.telegramMessageId ?? null,
              telegram_media: msg.telegramMedia ?? null,
              telegram_date: ts,
            },
          ];
        });
        scrollToBottom();
      }
    };
    on('new-message', handler);
    return () => {
      off('new-message', handler);
      accountRooms.forEach((room: string) => unsubscribe(room));
    };
  }, [accounts, isConnected, selectedAccountId, selectedChat, subscribe, unsubscribe, on, off]);

  useEffect(() => {
    const handler = (payload: { type?: string; data?: { messageId?: string; channelId?: string; bdAccountId?: string } }) => {
      if (payload?.type !== 'message.deleted') return;
      const d = payload.data;
      if (!d?.messageId) return;
      if (selectedChat && selectedAccountId && d.channelId === selectedChat.channel_id && d.bdAccountId === selectedAccountId) {
        setMessages((prev) => prev.filter((m) => m.id !== d.messageId));
      }
    };
    on('event', handler);
    return () => off('event', handler);
  }, [on, off, selectedChat, selectedAccountId]);

  useEffect(() => {
    if (!messageContextMenu && !chatContextMenu && !accountContextMenu) return;
    const close = () => {
      setMessageContextMenu(null);
      setChatContextMenu(null);
      setAccountContextMenu(null);
    };
    window.addEventListener('click', close, true);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', close, true);
      window.removeEventListener('scroll', close, true);
    };
  }, [messageContextMenu, chatContextMenu, accountContextMenu]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // Закрытие меню при клике вне его области
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest('.commands-menu') && !target.closest('.attach-menu')) {
        setShowCommandsMenu(false);
        setShowAttachMenu(false);
      }
      if (chatHeaderMenuRef.current && !chatHeaderMenuRef.current.contains(target)) {
        setShowChatHeaderMenu(false);
      }
    };

    if (showCommandsMenu || showAttachMenu || showChatHeaderMenu) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => {
        document.removeEventListener('mousedown', handleClickOutside);
      };
    }
  }, [showCommandsMenu, showAttachMenu, showChatHeaderMenu]);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  useEffect(() => {
    scrollToBottom();
    const t0 = setTimeout(scrollToBottom, 50);
    const t1 = setTimeout(scrollToBottom, 150);
    const t2 = setTimeout(scrollToBottom, 450);
    return () => {
      clearTimeout(t0);
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [messages, selectedChat?.channel_id, scrollToBottom]);

  const fetchAccounts = async () => {
    try {
      const response = await apiClient.get('/api/bd-accounts');
      setAccounts(response.data);
      if (response.data.length > 0 && !selectedAccountId) {
        setSelectedAccountId(response.data[0].id);
      }
    } catch (error: any) {
      console.error('Error fetching accounts:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchChats = async () => {
    if (!selectedAccountId) return;
    
    setLoadingChats(true);
    try {
      // Get chats from messaging service (these are chats with messages in DB)
      let chatsFromDB: any[] = [];
      try {
        const chatsResponse = await apiClient.get('/api/messaging/chats', {
          params: { channel: 'telegram', bdAccountId: selectedAccountId },
        });
        chatsFromDB = chatsResponse.data || [];
      } catch (chatsError: any) {
        console.warn('Could not fetch chats from messaging service:', chatsError);
        // Continue with dialogs only
      }
      
      // Chats from DB only (filtered by bdAccountId = allowed sync chats)
      const mapped: Chat[] = chatsFromDB.map((chat: any) => {
        const folderIds = Array.isArray(chat.folder_ids) ? chat.folder_ids.map((x: any) => Number(x)).filter((n: number) => !Number.isNaN(n)) : (chat.folder_id != null ? [Number(chat.folder_id)] : []);
        return {
        channel: chat.channel || 'telegram',
        channel_id: String(chat.channel_id),
        folder_id: chat.folder_id != null ? Number(chat.folder_id) : (folderIds[0] ?? null),
        folder_ids: folderIds.length > 0 ? folderIds : undefined,
        contact_id: chat.contact_id,
        first_name: chat.first_name,
        last_name: chat.last_name,
        email: chat.email,
        telegram_id: chat.telegram_id,
        display_name: chat.display_name ?? null,
        username: chat.username ?? null,
        name: chat.name || null,
        peer_type: chat.peer_type ?? null,
        unread_count: parseInt(chat.unread_count) || 0,
        last_message_at: chat.last_message_at && String(chat.last_message_at).trim() ? chat.last_message_at : '',
        last_message: chat.last_message,
      };
      });
      // Deduplicate by channel_id (API can return same chat multiple times when GROUP BY contact_id)
      const byChannelId = new Map<string, Chat>();
      const isIdOnly = (name: string | null, channelId: string) =>
        !name || name.trim() === '' || name === channelId || /^\d+$/.test(String(name).trim());
      for (const chat of mapped) {
        const existing = byChannelId.get(chat.channel_id);
        const chatTime = new Date(chat.last_message_at).getTime();
        const existingTime = existing ? new Date(existing.last_message_at).getTime() : 0;
        const preferNew =
          !existing ||
          chatTime > existingTime ||
          (chatTime === existingTime && isIdOnly(existing.name ?? existing.telegram_id ?? '', existing.channel_id) && !isIdOnly(chat.name ?? chat.telegram_id ?? '', chat.channel_id));
        if (preferNew) {
          const merged = { ...chat };
          if (existing) merged.unread_count = (existing.unread_count || 0) + (merged.unread_count || 0);
          byChannelId.set(chat.channel_id, merged);
        } else {
          existing.unread_count = (existing.unread_count || 0) + (chat.unread_count || 0);
        }
      }
      // Сверху самые новые чаты (по времени последнего сообщения)
      const formattedChats = Array.from(byChannelId.values()).sort((a, b) => {
        const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
        const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
        if (Number.isNaN(ta)) return 1;
        if (Number.isNaN(tb)) return -1;
        return tb - ta;
      });

      setChats(formattedChats);
    } catch (error: any) {
      console.error('Error fetching chats:', error);
      // Set empty array on error to show "No chats" message
      setChats([]);
    } finally {
      setLoadingChats(false);
    }
  };

  const fetchMessages = async (accountId: string, chat: Chat) => {
    setLoadingMessages(true);
    setMessagesPage(1);
    setMessagesTotal(0);
    setHistoryExhausted(false);
    try {
      const response = await apiClient.get('/api/messaging/messages', {
        params: {
          channel: chat.channel,
          channelId: chat.channel_id,
          bdAccountId: accountId,
          page: 1,
          limit: MESSAGES_PAGE_SIZE,
        },
      });
      const list = response.data.messages || [];
      setMessages(list);
      setMessagesTotal(response.data.pagination?.total ?? list.length);
      setHistoryExhausted(response.data.historyExhausted === true);
    } catch (error: any) {
      console.error('Error fetching messages:', error);
      setMessages([]);
      setMessagesTotal(0);
      setHistoryExhausted(false);
    } finally {
      setLoadingMessages(false);
    }
  };

  const loadOlderMessages = useCallback(async () => {
    if (!selectedAccountId || !selectedChat || loadingOlder || !hasMoreMessages) return;
    const scrollEl = messagesScrollRef.current;
    if (scrollEl) scrollRestoreRef.current = { height: scrollEl.scrollHeight, top: scrollEl.scrollTop };
    setLoadingOlder(true);
    const nextPage = messagesPage + 1;
    try {
      // Гибрид: догружаем одну страницу старых сообщений из Telegram в БД, затем читаем страницу из БД
      if (selectedChat.channel === 'telegram' && !historyExhausted) {
        try {
          const loadRes = await apiClient.post<{ added?: number; exhausted?: boolean }>(
            `/api/bd-accounts/${selectedAccountId}/chats/${selectedChat.channel_id}/load-older-history`
          );
          if (loadRes.data?.exhausted === true) setHistoryExhausted(true);
        } catch (_) {
          // не блокируем: дальше возьмём из БД что есть
        }
      }
      const response = await apiClient.get('/api/messaging/messages', {
        params: {
          channel: selectedChat.channel,
          channelId: selectedChat.channel_id,
          bdAccountId: selectedAccountId,
          page: nextPage,
          limit: MESSAGES_PAGE_SIZE,
        },
      });
      const list = response.data.messages || [];
      setMessages((prev) => [...list, ...prev]);
      setPrependedCount((prev) => prev + list.length);
      setMessagesPage(nextPage);
      setMessagesTotal(response.data.pagination?.total ?? messagesTotal + list.length);
      setHistoryExhausted(response.data.historyExhausted === true);
    } catch (error: any) {
      console.error('Error loading older messages:', error);
    } finally {
      setLoadingOlder(false);
    }
  }, [selectedAccountId, selectedChat, loadingOlder, hasMoreMessages, messagesPage, messagesTotal, historyExhausted]);

  // Восстановить позицию скролла после подгрузки старых сообщений (prepend), без фризов
  useEffect(() => {
    const restore = scrollRestoreRef.current;
    if (!restore || !messagesScrollRef.current) return;
    scrollRestoreRef.current = null;
    const el = messagesScrollRef.current;
    const apply = () => {
      el.scrollTop = el.scrollHeight - restore.height + restore.top;
    };
    requestAnimationFrame(() => {
      requestAnimationFrame(apply);
    });
  }, [messages.length]);

  // Сброс «пользователь скроллил вверх» и счётчика prepend при смене чата
  useEffect(() => {
    hasUserScrolledUpRef.current = false;
    setPrependedCount(0);
    virtuosoScrollAfterChatChangeRef.current = true;
  }, [selectedChat?.channel_id]);

  // Отслеживание скролла вверх — подгрузка только после явного скролла (избегаем 429)
  useEffect(() => {
    const container = messagesScrollRef.current;
    if (!container) return;
    const onScroll = () => {
      if (container.scrollTop < 150) hasUserScrolledUpRef.current = true;
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, []);

  // Подгрузка старых сообщений при скролле вверх: когда sentinel в зоне видимости (пользователь доскроллил до верха) — запрашиваем следующую страницу
  useEffect(() => {
    const sentinel = messagesTopSentinelRef.current;
    const scrollRoot = messagesScrollRef.current;
    if (!sentinel || !scrollRoot || !selectedChat || !hasMoreMessages || loadingOlder) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const [e] = entries;
        if (!e?.isIntersecting || !hasMoreMessages || loadingOlder) return;
        const now = Date.now();
        if (now - loadOlderLastCallRef.current < LOAD_OLDER_COOLDOWN_MS) return;
        loadOlderLastCallRef.current = now;
        loadOlderMessages();
      },
      { root: scrollRoot, rootMargin: '80px 0px 0px 0px', threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [selectedChat?.channel_id, hasMoreMessages, loadingOlder, loadOlderMessages]);

  const markAsRead = async () => {
    if (!selectedChat || !selectedAccountId) return;

    const chatUnread = selectedChat.unread_count ?? 0;
    try {
      await apiClient.post(
        `/api/messaging/chats/${selectedChat.channel_id}/mark-all-read?channel=${selectedChat.channel}`
      );
      setChats((prev) =>
        prev.map((chat) =>
          chat.channel_id === selectedChat.channel_id ? { ...chat, unread_count: 0 } : chat
        )
      );
      // Суммарный непрочитанный по аккаунту уменьшаем на число прочитанных в этом чате
      if (chatUnread > 0) {
        setAccounts((prev) =>
          prev.map((a) =>
            a.id === selectedAccountId
              ? { ...a, unread_count: Math.max(0, (a.unread_count ?? 0) - chatUnread) }
              : a
          )
        );
      }
    } catch (error) {
      console.warn('Error marking as read:', error);
    }
  };

  // Заглушки для новых функций
  const handleVoiceMessage = () => {
    console.log('[CRM] Voice message recording started');
    setIsRecording(true);
    // Заглушка - через 2 секунды остановим
    setTimeout(() => {
      setIsRecording(false);
      alert('Голосовое сообщение записано (заглушка)');
    }, 2000);
  };

  const handleAttachFile = (type: 'photo' | 'video' | 'file') => {
    setShowAttachMenu(false);
    fileInputRef.current?.click();
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files?.length) {
      setPendingFile(files[0]);
    }
    e.target.value = '';
  };

  const handleInsertFromScript = () => {
    console.log('[CRM] Insert from script');
    setShowCommandsMenu(false);
    const scriptMessage = 'Здравствуйте! Спасибо за интерес к нашему продукту. Как мы можем вам помочь?';
    setNewMessage(scriptMessage);
    alert('Сообщение из скрипта вставлено (заглушка)');
  };

  const handleInsertPrevious = () => {
    console.log('[CRM] Insert previous message');
    setShowCommandsMenu(false);
    if (messages.length > 0) {
      const lastOutbound = [...messages].reverse().find(m => m.direction === 'outbound');
      if (lastOutbound) {
        setNewMessage(lastOutbound.content);
        alert('Предыдущее сообщение вставлено (заглушка)');
      } else {
        alert('Нет предыдущих исходящих сообщений');
      }
    }
  };

  const handleInsertAIGenerated = () => {
    console.log('[CRM] Insert AI-generated message');
    setShowCommandsMenu(false);
    const aiMessage = 'На основе контекста беседы, предлагаю следующий ответ...';
    setNewMessage(aiMessage);
    alert('AI-сгенерированное сообщение вставлено (заглушка)');
  };

  const handleAutomation = () => {
    console.log('[CRM] Open automation');
    setShowCommandsMenu(false);
    alert('Открытие настроек автоматизации (заглушка)');
  };

  const handleCreateContact = () => {
    console.log('[CRM] Create contact');
    setShowCommandsMenu(false);
    alert('Создание контакта (заглушка)');
  };

  const handleAddTag = () => {
    console.log('[CRM] Add tag');
    setShowCommandsMenu(false);
    alert('Добавление тега к контакту (заглушка)');
  };

  const handleViewAnalytics = () => {
    console.log('[CRM] View analytics');
    setShowCommandsMenu(false);
    alert('Просмотр аналитики по контакту (заглушка)');
  };

  const handleScheduleMessage = () => {
    console.log('[CRM] Schedule message');
    setShowCommandsMenu(false);
    alert('Отложенная отправка сообщения (заглушка)');
  };

  const fileToBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
        resolve(base64 || '');
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });

  const handleSendMessage = async () => {
    if (!(newMessage.trim() || pendingFile) || !selectedChat || !selectedAccountId) return;
    if (!isSelectedAccountMine) return;

    const messageText = newMessage.trim();
    const fileToSend = pendingFile;
    setNewMessage('');
    setPendingFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
    if (selectedAccountId && selectedChat) {
      try {
        localStorage.removeItem(getDraftKey(selectedAccountId, selectedChat.channel_id));
      } catch (_) {}
    }
    setSendingMessage(true);

    const displayContent = messageText || (fileToSend ? `[Файл: ${fileToSend.name}]` : '');
    const tempMessage: Message = {
      id: `temp-${Date.now()}`,
      content: displayContent,
      direction: 'outbound',
      created_at: new Date().toISOString(),
      status: 'pending',
      contact_id: selectedChat.contact_id,
      channel: selectedChat.channel,
      channel_id: selectedChat.channel_id,
    };
    setMessages((prev) => [...prev, tempMessage]);
    scrollToBottom();

    try {
      const body: Record<string, string> = {
        contactId: selectedChat.contact_id ?? '',
        channel: selectedChat.channel,
        channelId: selectedChat.channel_id,
        content: messageText,
        bdAccountId: selectedAccountId,
      };
      if (fileToSend) {
        body.fileBase64 = await fileToBase64(fileToSend);
        body.fileName = fileToSend.name;
      }

      const response = await apiClient.post('/api/messaging/send', body);

      setMessages((prev) =>
        prev.map((msg) =>
          msg.id === tempMessage.id
            ? {
                ...msg,
                id: response.data.id,
                status: response.data.status,
                created_at: response.data.created_at,
              }
            : msg
        )
      );
      await fetchChats();
    } catch (error: any) {
      console.error('Error sending message:', error);
      setMessages((prev) => prev.filter((msg) => msg.id !== tempMessage.id));
      const status = error.response?.status;
      const data = error.response?.data;
      if (status === 413) {
        alert(data?.message || 'Файл слишком большой. Максимальный размер 2 ГБ.');
      } else {
        alert(data?.message || data?.error || 'Ошибка отправки сообщения');
      }
      if (fileToSend) {
        setPendingFile(fileToSend);
      }
    } finally {
      setSendingMessage(false);
    }
  };

  const getChatName = (chat: Chat) => {
    if (chat.display_name?.trim()) return chat.display_name.trim();
    const firstLast = `${chat.first_name || ''} ${chat.last_name || ''}`.trim();
    if (firstLast && !/^Telegram\s+\d+$/.test(firstLast)) return firstLast;
    if (chat.username) return chat.username.startsWith('@') ? chat.username : `@${chat.username}`;
    if (chat.name?.trim()) return chat.name.trim();
    if (chat.email?.trim()) return chat.email.trim();
    if (chat.telegram_id) return chat.telegram_id;
    return 'Unknown';
  };

  const openEditNameModal = () => {
    if (!selectedChat) return;
    setEditDisplayNameValue(selectedChat.display_name ?? getChatName(selectedChat) ?? '');
    setShowEditNameModal(true);
    setShowChatHeaderMenu(false);
  };

  const saveDisplayName = async () => {
    if (!selectedChat?.contact_id) return;
    setSavingDisplayName(true);
    try {
      await apiClient.patch(`/api/crm/contacts/${selectedChat.contact_id}`, {
        displayName: editDisplayNameValue.trim() || null,
      });
      const newName = editDisplayNameValue.trim() || null;
      setChats((prev) =>
        prev.map((c) =>
          c.channel_id === selectedChat.channel_id ? { ...c, display_name: newName } : c
        )
      );
      setSelectedChat((prev) => (prev ? { ...prev, display_name: newName } : null));
      setShowEditNameModal(false);
    } catch (err: any) {
      console.error('Error updating contact name:', err);
      alert(err?.response?.data?.error || 'Не удалось сохранить имя');
    } finally {
      setSavingDisplayName(false);
    }
  };

  const handleFolderIconSelect = async (folderRowId: string, emoji: string) => {
    if (!selectedAccountId) return;
    setFolderIconPickerId(null);
    try {
      const res = await apiClient.patch(
        `/api/bd-accounts/${selectedAccountId}/sync-folders/${folderRowId}`,
        { icon: emoji || null }
      );
      setFolders((prev) => prev.map((f) => (f.id === folderRowId ? { ...f, icon: res.data?.icon ?? null } : f)));
    } catch (err: any) {
      console.error('Error updating folder icon:', err);
    }
  };

  const handleChatFoldersToggle = async (chat: Chat, folderId: number) => {
    if (!selectedAccountId) return;
    const current = chatFolderIds(chat);
    const hasFolder = current.includes(folderId);
    const newIds = hasFolder ? current.filter((id) => id !== folderId) : [...current, folderId];
    try {
      await apiClient.patch(
        `/api/bd-accounts/${selectedAccountId}/chats/${chat.channel_id}/folder`,
        { folder_ids: newIds }
      );
      setChats((prev) =>
        prev.map((c) =>
          c.channel_id === chat.channel_id
            ? { ...c, folder_ids: newIds, folder_id: newIds[0] ?? null }
            : c
        )
      );
    } catch (err: any) {
      console.error('Error updating chat folders:', err);
      alert(err?.response?.data?.error || 'Не удалось изменить папки');
    }
  };

  const handleChatFoldersClear = async (chat: Chat) => {
    if (!selectedAccountId) return;
    setChatContextMenu(null);
    try {
      await apiClient.patch(
        `/api/bd-accounts/${selectedAccountId}/chats/${chat.channel_id}/folder`,
        { folder_ids: [] }
      );
      setChats((prev) =>
        prev.map((c) => (c.channel_id === chat.channel_id ? { ...c, folder_ids: [], folder_id: null } : c))
      );
    } catch (err: any) {
      console.error('Error clearing chat folders:', err);
      alert(err?.response?.data?.error || 'Не удалось убрать из папок');
    }
  };

  const handleCreateFolder = useCallback(
    async (folder_title: string, icon: string | null) => {
      if (!selectedAccountId) return null;
      const res = await apiClient.post<SyncFolder>(
        `/api/bd-accounts/${selectedAccountId}/sync-folders/custom`,
        { folder_title: folder_title.trim().slice(0, 12) || t('messaging.folderNewDefault'), icon }
      );
      return res.data ?? null;
    },
    [selectedAccountId, t]
  );

  const handleReorderFolders = useCallback(
    async (order: string[]) => {
      if (!selectedAccountId) return null;
      const res = await apiClient.patch<SyncFolder[]>(
        `/api/bd-accounts/${selectedAccountId}/sync-folders/order`,
        { order }
      );
      return Array.isArray(res.data) ? res.data : null;
    },
    [selectedAccountId]
  );

  const handleUpdateFolder = useCallback(
    async (
      folderRowId: string,
      data: { folder_title?: string; icon?: string | null }
    ) => {
      if (!selectedAccountId) return null;
      const res = await apiClient.patch<SyncFolder>(
        `/api/bd-accounts/${selectedAccountId}/sync-folders/${folderRowId}`,
        data
      );
      return res.data ?? null;
    },
    [selectedAccountId]
  );

  const handlePinChat = async (chat: Chat) => {
    if (!selectedAccountId) return;
    setChatContextMenu(null);
    try {
      await apiClient.post('/api/messaging/pinned-chats', {
        bdAccountId: selectedAccountId,
        channelId: chat.channel_id,
      });
      const res = await apiClient.get('/api/messaging/pinned-chats', { params: { bdAccountId: selectedAccountId } });
      const list = Array.isArray(res.data) ? res.data : [];
      setPinnedChannelIds(list.map((p: { channel_id: string }) => String(p.channel_id)));
    } catch (err: any) {
      console.error('Error pinning chat:', err);
      alert(err?.response?.data?.error || 'Не удалось закрепить чат');
    }
  };

  const handleUnpinChat = async (chat: Chat) => {
    if (!selectedAccountId) return;
    setChatContextMenu(null);
    try {
      await apiClient.delete(`/api/messaging/pinned-chats/${chat.channel_id}`, {
        params: { bdAccountId: selectedAccountId },
      });
      setPinnedChannelIds((prev) => prev.filter((id) => id !== chat.channel_id));
    } catch (err: any) {
      console.error('Error unpinning chat:', err);
      alert(err?.response?.data?.error || 'Не удалось открепить чат');
    }
  };

  const handleRemoveChat = async (chat: Chat) => {
    if (!selectedAccountId) return;
    if (!window.confirm(t('messaging.deleteChatConfirm'))) return;
    setChatContextMenu(null);
    try {
      await apiClient.delete(`/api/bd-accounts/${selectedAccountId}/chats/${chat.channel_id}`);
      setChats((prev) => prev.filter((c) => c.channel_id !== chat.channel_id));
      setPinnedChannelIds((prev) => prev.filter((id) => id !== chat.channel_id));
      if (selectedChat?.channel_id === chat.channel_id) {
        setSelectedChat(null);
        setMessages([]);
      }
    } catch (err: any) {
      console.error('Error removing chat:', err);
      alert(err?.response?.data?.message || err?.response?.data?.error || t('messaging.deleteChatError'));
    }
  };

  const renderMessageRow = useCallback(
    (msg: Message, index: number) => {
      const isOutbound = msg.direction === 'outbound';
      const msgTime = msg.telegram_date ?? msg.created_at;
      const prevMsgTime = messages[index - 1]?.telegram_date ?? messages[index - 1]?.created_at;
      const showDateSeparator =
        index === 0 || new Date(msgTime).toDateString() !== new Date(prevMsgTime).toDateString();
      return (
        <div>
          {showDateSeparator && (
            <div className="flex justify-center my-4">
              <span className="text-xs text-muted-foreground bg-muted px-3 py-1 rounded-full">
                {new Date(msgTime).toLocaleDateString('ru-RU', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                })}
              </span>
            </div>
          )}
          <div
            className={`flex items-end gap-2 ${isOutbound ? 'flex-row-reverse' : 'flex-row'}`}
            onContextMenu={(e) => {
              e.preventDefault();
              setMessageContextMenu({ x: e.clientX, y: e.clientY, messageId: msg.id });
            }}
          >
            <div className={`max-w-[70%] ${isOutbound ? 'msg-bubble-out' : 'msg-bubble-in'}`}>
              <MessageContent
                msg={msg}
                isOutbound={isOutbound}
                bdAccountId={selectedAccountId ?? ''}
                channelId={selectedChat?.channel_id ?? ''}
                onOpenMedia={setMediaViewer}
              />
              <div
                className={`text-xs mt-1 flex items-center gap-1 ${
                  isOutbound ? 'text-primary-foreground/80 justify-end' : 'text-muted-foreground justify-start'
                }`}
              >
                <span>{formatTime(msgTime)}</span>
                {isOutbound &&
                  (msg.status === 'read' || msg.status === 'delivered' ? (
                    <CheckCheck className="w-3.5 h-3.5 text-primary-foreground ml-1" />
                  ) : msg.status === 'sent' ? (
                    <Check className="w-3.5 h-3.5 text-primary-foreground/80 ml-1" />
                  ) : null)}
              </div>
              {msg.reactions && Object.keys(msg.reactions).length > 0 && (
                <div className={`flex flex-wrap gap-1 mt-1 ${isOutbound ? 'justify-end' : 'justify-start'}`}>
                  {Object.entries(msg.reactions).map(([emoji, count]) => (
                    <span key={emoji} className="text-xs bg-muted/80 rounded px-1.5 py-0.5" title={t('messaging.reactionCount', { count })}>
                      {emoji} {count > 1 ? count : ''}
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      );
    },
    [messages, selectedAccountId, selectedChat, setMediaViewer, t]
  );

  useEffect(() => {
    if (messages.length <= VIRTUAL_LIST_THRESHOLD || messages.length === 0 || !virtuosoScrollAfterChatChangeRef.current) return;
    virtuosoScrollAfterChatChangeRef.current = false;
    virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, align: 'end', behavior: 'auto' });
  }, [selectedChat?.channel_id, messages.length]);

  const REACTION_EMOJI = ['👍', '❤️', '🔥', '👏', '😄', '😮', '😢', '🙏', '👎'];
  const handleReaction = async (messageId: string, emoji: string) => {
    setMessageContextMenu(null);
    try {
      const res = await apiClient.patch<Message>(`/api/messaging/messages/${messageId}/reaction`, { emoji });
      setMessages((prev) => prev.map((m) => (m.id === messageId ? { ...m, reactions: res.data.reactions ?? m.reactions } : m)));
    } catch (err: any) {
      console.error('Error adding reaction:', err);
      alert(err?.response?.data?.error || t('messaging.reactionError'));
    }
  };

  const handleDeleteMessage = async (messageId: string) => {
    setDeletingMessageId(messageId);
    setMessageContextMenu(null);
    try {
      await apiClient.delete(`/api/messaging/messages/${messageId}`);
      setMessages((prev) => prev.filter((m) => m.id !== messageId));
    } catch (err: any) {
      console.error('Error deleting message:', err);
      alert(err?.response?.data?.message || err?.response?.data?.error || 'Не удалось удалить сообщение');
    } finally {
      setDeletingMessageId(null);
    }
  };

  const formatTime = (dateString: string) => {
    if (!dateString || !dateString.trim() || isNaN(new Date(dateString).getTime())) return '—';
    const date = new Date(dateString);
    const now = new Date();
    const diff = now.getTime() - date.getTime();
    const minutes = Math.floor(diff / (1000 * 60));
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);

    // Show time for today
    if (days === 0) {
      // If less than 1 minute ago, show "только что"
      if (minutes < 1) {
        return 'только что';
      }
      // If less than 1 hour ago, show minutes
      if (hours === 0) {
        return `${minutes} мин. назад`;
      }
      return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } else if (days === 1) {
      return 'Вчера ' + date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
    } else if (days < 7) {
      return date.toLocaleDateString('ru-RU', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    } else {
      return date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined });
    }
  };

  const filteredAccounts = accounts.filter((account) => {
    const q = accountSearch.toLowerCase().trim();
    if (!q) return true;
    const name = getAccountDisplayName(account).toLowerCase();
    const phone = (account.phone_number ?? '').toLowerCase();
    const username = (account.username ?? '').toLowerCase();
    const tgId = (account.telegram_id ?? '').toLowerCase();
    return name.includes(q) || phone.includes(q) || username.includes(q) || tgId.includes(q);
  });
  const selectedAccount = selectedAccountId ? accounts.find((a) => a.id === selectedAccountId) : null;
  const isSelectedAccountMine = selectedAccount?.is_owner === true;

  // Счётчики непрочитанных по папкам (для бейджей на кнопках папок)
  const chatFolderIds = useCallback((c: Chat) => (c.folder_ids && c.folder_ids.length > 0 ? c.folder_ids : (c.folder_id != null ? [Number(c.folder_id)] : [])), []);

  const unreadByFolder = useMemo(() => {
    const all = chats.reduce((s, c) => s + (c.unread_count || 0), 0);
    const byId: Record<number, number> = {};
    folders.forEach((f) => {
      const fid = f.folder_id;
      byId[fid] = fid === 0 ? all : chats
        .filter((c) => chatFolderIds(c).includes(fid))
        .reduce((s, c) => s + (c.unread_count || 0), 0);
    });
    byId[0] = all; // папка 0 «все чаты» — всегда сумма по всем
    return { all, byId };
  }, [chats, folders, chatFolderIds]);

  // Одна папка «все чаты»: из Telegram (folder_id 0) или дефолт. Без дублирования All и Все чаты.
  const displayFolders = useMemo(() => {
    const hasZero = folders.some((f) => f.folder_id === 0);
    const zero: SyncFolder = hasZero
      ? folders.find((f) => f.folder_id === 0)!
      : { id: '0', folder_id: 0, folder_title: t('messaging.folderAll'), order_index: -1, icon: '📋' };
    const rest = folders.filter((f) => f.folder_id !== 0);
    return [zero, ...rest];
  }, [folders, t]);

  const filteredChats = chats
    .filter((chat) => {
      if (selectedFolderId !== null && selectedFolderId !== 0) {
        if (!chatFolderIds(chat).includes(selectedFolderId)) return false;
      }
      return true;
    })
    .filter((chat) => {
      const name = getChatName(chat).toLowerCase();
      return name.includes(chatSearch.toLowerCase());
    })
    .filter((chat) => {
      if (chatTypeFilter === 'all') return true;
      const pt = (chat.peer_type ?? '').toLowerCase();
      if (chatTypeFilter === 'personal') return pt === 'user';
      if (chatTypeFilter === 'groups') return pt === 'chat';
      return true;
    });

  // Показ: закреплённые сверху (в порядке pin), затем остальные
  const pinnedSet = new Set(pinnedChannelIds);
  const pinnedChatsOrdered = pinnedChannelIds
    .map((id) => filteredChats.find((c) => c.channel_id === id))
    .filter((c): c is Chat => c != null);
  const unpinnedChats = filteredChats.filter((c) => !pinnedSet.has(c.channel_id));
  const displayChats = [...pinnedChatsOrdered, ...unpinnedChats];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full min-h-0 w-full rounded-lg border border-border bg-card">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  // Заполняем контейнер из layout; панели всегда на всю высоту (h-full), списки внутри — flex-1 min-h-0.
  return (
    <div className="relative flex flex-1 items-stretch h-full min-h-full w-full min-w-0 bg-card rounded-lg border border-border overflow-hidden isolate">
      {/* BD Accounts — на всю высоту; список flex-1 min-h-0 */}
      <div
        className={`h-full min-h-0 self-stretch bg-muted/40 dark:bg-muted/20 border-r border-border flex flex-col transition-[width] duration-200 shrink-0 ${accountsPanelCollapsed ? 'w-12' : 'w-64'}`}
        aria-expanded={!accountsPanelCollapsed}
      >
        {accountsPanelCollapsed ? (
          <div className="flex flex-col items-center py-2 flex-1 min-h-0 justify-start border-b border-border">
            <button
              type="button"
              onClick={() => setAccountsCollapsed(false)}
              className="p-2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground flex flex-col items-center gap-0.5 w-full"
              title={t('messaging.bdAccounts') + ' — развернуть'}
              aria-label={t('messaging.bdAccounts') + ', развернуть панель'}
            >
              <UserCircle className="w-5 h-5 shrink-0" aria-hidden />
              <ChevronRight className="w-4 h-4 shrink-0" aria-hidden />
            </button>
          </div>
        ) : (
          <>
        <div className="p-3 border-b border-border flex flex-col gap-2 shrink-0">
          <div className="flex items-center justify-between gap-2 min-h-[2rem]">
            <h3 className="font-semibold text-foreground truncate">{t('messaging.bdAccounts')}</h3>
            <button
              type="button"
              onClick={() => setAccountsCollapsed(true)}
              className="p-1.5 rounded-md text-muted-foreground hover:bg-accent shrink-0"
              title={t('messaging.collapseAccountsPanel')}
              aria-label={t('messaging.collapseAccountsPanel')}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative flex-1 min-w-0">
              <Search className="w-4 h-4 absolute left-3 top-2.5 text-muted-foreground" />
              <Input
                type="text"
                placeholder={t('common.search')}
                value={accountSearch}
                onChange={(e) => setAccountSearch(e.target.value)}
                className="pl-9 text-sm"
              />
            </div>
            <Button
              size="sm"
              onClick={() => window.location.href = '/dashboard/bd-accounts'}
              className="p-1.5 shrink-0"
              title={t('messaging.addAccount')}
            >
              <Plus className="w-4 h-4" />
            </Button>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col">
          {filteredAccounts.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground flex-1 min-h-0 flex items-center justify-center">
              {t('messaging.noAccounts')}
            </div>
          ) : (
            filteredAccounts.map((account) => (
              <div
                key={account.id}
                onClick={() => {
                  setSelectedAccountId(account.id);
                  setSelectedChat(null);
                  setMessages([]);
                }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setAccountContextMenu({ x: e.clientX, y: e.clientY, account });
                }}
                className={`p-3 cursor-pointer border-b border-border hover:bg-accent flex gap-3 ${
                  selectedAccountId === account.id
                    ? 'bg-primary/10 border-l-4 border-l-primary'
                    : ''
                }`}
              >
                <BDAccountAvatar accountId={account.id} account={account} className="w-10 h-10 shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-sm truncate">
                    {getAccountDisplayName(account)}
                  </div>
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
                  </div>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  {(account.unread_count ?? 0) > 0 && (
                    <span className="min-w-[1.25rem] h-5 px-1.5 rounded-full bg-primary text-primary-foreground text-xs flex items-center justify-center tabular-nums">
                      {account.unread_count! > 99 ? '99+' : account.unread_count}
                    </span>
                  )}
                  {account.is_active ? (
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
        )}
      </div>

      {/* Список чатов: заголовок+поиск вверху, под ними папки + список чатов */}
      <div
        className={`h-full min-h-0 self-stretch bg-card border-r border-border flex flex-col transition-[width] duration-200 shrink-0 ${chatsPanelCollapsed ? 'w-12' : 'w-[320px]'}`}
        aria-expanded={!chatsPanelCollapsed}
      >
        {chatsPanelCollapsed ? (
          <div className="flex flex-col items-center py-2 flex-1 min-h-0 justify-start border-b border-border w-12 shrink-0">
            <button
              type="button"
              onClick={() => setChatsCollapsed(false)}
              className="p-2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground flex flex-col items-center gap-0.5 w-full"
              title="Чаты — развернуть"
              aria-label="Развернуть панель чатов"
            >
              <MessageSquare className="w-5 h-5 shrink-0" aria-hidden />
              <ChevronRight className="w-4 h-4 shrink-0" aria-hidden />
            </button>
          </div>
        ) : (
          <>
          {/* Первая строка: общий заголовок «Чаты» + поиск — прижаты вверх, не растягиваются */}
          <div className="flex items-center gap-2 p-3 border-b border-border shrink-0 min-w-0 flex-none">
            <h3 className="font-semibold text-foreground truncate shrink-0">{t('messaging.chatsPanelTitle')}</h3>
            <div className="relative flex-1 min-w-0">
              <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground pointer-events-none" />
              <Input
                type="text"
                placeholder={t('messaging.searchChats')}
                value={chatSearch}
                onChange={(e) => setChatSearch(e.target.value)}
                className="pl-8 h-9 text-sm w-full"
              />
            </div>
            <button
              type="button"
              onClick={() => setChatsCollapsed(true)}
              className="p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground shrink-0"
              title={t('messaging.collapseChatsPanel')}
              aria-label={t('messaging.collapseChatsPanel')}
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
          </div>

          {/* Вторая строка: левая колонка — Sync + папки; правая — переключатель Все/Личные/Группы + список чатов. flex-1 чтобы контент занимал остаток, заголовок остаётся вверху */}
          <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
            {/* Левая колонка: кнопка Sync (на уровне переключателя типа) + папки + Edit */}
            {selectedAccountId && (
              <div className="w-14 flex-shrink-0 flex flex-col border-r border-border bg-muted/30 min-h-0">
                {/* Sync/Re-sync — на одном уровне с переключателем Все/Личные/Группы справа */}
                <div className="shrink-0 border-b border-border/50 flex items-center justify-center py-2">
                  <button
                    type="button"
                    onClick={() => window.location.href = `/dashboard/bd-accounts?accountId=${selectedAccountId}&openSelectChats=1`}
                    className="p-2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                    title={t('messaging.syncChatsTitle')}
                    aria-label={t('messaging.syncChatsTitle')}
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>
                </div>
                <div className="flex-1 min-h-0 overflow-y-auto py-1 flex flex-col">
                  {displayFolders.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => setSelectedFolderId(f.folder_id)}
                      title={f.folder_title}
                      className={`flex flex-col items-center justify-center py-2 px-1 gap-0.5 min-h-[48px] w-full rounded-none border-b border-border/30 ${
                        selectedFolderId === f.folder_id ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                      }`}
                    >
                      <span className="text-lg shrink-0">{f.icon || '📁'}</span>
                      <span className="text-[10px] font-medium truncate w-full text-center leading-tight">{f.folder_title}</span>
                      {(unreadByFolder.byId[f.folder_id] ?? 0) > 0 && (
                        <span className="min-w-[1rem] rounded-full bg-primary/20 px-1 text-[9px] tabular-nums">
                          {unreadByFolder.byId[f.folder_id]! > 99 ? '99+' : unreadByFolder.byId[f.folder_id]}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                {isSelectedAccountMine && (
                  <>
                    <button
                      type="button"
                      onClick={async () => {
                        if (!selectedAccountId) return;
                        setSyncFoldersPushing(true);
                        try {
                          const res = await apiClient.post<{ success: boolean; updated?: number; errors?: string[] }>(
                            `/api/bd-accounts/${selectedAccountId}/sync-folders-push-to-telegram`
                          );
                          if (res.data.errors?.length) {
                            alert(t('messaging.syncFoldersToTelegramDoneWithErrors', { count: res.data.updated ?? 0, errors: res.data.errors.join('\n') }));
                          } else {
                            alert(t('messaging.syncFoldersToTelegramDone', { count: res.data.updated ?? 0 }));
                          }
                        } catch (err: any) {
                          alert(err?.response?.data?.message || err?.response?.data?.error || t('messaging.syncFoldersToTelegramError'));
                        } finally {
                          setSyncFoldersPushing(false);
                        }
                      }}
                      disabled={syncFoldersPushing}
                      className="py-1.5 px-1 text-[10px] text-muted-foreground hover:text-foreground border-t border-border/50 disabled:opacity-50 truncate w-full"
                      title={t('messaging.syncFoldersToTelegram')}
                    >
                      {syncFoldersPushing ? '…' : t('messaging.syncFoldersToTelegramShort')}
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowFolderManageModal(true)}
                      className="flex flex-col items-center justify-center py-2 px-1 gap-0.5 text-muted-foreground hover:bg-accent hover:text-foreground border-t border-border"
                      title={t('messaging.folderEdit')}
                    >
                      <Pencil className="w-4 h-4 shrink-0" />
                      <span className="text-[10px] font-medium">{t('messaging.folderEdit')}</span>
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Правая колонка: переключатель Все/Личные/Группы + список чатов */}
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {/* Вторая строка: переключатель типа (на одном уровне с кнопкой Sync слева) */}
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-b border-border">
          <span className="text-xs text-muted-foreground shrink-0">Тип:</span>
          <div className="flex rounded-md border border-border p-0.5 bg-muted/50">
            {(['all', 'personal', 'groups'] as const).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setChatTypeFilter(key)}
                className={`px-2 py-1 text-xs font-medium rounded transition-colors ${
                  chatTypeFilter === key
                    ? 'bg-card text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {key === 'all' ? 'Все' : key === 'personal' ? 'Личные' : 'Группы'}
              </button>
            ))}
          </div>
        </div>

          {!accountSyncReady && (
            <div className="text-xs text-muted-foreground bg-amber-500/10 dark:bg-amber-500/20 border border-amber-500/30 rounded-md mx-3 mt-2 px-2.5 py-1.5 flex items-center gap-2 overflow-hidden shrink-0">
              {accountSyncProgress ? (
                <span className="truncate">
                  Синхронизация: {accountSyncProgress.done} / {accountSyncProgress.total}
                </span>
              ) : isSelectedAccountMine ? (
                <>
                  <span className="truncate flex-1 min-w-0">{t('messaging.selectChatsSync')}</span>
                  <button
                    type="button"
                    onClick={() => window.location.href = `/dashboard/bd-accounts?accountId=${selectedAccountId}&openSelectChats=1`}
                    className="text-primary font-medium shrink-0 hover:underline"
                  >
                    Настроить
                  </button>
                </>
              ) : (
                <span className="truncate">{t('messaging.colleagueAccountHint')}</span>
              )}
            </div>
          )}

        {/* Область списка чатов / загрузки: flex-1 min-h-0 — одна высота; лоадер в центре без дёргания при смене аккаунта */}
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col relative">
          {loadingChats ? (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <Loader2 className="w-6 h-6 animate-spin text-blue-600 shrink-0" aria-hidden />
            </div>
          ) : null}
          {!loadingChats && !accountSyncReady ? (
            <div className="p-4 flex flex-1 min-h-0 flex-col items-center justify-center text-center text-sm text-muted-foreground">
              {accountSyncProgress ? (
                <span>Ожидание завершения начальной синхронизации аккаунта…</span>
              ) : isSelectedAccountMine ? (
                <>
                  <p className="mb-3">Аккаунт ожидает настройки синхронизации.</p>
                  <Button
                    size="sm"
                    onClick={() => window.location.href = `/dashboard/bd-accounts?accountId=${selectedAccountId}&openSelectChats=1`}
                  >
                    Выбрать чаты и начать синхронизацию
                  </Button>
                </>
              ) : (
                <p>Аккаунт коллеги. Настройку синхронизации выполняет владелец.</p>
              )}
            </div>
          ) : !loadingChats && displayChats.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground flex-1 min-h-0 flex items-center justify-center">
              {t('messaging.noChats')}
            </div>
          ) : !loadingChats ? (
            displayChats.map((chat, idx) => {
              const isFirstPinned = idx === 0 && pinnedChatsOrdered.length > 0;
              const isFirstUnpinned = pinnedChatsOrdered.length > 0 && idx === pinnedChatsOrdered.length;
              return (
              <React.Fragment key={`${chat.channel}-${chat.channel_id}`}>
                {isFirstPinned && (
                  <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground bg-muted/30">
                    {t('messaging.pinnedSection')}
                  </div>
                )}
                {isFirstUnpinned && (
                  <div className="px-3 py-1.5 text-xs font-medium text-muted-foreground border-t border-border bg-muted/30">
                    {t('messaging.chatsSection')}
                  </div>
                )}
              <div
                key={`${chat.channel}-${chat.channel_id}`}
                onClick={() => setSelectedChat(chat)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!selectedAccountId) return;
                  setChatContextMenu({ x: e.clientX, y: e.clientY, chat });
                }}
                className={`p-4 cursor-pointer border-b border-border transition-colors flex gap-3 ${
                  selectedChat?.channel_id === chat.channel_id
                    ? 'bg-primary/10 dark:bg-primary/20'
                    : 'hover:bg-accent'
                }`}
              >
                <ChatAvatar
                  bdAccountId={selectedAccountId!}
                  chatId={chat.channel_id}
                  chat={chat}
                  className="w-10 h-10 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between mb-1 gap-2">
                    <div className="font-medium text-sm truncate min-w-0">
                      {getChatName(chat)}
                    </div>
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      {formatTime(chat.last_message_at)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm text-muted-foreground truncate min-w-0">
                      {chat.last_message || t('messaging.noMessages')}
                    </div>
                    {chat.unread_count > 0 && (
                      <span className="bg-primary text-primary-foreground text-xs rounded-full min-w-[1.25rem] h-5 px-1.5 flex items-center justify-center flex-shrink-0">
                        {chat.unread_count}
                      </span>
                    )}
                  </div>
                </div>
              </div>
              </React.Fragment>
              );
            })
          ) : null}
        </div>
          </div>
          </div>
        </>
        )}
      </div>

      {/* Chat Messages — центр на всю высоту; скролл только внутри панели сообщений */}
      <div className="flex-1 min-h-0 min-w-0 self-stretch h-full flex flex-col bg-background overflow-hidden">
        {selectedChat ? (
          <>
            <div className="px-4 py-3 border-b border-border bg-card/95 backdrop-blur-sm shrink-0">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold truncate">{getChatName(selectedChat)}</div>
                  {selectedChat.telegram_id && (
                    <div className="text-xs text-muted-foreground truncate">ID: {selectedChat.telegram_id}</div>
                  )}
                </div>
                <div className="relative" ref={chatHeaderMenuRef}>
                  <button
                    type="button"
                    onClick={() => setShowChatHeaderMenu((v) => !v)}
                    className="p-2 hover:bg-accent rounded"
                  >
                    <MoreVertical className="w-5 h-5" />
                  </button>
                  {showChatHeaderMenu && (
                    <div className="absolute right-0 top-full mt-1 py-1 bg-card border border-border rounded-lg shadow-lg z-10 min-w-[180px]">
                      <button
                        type="button"
                        onClick={openEditNameModal}
                        disabled={!selectedChat.contact_id}
                        className="w-full px-4 py-2 text-left text-sm hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                      >
                        <UserCircle className="w-4 h-4" />
                        {selectedChat.contact_id ? t('messaging.changeContactName') : t('messaging.noContact')}
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Модалка: кастомное имя контакта */}
            {showEditNameModal && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => !savingDisplayName && setShowEditNameModal(false)}>
                <div className="bg-card rounded-xl shadow-xl p-6 max-w-md w-full mx-4 border border-border" onClick={(e) => e.stopPropagation()}>
                  <h3 className="text-lg font-semibold mb-2 text-foreground">{t('messaging.contactName')}</h3>
                  <p className="text-sm text-muted-foreground mb-4">
                    {t('messaging.contactNameHint')}
                  </p>
                  <Input
                    value={editDisplayNameValue}
                    onChange={(e) => setEditDisplayNameValue(e.target.value)}
                    placeholder="Введите имя"
                    className="mb-4"
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setShowEditNameModal(false)} disabled={savingDisplayName}>
                      Отмена
                    </Button>
                    <Button onClick={saveDisplayName} disabled={savingDisplayName}>
                      {savingDisplayName ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Сохранить'}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesScrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden p-4 bg-muted/20 flex flex-col">
              {loadingMessages ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                  <MessageSquare className="w-12 h-12 mb-3 text-muted-foreground" />
                  <p className="text-sm">{t('messaging.noMessages')}</p>
                  <p className="text-xs mt-1 text-muted-foreground">{t('messaging.startConversation')}</p>
                </div>
              ) : messages.length > VIRTUAL_LIST_THRESHOLD ? (
                <div className="flex-1 min-h-0 flex flex-col w-full max-w-3xl mx-auto">
                  {loadingOlder && (
                    <div className="flex justify-center py-2 flex-shrink-0">
                      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                    </div>
                  )}
                  <Virtuoso
                    ref={virtuosoRef}
                    style={{ height: '100%', flex: 1 }}
                    data={messages}
                    firstItemIndex={INITIAL_FIRST_ITEM_INDEX - prependedCount}
                    startReached={() => {
                      const now = Date.now();
                      if (now - loadOlderLastCallRef.current < LOAD_OLDER_COOLDOWN_MS) return;
                      if (!hasMoreMessages || loadingOlder) return;
                      loadOlderLastCallRef.current = now;
                      loadOlderMessages();
                    }}
                    itemContent={(index, msg) => renderMessageRow(msg, index)}
                    followOutput="smooth"
                    initialTopMostItemIndex={messages.length - 1}
                    className="space-y-3"
                  />
                </div>
              ) : (
                <div className="space-y-3 w-full max-w-3xl mx-auto">
                  <div ref={messagesTopSentinelRef} className="h-2 flex-shrink-0" aria-hidden />
                  {loadingOlder && (
                    <div className="flex justify-center py-2">
                      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                    </div>
                  )}
                  {messages.map((msg, index) => (
                    <React.Fragment key={msg.id}>{renderMessageRow(msg, index)}</React.Fragment>
                  ))}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>

            {/* Context menu: chat — Pin, Add to folder, Remove */}
            <ContextMenu
              open={!!(chatContextMenu && selectedAccountId)}
              onClose={() => setChatContextMenu(null)}
              x={chatContextMenu?.x ?? 0}
              y={chatContextMenu?.y ?? 0}
              className="min-w-[180px]"
            >
              {chatContextMenu && selectedAccountId && (
                <>
                  {pinnedSet.has(chatContextMenu.chat.channel_id) ? (
                    <ContextMenuItem
                      icon={<PinOff className="w-4 h-4" />}
                      label={t('messaging.unpinChat')}
                      onClick={() => handleUnpinChat(chatContextMenu.chat)}
                    />
                  ) : (
                    <ContextMenuItem
                      icon={<Pin className="w-4 h-4" />}
                      label={t('messaging.pinChat')}
                      onClick={() => handlePinChat(chatContextMenu.chat)}
                    />
                  )}
                  <ContextMenuSection label={t('messaging.addToFolder')}>
                    <ContextMenuItem
                      label={t('messaging.folderNone')}
                      onClick={() => handleChatFoldersClear(chatContextMenu.chat)}
                    />
                    {folders.length === 0 ? (
                      <ContextMenuItem label={t('messaging.folderNoFolders')} disabled />
                    ) : (
                      folders.map((f) => {
                        const isInFolder = chatFolderIds(chatContextMenu.chat).includes(f.folder_id);
                        return (
                          <ContextMenuItem
                            key={f.id}
                            icon={isInFolder ? <Check className="w-4 h-4 text-primary" /> : undefined}
                            label={
                              <>
                                <span className="truncate flex-1">{f.folder_title}</span>
                                <span className="text-[10px] text-muted-foreground shrink-0">{f.is_user_created ? 'CRM' : 'TG'}</span>
                              </>
                            }
                            onClick={() => handleChatFoldersToggle(chatContextMenu.chat, f.folder_id)}
                          />
                        );
                      })
                    )}
                  </ContextMenuSection>
                  {isSelectedAccountMine && (
                    <>
                      <div className="border-t border-border my-1" />
                      <ContextMenuItem
                        icon={<Trash2 className="w-4 h-4" />}
                        label={t('messaging.deleteChat')}
                        destructive
                        onClick={() => handleRemoveChat(chatContextMenu.chat)}
                      />
                    </>
                  )}
                </>
              )}
            </ContextMenu>

            <FolderManageModal
              open={showFolderManageModal}
              onClose={() => setShowFolderManageModal(false)}
              folders={folders}
              onFoldersChange={setFolders}
              selectedAccountId={selectedAccountId}
              isAccountOwner={!!isSelectedAccountMine}
              onCreateFolder={handleCreateFolder}
              onReorder={handleReorderFolders}
              onUpdateFolder={handleUpdateFolder}
            />

            {/* Context menu: account — Settings (BD Accounts) */}
            <ContextMenu
              open={!!accountContextMenu}
              onClose={() => setAccountContextMenu(null)}
              x={accountContextMenu?.x ?? 0}
              y={accountContextMenu?.y ?? 0}
              className="min-w-[160px]"
            >
              {accountContextMenu && (
                <ContextMenuItem
                  icon={<Settings className="w-4 h-4" />}
                  label={t('messaging.accountSettings')}
                  onClick={() => {
                    setAccountContextMenu(null);
                    window.location.href = `/dashboard/bd-accounts?accountId=${accountContextMenu.account.id}`;
                  }}
                />
              )}
            </ContextMenu>

            {/* Context menu: message — reactions + delete */}
            <ContextMenu
              open={!!messageContextMenu}
              onClose={() => setMessageContextMenu(null)}
              x={messageContextMenu?.x ?? 0}
              y={messageContextMenu?.y ?? 0}
              className="min-w-[160px]"
            >
              {messageContextMenu && (
                <>
                  <ContextMenuSection label={t('messaging.reaction')} noTopBorder>
                    <div className="flex flex-wrap gap-1 px-2 pb-2">
                      {REACTION_EMOJI.map((emoji) => (
                        <button
                          key={emoji}
                          type="button"
                          className="p-1.5 rounded hover:bg-accent text-lg leading-none"
                          onClick={() => handleReaction(messageContextMenu.messageId, emoji)}
                          title={emoji}
                        >
                          {emoji}
                        </button>
                      ))}
                    </div>
                  </ContextMenuSection>
                  <div className="border-t border-border my-1" />
                  <ContextMenuItem
                    icon={deletingMessageId === messageContextMenu.messageId ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    label={t('messaging.deleteMessage')}
                    destructive
                    onClick={() => handleDeleteMessage(messageContextMenu.messageId)}
                    disabled={deletingMessageId === messageContextMenu.messageId}
                  />
                </>
              )}
            </ContextMenu>

            {/* Команды CRM - верхняя панель */}
            {showCommandsMenu && (
              <div className="commands-menu px-4 pt-3 pb-2 bg-muted/30 border-t border-border">
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={handleInsertFromScript}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-accent transition-colors"
                  >
                    <FileCode className="w-4 h-4 text-blue-600" />
                    <span>Из скрипта</span>
                  </button>
                  <button
                    onClick={handleInsertPrevious}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-accent transition-colors"
                  >
                    <History className="w-4 h-4 text-purple-600" />
                    <span>Предыдущее</span>
                  </button>
                  <button
                    onClick={handleInsertAIGenerated}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-accent transition-colors"
                  >
                    <Sparkles className="w-4 h-4 text-yellow-600" />
                    <span>AI-ответ</span>
                  </button>
                  <button
                    onClick={handleAutomation}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-accent transition-colors"
                  >
                    <Zap className="w-4 h-4 text-orange-600" />
                    <span>Автоматизация</span>
                  </button>
                  <button
                    onClick={handleCreateContact}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-accent transition-colors"
                  >
                    <UserCircle className="w-4 h-4 text-green-600" />
                    <span>Создать контакт</span>
                  </button>
                  <button
                    onClick={handleAddTag}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-accent transition-colors"
                  >
                    <Tag className="w-4 h-4 text-indigo-600" />
                    <span>Добавить тег</span>
                  </button>
                  <button
                    onClick={handleViewAnalytics}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-accent transition-colors"
                  >
                    <BarChart3 className="w-4 h-4 text-cyan-600" />
                    <span>Аналитика</span>
                  </button>
                  <button
                    onClick={handleScheduleMessage}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-accent transition-colors"
                  >
                    <Clock className="w-4 h-4 text-pink-600" />
                    <span>Отложить</span>
                  </button>
                  <button
                    onClick={() => setShowCommandsMenu(false)}
                    className="ml-auto p-1.5 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            <div className="p-4 bg-card border-t border-border">
              {pendingFile && (
                <div className="flex items-center gap-2 mb-2 py-1.5 px-2 rounded-lg bg-muted/60 text-sm">
                  <Paperclip className="w-4 h-4 text-muted-foreground shrink-0" />
                  <span className="truncate flex-1" title={pendingFile.name}>{pendingFile.name}</span>
                  <button
                    type="button"
                    onClick={() => { setPendingFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; }}
                    className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground"
                    title="Убрать файл"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}
              {/* Панель ввода сообщения */}
              <div className="flex items-end gap-2">
                {/* Кнопка прикрепления файлов */}
                <div className="relative attach-menu">
                  <button
                    onClick={() => setShowAttachMenu(!showAttachMenu)}
                    className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent rounded-lg transition-colors"
                    title="Прикрепить файл"
                  >
                    <Paperclip className="w-5 h-5" />
                  </button>
                  
                  {/* Выпадающее меню прикрепления */}
                  {showAttachMenu && (
                    <div className="absolute bottom-full left-0 mb-2 bg-card border border-border rounded-lg shadow-lg p-2 z-10 min-w-[180px]">
                      <button
                        onClick={() => handleAttachFile('photo')}
                        className="w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-accent rounded-lg transition-colors"
                      >
                        <Image className="w-4 h-4 text-blue-600" />
                        <span>Фото</span>
                      </button>
                      <button
                        onClick={() => handleAttachFile('video')}
                        className="w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-accent rounded-lg transition-colors"
                      >
                        <Video className="w-4 h-4 text-red-600" />
                        <span>Видео</span>
                      </button>
                      <button
                        onClick={() => handleAttachFile('file')}
                        className="w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-accent rounded-lg transition-colors"
                      >
                        <File className="w-4 h-4 text-muted-foreground" />
                        <span>Файл</span>
                      </button>
                    </div>
                  )}
                  
                  {/* Скрытый input для файлов */}
                  <input
                    ref={fileInputRef}
                    type="file"
                    className="hidden"
                    accept="image/*,video/*,.pdf,.doc,.docx,.txt,*/*"
                    onChange={handleFileSelect}
                  />
                </div>

                {/* Кнопка голосового сообщения */}
                <button
                  onClick={handleVoiceMessage}
                  className={`p-2 rounded-lg transition-colors ${
                    isRecording
                      ? 'bg-red-100 text-red-600 animate-pulse'
                      : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                  }`}
                  title="Голосовое сообщение"
                >
                  <Mic className="w-5 h-5" />
                </button>

                {/* Поле ввода как в Telegram: textarea с авто-высотой, Enter — отправить, Shift+Enter — новая строка */}
                <div className="flex-1 relative flex items-end min-h-[40px]">
                  <textarea
                    ref={messageInputRef}
                    placeholder={isSelectedAccountMine ? t('messaging.writeMessage') : t('messaging.colleagueViewOnly')}
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleSendMessage();
                      }
                    }}
                    disabled={!isSelectedAccountMine}
                    rows={1}
                    className="w-full min-h-[40px] max-h-[120px] py-2.5 px-3 pr-10 rounded-xl resize-none border border-input bg-background text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                  
                  {/* Кнопка команд CRM */}
                  <button
                    onClick={() => setShowCommandsMenu(!showCommandsMenu)}
                    className={`absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg transition-colors ${
                      showCommandsMenu
                        ? 'bg-blue-100 text-blue-600'
                        : 'text-muted-foreground hover:text-foreground hover:bg-accent'
                    }`}
                    title="Команды CRM"
                  >
                    <Bot className="w-4 h-4" />
                  </button>
                </div>

                {/* Кнопка отправки (только для своего аккаунта) */}
                <Button
                  onClick={handleSendMessage}
                  disabled={!isSelectedAccountMine || (!newMessage.trim() && !pendingFile) || sendingMessage}
                  className="px-4"
                  title={!isSelectedAccountMine ? 'Только владелец аккаунта может отправлять сообщения' : undefined}
                >
                  {sendingMessage ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <Send className="w-5 h-5" />
                  )}
                </Button>
              </div>

              {/* Индикатор записи голосового сообщения */}
              {isRecording && (
                <div className="mt-2 flex items-center gap-2 text-sm text-red-600">
                  <div className="w-2 h-2 bg-red-600 rounded-full animate-pulse"></div>
                  <span>Идет запись голосового сообщения...</span>
                  <button
                    onClick={() => setIsRecording(false)}
                    className="ml-auto text-xs text-muted-foreground hover:text-foreground"
                  >
                    Отменить
                  </button>
                </div>
              )}

              {/* Подсказка о командах */}
              {!showCommandsMenu && (
                <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                  <Bot className="w-3 h-3" />
                  <span>Нажмите на иконку бота для доступа к командам CRM</span>
                </div>
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 min-h-0 flex items-center justify-center bg-muted/20">
            <div className="text-center px-4">
              <MessageSquare className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-foreground mb-2">
                Выберите чат
              </h3>
              <p className="text-muted-foreground text-sm">
                Выберите чат из списка, чтобы начать переписку
              </p>
            </div>
          </div>
        )}
      </div>

      {/* Панель ИИ-помощника справа — на всю высоту */}
      <div
        className={`h-full min-h-0 self-stretch border-l border-border flex flex-col transition-[width] duration-200 ease-out shrink-0 bg-card ${aiPanelExpanded ? 'w-[min(24rem,90vw)]' : 'w-12'}`}
        aria-expanded={aiPanelExpanded}
      >
        {aiPanelExpanded ? (
          <>
            <div className="p-3 border-b border-border flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                  <Sparkles className="w-4 h-4 text-primary" />
                </div>
                <span className="font-semibold text-sm truncate">ИИ-помощник</span>
              </div>
              <button
                type="button"
                onClick={() => setAiPanelExpandedStored(false)}
                className="p-1.5 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground shrink-0"
                title="Свернуть панель"
                aria-label="Свернуть панель ИИ-помощника"
              >
                <ChevronRight className="w-5 h-5" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col p-3">
              <p className="text-xs text-muted-foreground mb-3">
                Команды для текущего чата (заглушка, бэкенд позже):
              </p>
              <div className="space-y-2">
                {[
                  { icon: FileText, label: 'Саммаризация чата', desc: 'Краткое содержание переписки' },
                  { icon: Send, label: 'Придумать сообщение', desc: 'ИИ предложит текст ответа' },
                  { icon: Bot, label: 'Ответить за меня', desc: 'Автоответ пока вас нет' },
                  { icon: MessageSquare, label: 'Идеи для ответа', desc: 'Несколько вариантов ответа' },
                  { icon: Zap, label: 'Тон сообщения', desc: 'Сделать текст вежливее / короче' },
                ].map(({ icon: Icon, label, desc }) => (
                  <button
                    key={label}
                    type="button"
                    className="w-full text-left p-3 rounded-lg border border-border bg-muted/30 hover:bg-muted/50 transition-colors flex gap-3 items-start"
                  >
                    <Icon className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm">{label}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">{desc}</div>
                    </div>
                  </button>
                ))}
              </div>
              <div className="mt-4 pt-4 border-t border-border">
                <p className="text-xs text-muted-foreground mb-2">Чат с помощником (заглушка):</p>
                <div className="rounded-lg border border-border bg-muted/20 p-3 min-h-[8rem] text-sm text-muted-foreground">
                  Здесь будет диалог в стиле ChatGPT/Claude — ввод запроса и ответы ИИ. Пока без бэкенда.
                </div>
                <Input
                  placeholder="Спросить помощника..."
                  className="mt-2 text-sm"
                  disabled
                  readOnly
                />
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-col items-center py-3 flex-1 min-h-0 justify-start border-b border-transparent">
            <button
              type="button"
              onClick={() => setAiPanelExpandedStored(true)}
              className="p-2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground flex flex-col items-center gap-0.5 w-full"
              title="ИИ-помощник — развернуть"
              aria-label="Развернуть панель ИИ-помощника"
            >
              <Sparkles className="w-5 h-5 shrink-0" aria-hidden />
              <ChevronLeft className="w-4 h-4 shrink-0" aria-hidden />
            </button>
          </div>
        )}
      </div>
      {mediaViewer && (
        <MediaViewer
          url={mediaViewer.url}
          type={mediaViewer.type}
          onClose={() => setMediaViewer(null)}
        />
      )}
    </div>
  );
}
