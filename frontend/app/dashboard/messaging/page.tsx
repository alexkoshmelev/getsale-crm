'use client';

import { useEffect, useState, useRef, useCallback } from 'react';
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
  Music, Film, Users
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import AIAssistantWidget from '@/components/ai/AIAssistantWidget';
import AIAssistantWindow from '@/components/ai/AIAssistantWindow';

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
  is_owner?: boolean; // текущий пользователь — владелец (может управлять аккаунтом)
}

interface Chat {
  channel: string;
  channel_id: string;
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
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!bdAccountId || !chatId) return;
    mounted.current = true;
    apiClient
      .get(`/api/bd-accounts/${bdAccountId}/chats/${chatId}/avatar`, { responseType: 'blob' })
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
  }, [bdAccountId, chatId]);

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

/** Загружает медиа с токеном и отдаёт blob URL для img/video/audio (браузер не шлёт Authorization в src). */
function useMediaUrl(mediaUrl: string | null) {
  const [url, setUrl] = useState<string | null>(null);
  const blobRef = useRef<string | null>(null);
  useEffect(() => {
    if (!mediaUrl) {
      setUrl(null);
      return;
    }
    let cancelled = false;
    const authStorage = typeof window !== 'undefined' ? localStorage.getItem('auth-storage') : null;
    const token = authStorage ? (JSON.parse(authStorage)?.state?.accessToken as string) : null;
    fetch(mediaUrl, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error('Failed to load media'))))
      .then((blob) => {
        if (!cancelled) {
          if (blobRef.current) URL.revokeObjectURL(blobRef.current);
          blobRef.current = URL.createObjectURL(blob);
          setUrl(blobRef.current);
        }
      })
      .catch(() => {
        if (!cancelled) setUrl(null);
      });
    return () => {
      cancelled = true;
      if (blobRef.current) {
        URL.revokeObjectURL(blobRef.current);
        blobRef.current = null;
      }
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
}: {
  msg: Message;
  isOutbound: boolean;
  bdAccountId: string | null;
  channelId: string;
}) {
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

  // Текст: content из API (БД); fallback на body на случай другого имени поля
  const contentText = (msg.content ?? (msg as any).body ?? '') || '';

  const textBlock = (
    <div className={textCls}>
      {contentText.trim() ? contentText : mediaType === 'text' ? '\u00A0' : null}
    </div>
  );

  if (mediaType === 'text') {
    return textBlock;
  }

  return (
    <div className="space-y-1">
      {/* Медиа: фото / видео / аудио через прокси Telegram */}
      {mediaType === 'photo' && mediaUrl && (
        <a href={mediaUrl} target="_blank" rel="noopener noreferrer" className="block rounded-lg overflow-hidden max-w-full">
          <img src={mediaUrl} alt="" className="max-h-64 object-contain rounded" />
        </a>
      )}
      {mediaType === 'video' && mediaUrl && (
        <video src={mediaUrl} controls className="max-h-64 rounded-lg" />
      )}
      {(mediaType === 'voice' || mediaType === 'audio') && mediaUrl && (
        <audio src={mediaUrl} controls className="max-w-full" />
      )}
      {/* Если медиа не загружается по URL (нет telegram_message_id) — показываем иконку и подпись */}
      {(!mediaUrl || mediaType === 'document' || mediaType === 'sticker') && (
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
  const hasMoreMessages = messagesPage * MESSAGES_PAGE_SIZE < messagesTotal || !historyExhausted;
  const [showCommandsMenu, setShowCommandsMenu] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showAIAssistant, setShowAIAssistant] = useState(false);
  const [accountSyncReady, setAccountSyncReady] = useState<boolean>(true);
  const [accountSyncProgress, setAccountSyncProgress] = useState<{ done: number; total: number } | null>(null);
  const [accountSyncError, setAccountSyncError] = useState<string | null>(null);
  const [showEditNameModal, setShowEditNameModal] = useState(false);
  const [editDisplayNameValue, setEditDisplayNameValue] = useState('');
  const [savingDisplayName, setSavingDisplayName] = useState(false);
  const [showChatHeaderMenu, setShowChatHeaderMenu] = useState(false);
  const chatHeaderMenuRef = useRef<HTMLDivElement>(null);
  const STORAGE_KEYS = { accountsPanel: 'messaging.accountsPanelCollapsed', chatsPanel: 'messaging.chatsPanelCollapsed' };

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

  const setAccountsCollapsed = useCallback((v: boolean) => {
    setAccountsPanelCollapsed(v);
    try { localStorage.setItem(STORAGE_KEYS.accountsPanel, String(v)); } catch {}
  }, []);
  const setChatsCollapsed = useCallback((v: boolean) => {
    setChatsPanelCollapsed(v);
    try { localStorage.setItem(STORAGE_KEYS.chatsPanel, String(v)); } catch {}
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

  useEffect(() => {
    if (selectedChat && selectedAccountId) {
      setMessages([]);
      fetchMessages(selectedAccountId, selectedChat);
      markAsRead();
    } else {
      setMessages([]);
    }
  }, [selectedChat, selectedAccountId]);

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
  const { subscribe, unsubscribe, on, off, isConnected } = useWebSocketContext();
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
      if (msg.bdAccountId === selectedAccountId) fetchChats();
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
              created_at: payload?.timestamp ?? new Date().toISOString(),
              status: 'delivered',
              contact_id: msg.contactId ?? null,
              channel: selectedChat.channel,
              channel_id: selectedChat.channel_id,
              telegram_message_id: msg.telegramMessageId ?? null,
              telegram_media: msg.telegramMedia ?? null,
              telegram_date: payload?.timestamp ?? null,
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

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

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
      const mapped: Chat[] = chatsFromDB.map((chat: any) => ({
        channel: chat.channel || 'telegram',
        channel_id: String(chat.channel_id),
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
        last_message_at: chat.last_message_at || new Date().toISOString(),
        last_message: chat.last_message,
      }));
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
      const formattedChats = Array.from(byChannelId.values()).sort(
        (a, b) => new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime()
      );

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
      setMessagesPage(nextPage);
      setMessagesTotal(response.data.pagination?.total ?? messagesTotal + list.length);
      setHistoryExhausted(response.data.historyExhausted === true);
    } catch (error: any) {
      console.error('Error loading older messages:', error);
    } finally {
      setLoadingOlder(false);
    }
  }, [selectedAccountId, selectedChat, loadingOlder, hasMoreMessages, messagesPage, messagesTotal]);

  // Восстановить позицию скролла после подгрузки старых сообщений (prepend)
  useEffect(() => {
    const restore = scrollRestoreRef.current;
    if (!restore || !messagesScrollRef.current) return;
    scrollRestoreRef.current = null;
    const el = messagesScrollRef.current;
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight - restore.height + restore.top;
    });
  }, [messages.length]);

  // Сброс «пользователь скроллил вверх» при смене чата
  useEffect(() => {
    hasUserScrolledUpRef.current = false;
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

  // Подгрузка старых сообщений при скролле вверх (как в Telegram)
  useEffect(() => {
    const el = messagesTopSentinelRef.current;
    if (!el || !selectedChat || !hasMoreMessages || loadingOlder) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const [e] = entries;
        if (!e?.isIntersecting || !hasMoreMessages || loadingOlder) return;
        if (!hasUserScrolledUpRef.current) return;
        const now = Date.now();
        if (now - loadOlderLastCallRef.current < LOAD_OLDER_COOLDOWN_MS) return;
        loadOlderLastCallRef.current = now;
        loadOlderMessages();
      },
      { root: el.closest('.overflow-y-auto') || null, rootMargin: '80px', threshold: 0 }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [selectedChat?.channel_id, hasMoreMessages, loadingOlder, loadOlderMessages]);

  const markAsRead = async () => {
    if (!selectedChat) return;

    try {
      // Use correct endpoint: /api/messaging/chats/:chatId/mark-all-read?channel=telegram
      await apiClient.post(
        `/api/messaging/chats/${selectedChat.channel_id}/mark-all-read?channel=${selectedChat.channel}`
      );
      // Update chat unread count
      setChats((prev) =>
        prev.map((chat) =>
          chat.channel_id === selectedChat.channel_id
            ? { ...chat, unread_count: 0 }
            : chat
        )
      );
    } catch (error) {
      // Silently fail - not critical
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
    console.log(`[CRM] Attach ${type}`);
    setShowAttachMenu(false);
    fileInputRef.current?.click();
    alert(`Прикрепление ${type === 'photo' ? 'фото' : type === 'video' ? 'видео' : 'файла'} (заглушка)`);
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

  const handleSendMessage = async () => {
    if (!newMessage.trim() || !selectedChat || !selectedAccountId) return;
    if (!isSelectedAccountMine) return; // только владелец может отправлять сообщения

    const messageText = newMessage.trim();
    setNewMessage('');
    setSendingMessage(true);

    // Optimistically add message to UI
    const tempMessage: Message = {
      id: `temp-${Date.now()}`,
      content: messageText,
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
      const response = await apiClient.post('/api/messaging/send', {
        contactId: selectedChat.contact_id,
        channel: selectedChat.channel,
        channelId: selectedChat.channel_id,
        content: messageText,
        bdAccountId: selectedAccountId,
      });

      // Replace temp message with real one
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

      // Refresh chats to update last message
      await fetchChats();
    } catch (error: any) {
      // "A listener indicated an asynchronous response..." — от расширения Chrome, не от приложения
      console.error('Error sending message:', error);
      // Remove temp message on error
      setMessages((prev) => prev.filter((msg) => msg.id !== tempMessage.id));
      alert(error.response?.data?.error || 'Ошибка отправки сообщения');
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

  const formatTime = (dateString: string) => {
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

  const filteredAccounts = accounts.filter((account) =>
    account.phone_number?.toLowerCase().includes(accountSearch.toLowerCase()) ||
    account.telegram_id?.toLowerCase().includes(accountSearch.toLowerCase())
  );
  const selectedAccount = selectedAccountId ? accounts.find((a) => a.id === selectedAccountId) : null;
  const isSelectedAccountMine = selectedAccount?.is_owner === true;

  const filteredChats = chats
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[calc(100vh-6.5rem)] min-h-0">
        <Loader2 className="w-8 h-8 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="relative flex h-[calc(100vh-6.5rem)] min-h-0 bg-card -m-6 rounded-lg border border-border overflow-hidden">
      {/* BD Accounts Sidebar — collapse/expand: в свёрнутом виде узкая полоска с кнопкой «Развернуть» */}
      <div
        className={`min-h-0 bg-muted/50 border-r border-border flex flex-col transition-[width] duration-200 shrink-0 ${accountsPanelCollapsed ? 'w-12' : 'w-64'}`}
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
        <div className="p-4 border-b border-border flex items-center justify-between shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold text-foreground">{t('messaging.bdAccounts')}</h3>
              <Button
                size="sm"
                onClick={() => window.location.href = '/dashboard/bd-accounts'}
                className="p-1"
              >
                <Plus className="w-4 h-4" />
              </Button>
            </div>
            <div className="relative">
              <Search className="w-4 h-4 absolute left-3 top-2.5 text-muted-foreground" />
              <Input
                type="text"
                placeholder={t('common.search')}
                value={accountSearch}
                onChange={(e) => setAccountSearch(e.target.value)}
                className="pl-9 text-sm"
              />
            </div>
          </div>
          <button
            type="button"
            onClick={() => setAccountsCollapsed(true)}
            className="p-1.5 rounded-md text-muted-foreground hover:bg-accent shrink-0"
            title="Свернуть панель аккаунтов"
            aria-label="Свернуть панель аккаунтов"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {filteredAccounts.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
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
                className={`p-3 cursor-pointer border-b border-border hover:bg-accent ${
                  selectedAccountId === account.id
                    ? 'bg-primary/10 border-l-4 border-l-primary'
                    : ''
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="font-medium text-sm truncate">
                      {account.phone_number || account.telegram_id || 'Unknown'}
                    </div>
                    <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
                      <span className="text-xs text-muted-foreground">Telegram</span>
                      {account.is_owner ? (
                        <span className="text-xs text-primary font-medium">{t('messaging.yourAccount')}</span>
                      ) : (
                        <span className="text-xs text-muted-foreground">{t('messaging.colleague')}</span>
                      )}
                      {account.sync_status === 'completed' ? (
                        <span className="text-xs text-green-600 dark:text-green-400 font-medium">{t('messaging.ready')}</span>
                      ) : (
                        <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">{t('messaging.syncing')}</span>
                      )}
                    </div>
                  </div>
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

      {/* Chats List — collapse/expand: в свёрнутом виде узкая полоска с кнопкой «Развернуть» */}
      <div
        className={`min-h-0 bg-card border-r border-border flex flex-col transition-[width] duration-200 shrink-0 ${chatsPanelCollapsed ? 'w-12' : 'w-80'}`}
        aria-expanded={!chatsPanelCollapsed}
      >
        {chatsPanelCollapsed ? (
          <div className="flex flex-col items-center py-2 flex-1 min-h-0 justify-start border-b border-border">
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
        <div className="p-4 border-b border-border flex items-center justify-between gap-2 shrink-0">
          <div className="flex-1 space-y-2 min-w-0">
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-2.5 text-muted-foreground" />
            <Input
              type="text"
              placeholder={t('messaging.searchChats')}
              value={chatSearch}
              onChange={(e) => setChatSearch(e.target.value)}
              className="pl-9 text-sm"
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs text-muted-foreground">Тип:</span>
            <div className="flex rounded-lg border border-border p-0.5 bg-muted/50">
              {(['all', 'personal', 'groups'] as const).map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setChatTypeFilter(key)}
                  className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
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
            <div className="text-xs text-muted-foreground bg-amber-500/10 dark:bg-amber-500/20 border border-amber-500/30 dark:border-amber-500/40 rounded-md px-3 py-2 space-y-2">
              {accountSyncProgress ? (
                `Идёт начальная синхронизация аккаунта (${accountSyncProgress.done} / ${accountSyncProgress.total} чатов)…`
              ) : isSelectedAccountMine ? (
                <>
                  <p className="font-medium text-foreground">Чтобы начать работу с этим аккаунтом:</p>
                  <p className="text-muted-foreground">{t('messaging.selectChatsSync')}</p>
                  {accountSyncError && <div className="text-destructive">{accountSyncError}</div>}
                  <div className="flex gap-2 flex-wrap">
                    <Button
                      size="sm"
                      onClick={() => window.location.href = `/dashboard/bd-accounts?accountId=${selectedAccountId}&openSelectChats=1`}
                    >
                      Выбрать чаты и начать синхронизацию
                    </Button>
                    {accountSyncError && (
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => window.location.href = '/dashboard/bd-accounts'}
                      >
                        Настроить в BD Аккаунтах
                      </Button>
                    )}
                  </div>
                </>
              ) : (
                <p className="text-muted-foreground">{t('messaging.colleagueAccountHint')}</p>
              )}
            </div>
          )}
          {accountSyncReady && isSelectedAccountMine && selectedAccountId && (
            <div className="text-xs">
              <Button
                variant="outline"
                size="sm"
                onClick={() => window.location.href = `/dashboard/bd-accounts?accountId=${selectedAccountId}&openSelectChats=1`}
              >
                Изменить список чатов / догрузить историю
              </Button>
            </div>
          )}
          </div>
          <button
            type="button"
            onClick={() => setChatsCollapsed(true)}
            className="p-1.5 rounded-md text-muted-foreground hover:bg-accent shrink-0"
            title="Свернуть панель чатов"
            aria-label="Свернуть панель чатов"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          {loadingChats ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
            </div>
          ) : !accountSyncReady ? (
            <div className="p-4 flex flex-col items-center justify-center text-center text-sm text-muted-foreground">
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
          ) : filteredChats.length === 0 ? (
            <div className="p-4 text-center text-sm text-muted-foreground">
              {t('messaging.noChats')}
            </div>
          ) : (
            filteredChats.map((chat) => (
              <div
                key={`${chat.channel}-${chat.channel_id}`}
                onClick={() => setSelectedChat(chat)}
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
            ))
          )}
        </div>
        </>
        )}
      </div>

      {/* Chat Messages */}
      <div className="flex-1 min-h-0 flex flex-col">
        {selectedChat ? (
          <>
            <div className="p-4 border-b border-border bg-card">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold">{getChatName(selectedChat)}</div>
                  <div className="text-sm text-muted-foreground">
                    {selectedChat.telegram_id && `Telegram ID: ${selectedChat.telegram_id}`}
                  </div>
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

            <div ref={messagesScrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 bg-muted/30">
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
              ) : (
                <div className="space-y-3">
                  <div ref={messagesTopSentinelRef} className="h-2 flex-shrink-0" aria-hidden />
                  {loadingOlder && (
                    <div className="flex justify-center py-2">
                      <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                    </div>
                  )}
                  {messages.map((msg, index) => {
                    const isOutbound = msg.direction === 'outbound';
                    const msgTime = msg.telegram_date ?? msg.created_at;
                    const prevMsgTime = messages[index - 1]?.telegram_date ?? messages[index - 1]?.created_at;
                    const showDateSeparator =
                      index === 0 ||
                      new Date(msgTime).toDateString() !== new Date(prevMsgTime).toDateString();
                    
                    return (
                      <div key={msg.id}>
                        {showDateSeparator && (
                          <div className="flex justify-center my-4">
                            <span className="text-xs text-muted-foreground bg-muted px-3 py-1 rounded-full">
                              {new Date(msgTime).toLocaleDateString('ru-RU', {
                                day: 'numeric',
                                month: 'long',
                                year: 'numeric'
                              })}
                            </span>
                          </div>
                        )}
                        <div
                          className={`flex items-end gap-2 ${
                            isOutbound ? 'flex-row-reverse' : 'flex-row'
                          }`}
                        >
                          <div
                            className={`max-w-[70%] rounded-2xl px-4 py-2 ${
                              isOutbound
                                ? 'bg-blue-500 text-white rounded-br-md'
                                : 'bg-card text-foreground rounded-bl-md shadow-sm border border-border'
                            }`}
                          >
                            <MessageContent
                                msg={msg}
                                isOutbound={isOutbound}
                                bdAccountId={selectedAccountId}
                                channelId={selectedChat.channel_id}
                              />
                            <div
                              className={`text-xs mt-1 flex items-center gap-1 ${
                                isOutbound
                                  ? 'text-blue-100 justify-end'
                                  : 'text-muted-foreground justify-start'
                              }`}
                            >
                              <span>{formatTime(msgTime)}</span>
                              {isOutbound && (
                                <span className="ml-1">
                                  {msg.status === 'delivered' ? '✓✓' : 
                                   msg.status === 'sent' ? '✓' : ''}
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })}
                  <div ref={messagesEndRef} />
                </div>
              )}
            </div>

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
                    accept="image/*,video/*,.pdf,.doc,.docx,.txt"
                    multiple
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

                {/* Поле ввода (только для своего аккаунта) */}
                <div className="flex-1 relative">
                  <div className="w-full">
                    <Input
                      type="text"
                      placeholder={isSelectedAccountMine ? t('messaging.writeMessage') : t('messaging.colleagueViewOnly')}
                      value={newMessage}
                      onChange={(e) => setNewMessage(e.target.value)}
                      onKeyPress={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault();
                          handleSendMessage();
                        }
                      }}
                      className="pr-10"
                      disabled={!isSelectedAccountMine}
                    />
                  </div>
                  
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
                  disabled={!isSelectedAccountMine || !newMessage.trim() || sendingMessage}
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
          <div className="flex-1 flex items-center justify-center bg-muted/30">
            <div className="text-center">
              <MessageSquare className="w-16 h-16 text-muted-foreground mx-auto mb-4" />
              <h3 className="text-lg font-semibold text-foreground mb-2">
                Выберите чат
              </h3>
              <p className="text-muted-foreground">
                Выберите чат из списка, чтобы начать переписку
              </p>
            </div>
          </div>
        )}
      </div>

      {/* AI Assistant Widget */}
      <AIAssistantWidget onOpen={() => setShowAIAssistant(true)} />

      {/* AI Assistant Window */}
      <AIAssistantWindow
        isOpen={showAIAssistant}
        onClose={() => setShowAIAssistant(false)}
        selectedChat={selectedChat ? {
          name: selectedChat.name,
          channel_id: selectedChat.channel_id,
          first_name: selectedChat.first_name,
          last_name: selectedChat.last_name,
        } : null}
      />
    </div>
  );
}
