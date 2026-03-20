/** BD account connect / sync-chats wizard — shared by `lib/api/bd-accounts` and bd-accounts UI. */

export interface BdConnectDialog {
  id: string;
  name: string;
  unreadCount?: number;
  lastMessage?: string;
  lastMessageDate?: string;
  isUser: boolean;
  isGroup: boolean;
  isChannel: boolean;
}

export interface FolderWithDialogs {
  id: number;
  title: string;
  emoticon?: string;
  dialogs: BdConnectDialog[];
}

export interface SyncChatRow {
  telegram_chat_id: string;
  folder_id: number | null;
  title?: string;
  peer_type?: string;
}

export interface BdDialogsByFoldersResponse {
  folders?: FolderWithDialogs[];
  truncated?: boolean;
  days?: number;
  maxDialogsPerFolder?: number;
}
