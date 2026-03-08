'use client';

/**
 * Messaging state is split into 4 stores for granular subscriptions and fewer re-renders:
 * - messaging-accounts-store: accounts, selectedAccountId, sync, loading
 * - messaging-chats-store: chats, selectedChat, folders, pinned, context menus
 * - messaging-messages-store: messages, newMessage, pagination, draftByChannel
 * - messaging-ui-store: modals, lead panel, realtime presence, newLeads, overrides
 *
 * useMessagingState() combines all 4 + refs for backward compatibility.
 * Prefer using individual stores with selectors where possible:
 *   useMessagingAccountsStore(s => s.accounts)
 *   useMessagingChatsStore(s => ({ chats: s.chats, selectedChat: s.selectedChat }))
 */

export {
  useMessagingAccountsStore,
  setAccountsCollapsed,
  type MessagingAccountsState,
} from './messaging-accounts-store';

export {
  useMessagingChatsStore,
  setChatsCollapsed,
  setHideEmptyFolders,
  type MessagingChatsState,
} from './messaging-chats-store';

export {
  useMessagingMessagesStore,
  type MessagingMessagesState,
} from './messaging-messages-store';

export {
  useMessagingUIStore,
  initRightPanelTab,
  type MessagingUIState,
} from './messaging-ui-store';
