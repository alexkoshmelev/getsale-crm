// Event definitions for event-driven architecture

export enum EventType {
  // User & Auth
  USER_CREATED = 'user.created',
  USER_UPDATED = 'user.updated',
  USER_DELETED = 'user.deleted',
  USER_LOGGED_IN = 'user.logged_in',
  
  // Organization
  ORGANIZATION_CREATED = 'organization.created',
  ORGANIZATION_UPDATED = 'organization.updated',
  
  // Company
  COMPANY_CREATED = 'company.created',
  COMPANY_UPDATED = 'company.updated',
  
  // Contact
  CONTACT_CREATED = 'contact.created',
  CONTACT_UPDATED = 'contact.updated',
  CONTACT_IMPORTED = 'contact.imported',
  
  // Deal
  DEAL_CREATED = 'deal.created',
  DEAL_UPDATED = 'deal.updated',
  DEAL_STAGE_CHANGED = 'deal.stage.changed',
  DEAL_CLOSED = 'deal.closed',
  
  // Message
  MESSAGE_RECEIVED = 'message.received',
  MESSAGE_SENT = 'message.sent',
  MESSAGE_READ = 'message.read',
  MESSAGE_DELETED = 'message.deleted',
  MESSAGE_EDITED = 'message.edited',
  
  // Campaign
  CAMPAIGN_CREATED = 'campaign.created',
  CAMPAIGN_STARTED = 'campaign.started',
  CAMPAIGN_PAUSED = 'campaign.paused',
  CAMPAIGN_COMPLETED = 'campaign.completed',
  
  // AI
  AI_DRAFT_GENERATED = 'ai.draft.generated',
  AI_DRAFT_APPROVED = 'ai.draft.approved',
  AI_DRAFT_REJECTED = 'ai.draft.rejected',
  AI_DRAFT_SENT = 'ai.draft.sent',
  
  // Bidi / BD Accounts
  BIDI_ASSIGNED = 'bidi.assigned',
  BIDI_UNASSIGNED = 'bidi.unassigned',
  BD_ACCOUNT_CONNECTED = 'bd_account.connected',
  BD_ACCOUNT_DISCONNECTED = 'bd_account.disconnected',
  BD_ACCOUNT_PURCHASED = 'bd_account.purchased',
  BD_ACCOUNT_SYNC_STARTED = 'bd_account.sync.started',
  BD_ACCOUNT_SYNC_PROGRESS = 'bd_account.sync.progress',
  BD_ACCOUNT_SYNC_COMPLETED = 'bd_account.sync.completed',
  BD_ACCOUNT_SYNC_FAILED = 'bd_account.sync.failed',
  /** Telegram presence/UI updates: typing, user status, read receipt, draft. Forwarded to frontend via WebSocket. */
  BD_ACCOUNT_TELEGRAM_UPDATE = 'bd_account.telegram_update',
  
  // Subscription
  SUBSCRIPTION_CREATED = 'subscription.created',
  SUBSCRIPTION_UPDATED = 'subscription.updated',
  SUBSCRIPTION_CANCELLED = 'subscription.cancelled',
  
  // Team
  TEAM_CREATED = 'team.created',
  TEAM_MEMBER_ADDED = 'team.member.added',
  TEAM_MEMBER_REMOVED = 'team.member.removed',
  TEAM_INVITATION_SENT = 'team.invitation.sent',
  
  // Pipeline & Leads
  STAGE_CREATED = 'stage.created',
  STAGE_UPDATED = 'stage.updated',
  STAGE_DELETED = 'stage.deleted',
  LEAD_CREATED = 'lead.created',
  LEAD_STAGE_CHANGED = 'lead.stage.changed',
  
  // Automation
  AUTOMATION_RULE_CREATED = 'automation.rule.created',
  AUTOMATION_RULE_TRIGGERED = 'automation.rule.triggered',
  
  // Trigger
  TRIGGER_EXECUTED = 'trigger.executed',
  
  // Analytics
  METRIC_RECORDED = 'metric.recorded',
}

export interface BaseEvent {
  id: string;
  type: EventType;
  timestamp: Date;
  organizationId: string;
  userId?: string;
  metadata?: Record<string, any>;
}

export interface UserCreatedEvent extends BaseEvent {
  type: EventType.USER_CREATED;
  data: {
    userId: string;
    email: string;
    organizationId: string;
  };
}

export interface MessageReceivedEvent extends BaseEvent {
  type: EventType.MESSAGE_RECEIVED;
  data: {
    messageId: string;
    channel: string;
    channelId?: string; // telegram chat id for room targeting
    contactId?: string;
    bdAccountId?: string;
    content: string;
    direction?: 'inbound' | 'outbound';
    telegramMessageId?: string | number;
    replyToTelegramId?: string | number;
    /** Для отображения реплая и медиа на фронте без доп. запроса */
    telegramMedia?: Record<string, unknown> | null;
    telegramEntities?: Array<Record<string, unknown>> | null;
    createdAt?: string;
  };
}

export interface MessageSentEvent extends BaseEvent {
  type: EventType.MESSAGE_SENT;
  data: {
    messageId: string;
    channel: string;
    channelId?: string;
    contactId?: string;
    bdAccountId?: string;
    content?: string;
    direction?: 'inbound' | 'outbound';
    telegramMessageId?: string | number;
    createdAt?: string;
  };
}

export interface MessageDeletedEvent extends BaseEvent {
  type: EventType.MESSAGE_DELETED;
  data: {
    messageId: string;
    bdAccountId: string;
    channelId: string;
    telegramMessageId?: number;
  };
}

export interface MessageEditedEvent extends BaseEvent {
  type: EventType.MESSAGE_EDITED;
  data: {
    messageId: string;
    bdAccountId: string;
    channelId: string;
    content?: string;
    telegramMessageId?: number;
  };
}

export interface DealStageChangedEvent extends BaseEvent {
  type: EventType.DEAL_STAGE_CHANGED;
  data: {
    dealId: string;
    fromStageId?: string;
    toStageId: string;
    reason?: string;
    autoMoved?: boolean;
  };
}

export interface AIDraftGeneratedEvent extends BaseEvent {
  type: EventType.AI_DRAFT_GENERATED;
  data: {
    draftId: string;
    contactId?: string;
    dealId?: string;
    content: string;
  };
}

export interface AIDraftApprovedEvent extends BaseEvent {
  type: EventType.AI_DRAFT_APPROVED;
  data: {
    draftId: string;
    content?: string;
  };
}

export interface BDAccountConnectedEvent extends BaseEvent {
  type: EventType.BD_ACCOUNT_CONNECTED;
  data: {
    bdAccountId: string;
    platform: string;
    userId?: string;
  };
}

export interface BDAccountSyncStartedEvent extends BaseEvent {
  type: EventType.BD_ACCOUNT_SYNC_STARTED;
  data: {
    bdAccountId: string;
    totalChats: number;
  };
}

export interface BDAccountSyncProgressEvent extends BaseEvent {
  type: EventType.BD_ACCOUNT_SYNC_PROGRESS;
  data: {
    bdAccountId: string;
    done: number;
    total: number;
    currentChatId?: string;
    currentChatTitle?: string;
    error?: string;
  };
}

export interface BDAccountSyncCompletedEvent extends BaseEvent {
  type: EventType.BD_ACCOUNT_SYNC_COMPLETED;
  data: {
    bdAccountId: string;
    totalChats: number;
    totalMessages?: number;
    failedChats?: number;
  };
}

export interface BDAccountSyncFailedEvent extends BaseEvent {
  type: EventType.BD_ACCOUNT_SYNC_FAILED;
  data: {
    bdAccountId: string;
    error: string;
  };
}

/** Telegram update kinds forwarded to frontend via bd_account.telegram_update. */
export type TelegramUpdateKind =
  | 'typing'
  | 'user_status'
  | 'read_inbox'
  | 'read_channel_inbox'
  | 'read_outbox'
  | 'read_channel_outbox'
  | 'draft'
  | 'message_id_confirmed'
  | 'dialog_pinned'
  | 'pinned_dialogs'
  | 'notify_settings'
  | 'user_name'
  | 'user_phone'
  | 'chat_participant_add'
  | 'chat_participant_delete'
  | 'scheduled_message'
  | 'delete_scheduled_messages'
  | 'message_poll'
  | 'message_poll_vote'
  | 'config'
  | 'dc_options'
  | 'lang_pack'
  | 'theme'
  | 'phone_call'
  | 'callback_query'
  | 'channel_too_long';

/** Telegram presence/UI update. Payload depends on updateKind. */
export interface BDAccountTelegramUpdateEvent extends BaseEvent {
  type: EventType.BD_ACCOUNT_TELEGRAM_UPDATE;
  data: {
    bdAccountId: string;
    organizationId: string;
    updateKind: TelegramUpdateKind;
    channelId?: string;
    userId?: string;
    action?: string;
    status?: string;
    expires?: number;
    maxId?: number;
    draftText?: string;
    replyToMsgId?: number;
    /** updateMessageID: confirmed telegram message id */
    telegramMessageId?: number;
    randomId?: string;
    /** dialog_pinned / pinned_dialogs */
    pinned?: boolean;
    folderId?: number;
    order?: string[];
    /** user_name */
    firstName?: string;
    lastName?: string;
    usernames?: string[];
    /** user_phone */
    phone?: string;
    /** chat_participant_add/delete */
    inviterId?: string;
    version?: number;
    /** scheduled_message / delete_scheduled_messages */
    messageIds?: number[];
    /** message_poll / message_poll_vote */
    pollId?: string;
    poll?: Record<string, unknown>;
    results?: Record<string, unknown>;
    options?: string[];
    qts?: number;
    /** channel_too_long: pts hint */
    pts?: number;
    /** callback_query / phone_call: id */
    queryId?: string;
    phoneCallId?: string;
    /** notify_settings: optional JSON-serializable */
    notifySettings?: Record<string, unknown>;
  };
}

export interface SubscriptionCreatedEvent extends BaseEvent {
  type: EventType.SUBSCRIPTION_CREATED;
  data: {
    subscriptionId: string;
    userId: string;
    plan: string;
    stripeSubscriptionId?: string;
  };
}

export interface TeamMemberAddedEvent extends BaseEvent {
  type: EventType.TEAM_MEMBER_ADDED;
  data: {
    teamId: string;
    userId: string;
    role: string;
  };
}

export interface AutomationRuleTriggeredEvent extends BaseEvent {
  type: EventType.AUTOMATION_RULE_TRIGGERED;
  data: {
    ruleId: string;
    clientId: string;
    action: string;
  };
}

// Subscription events
export interface SubscriptionUpdatedEvent extends BaseEvent {
  type: EventType.SUBSCRIPTION_UPDATED;
  data: {
    subscriptionId: string;
    plan?: string;
    status?: string;
    stripeSubscriptionId?: string;
  };
}

export interface SubscriptionCancelledEvent extends BaseEvent {
  type: EventType.SUBSCRIPTION_CANCELLED;
  data: {
    subscriptionId: string;
    cancelledAt: Date;
    reason?: string;
  };
}

// Team events
export interface TeamCreatedEvent extends BaseEvent {
  type: EventType.TEAM_CREATED;
  data: {
    teamId: string;
    name: string;
    organizationId: string;
  };
}

export interface TeamMemberRemovedEvent extends BaseEvent {
  type: EventType.TEAM_MEMBER_REMOVED;
  data: {
    teamId: string;
    userId: string;
    removedBy: string;
  };
}

export interface TeamInvitationSentEvent extends BaseEvent {
  type: EventType.TEAM_INVITATION_SENT;
  data: {
    teamId: string;
    email: string;
    role: string;
    invitedBy: string;
  };
}

// BD Account events
export interface BDAccountDisconnectedEvent extends BaseEvent {
  type: EventType.BD_ACCOUNT_DISCONNECTED;
  data: {
    bdAccountId: string;
    platform: string;
    userId: string;
  };
}

export interface BDAccountPurchasedEvent extends BaseEvent {
  type: EventType.BD_ACCOUNT_PURCHASED;
  data: {
    bdAccountId: string;
    platform: string;
    userId: string;
    price: number;
    currency: string;
  };
}

// Stage events
export interface StageCreatedEvent extends BaseEvent {
  type: EventType.STAGE_CREATED;
  data: {
    stageId: string;
    pipelineId: string;
    name?: string;
    order?: number;
  };
}

export interface StageUpdatedEvent extends BaseEvent {
  type: EventType.STAGE_UPDATED;
  data: {
    stageId: string;
    pipelineId: string;
    name?: string;
    order?: number;
  };
}

export interface StageDeletedEvent extends BaseEvent {
  type: EventType.STAGE_DELETED;
  data: {
    stageId: string;
    pipelineId: string;
  };
}

// Lead events (pipeline-service)
export interface LeadCreatedEvent extends BaseEvent {
  type: EventType.LEAD_CREATED;
  data: {
    contactId: string;
    pipelineId: string;
    stageId: string;
    leadId: string;
  };
}

export interface LeadStageChangedEvent extends BaseEvent {
  type: EventType.LEAD_STAGE_CHANGED;
  data: {
    contactId: string;
    pipelineId: string;
    fromStageId: string;
    toStageId: string;
    leadId: string;
  };
}

// Automation events
export interface AutomationRuleCreatedEvent extends BaseEvent {
  type: EventType.AUTOMATION_RULE_CREATED;
  data: {
    ruleId: string;
    name?: string;
    organizationId?: string;
    conditions?: Record<string, any>;
    actions?: Record<string, any>;
  };
}

export interface TriggerExecutedEvent extends BaseEvent {
  type: EventType.TRIGGER_EXECUTED;
  data: {
    type?: string;
    ruleId: string;
    action?: string;
    message?: string;
    userIds?: string[];
  };
}

// Company / Contact / Deal events (CRM)
export interface CompanyCreatedEvent extends BaseEvent {
  type: EventType.COMPANY_CREATED;
  data: { companyId: string };
}

export interface CompanyUpdatedEvent extends BaseEvent {
  type: EventType.COMPANY_UPDATED;
  data: { companyId: string };
}

export interface ContactCreatedEvent extends BaseEvent {
  type: EventType.CONTACT_CREATED;
  data: { contactId: string };
}

export interface ContactUpdatedEvent extends BaseEvent {
  type: EventType.CONTACT_UPDATED;
  data: { contactId: string };
}

export interface DealCreatedEvent extends BaseEvent {
  type: EventType.DEAL_CREATED;
  data: { dealId: string; pipelineId?: string };
}

export interface DealUpdatedEvent extends BaseEvent {
  type: EventType.DEAL_UPDATED;
  data: { dealId: string };
}

// Analytics events
export interface MetricRecordedEvent extends BaseEvent {
  type: EventType.METRIC_RECORDED;
  data: {
    metricName: string;
    value: number;
    tags?: Record<string, string>;
    timestamp: Date;
  };
}

export type Event = 
  | UserCreatedEvent
  | MessageReceivedEvent
  | MessageSentEvent
  | MessageDeletedEvent
  | MessageEditedEvent
  | DealStageChangedEvent
  | AIDraftGeneratedEvent
  | AIDraftApprovedEvent
  | TriggerExecutedEvent
  | CompanyCreatedEvent
  | CompanyUpdatedEvent
  | ContactCreatedEvent
  | ContactUpdatedEvent
  | DealCreatedEvent
  | DealUpdatedEvent
  | BDAccountConnectedEvent
  | BDAccountDisconnectedEvent
  | BDAccountPurchasedEvent
  | BDAccountSyncStartedEvent
  | BDAccountSyncProgressEvent
  | BDAccountSyncCompletedEvent
  | BDAccountSyncFailedEvent
  | BDAccountTelegramUpdateEvent
  | SubscriptionCreatedEvent
  | SubscriptionUpdatedEvent
  | SubscriptionCancelledEvent
  | TeamCreatedEvent
  | TeamMemberAddedEvent
  | TeamMemberRemovedEvent
  | TeamInvitationSentEvent
  | StageCreatedEvent
  | StageUpdatedEvent
  | StageDeletedEvent
  | LeadCreatedEvent
  | LeadStageChangedEvent
  | AutomationRuleCreatedEvent
  | AutomationRuleTriggeredEvent
  | MetricRecordedEvent;

