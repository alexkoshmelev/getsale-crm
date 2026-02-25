// Common types shared across all services

export interface User {
  id: string;
  email: string;
  organizationId: string;
  role: UserRole;
  bidiId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export enum UserRole {
  OWNER = 'owner',
  ADMIN = 'admin',
  SUPERVISOR = 'supervisor',
  BIDI = 'bidi',
  VIEWER = 'viewer',
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Company {
  id: string;
  organizationId: string;
  name: string;
  industry?: string;
  size?: string;
  description?: string;
  goals?: string[];
  policies?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export interface Contact {
  id: string;
  organizationId: string;
  companyId?: string;
  firstName: string;
  lastName?: string;
  email?: string;
  phone?: string;
  telegramId?: string;
  consentFlags: ConsentFlags;
  createdAt: Date;
  updatedAt: Date;
}

export interface ConsentFlags {
  email: boolean;
  sms: boolean;
  telegram: boolean;
  marketing: boolean;
}

export interface Deal {
  id: string;
  organizationId: string;
  companyId: string;
  contactId?: string;
  pipelineId: string;
  stageId: string;
  ownerId: string;
  leadId?: string | null;
  title: string;
  value?: number;
  currency?: string;
  history: DealHistory[];
  createdAt: Date;
  updatedAt: Date;
}

export interface DealHistory {
  id: string;
  action: string;
  fromStageId?: string;
  toStageId?: string;
  performedBy: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}

export interface Pipeline {
  id: string;
  organizationId: string;
  companyId: string;
  name: string;
  stages: PipelineStage[];
  createdAt: Date;
  updatedAt: Date;
}

export interface PipelineStage {
  id: string;
  name: string;
  order: number;
  entryRules?: StageRule[];
  exitRules?: StageRule[];
  allowedActions?: string[];
  autoTransitionConditions?: AutoTransition[];
}

export interface StageRule {
  type: 'field' | 'time' | 'event';
  condition: string;
  value: any;
}

export interface AutoTransition {
  trigger: string;
  targetStageId: string;
  conditions?: StageRule[];
}

export interface Message {
  id: string;
  organizationId: string;
  channel: MessageChannel;
  channelId: string; // Telegram chat ID, email thread ID, etc.
  contactId?: string;
  direction: MessageDirection;
  content: string;
  status: MessageStatus;
  unread: boolean;
  ownerId?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export enum MessageChannel {
  TELEGRAM = 'telegram',
  EMAIL = 'email',
  SMS = 'sms',
}

export enum MessageDirection {
  INBOUND = 'inbound',
  OUTBOUND = 'outbound',
}

export enum MessageStatus {
  PENDING = 'pending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  READ = 'read',
  FAILED = 'failed',
}

export interface Campaign {
  id: string;
  organizationId: string;
  companyId: string;
  pipelineId: string;
  name: string;
  targetAudience: CampaignAudience;
  templates: CampaignTemplate[];
  sequences: CampaignSequence[];
  schedule?: CampaignSchedule;
  status: CampaignStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CampaignAudience {
  filters: Record<string, any>;
  limit?: number;
}

export interface CampaignTemplate {
  id: string;
  name: string;
  channel: MessageChannel;
  content: string;
  conditions?: Record<string, any>;
}

export interface CampaignSequence {
  id: string;
  order: number;
  templateId: string;
  delay: number; // hours
  conditions?: Record<string, any>;
}

export interface CampaignSchedule {
  timezone: string;
  workingHours: {
    start: string;
    end: string;
  };
  daysOfWeek: number[];
}

export enum CampaignStatus {
  DRAFT = 'draft',
  ACTIVE = 'active',
  PAUSED = 'paused',
  COMPLETED = 'completed',
}

export interface AIDraft {
  id: string;
  organizationId: string;
  messageId?: string;
  contactId?: string;
  dealId?: string;
  content: string;
  status: AIDraftStatus;
  generatedBy: string; // AI agent ID or user ID
  editedBy?: string;
  approvedBy?: string;
  rejectedBy?: string;
  rejectionReason?: string;
  metadata?: Record<string, any>;
  createdAt: Date;
  updatedAt: Date;
}

export enum AIDraftStatus {
  GENERATED = 'generated',
  EDITED = 'edited',
  APPROVED = 'approved',
  SENT = 'sent',
  REJECTED = 'rejected',
}

export interface Bidi {
  id: string;
  organizationId: string;
  userId?: string;
  type: BidiType;
  name: string;
  workload: number;
  assignedContacts: string[];
  activeChats: number;
  performanceMetrics: BidiMetrics;
  createdAt: Date;
  updatedAt: Date;
}

export enum BidiType {
  INTERNAL = 'internal',
  EXTERNAL = 'external',
  AI = 'ai',
}

export interface BidiMetrics {
  messagesSent: number;
  messagesReceived: number;
  dealsClosed: number;
  responseTime: number; // average in minutes
}

export interface Trigger {
  id: string;
  organizationId: string;
  name: string;
  event: string;
  conditions?: TriggerCondition[];
  actions: TriggerAction[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface TriggerCondition {
  field: string;
  operator: 'eq' | 'ne' | 'gt' | 'lt' | 'gte' | 'lte' | 'in' | 'contains';
  value: any;
}

export interface TriggerAction {
  type: string;
  target: string;
  params: Record<string, any>;
}

