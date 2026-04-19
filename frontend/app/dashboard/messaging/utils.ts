import type { Chat, Message, MessageMediaType } from './types';
import { getBdAccountMediaProxyUrl } from '@/lib/api/bd-accounts';
import { getAccountDisplayName, getAccountInitials } from '@/lib/bd-account-display';

export { getAccountDisplayName, getAccountInitials };

// ─── Chat list mapping (API raw → Chat[], merge by channel_id, sort) ───

/** Map a single raw chat from /api/messaging/chats to Chat. */
export function mapRawChatToChat(chat: Record<string, unknown>): Chat {
  const folderIds = Array.isArray(chat.folder_ids)
    ? (chat.folder_ids as unknown[]).map((x) => Number(x)).filter((n) => !Number.isNaN(n))
    : chat.folder_id != null
      ? [Number(chat.folder_id)]
      : [];
  return {
    channel: (chat.channel as string) || 'telegram',
    channel_id: String(chat.channel_id),
    folder_id: chat.folder_id != null ? Number(chat.folder_id) : (folderIds[0] ?? null),
    folder_ids: folderIds.length > 0 ? folderIds : undefined,
    contact_id: (chat.contact_id as string) ?? null,
    first_name: (chat.first_name as string) ?? null,
    last_name: (chat.last_name as string) ?? null,
    email: (chat.email as string) ?? null,
    telegram_id: (chat.telegram_id as string) ?? null,
    display_name: (chat.display_name as string) ?? null,
    username: (chat.username as string) ?? null,
    name: (chat.name as string) ?? null,
    peer_type: (chat.peer_type as string) ?? null,
    unread_count: parseInt(String(chat.unread_count), 10) || 0,
    last_message_at:
      chat.last_message_at && String(chat.last_message_at).trim() ? String(chat.last_message_at) : '',
    last_message: (chat.last_message as string) ?? null,
    conversation_id: (chat.conversation_id as string) ?? null,
    lead_id: (chat.lead_id as string) ?? null,
    lead_stage_name: (chat.lead_stage_name as string) ?? null,
    lead_pipeline_name: (chat.lead_pipeline_name as string) ?? null,
    chat_title: (chat.chat_title as string) ?? null,
  };
}

/** Merge chats that share the same channel_id (prefer newer, aggregate unread_count), then sort by last_message_at desc. */
export function mergeAndSortChatsByChannelId(chats: Chat[]): Chat[] {
  const byChannelId = new Map<string, Chat>();
  const isIdOnly = (name: string | null, cid: string) =>
    !name || name.trim() === '' || name === cid || /^\d+$/.test(String(name).trim());
  for (const chat of chats) {
    const existing = byChannelId.get(chat.channel_id);
    const chatTime = new Date(chat.last_message_at).getTime();
    const existingTime = existing ? new Date(existing.last_message_at).getTime() : 0;
    const preferNew =
      !existing ||
      chatTime > existingTime ||
      (chatTime === existingTime &&
        isIdOnly(existing.name ?? existing.telegram_id ?? '', existing.channel_id) &&
        !isIdOnly(chat.name ?? chat.telegram_id ?? '', chat.channel_id));
    if (preferNew) {
      const merged = { ...chat };
      if (existing) merged.unread_count = (existing.unread_count || 0) + (merged.unread_count || 0);
      byChannelId.set(chat.channel_id, merged);
    } else if (existing) {
      existing.unread_count = (existing.unread_count || 0) + (chat.unread_count || 0);
    }
  }
  return Array.from(byChannelId.values()).sort((a, b) => {
    const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
    const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  });
}

function inferPeerTypeForDedupe(peerType: string | null | undefined, channelId: string): string {
  const cid = channelId.trim();
  if (!cid) return peerType ?? 'user';
  const isNegativeNumeric = /^-?\d+$/.test(cid) && parseInt(cid, 10) < 0;
  if (peerType === 'chat' && !isNegativeNumeric) return 'user';
  return peerType ?? 'user';
}

function shouldMergeTelegramDmChat(chat: Chat): boolean {
  const pt = inferPeerTypeForDedupe(chat.peer_type, chat.channel_id);
  if (pt !== 'user') return false;
  const cid = String(chat.channel_id || '').trim();
  if (!cid) return false;
  if (/^-?\d+$/.test(cid) && parseInt(cid, 10) < 0) return false;
  return true;
}

function dedupeTelegramIdentityKey(chat: Chat): string | null {
  const tg = chat.telegram_id?.trim() ?? '';
  if (tg !== '') return `tg:${tg}`;
  const contactId = chat.contact_id?.trim() ?? '';
  if (contactId !== '') return `c:${contactId}`;
  return null;
}

/**
 * Collapse duplicate sidebar rows for the same Telegram DM (aliases of channel_id) when
 * telegram_id or contact_id matches. Groups (negative channel_id) are unchanged.
 */
export function mergeChatsByTelegramIdentity(chats: Chat[]): Chat[] {
  const passthrough: Chat[] = [];
  const groups = new Map<string, Chat[]>();
  for (const chat of chats) {
    if (!shouldMergeTelegramDmChat(chat)) {
      passthrough.push(chat);
      continue;
    }
    const key = dedupeTelegramIdentityKey(chat);
    if (!key) {
      passthrough.push(chat);
      continue;
    }
    const list = groups.get(key) ?? [];
    list.push(chat);
    groups.set(key, list);
  }
  const merged: Chat[] = [];
  for (const [, group] of groups) {
    if (group.length === 1) {
      merged.push(group[0]!);
      continue;
    }
    let winner = group[0]!;
    let winnerMs = new Date(winner.last_message_at).getTime();
    for (let i = 1; i < group.length; i++) {
      const g = group[i]!;
      const ms = new Date(g.last_message_at).getTime();
      if (ms > winnerMs) {
        winner = g;
        winnerMs = ms;
      } else if (ms === winnerMs) {
        const wNum = /^\d+$/.test(String(winner.channel_id).trim());
        const gNum = /^\d+$/.test(String(g.channel_id).trim());
        if (gNum && !wNum) winner = g;
      }
    }
    const sumUnread = group.reduce((acc, x) => acc + (x.unread_count || 0), 0);
    const out: Chat = { ...winner, unread_count: sumUnread };
    if (!out.username?.trim()) {
      const withUsername = group.find((g) => g.username?.trim());
      if (withUsername?.username) out.username = withUsername.username;
    }
    if (!out.contact_id?.trim()) {
      const withContact = group.find((g) => g.contact_id?.trim());
      if (withContact?.contact_id) out.contact_id = withContact.contact_id;
    }
    merged.push(out);
  }
  const combined = [...passthrough, ...merged];
  return combined.sort((a, b) => {
    const ta = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
    const tb = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
    if (Number.isNaN(ta)) return 1;
    if (Number.isNaN(tb)) return -1;
    return tb - ta;
  });
}

/** Map raw chats from API to Chat[] (map + merge + sort). */
export function mapRawChatsToChatList(rawChats: Record<string, unknown>[]): Chat[] {
  const mapped = rawChats.map((chat) => mapRawChatToChat(chat));
  return mergeChatsByTelegramIdentity(mergeAndSortChatsByChannelId(mapped));
}

/** Map a single new-lead row from /api/messaging/new-leads to Chat. */
export function mapNewLeadRowToChat(r: Record<string, unknown>): Chat {
  const nameStr =
    (r.display_name as string)?.trim() ||
    [`${(r.first_name as string) || ''}`.trim(), `${(r.last_name as string) || ''}`.trim()]
      .filter(Boolean)
      .join(' ') ||
    (r.username as string) ||
    (r.telegram_id != null ? String(r.telegram_id) : '') ||
    null;
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
    name: nameStr ?? null,
    unread_count: Number(r.unread_count) || 0,
    last_message_at: r.last_message_at != null ? String(r.last_message_at) : '',
    last_message: (r.last_message as string) ?? null,
    conversation_id: (r.conversation_id as string) ?? null,
    lead_id: (r.lead_id as string) ?? null,
    lead_stage_name: (r.lead_stage_name as string) ?? null,
    lead_pipeline_name: (r.lead_pipeline_name as string) ?? null,
    bd_account_id: (r.bd_account_id as string) ?? null,
  };
}

// ─── Chat Helpers ────────────────────────────────────────────────────

export function getChatDisplayName(chat: Chat): string {
  const isGroup = chat.peer_type === 'chat' || chat.peer_type === 'channel';
  if (isGroup && chat.chat_title?.trim()) return chat.chat_title.trim();
  if (isGroup && chat.name?.trim()) return chat.name.trim();
  if (chat.display_name?.trim()) return chat.display_name.trim();
  const firstLast = `${chat.first_name || ''} ${chat.last_name || ''}`.trim();
  if (firstLast && !/^Telegram\s+\d+$/.test(firstLast)) return firstLast;
  if (chat.username) return chat.username.startsWith('@') ? chat.username : `@${chat.username}`;
  if (chat.name?.trim()) return chat.name.trim();
  if (chat.email?.trim()) return chat.email.trim();
  if (chat.telegram_id) return chat.telegram_id;
  return '?';
}

export function getChatInitials(chat: Chat): string {
  const name = getChatDisplayName(chat).replace(/^@/, '').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase().slice(0, 2);
  if (name.length >= 2) return name.slice(0, 2).toUpperCase();
  return name.slice(0, 1).toUpperCase() || '?';
}

export function getChatName(
  chat: Chat,
  overrides?: { firstName?: string; lastName?: string; usernames?: string[] },
): string {
  const isGroup = chat.peer_type === 'chat' || chat.peer_type === 'channel';
  if (isGroup && chat.chat_title?.trim()) return chat.chat_title.trim();
  if (isGroup && chat.name?.trim()) return chat.name.trim();
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
}

/**
 * Returns a display name that is unique among the given chats.
 * When multiple chats resolve to the same base name, appends a short channel_id suffix for duplicates.
 */
export function getChatNameUniqueInList(
  chat: Chat,
  allChats: Chat[],
  getBaseName: (c: Chat) => string,
): string {
  const base = getBaseName(chat);
  const sameNameChats = allChats.filter((c) => getBaseName(c) === base);
  if (sameNameChats.length <= 1) return base;
  const suffix = chat.channel_id.replace(/\D/g, '').slice(-4);
  return suffix ? `${base} (…${suffix})` : base;
}

// ─── Message Helpers ─────────────────────────────────────────────────

export function getMessageMediaType(msg: Message): MessageMediaType {
  const media = msg.telegram_media;
  if (!media || typeof media !== 'object') return 'text';
  const type = (media as Record<string, unknown>)._ ?? (media as Record<string, unknown>).className;
  if (type === 'messageMediaPhoto' || type === 'MessageMediaPhoto') return 'photo';
  if (type === 'messageMediaDocument' || type === 'MessageMediaDocument') {
    const doc = (media as Record<string, unknown>).document as Record<string, unknown> | undefined;
    if (doc && Array.isArray(doc.attributes)) {
      for (const a of doc.attributes as Record<string, unknown>[]) {
        const attr = a._ ?? a.className;
        if (attr === 'documentAttributeAudio' || attr === 'DocumentAttributeAudio') {
          return a.voice ? 'voice' : 'audio';
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

export function getForwardedFromLabel(msg: Message): string | null {
  const extra = msg.telegram_extra;
  if (!extra || typeof extra !== 'object') return null;
  const fwd = extra.fwd_from as Record<string, unknown> | undefined;
  if (!fwd || typeof fwd !== 'object') return null;

  const fromNameRaw = (fwd.from_name ?? fwd.fromName) as string | undefined;
  const fromName = typeof fromNameRaw === 'string' && fromNameRaw.trim() ? fromNameRaw.trim() : null;
  if (fromName) return fromName;

  const postAuthorRaw = (fwd.post_author ?? fwd.postAuthor) as string | undefined;
  const postAuthor = typeof postAuthorRaw === 'string' && postAuthorRaw.trim() ? postAuthorRaw.trim() : null;
  if (postAuthor) return postAuthor;

  return null;
}

export function getMediaProxyUrl(bdAccountId: string, channelId: string, telegramMessageId: string): string {
  return getBdAccountMediaProxyUrl(bdAccountId, channelId, telegramMessageId);
}

// ─── Formatting ──────────────────────────────────────────────────────

export function formatTime(dateString: string): string {
  if (!dateString || !dateString.trim() || isNaN(new Date(dateString).getTime())) return '—';
  const date = new Date(dateString);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const minutes = Math.floor(diff / (1000 * 60));
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const days = Math.floor(hours / 24);

  if (days === 0) {
    if (minutes < 1) return 'только что';
    if (hours === 0) return `${minutes} мин. назад`;
    return date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } else if (days === 1) {
    return 'Вчера ' + date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } else if (days < 7) {
    return date.toLocaleDateString('ru-RU', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  }
  return date.toLocaleDateString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

export function formatLeadPanelDate(iso: string): string {
  if (!iso || isNaN(new Date(iso).getTime())) return '—';
  const d = new Date(iso);
  const day = d.getDate();
  const month = d.toLocaleString('en-GB', { month: 'short' });
  const year = d.getFullYear();
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
  return `${day} ${month} ${year}, ${time}`;
}

// ─── Misc ────────────────────────────────────────────────────────────

export function getDraftKey(accountId: string, chatId: string): string {
  return `messaging.draft.${accountId}.${chatId}`;
}

export function getMessagesCacheKey(accountId: string, chatId: string): string {
  return `${accountId}:${chatId}`;
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
      resolve(base64 || '');
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
