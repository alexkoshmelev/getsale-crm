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
  
  // Subscription
  SUBSCRIPTION_CREATED = 'subscription.created',
  SUBSCRIPTION_UPDATED = 'subscription.updated',
  SUBSCRIPTION_CANCELLED = 'subscription.cancelled',
  
  // Team
  TEAM_CREATED = 'team.created',
  TEAM_MEMBER_ADDED = 'team.member.added',
  TEAM_MEMBER_REMOVED = 'team.member.removed',
  TEAM_INVITATION_SENT = 'team.invitation.sent',
  
  // Pipeline
  STAGE_CREATED = 'stage.created',
  STAGE_UPDATED = 'stage.updated',
  STAGE_DELETED = 'stage.deleted',
  
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
    contactId?: string;
    content: string;
  };
}

export interface DealStageChangedEvent extends BaseEvent {
  type: EventType.DEAL_STAGE_CHANGED;
  data: {
    dealId: string;
    fromStageId?: string;
    toStageId: string;
    reason?: string;
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

export interface BDAccountConnectedEvent extends BaseEvent {
  type: EventType.BD_ACCOUNT_CONNECTED;
  data: {
    bdAccountId: string;
    platform: string;
    userId: string;
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
    name: string;
    order: number;
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

// Automation events
export interface AutomationRuleCreatedEvent extends BaseEvent {
  type: EventType.AUTOMATION_RULE_CREATED;
  data: {
    ruleId: string;
    name: string;
    organizationId: string;
    conditions: Record<string, any>;
    actions: Record<string, any>;
  };
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
  | DealStageChangedEvent
  | AIDraftGeneratedEvent
  | BDAccountConnectedEvent
  | BDAccountDisconnectedEvent
  | BDAccountPurchasedEvent
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
  | AutomationRuleCreatedEvent
  | AutomationRuleTriggeredEvent
  | MetricRecordedEvent;

