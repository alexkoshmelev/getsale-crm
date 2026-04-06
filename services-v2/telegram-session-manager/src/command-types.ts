export enum CommandType {
  SEND_MESSAGE = 'SEND_MESSAGE',
  MARK_READ = 'MARK_READ',
  TYPING = 'TYPING',
  SYNC_CHATS = 'SYNC_CHATS',
  SEARCH_GROUPS = 'SEARCH_GROUPS',
  GET_PARTICIPANTS = 'GET_PARTICIPANTS',
  RESOLVE_USERNAME = 'RESOLVE_USERNAME',
  DELETE_MESSAGE = 'DELETE_MESSAGE',
  SEND_REACTION = 'SEND_REACTION',
  SAVE_DRAFT = 'SAVE_DRAFT',
  FORWARD_MESSAGE = 'FORWARD_MESSAGE',
  SEND_BULK = 'SEND_BULK',
  LOAD_OLDER_HISTORY = 'LOAD_OLDER_HISTORY',
  DISCONNECT = 'DISCONNECT',
  RECONNECT = 'RECONNECT',
  SPAMBOT_CHECK = 'SPAMBOT_CHECK',
  SYNC_HISTORY = 'SYNC_HISTORY',
}

export const COMMAND_PRIORITY: Record<CommandType, number> = {
  [CommandType.SEND_MESSAGE]: 8,
  [CommandType.MARK_READ]: 5,
  [CommandType.TYPING]: 5,
  [CommandType.SYNC_CHATS]: 3,
  [CommandType.SEARCH_GROUPS]: 2,
  [CommandType.GET_PARTICIPANTS]: 2,
  [CommandType.RESOLVE_USERNAME]: 4,
  [CommandType.DELETE_MESSAGE]: 7,
  [CommandType.SEND_REACTION]: 6,
  [CommandType.SAVE_DRAFT]: 4,
  [CommandType.FORWARD_MESSAGE]: 7,
  [CommandType.SEND_BULK]: 6,
  [CommandType.LOAD_OLDER_HISTORY]: 3,
  [CommandType.DISCONNECT]: 10,
  [CommandType.RECONNECT]: 10,
  [CommandType.SPAMBOT_CHECK]: 2,
  [CommandType.SYNC_HISTORY]: 3,
};

export interface TelegramCommand<T = unknown> {
  id: string;
  type: CommandType;
  payload: T;
  priority: number;
  timestamp?: number;
}

export interface SendMessagePayload {
  conversationId: string;
  text: string;
  channelId?: string;
  organizationId: string;
  userId: string;
  contactId?: string;
  campaignId?: string;
  participantId?: string;
  replyTo?: number;
  /** When messaging-api pre-persists the message, pass its ID so TSM updates instead of duplicating. */
  messageId?: string;
  fileBase64?: string;
  fileName?: string;
}

export interface TypingPayload {
  channelId: string;
  duration: number;
}

export interface MarkReadPayload {
  channelId: string;
  messageIds: number[];
}

export interface SyncChatsPayload {
  organizationId: string;
}

export interface SearchGroupsPayload {
  query: string;
  limit?: number;
}

export interface GetParticipantsPayload {
  chatId: string;
  offset?: number;
  limit?: number;
}

export interface ResolveUsernamePayload {
  username: string;
}

export interface DeleteMessagePayload {
  accountId: string;
  organizationId: string;
  channelId: string;
  telegramMessageId: number;
}

export interface SendReactionPayload {
  accountId: string;
  organizationId: string;
  chatId: string;
  telegramMessageId: number;
  reaction: string[];
}

export interface SaveDraftPayload {
  accountId: string;
  organizationId: string;
  channelId: string;
  text: string;
  replyToMsgId: number | string | null;
}

export interface ForwardMessagePayload {
  accountId: string;
  organizationId: string;
  fromChatId: string;
  toChatId: string;
  telegramMessageId: number;
}

export interface SendBulkPayload {
  accountId: string;
  organizationId: string;
  channelIds: string[];
  text: string;
}

export interface LoadOlderHistoryPayload {
  accountId: string;
  organizationId: string;
  chatId: string;
}

export interface AccountLifecyclePayload {
  accountId: string;
  organizationId: string;
}

export interface SyncHistoryPayload {
  accountId: string;
  organizationId: string;
}

export type AccountState = 'disconnected' | 'connecting' | 'connected' | 'flood_wait' | 'spam_restricted' | 'error' | 'reauth_required';
