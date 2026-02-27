'use client';

import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
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
  Music, Film, Users, Check, CheckCheck, RefreshCw, Pin, PinOff, Smile, Pencil,
  Reply, Forward, Copy, Heart, Filter, Inbox
} from 'lucide-react';
import Button from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { ContextMenu, ContextMenuSection, ContextMenuItem } from '@/components/ui/ContextMenu';
import { Virtuoso } from 'react-virtuoso';
import { LinkifyText } from '@/components/messaging/LinkifyText';
import { LinkPreview, extractFirstUrl } from '@/components/messaging/LinkPreview';
import { MediaViewer } from '@/components/messaging/MediaViewer';
import { FolderManageModal } from '@/components/messaging/FolderManageModal';
import { AddToFunnelModal } from '@/components/crm/AddToFunnelModal';
import { EmptyState } from '@/components/ui/EmptyState';
import { Modal } from '@/components/ui/Modal';
import { fetchGroupSources, type GroupSource } from '@/lib/api/campaigns';
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
  /** Демо-аккаунт: только данные в БД, отправка отключена */
  is_demo?: boolean;
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
  /** PHASE 2.1: контракт §11а — только отображение, без derived state */
  conversation_id?: string | null;
  lead_id?: string | null;
  lead_stage_name?: string | null;
  lead_pipeline_name?: string | null;
  /** PHASE 2.3: для элементов из new-leads (могут быть с разных аккаунтов) */
  bd_account_id?: string | null;
}

/** PHASE 2.2 — контракт GET /api/messaging/conversations/:id/lead-context. PHASE 2.5–2.7: shared, won, lost. */
interface LeadContext {
  conversation_id: string;
  lead_id: string;
  contact_name: string;
  contact_telegram_id?: string | null;
  contact_username?: string | null;
  bd_account_id?: string | null;
  channel_id?: string | null;
  pipeline: { id: string; name: string };
  stage: { id: string; name: string };
  stages: Array<{ id: string; name: string }>;
  campaign: { id: string; name: string } | null;
  became_lead_at: string;
  shared_chat_created_at?: string | null;
  shared_chat_channel_id?: string | null;
  shared_chat_settings?: { titleTemplate: string; extraUsernames: string[] };
  won_at?: string | null;
  revenue_amount?: number | null;
  lost_at?: string | null;
  loss_reason?: string | null;
  timeline: Array<{ type: string; created_at: string; stage_name?: string }>;
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
  reply_to_telegram_id?: string | null; // id сообщения в Telegram, на которое ответили
  telegram_media?: Record<string, unknown> | null;
  telegram_entities?: Array<Record<string, unknown>> | null;
  telegram_date?: string | null;  // оригинальное время отправки в Telegram
  telegram_extra?: Record<string, unknown> | null;  // fwd_from, reactions, views и т.д.
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

const MEDIA_TYPE_I18N_KEYS: Record<MessageMediaType, string> = {
  text: '',
  photo: 'photo',
  voice: 'mediaVoice',
  audio: 'mediaAudio',
  video: 'video',
  document: 'mediaDocument',
  sticker: 'mediaSticker',
  unknown: 'mediaUnknown',
};

/** Подпись «Переслано из …» из telegram_extra.fwd_from (from_name, post_author и т.д.). */
function getForwardedFromLabel(msg: Message): string | null {
  const extra = msg.telegram_extra;
  if (!extra || typeof extra !== 'object') return null;
  const fwd = extra.fwd_from as Record<string, unknown> | undefined;
  if (!fwd || typeof fwd !== 'object') return null;
  const fromName =
    (typeof (fwd.from_name ?? (fwd as any).fromName) === 'string' && (fwd.from_name ?? (fwd as any).fromName).trim())
      ? (fwd.from_name ?? (fwd as any).fromName).trim()
      : null;
  if (fromName) return fromName;
  const postAuthor =
    (typeof (fwd.post_author ?? (fwd as any).postAuthor) === 'string' && (fwd.post_author ?? (fwd as any).postAuthor).trim())
      ? (fwd.post_author ?? (fwd as any).postAuthor).trim()
      : null;
  if (postAuthor) return postAuthor;
  if (fwd.saved_from_peer || fwd.from_id || fwd.channel_post != null) return null;
  return null;
}

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

function DownloadLink({ url, className, downloadLabel = 'Download' }: { url: string; className?: string; downloadLabel?: string }) {
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
      {loading ? '…' : downloadLabel}
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
  const label = mediaType === 'text' ? '' : t('messaging.' + MEDIA_TYPE_I18N_KEYS[mediaType]);
  const rawContent = (msg.content ?? (msg as any).body ?? '') || '';
  const isFilePlaceholderOnly = /^\[(Файл|File):\s*.+\]$/i.test(rawContent.trim());
  const hasCaption = !!rawContent.trim() && !(mediaType === 'photo' && isFilePlaceholderOnly);
  const textCls = 'text-sm leading-relaxed whitespace-pre-wrap break-words';
  const iconCls = isOutbound ? 'text-primary-foreground/80' : 'text-muted-foreground';
  const canLoadMedia =
    bdAccountId && channelId && msg.telegram_message_id && mediaType !== 'text' && mediaType !== 'unknown';

  const mediaApiUrl = canLoadMedia
    ? getMediaProxyUrl(bdAccountId!, channelId, msg.telegram_message_id!)
    : null;
  const mediaUrl = useMediaUrl(mediaApiUrl);

  const contentText = hasCaption ? rawContent : '';
  const firstUrl = contentText.trim() ? extractFirstUrl(contentText) : null;

  const textBlock = (
    <div>
      <div className={textCls}>
        {contentText.trim() ? (
          <LinkifyText text={contentText} className="break-words" />
        ) : mediaType === 'text' ? '\u00A0' : null}
      </div>
      {firstUrl && <LinkPreview url={firstUrl} />}
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
        <DownloadLink url={mediaApiUrl} className="text-xs underline" downloadLabel={t('messaging.download')} />
      )}
      {hasCaption && textBlock}
    </div>
  );
}

export default function MessagingPage() {
  const { t } = useTranslation();
  const { user: currentUser } = useAuthStore();
  const searchParams = useSearchParams();
  const urlOpenAppliedRef = useRef(false);
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
  /** channel_id чата, для которого сейчас загружены messages. Нужно, чтобы Virtuoso монтировался только с правильными данными и сразу показывал низ. */
  const [lastLoadedChannelId, setLastLoadedChannelId] = useState<string | null>(null);
  const [accountSearch, setAccountSearch] = useState('');
  const [chatSearch, setChatSearch] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesTopSentinelRef = useRef<HTMLDivElement>(null);
  const messagesScrollRef = useRef<HTMLDivElement>(null);
  const scrollRestoreRef = useRef<{ height: number; top: number } | null>(null);
  const hasUserScrolledUpRef = useRef(false);
  const loadOlderLastCallRef = useRef<number>(0);
  const skipScrollToBottomAfterPrependRef = useRef(false);
  /** Для обычного списка: пользователь у нижнего края — новые сообщения показываем внизу без принудительного скролла вверх */
  const isAtBottomRef = useRef(true);
  const scrollToBottomRef = useRef<() => void>(() => {});
  const LOAD_OLDER_COOLDOWN_MS = 2500;
  const MESSAGES_PAGE_SIZE = 50;
  /** Два режима списка сообщений: до 200 — обычный div + map, свыше 200 — Virtuoso (виртуализация). Оба при открытии чата показывают низ без анимации (behavior: 'auto'). */
  const VIRTUAL_LIST_THRESHOLD = 200;
  const INITIAL_FIRST_ITEM_INDEX = 1000000;
  const MAX_CACHED_CHATS = 30;
  const [prependedCount, setPrependedCount] = useState(0);
  const virtuosoRef = useRef<any>(null);
  /** Показывать кнопку «вниз», когда пользователь проскроллил вверх (не у последнего сообщения). */
  const [showScrollToBottomButton, setShowScrollToBottomButton] = useState(false);
  type MessagesCacheEntry = { messages: Message[]; messagesTotal: number; messagesPage: number; historyExhausted: boolean };
  const messagesCacheRef = useRef<Map<string, MessagesCacheEntry>>(new Map());
  const messagesCacheOrderRef = useRef<string[]>([]);
  const getMessagesCacheKey = (accountId: string, chatId: string) => `${accountId}:${chatId}`;
  const hasMoreMessages = messagesPage * MESSAGES_PAGE_SIZE < messagesTotal || !historyExhausted;
  const [showCommandsMenu, setShowCommandsMenu] = useState(false);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [accountSyncReady, setAccountSyncReady] = useState<boolean>(true);
  const [accountSyncProgress, setAccountSyncProgress] = useState<{ done: number; total: number } | null>(null);
  const [accountSyncError, setAccountSyncError] = useState<string | null>(null);
  const [messageContextMenu, setMessageContextMenu] = useState<{ x: number; y: number; message: Message } | null>(null);
  const [replyToMessage, setReplyToMessage] = useState<Message | null>(null);
  const [forwardModal, setForwardModal] = useState<Message | null>(null);
  const [forwardingToChatId, setForwardingToChatId] = useState<string | null>(null);
  const [dragOverFolderId, setDragOverFolderId] = useState<number | null>(null);
  const [deletingMessageId, setDeletingMessageId] = useState<string | null>(null);
  const [folders, setFolders] = useState<SyncFolder[]>([]);
  const [selectedFolderId, setSelectedFolderId] = useState<number>(0); // 0 = «все чаты» (одна папка из Telegram или дефолт)
  const [folderIconPickerId, setFolderIconPickerId] = useState<string | null>(null);
  const [syncFoldersPushing, setSyncFoldersPushing] = useState(false);
  const [showFolderManageModal, setShowFolderManageModal] = useState(false);
  const [broadcastModalOpen, setBroadcastModalOpen] = useState(false);
  /** Временно скрыта кнопка «Синхронизировать папки с Telegram» на фронте */
  const SHOW_SYNC_FOLDERS_TO_TELEGRAM = false;
  const FOLDER_ICON_OPTIONS = ['📁', '📂', '💬', '⭐', '🔴', '📥', '📤', '✏️'];
  const [pinnedChannelIds, setPinnedChannelIds] = useState<string[]>([]);
  const [chatContextMenu, setChatContextMenu] = useState<{ x: number; y: number; chat: Chat } | null>(null);
  const [accountContextMenu, setAccountContextMenu] = useState<{ x: number; y: number; account: BDAccount } | null>(null);
  const [showEditNameModal, setShowEditNameModal] = useState(false);
  const [createSharedChatModalOpen, setCreateSharedChatModalOpen] = useState(false);
  const [createSharedChatTitle, setCreateSharedChatTitle] = useState('');
  const [createSharedChatExtraUsernames, setCreateSharedChatExtraUsernames] = useState<string[]>([]);
  const [createSharedChatSubmitting, setCreateSharedChatSubmitting] = useState(false);
  /** PHASE 2.7 — Won / Lost */
  const [markWonModalOpen, setMarkWonModalOpen] = useState(false);
  const [markWonRevenue, setMarkWonRevenue] = useState('');
  const [markWonSubmitting, setMarkWonSubmitting] = useState(false);
  const [markLostModalOpen, setMarkLostModalOpen] = useState(false);
  const [markLostReason, setMarkLostReason] = useState('');
  const [markLostSubmitting, setMarkLostSubmitting] = useState(false);
  /** Telegram presence: «печатает» в текущем чате (сбрасывается через 6 сек по спецификации Telegram). */
  const [typingChannelId, setTypingChannelId] = useState<string | null>(null);
  const typingClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Черновики по channelId (из updateDraftMessage). */
  const [draftByChannel, setDraftByChannel] = useState<Record<string, { text: string; replyToMsgId?: number }>>({});
  /** Статусы пользователей (userId -> { status, expires? }) для отображения онлайн. */
  const [userStatusByUserId, setUserStatusByUserId] = useState<Record<string, { status: string; expires?: number }>>({});
  /** Макс. id прочитанных исходящих по чату (read_outbox / read_channel_outbox) — для галочек «прочитано». */
  const [readOutboxMaxIdByChannel, setReadOutboxMaxIdByChannel] = useState<Record<string, number>>({});
  /** Переопределения имени/телефона из апдейтов user_name, user_phone (userId → поля). */
  const [contactDisplayOverrides, setContactDisplayOverrides] = useState<Record<string, { firstName?: string; lastName?: string; usernames?: string[]; phone?: string }>>({});
  /** channel_too_long: channelId, для которого нужно показать «Обновить историю». */
  const [channelNeedsRefresh, setChannelNeedsRefresh] = useState<string | null>(null);
  const [editDisplayNameValue, setEditDisplayNameValue] = useState('');
  const [savingDisplayName, setSavingDisplayName] = useState(false);
  const [showChatHeaderMenu, setShowChatHeaderMenu] = useState(false);
  const [addToFunnelFromChat, setAddToFunnelFromChat] = useState<{
    contactId: string;
    contactName: string;
    dealTitle?: string;
    bdAccountId?: string;
    channel?: string;
    channelId?: string;
  } | null>(null);
  const chatHeaderMenuRef = useRef<HTMLDivElement>(null);
  const [mediaViewer, setMediaViewer] = useState<{ url: string; type: 'image' | 'video' } | null>(null);
  const [aiSummaryText, setAiSummaryText] = useState<string | null>(null);
  const [aiSummaryLoading, setAiSummaryLoading] = useState(false);
  const [aiSummaryError, setAiSummaryError] = useState<string | null>(null);
  /** PHASE 2.2 — Lead Panel: состояние открыта/закрыта по conversation_id */
  const [leadPanelOpenByConvId, setLeadPanelOpenByConvId] = useState<Record<string, boolean>>({});
  const [leadContext, setLeadContext] = useState<LeadContext | null>(null);
  const [leadContextLoading, setLeadContextLoading] = useState(false);
  const [leadContextError, setLeadContextError] = useState<string | null>(null);
  const [leadStagePatching, setLeadStagePatching] = useState(false);
  /** PHASE 2.3 §11в — папка «Новые лиды»: системная секция сайдбара */
  const [activeSidebarSection, setActiveSidebarSection] = useState<'new-leads' | 'telegram'>('telegram');
  const [newLeads, setNewLeads] = useState<Chat[]>([]);
  const [newLeadsLoading, setNewLeadsLoading] = useState(false);

  useEffect(() => {
    setAiSummaryText(null);
    setAiSummaryError(null);
  }, [selectedChat?.channel_id]);

  const convId = selectedChat?.conversation_id ?? null;
  const isLead = !!(selectedChat?.lead_id && convId);
  const isLeadPanelOpen = isLead && (leadPanelOpenByConvId[convId ?? ''] !== false);

  useEffect(() => {
    if (!convId || !selectedChat?.lead_id || !isLeadPanelOpen) {
      setLeadContext(null);
      setLeadContextError(null);
      return;
    }
    let cancelled = false;
    setLeadContextLoading(true);
    setLeadContextError(null);
    apiClient
      .get<LeadContext>(`/api/messaging/conversations/${convId}/lead-context`)
      .then((res) => {
        if (!cancelled && res.data) setLeadContext(res.data);
      })
      .catch((err) => {
        if (!cancelled) setLeadContextError(err?.response?.data?.error ?? 'Failed to load lead context');
      })
      .finally(() => {
        if (!cancelled) setLeadContextLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [convId, selectedChat?.lead_id, isLeadPanelOpen]);

  const setLeadPanelOpen = (open: boolean) => {
    if (!convId) return;
    setLeadPanelOpenByConvId((prev) => ({ ...prev, [convId]: open }));
    if (!open) setLeadContext(null);
  };

  const handleLeadStageChange = async (stageId: string) => {
    if (!leadContext?.lead_id || leadStagePatching) return;
    setLeadStagePatching(true);
    try {
      const res = await apiClient.patch<{ stage: { id: string; name: string } }>(
        `/api/pipeline/leads/${leadContext.lead_id}/stage`,
        { stage_id: stageId }
      );
      if (res.data?.stage) setLeadContext((prev) => (prev ? { ...prev, stage: res.data!.stage } : null));
    } finally {
      setLeadStagePatching(false);
    }
  };

  const fetchNewLeads = useCallback(async () => {
    setNewLeadsLoading(true);
    try {
      const res = await apiClient.get<Record<string, unknown>[]>('/api/messaging/new-leads');
      const rows = Array.isArray(res.data) ? res.data : [];
      const mapped: Chat[] = rows.map((r: Record<string, unknown>) => {
        const nameStr = (r.display_name as string)?.trim() || [(`${r.first_name || ''}`).trim(), (`${r.last_name || ''}`).trim()].filter(Boolean).join(' ') || (r.username as string) || (r.telegram_id != null ? String(r.telegram_id) : '') || null;
        return {
          channel: (r.channel as string) || 'telegram',
          channel_id: String(r.channel_id),
          contact_id: (r.contact_id as string) ?? null,
          first_name: (r.first_name as string) ?? null,
          last_name: (r.last_name as string) ?? null,
          email: null,
          telegram_id: r.telegram_id != null ? String(r.telegram_id) : null,
          display_name: (r.display_name as string) ?? null,
          username: (r.username as string) ?? null,
          name: nameStr || null,
          unread_count: Number(r.unread_count) || 0,
          last_message_at: (r.last_message_at != null ? String(r.last_message_at) : ''),
          last_message: (r.last_message as string) ?? null,
          conversation_id: (r.conversation_id as string) ?? null,
          lead_id: (r.lead_id as string) ?? null,
          lead_stage_name: (r.lead_stage_name as string) ?? null,
          lead_pipeline_name: (r.lead_pipeline_name as string) ?? null,
          bd_account_id: (r.bd_account_id as string) ?? null,
        };
      });
      setNewLeads(mapped);
    } catch {
      setNewLeads([]);
    } finally {
      setNewLeadsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeSidebarSection === 'new-leads') fetchNewLeads();
  }, [activeSidebarSection, fetchNewLeads]);

  const STORAGE_KEYS = {
    accountsPanel: 'messaging.accountsPanelCollapsed',
    chatsPanel: 'messaging.chatsPanelCollapsed',
    aiPanel: 'messaging.aiPanelExpanded',
    hideEmptyFolders: 'messaging.hideEmptyFolders',
  };
  const getDraftKey = (accountId: string, chatId: string) =>
    `messaging.draft.${accountId}.${chatId}`;
  const messageInputRef = useRef<HTMLTextAreaElement>(null);
  const prevChatRef = useRef<{ accountId: string; chatId: string } | null>(null);
  const newMessageRef = useRef(newMessage);
  newMessageRef.current = newMessage;
  const fetchChatsRef = useRef<(() => Promise<void>) | null>(null);

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

  const [hideEmptyFolders, setHideEmptyFoldersState] = useState(() => {
    if (typeof window === 'undefined') return true;
    try {
      return localStorage.getItem(STORAGE_KEYS.hideEmptyFolders) !== 'false';
    } catch { return true; }
  });
  const setHideEmptyFolders = useCallback((v: boolean) => {
    setHideEmptyFoldersState(v);
    try { localStorage.setItem(STORAGE_KEYS.hideEmptyFolders, String(v)); } catch {}
  }, []);

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

  // После долгого простоя при возврате на вкладку перезапросить аккаунты
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchAccounts();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Open account and chat from URL (e.g. from command palette: ?bdAccountId=...&open=channelId)
  const urlBdAccountId = searchParams.get('bdAccountId');
  const urlOpenChannelId = searchParams.get('open');
  useEffect(() => {
    if (!urlBdAccountId || accounts.length === 0) return;
    const exists = accounts.some((a) => a.id === urlBdAccountId);
    if (exists) setSelectedAccountId(urlBdAccountId);
  }, [urlBdAccountId, accounts]);

  useEffect(() => {
    if (urlOpenAppliedRef.current || !urlOpenChannelId || !selectedAccountId || chats.length === 0) return;
    const chat = chats.find((c) => c.channel_id === urlOpenChannelId);
    if (chat) {
      urlOpenAppliedRef.current = true;
      setSelectedChat(chat);
      if (chat.lead_id && chat.conversation_id) {
        setLeadPanelOpenByConvId((prev) => ({ ...prev, [chat.conversation_id!]: true }));
      }
    }
  }, [urlOpenChannelId, selectedAccountId, chats]);

  // При открытии чата подставляем черновик из Telegram (updateDraftMessage). Только при смене чата, чтобы не затирать ввод при приходе черновика для другого чата.
  useEffect(() => {
    if (!selectedChat) return;
    setNewMessage(draftByChannel[selectedChat.channel_id]?.text ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- только при смене чата
  }, [selectedChat?.channel_id]);

  // Сброс баннера «История устарела» при смене аккаунта (контекст другого аккаунта).
  useEffect(() => {
    setChannelNeedsRefresh(null);
  }, [selectedAccountId]);

  // Всегда загружаем чаты из БД при выборе аккаунта. Для демо — только из БД, без Telegram/sync.
  useEffect(() => {
    if (!selectedAccountId) {
      setChats([]);
      setLoadingChats(false);
      return;
    }
    let cancelled = false;
    setLoadingChats(true);
    apiClient
      .get<unknown[]>('/api/messaging/chats', {
        params: { channel: 'telegram', bdAccountId: selectedAccountId },
      })
      .then((res) => {
        if (cancelled) return;
        const chatsFromDB = Array.isArray(res.data) ? res.data : [];
        const mapped: Chat[] = chatsFromDB.map((chat: any) => {
          const folderIds = Array.isArray(chat.folder_ids) ? chat.folder_ids.map((x: any) => Number(x)).filter((n: number) => !Number.isNaN(n)) : (chat.folder_id != null ? [Number(chat.folder_id)] : []);
          return {
            channel: (chat.channel as string) || 'telegram',
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
            unread_count: parseInt(chat.unread_count, 10) || 0,
            last_message_at: chat.last_message_at && String(chat.last_message_at).trim() ? chat.last_message_at : '',
            last_message: chat.last_message,
            conversation_id: chat.conversation_id ?? null,
            lead_id: chat.lead_id ?? null,
            lead_stage_name: chat.lead_stage_name ?? null,
            lead_pipeline_name: chat.lead_pipeline_name ?? null,
          };
        });
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
            if (existing) existing.unread_count = (existing.unread_count || 0) + (chat.unread_count || 0);
          }
        }
        const formattedChats = Array.from(byChannelId.values()).sort((a, b) => {
          const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
          const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
          if (Number.isNaN(ta)) return 1;
          if (Number.isNaN(tb)) return -1;
          return tb - ta;
        });
        setChats(formattedChats);
      })
      .catch((err) => {
        if (!cancelled) {
          console.error('Error fetching chats:', err);
          setChats([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingChats(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedAccountId]);

  // Сохранение черновика в Telegram (messages.saveDraft) с debounce 1.5 с.
  const draftSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!selectedAccountId || !selectedChat) return;
    const channelId = selectedChat.channel_id;
    const text = newMessage.trim();
    const replyToMsgId = replyToMessage?.telegram_message_id ? Number(replyToMessage.telegram_message_id) : undefined;
    if (draftSaveTimerRef.current) clearTimeout(draftSaveTimerRef.current);
    draftSaveTimerRef.current = setTimeout(() => {
      draftSaveTimerRef.current = null;
      apiClient
        .post(`/api/bd-accounts/${selectedAccountId}/draft`, { channelId, text, replyToMsgId })
        .catch(() => {});
    }, 1500);
    return () => {
      if (draftSaveTimerRef.current) {
        clearTimeout(draftSaveTimerRef.current);
        draftSaveTimerRef.current = null;
      }
    };
  }, [selectedAccountId, selectedChat?.channel_id, newMessage, replyToMessage?.telegram_message_id]);

  // Проверяем статус синхронизации выбранного аккаунта. Чаты всегда грузятся из БД при выборе аккаунта (отдельный эффект).
  useEffect(() => {
    const checkSync = async () => {
      if (!selectedAccountId) return;
      const selectedAccount = accounts.find((a) => a.id === selectedAccountId);
      const alreadyCompleted = selectedAccount?.sync_status === 'completed' || selectedAccount?.is_demo === true;
      if (alreadyCompleted) {
        setAccountSyncReady(true);
        setAccountSyncProgress(null);
        setAccountSyncError(null);
        return;
      }

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
  }, [selectedAccountId, accounts]);

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

  const prevChatCacheKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (selectedChat && selectedAccountId) {
      const key = getMessagesCacheKey(selectedAccountId, selectedChat.channel_id);
      // Сохранить предыдущий чат в кеш перед переключением (при первом выборе prevChatCacheKeyRef ещё null)
      const prevKey = prevChatCacheKeyRef.current;
      if (prevKey && prevKey !== key) {
        const order = messagesCacheOrderRef.current;
        const cache = messagesCacheRef.current;
        cache.set(prevKey, {
          messages,
          messagesTotal,
          messagesPage,
          historyExhausted,
        });
        const idx = order.indexOf(prevKey);
        if (idx !== -1) order.splice(idx, 1);
        order.push(prevKey);
        while (order.length > MAX_CACHED_CHATS) {
          const evict = order.shift()!;
          cache.delete(evict);
        }
      }
      prevChatCacheKeyRef.current = key;

      const cached = messagesCacheRef.current.get(key);
      if (cached) {
        // Не брать из кеша пустой список, если история не исчерпана — бэкенд мог подгрузить сообщения при первом открытии
        if (cached.messages.length === 0 && !cached.historyExhausted) {
          setMessages([]);
          fetchMessages(selectedAccountId, selectedChat);
        } else {
          setMessages(cached.messages);
          setMessagesTotal(cached.messagesTotal);
          setMessagesPage(cached.messagesPage);
          setHistoryExhausted(cached.historyExhausted);
          setLoadingMessages(false);
          setPrependedCount(0);
          setLastLoadedChannelId(selectedChat.channel_id);
          markAsRead();
          return;
        }
        markAsRead();
        return;
      }
      setMessages([]);
      fetchMessages(selectedAccountId, selectedChat);
      markAsRead();
    } else {
      prevChatCacheKeyRef.current = null;
      setMessages([]);
      setLastLoadedChannelId(null);
    }
  }, [selectedChat?.channel_id, selectedChat?.channel, selectedAccountId]);

  // Черновики: при смене чата сохраняем текущий текст в localStorage, подставляем черновик нового чата; сброс ответа
  useEffect(() => {
    const prev = prevChatRef.current;
    if (prev) {
      try {
        localStorage.setItem(getDraftKey(prev.accountId, prev.chatId), newMessageRef.current);
      } catch (_) {}
    }
    setReplyToMessage(null);
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
      const isOutbound = msg?.direction === 'outbound';
      const ts = payload?.timestamp ?? msg?.createdAt ?? new Date().toISOString();
      const contentPreview = (msg?.content && String(msg.content).trim()) ? String(msg.content).trim().slice(0, 200) : null;
      const isCurrentChat = selectedAccountId === msg.bdAccountId && selectedChat?.channel_id === String(msg.channelId ?? '');
      // Не увеличивать счётчик непрочитанных для исходящих (свои сообщения из ТГ или только что отправленные)
      if (!isCurrentChat && !isOutbound) {
        setAccounts((prev) =>
          prev.map((a) =>
            a.id === msg.bdAccountId ? { ...a, unread_count: (a.unread_count ?? 0) + 1 } : a
          )
        );
      }
      // Обновить чат в списке: превью, время; счётчик непрочитанных только для входящих
      if (msg.bdAccountId === selectedAccountId && msg.channelId) {
        const isCurrentChatForChat = selectedChat?.channel_id === String(msg.channelId);
        setChats((prev) => {
          const chatId = String(msg.channelId);
          const idx = prev.findIndex((c) => c.channel_id === chatId);
          if (idx < 0) return prev;
          const updated = prev.map((c, i) => {
            if (i !== idx) return c;
            const unread = isCurrentChatForChat ? 0 : (c.unread_count || 0) + (isOutbound ? 0 : 1);
            return { ...c, last_message_at: ts, last_message: (contentPreview && contentPreview.trim()) ? contentPreview.trim().slice(0, 200) : '[Media]', unread_count: Math.max(0, unread) };
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
      if (msg.bdAccountId === selectedAccountId && selectedChat && (msg.channelId === selectedChat.channel_id || msg.channelId == null)) {
        setMessages((prev) => {
          const existingById = prev.find((m) => m.id === msg.messageId);
          if (existingById) {
            // Обновить существующее (например temp → с telegram_message_id)
            if (msg.telegramMessageId != null && !existingById.telegram_message_id)
              return prev.map((m) => m.id === msg.messageId ? { ...m, telegram_message_id: String(msg.telegramMessageId), status: 'delivered' } : m);
            return prev;
          }
          // Не дублировать: если уже есть сообщение с тем же telegram_message_id в этом чате — не добавлять (событие могло прийти раньше ответа send)
          const tgId = msg.telegramMessageId != null ? String(msg.telegramMessageId) : null;
          if (tgId && prev.some((m) => m.telegram_message_id === tgId && m.channel_id === selectedChat.channel_id)) return prev;
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
              telegram_message_id: tgId,
              reply_to_telegram_id: msg.replyToTelegramId != null ? String(msg.replyToTelegramId) : null,
              telegram_media: msg.telegramMedia ?? null,
              telegram_entities: msg.telegramEntities ?? null,
              telegram_date: ts,
            },
          ];
        });
        if (isAtBottomRef.current) scrollToBottomRef.current();
      }
    };
    on('new-message', handler);
    return () => {
      off('new-message', handler);
      accountRooms.forEach((room: string) => unsubscribe(room));
    };
  }, [accounts, isConnected, selectedAccountId, selectedChat, subscribe, unsubscribe, on, off]);

  useEffect(() => {
    const handler = (payload: {
      type?: string;
      data?: {
        messageId?: string;
        channelId?: string;
        bdAccountId?: string;
        content?: string;
      };
    }) => {
      const d = payload?.data;
      if (!d?.messageId) return;
      if (selectedAccountId && d.bdAccountId !== selectedAccountId) return;

      if (payload?.type === 'message.deleted') {
        if (selectedChat && d.channelId === selectedChat.channel_id) {
          setMessages((prev) => prev.filter((m) => m.id !== d.messageId));
        }
        return;
      }

      if (payload?.type === 'message.edited' && d.content !== undefined) {
        if (selectedChat && d.channelId === selectedChat.channel_id) {
          setMessages((prev) =>
            prev.map((m) => (m.id === d.messageId ? { ...m, content: d.content ?? m.content } : m))
          );
        }
      }
    };
    on('event', handler);
    return () => off('event', handler);
  }, [on, off, selectedChat, selectedAccountId]);

  // Telegram presence: typing, user status, read receipt, draft
  useEffect(() => {
    const handler = (payload: {
      type?: string;
      data?: {
        bdAccountId?: string;
        updateKind?: string;
        channelId?: string;
        userId?: string;
        status?: string;
        expires?: number;
        maxId?: number;
        draftText?: string;
        replyToMsgId?: number;
        pinned?: boolean;
        order?: string[];
        firstName?: string;
        lastName?: string;
        usernames?: string[];
        phone?: string;
      };
    }) => {
      if (payload?.type !== 'bd_account.telegram_update' || !payload?.data) return;
      const d = payload.data;
      if (selectedAccountId && d.bdAccountId !== selectedAccountId) return;

      switch (d.updateKind) {
        case 'typing':
          if (d.channelId) {
            setTypingChannelId(d.channelId);
            if (typingClearTimerRef.current) clearTimeout(typingClearTimerRef.current);
            typingClearTimerRef.current = setTimeout(() => {
              setTypingChannelId((prev) => (prev === d.channelId ? null : prev));
              typingClearTimerRef.current = null;
            }, 6000);
          }
          break;
        case 'user_status':
          if (d.userId != null) {
            setUserStatusByUserId((prev) => ({
              ...prev,
              [d.userId!]: { status: d.status ?? '', expires: d.expires },
            }));
          }
          break;
        case 'read_inbox':
        case 'read_channel_inbox':
          if (d.channelId) {
            setChats((prev) =>
              prev.map((c) => (c.channel_id === d.channelId ? { ...c, unread_count: 0 } : c))
            );
          }
          break;
        case 'read_outbox':
        case 'read_channel_outbox':
          if (d.channelId != null && typeof d.maxId === 'number') {
            setReadOutboxMaxIdByChannel((prev) => ({
              ...prev,
              [d.channelId!]: Math.max(prev[d.channelId!] ?? 0, d.maxId!),
            }));
          }
          break;
        case 'draft':
          if (d.channelId != null) {
            setDraftByChannel((prev) => ({
              ...prev,
              [d.channelId!]: {
                text: d.draftText ?? '',
                replyToMsgId: d.replyToMsgId,
              },
            }));
          }
          break;
        case 'dialog_pinned':
          if (d.channelId != null) {
            setPinnedChannelIds((prev) =>
              d.pinned
                ? prev.includes(d.channelId!)
                  ? prev
                  : [...prev, d.channelId!]
                : prev.filter((id) => id !== d.channelId)
            );
          }
          break;
        case 'pinned_dialogs':
          if (Array.isArray(d.order) && d.order.length >= 0) {
            setPinnedChannelIds(d.order);
          }
          break;
        case 'user_name':
          if (d.userId != null) {
            setContactDisplayOverrides((prev) => ({
              ...prev,
              [d.userId!]: {
                ...prev[d.userId!],
                firstName: d.firstName ?? prev[d.userId!]?.firstName,
                lastName: d.lastName ?? prev[d.userId!]?.lastName,
                usernames: d.usernames ?? prev[d.userId!]?.usernames,
              },
            }));
          }
          break;
        case 'user_phone':
          if (d.userId != null) {
            setContactDisplayOverrides((prev) => ({
              ...prev,
              [d.userId!]: { ...prev[d.userId!], phone: d.phone ?? prev[d.userId!]?.phone },
            }));
          }
          break;
        case 'chat_participant_add':
        case 'chat_participant_delete':
          fetchChatsRef.current?.();
          break;
        case 'channel_too_long':
          if (d.channelId) setChannelNeedsRefresh(d.channelId);
          break;
        case 'message_id_confirmed':
        case 'notify_settings':
        case 'scheduled_message':
        case 'delete_scheduled_messages':
        case 'message_poll':
        case 'message_poll_vote':
        case 'config':
        case 'dc_options':
        case 'lang_pack':
        case 'theme':
        case 'phone_call':
        case 'callback_query':
          break;
      }
    };
    on('event', handler);
    return () => {
      off('event', handler);
      if (typingClearTimerRef.current) {
        clearTimeout(typingClearTimerRef.current);
        typingClearTimerRef.current = null;
      }
    };
  }, [on, off, selectedAccountId]);

  useEffect(() => {
    if (!messageContextMenu && !chatContextMenu && !accountContextMenu) return;
    const close = () => {
      setMessageContextMenu(null);
      setChatContextMenu(null);
      setAccountContextMenu(null);
    };
    const handleWindowClick = (e: MouseEvent) => {
      if (e.button === 2) return;
      const target = e.target as HTMLElement;
      if (target?.closest?.('[role="menu"]')) return;
      close();
    };
    window.addEventListener('click', handleWindowClick, true);
    window.addEventListener('scroll', close, true);
    return () => {
      window.removeEventListener('click', handleWindowClick, true);
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
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, []);
  scrollToBottomRef.current = scrollToBottom;

  /** Скролл к самому последнему сообщению (мгновенно, без анимации). Для кнопки «вниз» и при открытии чата. */
  const scrollToLastMessage = useCallback(() => {
    if (messages.length === 0) return;
    if (messages.length > VIRTUAL_LIST_THRESHOLD && virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({ index: messages.length - 1, align: 'end', behavior: 'auto' });
      setShowScrollToBottomButton(false);
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    setShowScrollToBottomButton(false);
  }, [messages.length]);

  // Один раз показать низ для обычного списка (не Virtuoso): мгновенно, без отложенных вызовов.
  useEffect(() => {
    if (messages.length > VIRTUAL_LIST_THRESHOLD || messages.length === 0) return;
    if (skipScrollToBottomAfterPrependRef.current) {
      skipScrollToBottomAfterPrependRef.current = false;
      return;
    }
    requestAnimationFrame(() => scrollToBottom());
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
        conversation_id: chat.conversation_id ?? null,
        lead_id: chat.lead_id ?? null,
        lead_stage_name: chat.lead_stage_name ?? null,
        lead_pipeline_name: chat.lead_pipeline_name ?? null,
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
  fetchChatsRef.current = fetchChats;

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
      setLastLoadedChannelId(chat.channel_id);
    } catch (error: any) {
      console.error('Error fetching messages:', error);
      setMessages([]);
      setMessagesTotal(0);
      setHistoryExhausted(false);
      setLastLoadedChannelId(chat.channel_id);
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
      skipScrollToBottomAfterPrependRef.current = true;
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

  // Восстановить позицию скролла после подгрузки старых сообщений (prepend), без фризов. Не применять при смене чата (scrollRestoreRef сбрасывается в эффекте смены чата).
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

  // Сброс при смене чата: сброс подгрузки, флага «внизу» и сохранённой позиции скролла (иначе эффект восстановления применит старую позицию и скролл дёрнется в середину).
  useEffect(() => {
    hasUserScrolledUpRef.current = false;
    setPrependedCount(0);
    isAtBottomRef.current = true;
    setShowScrollToBottomButton(false);
    scrollRestoreRef.current = null;
  }, [selectedChat?.channel_id]);

  // Отслеживание скролла: вверх — для подгрузки; внизу — чтобы новые сообщения скроллили только если пользователь уже внизу (как в Telegram)
  useEffect(() => {
    const container = messagesScrollRef.current;
    if (!container) return;
    const onScroll = () => {
      if (container.scrollTop < 150) hasUserScrolledUpRef.current = true;
      const nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 80;
      isAtBottomRef.current = nearBottom;
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
    const replyTo = replyToMessage;
    setNewMessage('');
    setPendingFile(null);
    setReplyToMessage(null);
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
      if (replyTo?.telegram_message_id) {
        body.replyToMessageId = replyTo.telegram_message_id;
      }

      const response = await apiClient.post('/api/messaging/send', body);
      const serverMessage = response.data as Record<string, unknown>;
      const tgDate = serverMessage.telegram_date;
      const telegramDateStr =
        tgDate != null
          ? typeof tgDate === 'string'
            ? tgDate
            : typeof tgDate === 'number'
              ? new Date(tgDate * 1000).toISOString()
              : undefined
          : undefined;

      const merged: Message = {
        ...tempMessage,
        id: String(serverMessage.id ?? tempMessage.id),
        status: String(serverMessage.status ?? tempMessage.status),
        created_at: String(serverMessage.created_at ?? tempMessage.created_at),
        telegram_message_id: serverMessage.telegram_message_id != null ? String(serverMessage.telegram_message_id) : tempMessage.telegram_message_id,
        telegram_date: telegramDateStr ?? tempMessage.telegram_date,
        reply_to_telegram_id: serverMessage.reply_to_telegram_id != null ? String(serverMessage.reply_to_telegram_id) : (tempMessage.reply_to_telegram_id ?? replyTo?.telegram_message_id ?? undefined),
        telegram_media: (serverMessage.telegram_media != null && typeof serverMessage.telegram_media === 'object') ? serverMessage.telegram_media as Record<string, unknown> : tempMessage.telegram_media,
        telegram_entities: Array.isArray(serverMessage.telegram_entities) ? serverMessage.telegram_entities as Array<Record<string, unknown>> : tempMessage.telegram_entities,
      };

      setMessages((prev) => {
        const next = prev.map((msg) => (msg.id === tempMessage.id ? merged : msg));
        // Убрать дубликаты по id (если событие new-message пришло раньше ответа, мог появиться второй элемент с тем же id)
        const seen = new Set<string>();
        return next.filter((m) => {
          if (seen.has(m.id)) return false;
          seen.add(m.id);
          return true;
        });
      });
      // Очистить черновик в Telegram после успешной отправки
      if (selectedAccountId && selectedChat) {
        apiClient.post(`/api/bd-accounts/${selectedAccountId}/draft`, { channelId: selectedChat.channel_id, text: '' }).catch(() => {});
      }
      if (selectedChat.conversation_id) {
        setNewLeads((prev) => prev.filter((c) => c.conversation_id !== selectedChat.conversation_id));
      }
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

  const getChatName = (chat: Chat, overrides?: { firstName?: string; lastName?: string; usernames?: string[] }) => {
    if (chat.display_name?.trim()) return chat.display_name.trim();
    const first = (overrides?.firstName ?? chat.first_name ?? '').trim();
    const last = (overrides?.lastName ?? chat.last_name ?? '').trim();
    const firstLast = `${first} ${last}`.trim();
    if (firstLast && !/^Telegram\s+\d+$/.test(firstLast)) return firstLast;
    const username = overrides?.usernames?.[0] ?? chat.username;
    if (username) return username.startsWith('@') ? username : `@${username}`;
    if (chat.name?.trim()) return chat.name.trim();
    if (chat.email?.trim()) return chat.email.trim();
    if (chat.telegram_id) return chat.telegram_id;
    return 'Unknown';
  };

  const getChatNameWithOverrides = (chat: Chat) => getChatName(chat, contactDisplayOverrides[chat.channel_id]);

  const openEditNameModal = () => {
    if (!selectedChat) return;
    setEditDisplayNameValue(selectedChat.display_name ?? getChatNameWithOverrides(selectedChat) ?? '');
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

  const handleDeleteFolder = useCallback(
    async (folderRowId: string) => {
      if (!selectedAccountId) return;
      await apiClient.delete(
        `/api/bd-accounts/${selectedAccountId}/sync-folders/${folderRowId}`
      );
    },
    [selectedAccountId]
  );

  const handleFolderDeleted = useCallback((folderId: number) => {
    setSelectedFolderId((prev) => (prev === folderId ? 0 : prev));
  }, []);

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

  const scrollToMessageByTelegramId = useCallback((telegramMessageId: string) => {
    const id = String(telegramMessageId).trim();
    if (!id) return;
    const index = messages.findIndex((m) => String(m.telegram_message_id) === id);
    if (index < 0) return;
    if (messages.length > VIRTUAL_LIST_THRESHOLD && virtuosoRef.current) {
      virtuosoRef.current.scrollToIndex({ index, align: 'center', behavior: 'auto' });
      return;
    }
    const container = messagesScrollRef.current;
    if (!container) return;
    const el = container.querySelector(`[data-telegram-message-id="${id}"]`);
    if (el) (el as HTMLElement).scrollIntoView({ behavior: 'auto', block: 'center' });
  }, [messages]);

  const renderMessageRow = useCallback(
    (msg: Message, index: number) => {
      const isOutbound = msg.direction === 'outbound';
      const msgTime = msg.telegram_date ?? msg.created_at;
      const prevMsgTime = messages[index - 1]?.telegram_date ?? messages[index - 1]?.created_at;
      const showDateSeparator =
        index === 0 || new Date(msgTime).toDateString() !== new Date(prevMsgTime).toDateString();
      const replyToTgId = (msg.reply_to_telegram_id ?? (msg as any).replyToTelegramId) != null
        ? String(msg.reply_to_telegram_id ?? (msg as any).replyToTelegramId).trim()
        : null;
      const repliedToMsg = replyToTgId ? messages.find((m) => String(m.telegram_message_id ?? (m as any).telegramMessageId) === replyToTgId) : null;
      const replyPreviewText = repliedToMsg
        ? (repliedToMsg.content ?? '').trim().slice(0, 60) || t('messaging.replyPreviewMedia')
        : replyToTgId
          ? t('messaging.replyPreviewMedia')
          : '';

      return (
        <div data-telegram-message-id={msg.telegram_message_id ?? ''}>
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
              setChatContextMenu(null);
              setAccountContextMenu(null);
              setMessageContextMenu({ x: e.clientX, y: e.clientY, message: msg });
            }}
          >
            <div className={`max-w-[70%] ${isOutbound ? 'msg-bubble-out' : 'msg-bubble-in'}`}>
              {replyToTgId && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    scrollToMessageByTelegramId(replyToTgId);
                  }}
                  className={`w-full text-left border-l-2 rounded pl-2 py-1 mb-1.5 text-xs truncate transition-colors ${
                    isOutbound
                      ? 'border-primary-foreground/50 text-primary-foreground/90 hover:bg-primary-foreground/10'
                      : 'border-primary text-muted-foreground hover:bg-muted/60'
                  }`}
                  title={t('messaging.scrollToMessage')}
                >
                  <Reply className="w-3.5 h-3.5 inline-block mr-1 align-middle shrink-0" />
                  <span className="align-middle">{replyPreviewText}{replyPreviewText.length >= 60 ? '…' : ''}</span>
                </button>
              )}
              {(() => {
                const fwdLabel = getForwardedFromLabel(msg);
                const hasFwd = fwdLabel || (msg.telegram_extra?.fwd_from && typeof msg.telegram_extra.fwd_from === 'object');
                if (!hasFwd) return null;
                const text = fwdLabel ? t('messaging.forwardedFrom', { name: fwdLabel }) : t('messaging.forwarded');
                return (
                  <div
                    className={`text-[11px] mb-1 truncate ${
                      isOutbound ? 'text-primary-foreground/70' : 'text-muted-foreground'
                    }`}
                    title={text}
                  >
                    {text}
                  </div>
                );
              })()}
              <MessageContent
                msg={msg}
                isOutbound={isOutbound}
                bdAccountId={selectedAccountId ?? ''}
                channelId={selectedChat?.channel_id ?? ''}
                onOpenMedia={(url, type) => setMediaViewer({ url, type })}
              />
              <div
                className={`text-xs mt-1 flex items-center gap-1 ${
                  isOutbound ? 'text-primary-foreground/80 justify-end' : 'text-muted-foreground justify-start'
                }`}
              >
                <span>{formatTime(msgTime)}</span>
                {isOutbound && (() => {
                  const readMax = selectedChat ? readOutboxMaxIdByChannel[selectedChat.channel_id] : undefined;
                  const tgId = msg.telegram_message_id != null ? Number(msg.telegram_message_id) : null;
                  const isReadByReceipt = readMax != null && tgId != null && tgId <= readMax;
                  const isRead = msg.status === 'read' || msg.status === 'delivered' || isReadByReceipt;
                  return isRead ? (
                    <CheckCheck className="w-3.5 h-3.5 text-primary-foreground ml-1" />
                  ) : msg.status === 'sent' || msg.status === 'delivered' || (msg.status === 'pending' && tgId != null) ? (
                    <Check className="w-3.5 h-3.5 text-primary-foreground/80 ml-1" />
                  ) : null;
                })()}
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
    [messages, selectedAccountId, selectedChat, readOutboxMaxIdByChannel, setMediaViewer, t, scrollToMessageByTelegramId]
  );

  // Сразу после монтирования Virtuoso для этого чата — мгновенно (behavior: 'auto') скролл в самый низ. Двойной rAF чтобы сработало после раскладки.
  useEffect(() => {
    if (messages.length <= VIRTUAL_LIST_THRESHOLD || messages.length === 0) return;
    if (lastLoadedChannelId !== selectedChat?.channel_id) return;
    const scrollToEnd = () => virtuosoRef.current?.scrollToIndex({ index: messages.length - 1, align: 'end', behavior: 'auto' });
    const raf1 = requestAnimationFrame(() => {
      scrollToEnd();
      requestAnimationFrame(scrollToEnd);
    });
    return () => cancelAnimationFrame(raf1);
  }, [lastLoadedChannelId, selectedChat?.channel_id, messages.length]);

  // Кнопка «вниз» для обычного списка (не Virtuoso): показывать, если проскроллили вверх больше ~10 сообщений
  useEffect(() => {
    if (messages.length > VIRTUAL_LIST_THRESHOLD || messages.length === 0) return;
    const el = messagesScrollRef.current;
    if (!el) return;
    const SCROLL_THRESHOLD_PX = 400;
    const check = () => {
      const { scrollTop, scrollHeight, clientHeight } = el;
      const fromBottom = scrollHeight - scrollTop - clientHeight;
      if (fromBottom > SCROLL_THRESHOLD_PX) setShowScrollToBottomButton(true);
      else if (fromBottom < 50) setShowScrollToBottomButton(false);
    };
    el.addEventListener('scroll', check, { passive: true });
    check();
    return () => el.removeEventListener('scroll', check);
  }, [messages.length]);

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

  const handleCopyMessageText = (msg: Message) => {
    setMessageContextMenu(null);
    const text = (msg.content ?? (msg as any).body ?? '').trim() || '';
    if (text) {
      navigator.clipboard.writeText(text).then(
        () => { /* optional: toast t('common.copied') */ },
        () => alert(t('messaging.copyFailed'))
      );
    }
  };

  const handleReplyToMessage = (msg: Message) => {
    setMessageContextMenu(null);
    setReplyToMessage(msg);
    messageInputRef.current?.focus();
  };

  const handleForwardMessage = (msg: Message) => {
    setMessageContextMenu(null);
    setForwardModal(msg);
  };

  const handleForwardToChat = async (toChatId: string) => {
    if (!forwardModal || !selectedAccountId || !selectedChat) return;
    const telegramId = forwardModal.telegram_message_id ? Number(forwardModal.telegram_message_id) : null;
    if (telegramId == null) {
      alert(t('messaging.forwardError'));
      return;
    }
    setForwardingToChatId(toChatId);
    try {
      await apiClient.post(`/api/bd-accounts/${selectedAccountId}/forward`, {
        fromChatId: selectedChat.channel_id,
        toChatId,
        telegramMessageId: telegramId,
      });
      setForwardModal(null);
      setForwardingToChatId(null);
      if (toChatId === selectedChat.channel_id) {
        await fetchMessages(selectedAccountId, selectedChat);
      }
    } catch (err: any) {
      console.error('Error forwarding message:', err);
      alert(err?.response?.data?.message || err?.response?.data?.error || t('messaging.forwardError'));
    } finally {
      setForwardingToChatId(null);
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

  const formatLeadPanelDate = (iso: string) => {
    if (!iso || isNaN(new Date(iso).getTime())) return '—';
    const d = new Date(iso);
    const day = d.getDate();
    const month = d.toLocaleString('en-GB', { month: 'short' });
    const year = d.getFullYear();
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
    return `${day} ${month} ${year}, ${time}`;
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

  const handleFolderDrop = useCallback(
    (folderId: number, e: React.DragEvent) => {
      e.preventDefault();
      setDragOverFolderId(null);
      try {
        const raw = e.dataTransfer.getData('application/json');
        if (!raw) return;
        const { bdAccountId, chat } = JSON.parse(raw) as { bdAccountId: string; chat: Chat };
        if (bdAccountId !== selectedAccountId) return;
        if (!chatFolderIds(chat).includes(folderId)) handleChatFoldersToggle(chat, folderId);
      } catch (_) {}
    },
    [selectedAccountId, chatFolderIds, handleChatFoldersToggle]
  );

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

  // Папки с хотя бы одним чатом (для фильтра «скрывать пустые»). Папка 0 «все чаты» всегда непустая при наличии чатов.
  const nonEmptyFolderIds = useMemo(() => {
    const set = new Set<number>([0]);
    chats.forEach((c) => chatFolderIds(c).forEach((fid) => set.add(fid)));
    return set;
  }, [chats, chatFolderIds]);

  // Одна папка «все чаты»: из Telegram (folder_id 0) или дефолт. При hideEmptyFolders скрываем папки без чатов (только в Мессенджере).
  const displayFolders = useMemo(() => {
    const hasZero = folders.some((f) => f.folder_id === 0);
    const zero: SyncFolder = hasZero
      ? folders.find((f) => f.folder_id === 0)!
      : { id: '0', folder_id: 0, folder_title: t('messaging.folderAll'), order_index: -1, icon: '📋' };
    const rest = folders.filter((f) => f.folder_id !== 0);
    const list = [zero, ...rest];
    if (hideEmptyFolders) return list.filter((f) => nonEmptyFolderIds.has(f.folder_id));
    return list;
  }, [folders, t, hideEmptyFolders, nonEmptyFolderIds]);

  // PHASE 2.1 §11а: без поиска и фильтров по типу чата — только папка и порядок по last_message_at
  const filteredChats = chats.filter((chat) => {
    if (selectedFolderId !== null && selectedFolderId !== 0) {
      if (!chatFolderIds(chat).includes(selectedFolderId)) return false;
    }
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
        className={`h-full min-h-0 self-stretch bg-muted/40 dark:bg-muted/20 border-r border-border flex flex-col transition-[width] duration-200 shrink-0 ${accountsPanelCollapsed ? 'w-16' : 'w-64'}`}
        aria-expanded={!accountsPanelCollapsed}
      >
        {accountsPanelCollapsed ? (
          <div className="flex flex-col flex-1 min-h-0 w-full">
            <button
              type="button"
              onClick={() => setAccountsCollapsed(false)}
              className="p-2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground flex flex-col items-center gap-0.5 w-full shrink-0 border-b border-border"
              title={t('messaging.bdAccounts') + ' — развернуть'}
              aria-label={t('messaging.bdAccounts') + ', развернуть панель'}
            >
              <UserCircle className="w-5 h-5 shrink-0" aria-hidden />
              <ChevronRight className="w-4 h-4 shrink-0" aria-hidden />
            </button>
            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center pt-2 pb-1 gap-1 scroll-thin-overlay">
              {filteredAccounts.length === 0 ? null : filteredAccounts.map((account) => (
                <button
                  key={account.id}
                  type="button"
                  onClick={() => {
                    setSelectedAccountId(account.id);
                    setSelectedChat(null);
                    setMessages([]);
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    setChatContextMenu(null);
                    setMessageContextMenu(null);
                    setAccountContextMenu({ x: e.clientX, y: e.clientY, account });
                  }}
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

        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col scroll-thin-overlay">
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
                    setChatContextMenu(null);
                    setMessageContextMenu(null);
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
        className={`h-full min-h-0 self-stretch bg-card border-r border-border flex flex-col transition-[width] duration-200 shrink-0 ${chatsPanelCollapsed ? 'w-32' : 'w-[320px]'}`}
        aria-expanded={!chatsPanelCollapsed}
      >
        {chatsPanelCollapsed ? (
          <div className="flex flex-col flex-1 min-h-0 w-full min-w-0">
            {/* Кнопка разворота на всю ширину (как в Telegram) */}
            <button
              type="button"
              onClick={() => setChatsCollapsed(false)}
              className="p-2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground flex flex-col items-center gap-0.5 w-full shrink-0 border-b border-border"
              title={t('messaging.chatsPanelTitle') + ' — развернуть'}
              aria-label={t('messaging.expandChatsPanel')}
            >
              <MessageSquare className="w-5 h-5 shrink-0" aria-hidden />
              <ChevronRight className="w-4 h-4 shrink-0" aria-hidden />
            </button>
            {selectedAccountId && (
              <div className="flex flex-1 min-h-0 min-w-0">
                {/* Левая колонка: Sync + папки + Sync to TG + Edit (как в развёрнутом виде) */}
                <div className="w-16 flex-shrink-0 flex flex-col border-r border-border bg-muted/30 min-h-0">
                  {/* Кнопка синхронизации сверху */}
                  <div className="shrink-0 border-b border-border/50 flex items-center justify-center gap-0.5 py-2">
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
                  <div className="flex-1 min-h-0 overflow-y-auto pt-2 pb-1 flex flex-col scroll-thin-overlay">
                    {displayFolders.map((f) => (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setSelectedFolderId(f.folder_id)}
                        title={f.folder_title}
                        onDragOver={(e) => { e.preventDefault(); setDragOverFolderId(f.folder_id); }}
                        onDragLeave={() => setDragOverFolderId(null)}
                        onDrop={(e) => handleFolderDrop(f.folder_id, e)}
                        className={`flex flex-col items-center justify-center py-2 px-1 gap-0.5 min-h-[48px] w-full rounded-none border-b border-border/30 transition-colors ${
                          selectedFolderId === f.folder_id ? 'bg-primary/10 dark:bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                        } ${dragOverFolderId === f.folder_id ? 'ring-2 ring-primary bg-primary/20' : ''}`}
                      >
                        <span className="text-lg shrink-0 leading-none">{f.icon || '📁'}</span>
                        <span className="text-[10px] font-medium truncate w-full text-center leading-tight">{f.folder_title}</span>
                        {(unreadByFolder.byId[f.folder_id] ?? 0) > 0 && (
                          <span className={`min-w-[1rem] rounded-full px-1 text-[9px] tabular-nums leading-none ${selectedFolderId === f.folder_id ? 'bg-primary/30 text-primary-foreground' : 'bg-primary/20'}`}>
                            {unreadByFolder.byId[f.folder_id]! > 99 ? '99+' : unreadByFolder.byId[f.folder_id]}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                  {isSelectedAccountMine && (
                    <>
                      {SHOW_SYNC_FOLDERS_TO_TELEGRAM && (
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
                          className="py-1.5 px-1 text-[10px] text-muted-foreground hover:text-foreground border-t border-border/50 disabled:opacity-50 truncate w-full shrink-0"
                          title={t('messaging.syncFoldersToTelegram')}
                        >
                          {syncFoldersPushing ? '…' : t('messaging.syncFoldersToTelegramShort')}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setShowFolderManageModal(true)}
                        className="flex flex-col items-center justify-center py-2 px-1 gap-0.5 text-muted-foreground hover:bg-accent hover:text-foreground border-t border-border shrink-0"
                        title={t('messaging.folderEdit')}
                      >
                        <Pencil className="w-4 h-4 shrink-0" />
                        <span className="text-[10px] font-medium">{t('messaging.folderEdit')}</span>
                      </button>
                    </>
                  )}
                </div>
                {/* Правая колонка: чаты — аватарки/инициалы (ширина w-16) */}
                <div className="w-16 flex-shrink-0 flex flex-col min-h-0">
                  <div className="flex-1 min-h-0 overflow-y-auto flex flex-col items-center pt-2 pb-1 gap-1 scroll-thin-overlay">
                    {!loadingChats && accountSyncReady && displayChats.length > 0 && displayChats.map((chat) => (
                      <button
                        key={`${chat.channel}-${chat.channel_id}`}
                        type="button"
                        onClick={() => setSelectedChat(chat)}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          if (!selectedAccountId) return;
                          setAccountContextMenu(null);
                          setMessageContextMenu(null);
                          setChatContextMenu({ x: e.clientX, y: e.clientY, chat });
                        }}
                        title={getChatNameWithOverrides(chat)}
                        className={`relative shrink-0 rounded-full p-0.5 transition-colors hover:ring-2 hover:ring-primary/50 ${
                          selectedChat?.channel_id === chat.channel_id ? 'ring-2 ring-primary' : ''
                        }`}
                      >
                        <ChatAvatar
                          bdAccountId={selectedAccountId}
                          chatId={chat.channel_id}
                          chat={chat}
                          className="w-8 h-8"
                        />
                        {chat.unread_count > 0 && (
                          <span className="absolute -top-0.5 -right-0.5 min-w-[0.875rem] h-3.5 px-0.5 rounded-full bg-primary text-primary-foreground text-[10px] flex items-center justify-center leading-none">
                            {chat.unread_count}
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        ) : (
          <>
          {/* Первая строка: заголовок «Чаты» (PHASE 2.1 §11а: поиск убран) */}
          <div className="flex items-center gap-2 p-3 border-b border-border shrink-0 min-w-0 flex-none">
            <h3 className="font-semibold text-foreground truncate flex-1 min-w-0">{t('messaging.chatsPanelTitle')}</h3>
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
              <div className="w-16 flex-shrink-0 flex flex-col border-r border-border bg-muted/30 min-h-0">
                {/* PHASE 2.3 §11в — системная папка «Новые лиды» сверху, визуально отделена */}
                <button
                  type="button"
                  onClick={() => setActiveSidebarSection('new-leads')}
                  className={`shrink-0 flex flex-col items-center justify-center py-2 px-1 gap-0.5 min-h-[48px] w-full rounded-none border-b border-border transition-colors ${
                    activeSidebarSection === 'new-leads' ? 'bg-primary/10 dark:bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                  }`}
                  title={t('messaging.newLeadsFolder')}
                >
                  <Inbox className="w-5 h-5 shrink-0" aria-hidden />
                  <span className="text-[10px] font-medium truncate w-full text-center leading-tight">{t('messaging.newLeadsFolder')}</span>
                  {newLeads.length > 0 && (
                    <span className={`min-w-[1rem] rounded-full px-1 text-[9px] tabular-nums ${activeSidebarSection === 'new-leads' ? 'bg-primary/30 text-primary-foreground' : 'bg-primary/20'}`}>
                      {newLeads.length > 99 ? '99+' : newLeads.length}
                    </span>
                  )}
                </button>
                <div className="shrink-0 h-px bg-border" aria-hidden />
                {/* Sync/Re-sync — на одном уровне с переключателем Все/Личные/Группы справа. Ширина w-16 = как свернутая навигация, не меняется при сворачивании панели чатов */}
<div className="shrink-0 border-b border-border/50 flex items-center justify-center gap-0.5 py-2">
                    <button
                      type="button"
                      onClick={() => window.location.href = `/dashboard/bd-accounts?accountId=${selectedAccountId}&openSelectChats=1`}
                      className="p-2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                      title={t('messaging.syncChatsTitle')}
                      aria-label={t('messaging.syncChatsTitle')}
                    >
                      <RefreshCw className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setBroadcastModalOpen(true)}
                      className="p-2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
                      title={t('messaging.broadcastToGroups', 'Рассылка в группы')}
                      aria-label={t('messaging.broadcastToGroups', 'Рассылка в группы')}
                    >
                      <Users className="w-4 h-4" />
                    </button>
                  </div>
                  <div className="flex-1 min-h-0 overflow-y-auto pt-2 pb-1 flex flex-col scroll-thin-overlay">
                    {displayFolders.map((f) => (
                    <button
                      key={f.id}
                      type="button"
                      onClick={() => { setActiveSidebarSection('telegram'); setSelectedFolderId(f.folder_id); }}
                      title={f.folder_title}
                      onDragOver={(e) => { e.preventDefault(); setDragOverFolderId(f.folder_id); }}
                      onDragLeave={() => setDragOverFolderId(null)}
                      onDrop={(e) => handleFolderDrop(f.folder_id, e)}
                      className={`flex flex-col items-center justify-center py-2 px-1 gap-0.5 min-h-[48px] w-full rounded-none border-b border-border/30 transition-colors ${
                        selectedFolderId === f.folder_id ? 'bg-primary/10 dark:bg-primary/20 text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                      } ${dragOverFolderId === f.folder_id ? 'ring-2 ring-primary bg-primary/20' : ''}`}
                    >
                      <span className="text-lg shrink-0">{f.icon || '📁'}</span>
                      <span className="text-[10px] font-medium truncate w-full text-center leading-tight">{f.folder_title}</span>
                      {(unreadByFolder.byId[f.folder_id] ?? 0) > 0 && (
                        <span className={`min-w-[1rem] rounded-full px-1 text-[9px] tabular-nums ${selectedFolderId === f.folder_id ? 'bg-primary/30 text-primary-foreground' : 'bg-primary/20'}`}>
                          {unreadByFolder.byId[f.folder_id]! > 99 ? '99+' : unreadByFolder.byId[f.folder_id]}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
                {isSelectedAccountMine && (
                  <>
                    {SHOW_SYNC_FOLDERS_TO_TELEGRAM && (
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
                    )}
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

            {/* Правая колонка: список чатов или new-leads (PHASE 2.3 §11в) */}
          <div className="flex-1 min-w-0 flex flex-col min-h-0">
          {activeSidebarSection === 'new-leads' ? (
            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col relative scroll-thin-overlay">
              {newLeadsLoading ? (
                <div className="absolute inset-0 flex items-center justify-center">
                  <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
                </div>
              ) : newLeads.length === 0 ? (
                <div className="flex-1 min-h-0 flex flex-col items-center justify-center p-4 text-center">
                  <p className="text-sm font-medium text-foreground">{t('messaging.newLeadsEmptyTitle')}</p>
                  <p className="text-xs text-muted-foreground mt-1">{t('messaging.newLeadsEmptyDesc')}</p>
                </div>
              ) : (
                newLeads.map((chat) => (
                  <div
                    key={chat.conversation_id ?? `${chat.channel}-${chat.channel_id}`}
                    onClick={() => {
                      if (chat.bd_account_id) setSelectedAccountId(chat.bd_account_id);
                      setSelectedChat(chat);
                    }}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      if (chat.bd_account_id) setAccountContextMenu(null);
                      setMessageContextMenu(null);
                      setChatContextMenu({ x: e.clientX, y: e.clientY, chat });
                    }}
                    className={`p-4 cursor-pointer border-b border-border transition-colors flex gap-3 ${
                      selectedChat?.channel_id === chat.channel_id ? 'bg-primary/10 dark:bg-primary/20' : 'hover:bg-accent'
                    }`}
                  >
                    <ChatAvatar
                      bdAccountId={chat.bd_account_id ?? selectedAccountId ?? ''}
                      chatId={chat.channel_id}
                      chat={chat}
                      className="w-10 h-10 shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-start justify-between gap-2 mb-0.5">
                        <div className="font-medium text-sm truncate min-w-0 flex items-center gap-1.5 flex-wrap">
                          <span className="truncate">{getChatDisplayName(chat)}</span>
                          <span className="shrink-0 text-[10px] font-normal px-1.5 py-0.5 rounded bg-primary/15 text-primary">
                            {t('messaging.badgeLead')}
                          </span>
                        </div>
                        <span className="text-xs text-muted-foreground flex-shrink-0">
                          {formatTime(chat.last_message_at)}
                        </span>
                      </div>
                      {chat.lead_id && (chat.lead_pipeline_name != null || chat.lead_stage_name != null) && (
                        <div className="flex flex-col gap-0 text-[11px] text-muted-foreground mb-0.5">
                          {chat.lead_pipeline_name != null && <span className="truncate">{chat.lead_pipeline_name}</span>}
                          {chat.lead_stage_name != null && <span className="truncate">{chat.lead_stage_name}</span>}
                        </div>
                      )}
                      <div className="text-sm text-muted-foreground truncate min-w-0">
                        {chat.last_message === '[Media]' ? t('messaging.mediaPreview') : (chat.last_message || t('messaging.noMessages'))}
                      </div>
                      {chat.unread_count > 0 && (
                        <span className="mt-1 inline-flex items-center justify-center bg-primary text-primary-foreground text-xs rounded-full min-w-[1.25rem] h-5 px-1.5 w-fit">
                          {chat.unread_count}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          ) : (
          <>
          {!accountSyncReady && (
            <div className="text-xs text-muted-foreground bg-amber-500/10 dark:bg-amber-500/20 border border-amber-500/30 rounded-md mx-3 mt-2 px-2.5 py-1.5 flex items-center gap-2 overflow-hidden shrink-0">
              {accountSyncProgress ? (
                <span className="truncate">
                  Синхронизация: {accountSyncProgress.done} / {accountSyncProgress.total}
                </span>
              ) : isSelectedAccountMine ? (
                <div className="flex flex-col gap-1 min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate flex-1 min-w-0">{t('messaging.selectChatsSync')}</span>
                    <button
                      type="button"
                      onClick={() => window.location.href = `/dashboard/bd-accounts?accountId=${selectedAccountId}&openSelectChats=1`}
                      className="text-primary font-medium shrink-0 hover:underline"
                    >
                      {t('messaging.configure')}
                    </button>
                  </div>
                  <span className="text-[11px] text-muted-foreground/90">{t('messaging.syncSafetyShort')}</span>
                </div>
              ) : (
                <span className="truncate">{t('messaging.colleagueAccountHint')}</span>
              )}
            </div>
          )}

        {/* Область списка чатов / загрузки: flex-1 min-h-0 — одна высота; лоадер в центре без дёргания при смене аккаунта */}
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col relative scroll-thin-overlay">
          {loadingChats ? (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <Loader2 className="w-6 h-6 animate-spin text-blue-600 shrink-0" aria-hidden />
            </div>
          ) : null}
          {!loadingChats && !accountSyncReady ? (
            <div className="p-4 flex flex-1 min-h-0 flex-col items-center justify-center text-center text-sm text-muted-foreground">
              {accountSyncProgress ? (
                <span>{t('messaging.waitingSync')}</span>
              ) : isSelectedAccountMine ? (
                <>
                  <p className="mb-2">{t('messaging.accountNeedsSync')}</p>
                  <p className="text-xs text-muted-foreground mb-3 max-w-xs">{t('messaging.syncSafetyShort')}</p>
                  <Button
                    size="sm"
                    onClick={() => window.location.href = `/dashboard/bd-accounts?accountId=${selectedAccountId}&openSelectChats=1`}
                  >
                    {t('messaging.selectChatsAndStartSync')}
                  </Button>
                </>
              ) : (
                <p>{t('messaging.colleagueSyncOwner')}</p>
              )}
            </div>
          ) : !loadingChats && displayChats.length === 0 ? (
            <div className="flex-1 min-h-0 flex items-center justify-center p-4">
              <EmptyState
                icon={MessageSquare}
                title={t('messaging.noChats')}
                description={t('messaging.noChatsDesc')}
                action={
                  <Link href="/dashboard/bd-accounts">
                    <Button>{t('messaging.noChatsCta')}</Button>
                  </Link>
                }
              />
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
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData('application/json', JSON.stringify({ bdAccountId: selectedAccountId, chat }));
                  e.dataTransfer.effectAllowed = 'move';
                }}
                onClick={() => setSelectedChat(chat)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  if (!selectedAccountId) return;
                  setAccountContextMenu(null);
                  setMessageContextMenu(null);
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
                  <div className="flex items-start justify-between gap-2 mb-0.5">
                    <div className="font-medium text-sm truncate min-w-0 flex items-center gap-1.5 flex-wrap">
                      <span className="truncate">{getChatNameWithOverrides(chat)}</span>
                      <span className={`shrink-0 text-[10px] font-normal px-1.5 py-0.5 rounded ${chat.lead_id ? 'bg-primary/15 text-primary' : 'text-muted-foreground'}`}>
                        {chat.lead_id ? t('messaging.badgeLead') : t('messaging.badgeContact')}
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground flex-shrink-0">
                      {formatTime(chat.last_message_at)}
                    </span>
                  </div>
                  {chat.lead_id && (chat.lead_pipeline_name != null || chat.lead_stage_name != null) && (
                    <div className="flex flex-col gap-0 text-[11px] text-muted-foreground mb-0.5">
                      {chat.lead_pipeline_name != null && <span className="truncate">{chat.lead_pipeline_name}</span>}
                      {chat.lead_stage_name != null && <span className="truncate">{chat.lead_stage_name}</span>}
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm text-muted-foreground truncate min-w-0">
                      {chat.last_message === '[Media]' ? t('messaging.mediaPreview') : (chat.last_message || t('messaging.noMessages'))}
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
          </>
          )}
          </div>
          </div>
        </>
        )}
      </div>

      {/* Chat + Lead Panel: центр — чат, справа — Lead Panel при lead_id (§11б) */}
      <div className="flex flex-1 min-h-0 min-w-0 self-stretch h-full overflow-hidden">
        <div className="flex-1 min-h-0 min-w-0 flex flex-col bg-background overflow-hidden">
        {selectedChat ? (
          <>
            <div className="relative z-10 px-4 py-3 border-b border-border bg-card/95 backdrop-blur-sm shrink-0 min-h-[3.5rem] flex flex-col justify-center">
              <div className="flex items-center justify-between gap-2 min-h-[2rem]">
                <div className="min-w-0 flex-1">
                  <div className="font-semibold truncate flex items-center gap-2">
                    {getChatNameWithOverrides(selectedChat)}
                    {isLead && !isLeadPanelOpen && (
                      <button
                        type="button"
                        onClick={() => setLeadPanelOpen(true)}
                        className="shrink-0 text-[10px] font-normal px-1.5 py-0.5 rounded bg-primary/15 text-primary hover:bg-primary/25"
                        title={t('messaging.leadPanelOpen')}
                      >
                        {t('messaging.badgeLead')}
                      </button>
                    )}
                    {selectedChat.peer_type === 'user' && (() => {
                      const st = userStatusByUserId[selectedChat.channel_id];
                      if (st?.status === 'UserStatusOnline') return <span className="inline-block w-2 h-2 rounded-full bg-green-500 shrink-0" title={t('messaging.online')} aria-label={t('messaging.online')} />;
                      if (st?.status === 'UserStatusOffline' && st?.expires && st.expires > 0) return <span className="text-xs text-muted-foreground" title={t('messaging.recently')}>{t('messaging.recently')}</span>;
                      return null;
                    })()}
                  </div>
                  {selectedChat.telegram_id && (
                    <div className="text-xs text-muted-foreground truncate">ID: {selectedChat.telegram_id}</div>
                  )}
                  {typingChannelId === selectedChat.channel_id && (
                    <div className="text-xs text-primary mt-0.5 animate-pulse">{t('messaging.typing')}</div>
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
                    <div
                      className="absolute right-0 top-full mt-1 py-1 bg-card border border-border rounded-lg shadow-lg min-w-[180px] z-[100]"
                      role="menu"
                    >
                      <button
                        type="button"
                        onClick={() => { setShowChatHeaderMenu(false); openEditNameModal(); }}
                        disabled={!selectedChat.contact_id}
                        className="w-full px-4 py-2 text-left text-sm hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed flex items-center gap-2"
                        role="menuitem"
                      >
                        <UserCircle className="w-4 h-4 shrink-0" />
                        {selectedChat.contact_id ? t('messaging.changeContactName') : t('messaging.noContact')}
                      </button>
                      {selectedChat.contact_id && (
                        <button
                          type="button"
                          onClick={() => {
                            setShowChatHeaderMenu(false);
                            setAddToFunnelFromChat({
                              contactId: selectedChat.contact_id!,
                              contactName: getChatNameWithOverrides(selectedChat),
                              dealTitle: getChatNameWithOverrides(selectedChat),
                              bdAccountId: selectedAccountId ?? undefined,
                              channel: selectedChat.channel,
                              channelId: selectedChat.channel_id,
                            });
                          }}
                          className="w-full px-4 py-2 text-left text-sm hover:bg-accent flex items-center gap-2"
                          role="menuitem"
                        >
                          <Filter className="w-4 h-4 shrink-0" />
                          {t('pipeline.addToFunnel')}
                        </button>
                      )}
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
                    placeholder={t('messaging.enterName')}
                    className="mb-4"
                  />
                  <div className="flex justify-end gap-2">
                    <Button variant="outline" onClick={() => setShowEditNameModal(false)} disabled={savingDisplayName}>
                      Отмена
                    </Button>
                    <Button onClick={saveDisplayName} disabled={savingDisplayName}>
                      {savingDisplayName ? <Loader2 className="w-4 h-4 animate-spin" /> : t('common.save')}
                    </Button>
                  </div>
                </div>
              </div>
            )}

            <div className="relative flex-1 min-h-0 flex flex-col">
              <div ref={messagesScrollRef} className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden pl-4 pt-4 pb-4 pr-[10px] bg-muted/20 flex flex-col scroll-thin">
              {channelNeedsRefresh === selectedChat?.channel_id && (
                <div className="flex items-center justify-between gap-2 py-2 px-3 mb-2 rounded-lg bg-amber-500/15 border border-amber-500/40 text-sm">
                  <span className="text-foreground">{t('messaging.channelTooLongBanner')}</span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setChannelNeedsRefresh(null);
                      loadOlderMessages();
                    }}
                  >
                    {t('messaging.refreshHistory')}
                  </Button>
                </div>
              )}
              {selectedChat && lastLoadedChannelId !== selectedChat.channel_id ? (
                <div className="flex items-center justify-center h-full">
                  <Loader2 className="w-6 h-6 animate-spin text-blue-600" />
                </div>
              ) : loadingMessages ? (
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
                <div key={`virtuoso-${selectedChat?.channel_id ?? 'none'}-${lastLoadedChannelId ?? 'none'}`} className="flex-1 min-h-0 flex flex-col w-full max-w-3xl mx-auto">
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
                    followOutput="auto"
                    initialTopMostItemIndex={{ index: Math.max(0, messages.length - 1), align: 'end' }}
                    atBottomStateChange={(atBottom) => {
                      if (atBottom) setShowScrollToBottomButton(false);
                    }}
                    rangeChanged={(range) => {
                      if (range.endIndex < messages.length - 10) setShowScrollToBottomButton(true);
                    }}
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
              {showScrollToBottomButton && messages.length > 0 && (
                <button
                  type="button"
                  onClick={scrollToLastMessage}
                  className="absolute bottom-4 right-6 z-10 p-2 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 transition-colors focus:outline-none focus:ring-2 focus:ring-ring"
                  title={t('messaging.scrollToBottom', 'Вниз к последнему сообщению')}
                  aria-label={t('messaging.scrollToBottom', 'Вниз к последнему сообщению')}
                >
                  <ChevronDown className="w-5 h-5" />
                </button>
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
                    <span>{t('messaging.fromScript')}</span>
                  </button>
                  <button
                    onClick={handleInsertPrevious}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-accent transition-colors"
                  >
                    <History className="w-4 h-4 text-purple-600" />
                    <span>{t('messaging.previous')}</span>
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
                    <span>{t('messaging.automation')}</span>
                  </button>
                  <button
                    onClick={handleCreateContact}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-accent transition-colors"
                  >
                    <UserCircle className="w-4 h-4 text-green-600" />
                    <span>{t('messaging.createContact')}</span>
                  </button>
                  <button
                    onClick={handleAddTag}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-accent transition-colors"
                  >
                    <Tag className="w-4 h-4 text-indigo-600" />
                    <span>{t('messaging.addTag')}</span>
                  </button>
                  <button
                    onClick={handleViewAnalytics}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-accent transition-colors"
                  >
                    <BarChart3 className="w-4 h-4 text-cyan-600" />
                    <span>{t('nav.analytics')}</span>
                  </button>
                  <button
                    onClick={handleScheduleMessage}
                    className="flex items-center gap-2 px-3 py-1.5 text-sm bg-card border border-border rounded-lg hover:bg-accent transition-colors"
                  >
                    <Clock className="w-4 h-4 text-pink-600" />
                    <span>{t('messaging.schedule')}</span>
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
                    title={t('messaging.removeFile')}
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
                    title={t('messaging.attachFile')}
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
                        <span>{t('messaging.photo')}</span>
                      </button>
                      <button
                        onClick={() => handleAttachFile('video')}
                        className="w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-accent rounded-lg transition-colors"
                      >
                        <Video className="w-4 h-4 text-red-600" />
                        <span>{t('messaging.video')}</span>
                      </button>
                      <button
                        onClick={() => handleAttachFile('file')}
                        className="w-full flex items-center gap-3 px-3 py-2 text-sm hover:bg-accent rounded-lg transition-colors"
                      >
                        <File className="w-4 h-4 text-muted-foreground" />
                        <span>{t('messaging.file')}</span>
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
                  title={t('messaging.voiceMessage')}
                >
                  <Mic className="w-5 h-5" />
                </button>

                {/* Превью ответа (reply) — как в Telegram */}
                {replyToMessage && (
                  <div className="flex items-center gap-2 mb-2 py-1.5 px-3 rounded-lg bg-muted/60 border-l-2 border-primary text-sm">
                    <Reply className="w-4 h-4 text-primary shrink-0" />
                    <span className="text-muted-foreground truncate flex-1 min-w-0">
                      {(replyToMessage.content ?? '').trim().slice(0, 80) || t('messaging.replyPreviewMedia')}
                      {(replyToMessage.content ?? '').trim().length > 80 ? '…' : ''}
                    </span>
                    <button
                      type="button"
                      onClick={() => setReplyToMessage(null)}
                      className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground shrink-0"
                      title={t('common.close')}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                )}
                {/* Поле ввода как в Telegram: textarea с авто-высотой, Enter — отправить, Shift+Enter — новая строка */}
                <div className="flex-1 relative flex items-end min-h-[40px]">
                  <textarea
                    ref={messageInputRef}
                    placeholder={isSelectedAccountMine ? t('messaging.writeMessage') : t('messaging.colleagueViewOnly')}
                    value={newMessage}
                    onChange={(e) => setNewMessage(e.target.value)}
                    onPaste={(e) => {
                      const items = e.clipboardData?.items;
                      if (!items?.length || !isSelectedAccountMine) return;
                      for (let i = 0; i < items.length; i++) {
                        const item = items[i];
                        if (item.kind === 'file') {
                          const file = item.getAsFile();
                          if (file?.type.startsWith('image/')) {
                            e.preventDefault();
                            setPendingFile(file);
                            return;
                          }
                        }
                      }
                    }}
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
                    title={t('messaging.crmCommands')}
                  >
                    <Bot className="w-4 h-4" />
                  </button>
                </div>

                {/* Кнопка отправки (только для своего аккаунта) */}
                <Button
                  onClick={handleSendMessage}
                  disabled={!isSelectedAccountMine || (!newMessage.trim() && !pendingFile) || sendingMessage}
                  className="px-4"
                  title={!isSelectedAccountMine ? t('messaging.onlyOwnerCanSend') : undefined}
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
                  <span>{t('messaging.recordingVoice')}</span>
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
                  <span>{t('messaging.botCommandsHint')}</span>
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

        {/* PHASE 2.2 — Lead Panel: только при lead_id, 4 блока по §11б */}
        {isLead && isLeadPanelOpen && (
          <div className="w-[280px] shrink-0 border-l border-border bg-card flex flex-col min-h-0 overflow-hidden">
            {/* Block 1 — Header */}
            <div className="shrink-0 px-3 py-3 border-b border-border flex items-start justify-between gap-2">
              <div className="min-w-0 flex-1">
                <div className="font-semibold text-base truncate text-foreground">
                  {leadContext?.contact_name || getChatNameWithOverrides(selectedChat!)}
                </div>
                <span className="inline-block mt-1 text-[10px] font-normal px-1.5 py-0.5 rounded bg-primary/15 text-primary">
                  {t('messaging.badgeLead')}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setLeadPanelOpen(false)}
                className="p-1.5 rounded text-muted-foreground hover:bg-accent hover:text-foreground shrink-0"
                title={t('messaging.leadPanelClose')}
                aria-label={t('messaging.leadPanelClose')}
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {leadContextLoading ? (
              <div className="flex-1 flex items-center justify-center p-4">
                <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
              </div>
            ) : leadContextError ? (
              <div className="p-3 text-sm text-destructive">{leadContextError}</div>
            ) : leadContext ? (
              <>
                {/* Block 2 — Pipeline + Stage */}
                <div className="shrink-0 px-3 py-3 border-b border-border space-y-2">
                  <div className="text-sm font-medium text-foreground truncate">{leadContext.pipeline.name}</div>
                  <select
                    value={leadContext.stage.id}
                    onChange={(e) => handleLeadStageChange(e.target.value)}
                    disabled={leadStagePatching}
                    className="w-full text-sm rounded-md border border-input bg-background px-2 py-1.5 text-foreground"
                  >
                    {leadContext.stages.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                  {leadStagePatching && (
                    <div className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span>…</span>
                    </div>
                  )}
                </div>

                {/* Block 3 — Source + PHASE 2.5 «Создать общий чат» */}
                {(leadContext.campaign != null || leadContext.became_lead_at) && (
                  <div className="shrink-0 px-3 py-3 border-b border-border space-y-2 text-sm text-muted-foreground">
                    {leadContext.campaign != null && (
                      <div className="truncate">
                        {t('messaging.leadPanelCampaign')}: {leadContext.campaign.name}
                      </div>
                    )}
                    {leadContext.became_lead_at && (
                      <div>
                        {formatLeadPanelDate(leadContext.became_lead_at)}
                      </div>
                    )}
                    {leadContext.campaign != null && !leadContext.shared_chat_created_at && (
                      <button
                        type="button"
                        onClick={() => {
                          const template = leadContext.shared_chat_settings?.titleTemplate ?? 'Чат: {{contact_name}}';
                          const title = template.replace(/\{\{\s*contact_name\s*\}\}/gi, (leadContext.contact_name || 'Контакт').trim()).trim() || `Чат: ${leadContext.contact_name || 'Контакт'}`;
                          setCreateSharedChatTitle(title);
                          setCreateSharedChatExtraUsernames(leadContext.shared_chat_settings?.extraUsernames ?? []);
                          setCreateSharedChatModalOpen(true);
                        }}
                        className="text-left w-full px-2 py-1.5 rounded-md bg-primary/10 text-primary hover:bg-primary/20 text-xs font-medium"
                      >
                        {t('messaging.createSharedChat')}
                      </button>
                    )}
                    {leadContext.campaign != null && leadContext.shared_chat_created_at && (
                      <div className="space-y-1.5 pt-0.5">
                        <div className="text-emerald-600 dark:text-emerald-400 text-xs font-medium">
                          ✓ {t('messaging.sharedChatCreated', 'Общий чат создан')}
                        </div>
                        {leadContext.shared_chat_channel_id && (
                          <a
                            href={(() => {
                              const s = String(leadContext.shared_chat_channel_id!);
                              const id = s.startsWith('-100') ? s.slice(4) : s.replace(/^-/, '');
                              return `https://t.me/c/${id}`;
                            })()}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                          >
                            🔗 {t('messaging.openInTelegram', 'Открыть в Telegram')}
                          </a>
                        )}
                      </div>
                    )}
                    {/* PHASE 2.7 — Won / Lost: кнопки только если shared и ещё не закрыто */}
                    {leadContext.shared_chat_created_at && !leadContext.won_at && !leadContext.lost_at && (
                      <div className="flex flex-col gap-1.5 pt-1">
                        <button
                          type="button"
                          onClick={() => { setMarkWonRevenue(''); setMarkWonModalOpen(true); }}
                          className="text-left w-full px-2 py-1.5 rounded-md bg-emerald-500/15 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-500/25 text-xs font-medium"
                        >
                          ✓ {t('messaging.markWon', 'Закрыть сделку (Won)')}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setMarkLostReason(''); setMarkLostModalOpen(true); }}
                          className="text-left w-full px-2 py-1.5 rounded-md bg-muted text-muted-foreground hover:bg-destructive/10 hover:text-destructive text-xs font-medium"
                        >
                          ✕ {t('messaging.markLost', 'Отметить как потеряно (Lost)')}
                        </button>
                      </div>
                    )}
                    {leadContext.won_at && (
                      <div className="pt-1 text-xs font-medium text-emerald-600 dark:text-emerald-400">
                        ✓ {t('messaging.dealWon', 'Сделка закрыта')}
                        {leadContext.revenue_amount != null && leadContext.revenue_amount > 0 && (
                          <span className="ml-1"> — {leadContext.revenue_amount} €</span>
                        )}
                      </div>
                    )}
                    {leadContext.lost_at && (
                      <div className="pt-1 text-xs text-muted-foreground">
                        ✕ {t('messaging.dealLost', 'Сделка потеряна')}
                        {leadContext.loss_reason && (
                          <div className="mt-0.5 text-[11px] opacity-90">{leadContext.loss_reason}</div>
                        )}
                      </div>
                    )}
                  </div>
                )}

                {/* Block 4 — Timeline */}
                <div className="flex-1 min-h-0 overflow-y-auto px-3 py-3 space-y-2">
                  {leadContext.timeline.length === 0 ? (
                    <div className="text-xs text-muted-foreground">—</div>
                  ) : (
                    leadContext.timeline.map((ev, i) => (
                      <div key={i} className="text-xs text-muted-foreground">
                        <span className="text-[10px] tabular-nums">{formatLeadPanelDate(ev.created_at)}</span>
                        {' — '}
                        {ev.type === 'lead_created' && t('messaging.timelineLeadCreated')}
                        {ev.type === 'stage_changed' && t('messaging.timelineStageChanged', { name: ev.stage_name ?? '' })}
                        {ev.type === 'deal_created' && t('messaging.timelineDealCreated')}
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : null}
          </div>
        )}
      </div>

      {/* Модалка создания общего чата в Telegram */}
      <Modal
        isOpen={createSharedChatModalOpen}
        onClose={() => setCreateSharedChatModalOpen(false)}
        title={t('messaging.createSharedChatModalTitle', 'Создать общий чат в Telegram')}
        size="md"
      >
        <div className="px-6 py-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('messaging.createSharedChatModalDesc', 'Будет создана группа в Telegram с текущим BD-аккаунтом, лидом и указанными участниками.')}
          </p>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">{t('messaging.sharedChatTitle', 'Название чата')}</label>
            <Input
              value={createSharedChatTitle}
              onChange={(e) => setCreateSharedChatTitle(e.target.value)}
              placeholder={t('messaging.sharedChatTitlePlaceholder', 'Чат: Имя контакта')}
              className="w-full"
              maxLength={255}
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">{t('messaging.sharedChatParticipants', 'Участники')}</label>
            <div className="text-xs text-muted-foreground mb-1.5">
              {t('messaging.sharedChatLeadParticipant', 'Лид')}: {leadContext?.contact_username ? `@${leadContext.contact_username}` : leadContext?.contact_name || '—'}
            </div>
            <div className="flex flex-wrap gap-2">
              {(createSharedChatExtraUsernames).map((u, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-1 text-sm">
                  @{u}
                  <button
                    type="button"
                    onClick={() => setCreateSharedChatExtraUsernames((prev) => prev.filter((_, j) => j !== i))}
                    className="text-muted-foreground hover:text-destructive"
                    aria-label={t('messaging.remove')}
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                </span>
              ))}
              <input
                type="text"
                placeholder={t('messaging.sharedChatAddUsername', 'Добавить @username')}
                className="rounded-md border border-border bg-background px-2 py-1 text-sm w-36 focus:outline-none focus:ring-2 focus:ring-primary"
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    const v = (e.target as HTMLInputElement).value.trim().replace(/^@/, '');
                    if (v) {
                      setCreateSharedChatExtraUsernames((prev) => (prev.includes(v) ? prev : [...prev, v]));
                      (e.target as HTMLInputElement).value = '';
                    }
                  }
                }}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setCreateSharedChatModalOpen(false)} disabled={createSharedChatSubmitting}>
              {t('global.cancel', 'Отмена')}
            </Button>
            <Button
              onClick={async () => {
                if (!leadContext) return;
                setCreateSharedChatSubmitting(true);
                try {
                  await apiClient.post('/api/messaging/create-shared-chat', {
                    conversation_id: leadContext.conversation_id,
                    title: createSharedChatTitle.trim() || undefined,
                    participant_usernames: createSharedChatExtraUsernames,
                  });
                  const res = await apiClient.get<LeadContext>(`/api/messaging/conversations/${leadContext.conversation_id}/lead-context`);
                  setLeadContext(res.data);
                  setCreateSharedChatModalOpen(false);
                } catch (e: unknown) {
                  const status = (e as { response?: { status?: number } })?.response?.status;
                  if (status === 409) {
                    const res = await apiClient.get<LeadContext>(`/api/messaging/conversations/${leadContext.conversation_id}/lead-context`);
                    setLeadContext(res.data);
                    setCreateSharedChatModalOpen(false);
                  } else {
                    console.error('create-shared-chat failed', e);
                  }
                } finally {
                  setCreateSharedChatSubmitting(false);
                }
              }}
              disabled={createSharedChatSubmitting}
            >
              {createSharedChatSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {createSharedChatSubmitting ? t('messaging.creating', 'Создание…') : t('messaging.createSharedChat', 'Создать общий чат')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* PHASE 2.7 — Закрыть сделку (Won) */}
      <Modal
        isOpen={markWonModalOpen}
        onClose={() => !markWonSubmitting && setMarkWonModalOpen(false)}
        title={t('messaging.markWonModalTitle', 'Закрыть сделку')}
        size="sm"
      >
        <div className="px-6 py-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('messaging.markWonConfirm', 'Действие необратимо. В диалог будет добавлено системное сообщение.')}
          </p>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">{t('messaging.revenueAmount', 'Сумма сделки')}</label>
            <input
              type="number"
              min="0"
              step="0.01"
              value={markWonRevenue}
              onChange={(e) => setMarkWonRevenue(e.target.value)}
              placeholder="0"
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground"
            />
            <p className="text-xs text-muted-foreground mt-1">€</p>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setMarkWonModalOpen(false)} disabled={markWonSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button
              onClick={async () => {
                if (!leadContext) return;
                const amount = markWonRevenue.trim() ? parseFloat(markWonRevenue.replace(',', '.')) : null;
                if (amount != null && (Number.isNaN(amount) || amount < 0)) return;
                setMarkWonSubmitting(true);
                try {
                  await apiClient.post('/api/messaging/mark-won', {
                    conversation_id: leadContext.conversation_id,
                    ...(amount != null && !Number.isNaN(amount) ? { revenue_amount: amount } : {}),
                  });
                  const res = await apiClient.get<LeadContext>(`/api/messaging/conversations/${leadContext.conversation_id}/lead-context`);
                  setLeadContext(res.data);
                  setMarkWonModalOpen(false);
                } catch (e) {
                  console.error('mark-won failed', e);
                } finally {
                  setMarkWonSubmitting(false);
                }
              }}
              disabled={markWonSubmitting}
            >
              {markWonSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {markWonSubmitting ? t('common.saving') : t('messaging.closeDeal', 'Закрыть сделку')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* PHASE 2.7 — Отметить как потеряно (Lost) */}
      <Modal
        isOpen={markLostModalOpen}
        onClose={() => !markLostSubmitting && setMarkLostModalOpen(false)}
        title={t('messaging.markLostModalTitle', 'Отметить как потеряно')}
        size="sm"
      >
        <div className="px-6 py-4 space-y-4">
          <p className="text-sm text-muted-foreground">
            {t('messaging.markLostConfirm', 'Действие необратимо. В диалог будет добавлено системное сообщение.')}
          </p>
          <div>
            <label className="block text-sm font-medium text-foreground mb-1.5">{t('messaging.lossReason', 'Причина (необязательно)')}</label>
            <textarea
              value={markLostReason}
              onChange={(e) => setMarkLostReason(e.target.value)}
              placeholder={t('messaging.lossReasonPlaceholder', 'Например: отказ, не вышли на связь')}
              rows={3}
              className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground resize-none"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="outline" onClick={() => setMarkLostModalOpen(false)} disabled={markLostSubmitting}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={async () => {
                if (!leadContext) return;
                setMarkLostSubmitting(true);
                try {
                  await apiClient.post('/api/messaging/mark-lost', {
                    conversation_id: leadContext.conversation_id,
                    reason: markLostReason.trim() || undefined,
                  });
                  const res = await apiClient.get<LeadContext>(`/api/messaging/conversations/${leadContext.conversation_id}/lead-context`);
                  setLeadContext(res.data);
                  setMarkLostModalOpen(false);
                } catch (e) {
                  console.error('mark-lost failed', e);
                } finally {
                  setMarkLostSubmitting(false);
                }
              }}
              disabled={markLostSubmitting}
            >
              {markLostSubmitting ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {markLostSubmitting ? t('common.saving') : t('messaging.markAsLost', 'Отметить как потеряно')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Контекстные меню и модалки — всегда в DOM, чтобы ПКМ работал и без выбранного чата */}
      <ContextMenu
        open={!!(chatContextMenu && selectedAccountId)}
        onClose={() => setChatContextMenu(null)}
        x={chatContextMenu?.x ?? 0}
        y={chatContextMenu?.y ?? 0}
        className="min-w-[180px]"
        estimatedHeight={320}
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
            {chatContextMenu.chat.contact_id && (
              <ContextMenuItem
                icon={<Filter className="w-4 h-4" />}
                label={t('pipeline.addToFunnel')}
                onClick={() => {
                  setChatContextMenu(null);
                  setAddToFunnelFromChat({
                    contactId: chatContextMenu.chat.contact_id!,
                    contactName: getChatNameWithOverrides(chatContextMenu.chat),
                    dealTitle: getChatNameWithOverrides(chatContextMenu.chat),
                    bdAccountId: selectedAccountId ?? undefined,
                    channel: chatContextMenu.chat.channel,
                    channelId: chatContextMenu.chat.channel_id,
                  });
                }}
              />
            )}
            <ContextMenuSection label={t('messaging.addToFolder')}>
              <ContextMenuItem
                label={t('messaging.folderNone')}
                onClick={() => handleChatFoldersClear(chatContextMenu.chat)}
              />
              {displayFolders.filter((f) => f.folder_id !== 0).length === 0 ? (
                <ContextMenuItem label={t('messaging.folderNoFolders')} disabled />
              ) : (
                displayFolders
                  .filter((f) => f.folder_id !== 0)
                  .map((f) => {
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
        hideEmptyFolders={hideEmptyFolders}
        onHideEmptyFoldersChange={setHideEmptyFolders}
        onCreateFolder={handleCreateFolder}
        onReorder={handleReorderFolders}
        onUpdateFolder={handleUpdateFolder}
        onDeleteFolder={handleDeleteFolder}
        onFolderDeleted={handleFolderDeleted}
      />

      <AddToFunnelModal
        isOpen={!!addToFunnelFromChat}
        onClose={() => setAddToFunnelFromChat(null)}
        contactId={addToFunnelFromChat?.contactId ?? ''}
        contactName={addToFunnelFromChat?.contactName}
        dealTitle={addToFunnelFromChat?.dealTitle}
        bdAccountId={addToFunnelFromChat?.bdAccountId}
        channel={addToFunnelFromChat?.channel}
        channelId={addToFunnelFromChat?.channelId}
        defaultPipelineId={typeof window !== 'undefined' ? window.localStorage.getItem('pipeline.selectedPipelineId') : null}
      />

      {broadcastModalOpen && selectedAccountId && (
        <BroadcastToGroupsModal
          accountId={selectedAccountId}
          accountName={accounts.find((a) => a.id === selectedAccountId) ? getAccountDisplayName(accounts.find((a) => a.id === selectedAccountId)!) : ''}
          onClose={() => setBroadcastModalOpen(false)}
          t={t}
        />
      )}

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

      <ContextMenu
        open={!!messageContextMenu}
        onClose={() => setMessageContextMenu(null)}
        x={messageContextMenu?.x ?? 0}
        y={messageContextMenu?.y ?? 0}
        className="min-w-[180px]"
        estimatedHeight={320}
      >
        {messageContextMenu && (
          <>
            <ContextMenuItem
              icon={<Reply className="w-4 h-4" />}
              label={t('messaging.reply')}
              onClick={() => handleReplyToMessage(messageContextMenu.message)}
            />
            <ContextMenuItem
              icon={<Forward className="w-4 h-4" />}
              label={t('messaging.forward')}
              onClick={() => handleForwardMessage(messageContextMenu.message)}
            />
            <ContextMenuItem
              icon={<Copy className="w-4 h-4" />}
              label={t('messaging.copyText')}
              onClick={() => handleCopyMessageText(messageContextMenu.message)}
            />
            <ContextMenuItem
              icon={<Heart className="w-4 h-4" />}
              label={
                messageContextMenu.message.reactions?.['❤️']
                  ? t('messaging.unlike')
                  : t('messaging.like')
              }
              onClick={() => handleReaction(messageContextMenu.message.id, '❤️')}
            />
            <ContextMenuSection label={t('messaging.reaction')}>
              <div className="flex flex-wrap gap-1 px-2 pb-2">
                {REACTION_EMOJI.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="p-1.5 rounded hover:bg-accent text-lg leading-none"
                    onClick={() => handleReaction(messageContextMenu.message.id, emoji)}
                    title={emoji}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            </ContextMenuSection>
            <div className="border-t border-border my-1" />
            <ContextMenuItem
              icon={deletingMessageId === messageContextMenu.message.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              label={t('messaging.deleteMessage')}
              destructive
              onClick={() => handleDeleteMessage(messageContextMenu.message.id)}
              disabled={deletingMessageId === messageContextMenu.message.id}
            />
          </>
        )}
      </ContextMenu>

      {/* Панель ИИ-помощника справа — ширина и стили как у левых панелей (w-16 свернута, w-[320px] развернута) */}
      <div
        className={`h-full min-h-0 self-stretch bg-card border-l border-border flex flex-col transition-[width] duration-200 shrink-0 ${aiPanelExpanded ? 'w-[320px]' : 'w-16'}`}
        aria-expanded={aiPanelExpanded}
      >
        {aiPanelExpanded ? (
          <>
            <div className="flex items-center justify-between gap-2 p-3 border-b border-border shrink-0 min-h-[3.5rem]">
              <h3 className="font-semibold text-foreground truncate flex-1 min-w-0">{t('messaging.aiAssistant')}</h3>
              <button
                type="button"
                onClick={() => setAiPanelExpandedStored(false)}
                className="p-1.5 rounded-md text-muted-foreground hover:bg-accent shrink-0"
                title={t('messaging.collapsePanel')}
                aria-label={t('messaging.collapseAiPanelAria')}
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto flex flex-col p-3">
              {aiSummaryText !== null && (
                <div className="mb-3 p-3 rounded-lg border border-border bg-muted/20">
                  <div className="flex items-center gap-2 mb-1.5">
                    <FileText className="w-4 h-4 text-primary shrink-0" />
                    <span className="font-medium text-sm">{t('messaging.aiSummary')}</span>
                  </div>
                  <p className="text-sm text-foreground whitespace-pre-wrap">{aiSummaryText}</p>
                </div>
              )}
              <p className="text-xs text-muted-foreground mb-3">
                {t('messaging.aiCommandsPlaceholder')}
              </p>
              <div className="space-y-2">
                {[
                  { icon: FileText, labelKey: 'aiSummary', descKey: 'aiSummaryDesc', action: 'summary' as const },
                  { icon: Send, labelKey: 'aiCompose', descKey: 'aiComposeDesc', action: null },
                  { icon: Bot, labelKey: 'aiReplyForMe', descKey: 'aiReplyForMeDesc', action: null },
                  { icon: MessageSquare, labelKey: 'aiReplyIdeas', descKey: 'aiReplyIdeasDesc', action: null },
                  { icon: Zap, labelKey: 'aiTone', descKey: 'aiToneDesc', action: null },
                ].map(({ icon: Icon, labelKey, descKey, action }) => (
                  <button
                    key={labelKey}
                    type="button"
                    disabled={action === 'summary' && (!selectedChat || !messages.length || aiSummaryLoading)}
                    onClick={action === 'summary' ? async () => {
                      if (!selectedChat || messages.length === 0) return;
                      setAiSummaryError(null);
                      setAiSummaryLoading(true);
                      try {
                        const res = await apiClient.post<{ summary?: string; empty?: boolean }>('/api/ai/chat/summarize', {
                          messages: messages.map((m) => ({ content: m.content ?? '', role: m.direction === 'outbound' ? 'user' : 'assistant' })),
                        });
                        setAiSummaryText(res.data?.empty ? '' : (res.data?.summary ?? ''));
                      } catch (e: any) {
                        const code = e?.response?.data?.code;
                        const msg = e?.response?.data?.message || e?.message;
                        setAiSummaryError(code === 'OPENAI_NOT_CONFIGURED' ? t('messaging.aiNotConfigured') : msg);
                        setAiSummaryText(null);
                      } finally {
                        setAiSummaryLoading(false);
                      }
                    } : undefined}
                    className="w-full text-left p-3 rounded-lg border border-border bg-muted/30 hover:bg-muted/50 transition-colors flex gap-3 items-start disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {aiSummaryLoading && action === 'summary' ? (
                      <Loader2 className="w-4 h-4 text-primary shrink-0 mt-0.5 animate-spin" />
                    ) : (
                      <Icon className="w-4 h-4 text-primary shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="font-medium text-sm">{t(`messaging.${labelKey}`)}</div>
                      <div className="text-xs text-muted-foreground mt-0.5">
                        {action === 'summary' && aiSummaryError ? aiSummaryError : t(`messaging.${descKey}`)}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              <div className="mt-4 pt-4 border-t border-border">
                <p className="text-xs text-muted-foreground mb-2">{t('messaging.aiChatPlaceholder')}</p>
                <div className="rounded-lg border border-border bg-muted/20 p-3 min-h-[8rem] text-sm text-muted-foreground">
                  {t('messaging.aiChatStubText')}
                </div>
                <Input
                  placeholder={t('messaging.askAssistantPlaceholder')}
                  className="mt-2 text-sm"
                  disabled
                  readOnly
                />
              </div>
            </div>
          </>
        ) : (
          <div className="flex flex-col flex-1 min-h-0 w-full">
            <button
              type="button"
              onClick={() => setAiPanelExpandedStored(true)}
              className="p-2 rounded-md text-muted-foreground hover:bg-accent hover:text-foreground flex flex-col items-center gap-0.5 w-full shrink-0 border-b border-border"
              title={t('messaging.expandAiPanel')}
              aria-label={t('messaging.expandAiPanelAria')}
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

      {/* Модалка пересылки сообщения в чат */}
      {forwardModal && selectedAccountId && (
        <div
          className="fixed inset-0 bg-black/50 flex items-center justify-center z-50"
          onClick={() => !forwardingToChatId && setForwardModal(null)}
        >
          <div
            className="bg-card rounded-xl shadow-xl border border-border max-w-md w-full mx-4 max-h-[70vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-3 border-b border-border font-semibold">{t('messaging.forwardToChat')}</div>
            <div className="overflow-y-auto flex-1 min-h-0 p-2">
              {displayChats
                .filter((c) => c.channel_id !== selectedChat?.channel_id)
                .map((chat) => (
                  <button
                    key={chat.channel_id}
                    type="button"
                    onClick={() => handleForwardToChat(chat.channel_id)}
                    disabled={!!forwardingToChatId}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-accent text-left disabled:opacity-50"
                  >
                    <ChatAvatar bdAccountId={selectedAccountId} chatId={chat.channel_id} chat={chat} className="w-10 h-10" />
                    <span className="truncate flex-1">{getChatNameWithOverrides(chat)}</span>
                    {forwardingToChatId === chat.channel_id && <Loader2 className="w-4 h-4 animate-spin shrink-0" />}
                  </button>
                ))}
              {displayChats.filter((c) => c.channel_id !== selectedChat?.channel_id).length === 0 && (
                <p className="text-sm text-muted-foreground py-4 text-center">{t('messaging.noChats')}</p>
              )}
            </div>
            <div className="p-2 border-t border-border">
              <Button variant="outline" onClick={() => setForwardModal(null)} disabled={!!forwardingToChatId}>
                {t('common.cancel')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function BroadcastToGroupsModal({
  accountId,
  accountName,
  onClose,
  t,
}: {
  accountId: string;
  accountName: string;
  onClose: () => void;
  t: ReturnType<typeof useTranslation>['t'];
}) {
  const [groups, setGroups] = useState<GroupSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ sent: number; failed: { channelId: string; error: string }[] } | null>(null);

  useEffect(() => {
    fetchGroupSources()
      .then((list) => setGroups(list.filter((g) => g.bd_account_id === accountId)))
      .catch(() => setGroups([]))
      .finally(() => setLoading(false));
  }, [accountId]);

  const toggle = (telegramChatId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(telegramChatId)) next.delete(telegramChatId);
      else next.add(telegramChatId);
      return next;
    });
  };

  const handleSend = async () => {
    if (selectedIds.size === 0 || !text.trim()) return;
    setSending(true);
    setResult(null);
    try {
      const res = await apiClient.post<{ sent: number; failed: { channelId: string; error: string }[] }>(
        `/api/bd-accounts/${accountId}/send-bulk`,
        { channelIds: Array.from(selectedIds), text: text.trim() }
      );
      setResult(res.data);
    } catch (err: any) {
      setResult({ sent: 0, failed: [{ channelId: '', error: err?.response?.data?.message || err?.response?.data?.error || String(err) }] });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
      <div
        className="bg-card rounded-xl shadow-xl border border-border max-w-lg w-full mx-4 max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-4 border-b border-border font-semibold text-foreground">
          {t('messaging.broadcastToGroups', 'Рассылка в группы')} — {accountName}
        </div>
        <div className="flex-1 overflow-y-auto min-h-0 p-4 space-y-3">
          {loading ? (
            <div className="flex items-center justify-center py-8 text-muted-foreground">
              <Loader2 className="w-6 h-6 animate-spin" />
            </div>
          ) : groups.length === 0 ? (
            <p className="text-sm text-muted-foreground py-4">{t('messaging.noGroupsSynced', 'Нет групповых чатов')}</p>
          ) : (
            <>
              <p className="text-sm text-muted-foreground">{t('messaging.broadcastSelectGroups', 'Выберите группы и введите сообщение')}</p>
              <div className="max-h-48 overflow-y-auto border border-border rounded-lg divide-y divide-border">
                {groups.map((g) => (
                  <label
                    key={g.telegram_chat_id}
                    className="flex items-center gap-3 px-3 py-2 hover:bg-muted/30 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(g.telegram_chat_id)}
                      onChange={() => toggle(g.telegram_chat_id)}
                      className="rounded border-border"
                    />
                    <span className="text-sm text-foreground truncate flex-1">{g.title || g.telegram_chat_id}</span>
                  </label>
                ))}
              </div>
              <div>
                <label className="block text-sm font-medium text-foreground mb-1">{t('messaging.message', 'Сообщение')}</label>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder={t('messaging.typeMessage', 'Введите текст...')}
                  rows={4}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-background text-foreground text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
                />
              </div>
              {result && (
                <div className="p-3 rounded-lg bg-muted/50 text-sm text-foreground">
                  {t('messaging.sent', 'Отправлено')}: {result.sent}
                  {result.failed.length > 0 && (
                    <span className="text-destructive ml-2">{t('messaging.failed', 'Ошибки')}: {result.failed.length}</span>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <div className="p-4 border-t border-border flex gap-2 justify-end">
          <Button variant="outline" onClick={onClose}>{t('common.close')}</Button>
          <Button
            disabled={loading || selectedIds.size === 0 || !text.trim() || sending}
            onClick={handleSend}
          >
            {sending ? t('common.sending', 'Отправка...') : t('messaging.sendToGroups', 'Отправить в выбранные')}
          </Button>
        </div>
      </div>
    </div>
  );
}
