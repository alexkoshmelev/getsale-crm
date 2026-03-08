'use client';

import { create } from 'zustand';
import { getPersistedRightPanelTab } from '@/components/messaging/RightWorkspacePanel';
import type { Message, Chat, LeadContext, Note, Reminder, RightPanelTab } from '../types';

export interface MessagingUIState {
  showScrollToBottomButton: boolean;
  showCommandsMenu: boolean;
  showAttachMenu: boolean;
  pendingFile: File | null;
  isRecording: boolean;
  forwardModal: Message | null;
  forwardingToChatId: string | null;
  dragOverFolderId: number | null;
  showFolderManageModal: boolean;
  broadcastModalOpen: boolean;
  showEditNameModal: boolean;
  folderIconPickerId: string | null;
  syncFoldersPushing: boolean;
  createSharedChatModalOpen: boolean;
  createSharedChatTitle: string;
  createSharedChatExtraUsernames: string[];
  createSharedChatNewUsername: string;
  createSharedChatSubmitting: boolean;
  markWonModalOpen: boolean;
  markWonRevenue: string;
  markWonSubmitting: boolean;
  markLostModalOpen: boolean;
  markLostReason: string;
  markLostSubmitting: boolean;
  leadCardModalOpen: boolean;
  showChatHeaderMenu: boolean;
  editDisplayNameValue: string;
  savingDisplayName: boolean;
  mediaViewer: { url: string; type: 'image' | 'video' } | null;
  addToFunnelFromChat: {
    contactId: string;
    contactName: string;
    leadTitle?: string;
    bdAccountId?: string;
    channel?: string;
    channelId?: string;
  } | null;
  typingChannelId: string | null;
  userStatusByUserId: Record<string, { status: string; expires?: number }>;
  readOutboxMaxIdByChannel: Record<string, number>;
  rightPanelOpen: boolean;
  rightPanelTab: RightPanelTab | null;
  leadPanelOpenByConvId: Record<string, boolean>;
  leadContext: LeadContext | null;
  leadContextLoading: boolean;
  leadContextError: string | null;
  leadStagePatching: boolean;
  leadNotes: Note[];
  leadReminders: Reminder[];
  leadNoteText: string;
  leadRemindAt: string;
  leadRemindTitle: string;
  addingLeadNote: boolean;
  addingLeadReminder: boolean;
  leadNoteModalOpen: boolean;
  leadReminderModalOpen: boolean;
  contactDisplayOverrides: Record<string, { firstName?: string; lastName?: string; usernames?: string[]; phone?: string }>;
  channelNeedsRefresh: string | null;
  activeSidebarSection: 'new-leads' | 'telegram';
  newLeads: Chat[];
  newLeadsLoading: boolean;
}

type SetState = (partial: Partial<MessagingUIState> | ((prev: MessagingUIState) => Partial<MessagingUIState>)) => void;

export type MessagingUISetters = {
  [K in keyof MessagingUIState as `set${Capitalize<K & string>}`]: (
    v: MessagingUIState[K] | ((prev: MessagingUIState[K]) => MessagingUIState[K])
  ) => void;
};

function createSetters(set: SetState): MessagingUISetters {
  const keys: (keyof MessagingUIState)[] = [
    'showScrollToBottomButton', 'showCommandsMenu', 'showAttachMenu', 'pendingFile', 'isRecording',
    'forwardModal', 'forwardingToChatId', 'dragOverFolderId', 'showFolderManageModal', 'broadcastModalOpen',
    'showEditNameModal', 'folderIconPickerId', 'syncFoldersPushing', 'createSharedChatModalOpen',
    'createSharedChatTitle', 'createSharedChatExtraUsernames', 'createSharedChatNewUsername', 'createSharedChatSubmitting',
    'markWonModalOpen', 'markWonRevenue', 'markWonSubmitting', 'markLostModalOpen', 'markLostReason', 'markLostSubmitting',
    'leadCardModalOpen', 'showChatHeaderMenu', 'editDisplayNameValue', 'savingDisplayName', 'mediaViewer', 'addToFunnelFromChat',
    'typingChannelId', 'userStatusByUserId', 'readOutboxMaxIdByChannel', 'rightPanelOpen', 'rightPanelTab', 'leadPanelOpenByConvId',
    'leadContext', 'leadContextLoading', 'leadContextError', 'leadStagePatching', 'leadNotes', 'leadReminders',
    'leadNoteText', 'leadRemindAt', 'leadRemindTitle', 'addingLeadNote', 'addingLeadReminder', 'leadNoteModalOpen', 'leadReminderModalOpen',
    'contactDisplayOverrides', 'channelNeedsRefresh', 'activeSidebarSection', 'newLeads', 'newLeadsLoading',
  ];
  const out = {} as Record<string, (v: unknown) => void>;
  for (const k of keys) {
    const name = 'set' + (k.charAt(0).toUpperCase() + k.slice(1));
    out[name] = (v: unknown) =>
      set((s) => ({ [k]: typeof v === 'function' ? (v as (p: unknown) => unknown)(s[k]) : v }));
  }
  return out as MessagingUISetters;
}

const initialState: MessagingUIState = {
  showScrollToBottomButton: false,
  showCommandsMenu: false,
  showAttachMenu: false,
  pendingFile: null,
  isRecording: false,
  forwardModal: null,
  forwardingToChatId: null,
  dragOverFolderId: null,
  showFolderManageModal: false,
  broadcastModalOpen: false,
  showEditNameModal: false,
  folderIconPickerId: null,
  syncFoldersPushing: false,
  createSharedChatModalOpen: false,
  createSharedChatTitle: '',
  createSharedChatExtraUsernames: [],
  createSharedChatNewUsername: '',
  createSharedChatSubmitting: false,
  markWonModalOpen: false,
  markWonRevenue: '',
  markWonSubmitting: false,
  markLostModalOpen: false,
  markLostReason: '',
  markLostSubmitting: false,
  leadCardModalOpen: false,
  showChatHeaderMenu: false,
  editDisplayNameValue: '',
  savingDisplayName: false,
  mediaViewer: null,
  addToFunnelFromChat: null,
  typingChannelId: null,
  userStatusByUserId: {},
  readOutboxMaxIdByChannel: {},
  rightPanelOpen: false,
  rightPanelTab: null,
  leadPanelOpenByConvId: {},
  leadContext: null,
  leadContextLoading: false,
  leadContextError: null,
  leadStagePatching: false,
  leadNotes: [],
  leadReminders: [],
  leadNoteText: '',
  leadRemindAt: '',
  leadRemindTitle: '',
  addingLeadNote: false,
  addingLeadReminder: false,
  leadNoteModalOpen: false,
  leadReminderModalOpen: false,
  contactDisplayOverrides: {},
  channelNeedsRefresh: null,
  activeSidebarSection: 'telegram',
  newLeads: [],
  newLeadsLoading: false,
};

export const useMessagingUIStore = create<MessagingUIState & MessagingUISetters>((set) => ({
  ...initialState,
  ...createSetters(set),
}));

export function initRightPanelTab(): void {
  const t = getPersistedRightPanelTab();
  if (t) useMessagingUIStore.setState({ rightPanelTab: t });
}
