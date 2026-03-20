import type { Note, Reminder } from '@/lib/api/crm';
import type { RightPanelTab } from '@/components/messaging/RightWorkspacePanel';
import type { BDAccount, BdSyncFolder } from '@/lib/types/bd-account';

// ─── Domain Interfaces ───────────────────────────────────────────────

export type { BDAccount };

export type SyncFolder = BdSyncFolder;

export interface Chat {
  channel: string;
  channel_id: string;
  folder_id?: number | null;
  folder_ids?: number[];
  contact_id: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  telegram_id: string | null;
  display_name: string | null;
  username: string | null;
  name: string | null;
  peer_type?: string | null;
  unread_count: number;
  last_message_at: string;
  last_message: string | null;
  conversation_id?: string | null;
  lead_id?: string | null;
  lead_stage_name?: string | null;
  lead_pipeline_name?: string | null;
  bd_account_id?: string | null;
  account_name?: string | null;
  chat_title?: string | null;
}

export interface LeadContext {
  conversation_id: string;
  lead_id: string;
  contact_id?: string | null;
  contact_name: string;
  contact_telegram_id?: string | null;
  contact_username?: string | null;
  company_name?: string | null;
  bd_account_id?: string | null;
  channel_id?: string | null;
  pipeline: { id: string; name: string };
  stage: { id: string; name: string };
  stages: Array<{ id: string; name: string }>;
  campaign: { id: string; name: string } | null;
  became_lead_at: string;
  shared_chat_created_at?: string | null;
  shared_chat_channel_id?: string | null;
  shared_chat_invite_link?: string | null;
  shared_chat_settings?: { titleTemplate: string; extraUsernames: string[] };
  won_at?: string | null;
  revenue_amount?: number | null;
  lost_at?: string | null;
  loss_reason?: string | null;
  timeline: Array<{ type: string; created_at: string; stage_name?: string }>;
}

export interface Message {
  id: string;
  content: string;
  direction: string;
  created_at: string;
  status: string;
  contact_id: string | null;
  channel: string;
  channel_id: string;
  telegram_message_id?: string | null;
  reply_to_telegram_id?: string | null;
  telegram_media?: Record<string, unknown> | null;
  telegram_entities?: Array<Record<string, unknown>> | null;
  telegram_date?: string | null;
  telegram_extra?: Record<string, unknown> | null;
  reactions?: Record<string, number> | null;
  sender_name?: string | null;
}

export type MessageMediaType = 'text' | 'photo' | 'voice' | 'audio' | 'video' | 'document' | 'sticker' | 'unknown';

export type MessagesCacheEntry = {
  messages: Message[];
  messagesTotal: number;
  messagesPage: number;
  historyExhausted: boolean;
};

// ─── Constants ───────────────────────────────────────────────────────

export const MESSAGES_PAGE_SIZE = 50;
export const VIRTUAL_LIST_THRESHOLD = 200;
export const INITIAL_FIRST_ITEM_INDEX = 1_000_000;
export const MAX_CACHED_CHATS = 30;
export const LOAD_OLDER_COOLDOWN_MS = 2500;

export const FOLDER_ICON_OPTIONS = ['📁', '📂', '💬', '⭐', '🔴', '📥', '📤', '✏️'];
export const SHOW_SYNC_FOLDERS_TO_TELEGRAM = false;
export const REACTION_EMOJI = ['👍', '❤️', '🔥', '👏', '😄', '😮', '😢', '🙏', '👎'];

export const MEDIA_TYPE_I18N_KEYS: Record<MessageMediaType, string> = {
  text: '',
  photo: 'photo',
  voice: 'mediaVoice',
  audio: 'mediaAudio',
  video: 'video',
  document: 'mediaDocument',
  sticker: 'mediaSticker',
  unknown: 'mediaUnknown',
};

export const STORAGE_KEYS = {
  accountsPanel: 'messaging.accountsPanelCollapsed',
  chatsPanel: 'messaging.chatsPanelCollapsed',
  hideEmptyFolders: 'messaging.hideEmptyFolders',
} as const;

// ─── Re-exports for convenience ─────────────────────────────────────

export type { Note, Reminder, RightPanelTab };
