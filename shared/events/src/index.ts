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
  
  // Bidi
  BIDI_ASSIGNED = 'bidi.assigned',
  BIDI_UNASSIGNED = 'bidi.unassigned',
  
  // Trigger
  TRIGGER_EXECUTED = 'trigger.executed',
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

export type Event = 
  | UserCreatedEvent
  | MessageReceivedEvent
  | DealStageChangedEvent
  | AIDraftGeneratedEvent;

