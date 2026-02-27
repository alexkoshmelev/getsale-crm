import { apiClient } from './client';

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed';

export interface CampaignTargetAudience {
  filters?: Record<string, unknown>;
  limit?: number;
  onlyNew?: boolean;
  contactIds?: string[];
  bdAccountId?: string;
  sendDelaySeconds?: number;
  /** Перед запуском обогащать контакты из Telegram (getEntity → first_name, last_name, username). */
  enrichContactsBeforeStart?: boolean;
  /** Dynamic campaign: auto-add leads when they enter one of these stages in the given pipeline */
  dynamicPipelineId?: string;
  dynamicStageIds?: string[];
}

export interface LeadCreationSettings {
  trigger?: 'on_first_send' | 'on_reply';
  default_stage_id?: string;
  /** User ID to set as lead responsible when creating lead from campaign. */
  default_responsible_id?: string;
}

export interface Campaign {
  id: string;
  organization_id: string;
  company_id?: string | null;
  pipeline_id?: string | null;
  name: string;
  status: CampaignStatus;
  target_audience: CampaignTargetAudience;
  lead_creation_settings?: LeadCreationSettings | null;
  schedule?: {
    timezone?: string;
    workingHours?: { start: string; end: string };
    daysOfWeek?: number[];
  } | null;
  created_at: string;
  updated_at: string;
  /** PHASE 2.5 — мини-KPI в списке (приходят с GET /api/campaigns). */
  total_sent?: number;
  total_read?: number;
  total_replied?: number;
  total_converted_to_shared_chat?: number;
  total_won?: number;
  total_revenue?: number;
}

export interface CampaignTemplate {
  id: string;
  organization_id: string;
  campaign_id: string | null;
  name: string;
  channel: string;
  content: string;
  conditions?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export type CampaignStepTriggerType = 'delay' | 'after_reply';

export interface CampaignSequenceStep {
  id: string;
  campaign_id: string;
  order_index: number;
  template_id: string;
  delay_hours: number;
  delay_minutes?: number;
  trigger_type?: CampaignStepTriggerType;
  conditions?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  template_name?: string;
  channel?: string;
  content?: string;
}

export interface SelectedContactInfo {
  id: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  username: string | null;
  telegram_id: string | null;
  email: string | null;
  phone: string | null;
}

export interface CampaignWithDetails extends Campaign {
  templates: CampaignTemplate[];
  sequences: CampaignSequenceStep[];
  /** For draft/paused: contacts selected in audience (from target_audience.contactIds). */
  selected_contacts?: SelectedContactInfo[];
}

export interface CampaignParticipant {
  id: string;
  campaign_id: string;
  contact_id: string;
  bd_account_id: string | null;
  channel_id: string | null;
  status: string;
  current_step: number;
  next_send_at: string | null;
  first_name?: string | null;
  last_name?: string | null;
  telegram_id?: string | null;
  created_at: string;
  updated_at: string;
}

/** PHASE 2.5 — участник с полями для воронки (статус по этапу, даты, conversation_id). */
export type CampaignParticipantPhase = 'sent' | 'read' | 'replied' | 'shared';

export interface CampaignParticipantRow {
  participant_id: string;
  contact_id: string;
  contact_name: string;
  conversation_id: string | null;
  bd_account_id: string | null;
  channel_id: string | null;
  status_phase: CampaignParticipantPhase;
  pipeline_stage_name: string | null;
  sent_at: string | null;
  replied_at: string | null;
  shared_chat_created_at: string | null;
}

export interface CampaignStats {
  total: number;
  byStatus: Record<string, number>;
  totalSends?: number;
  contactsSent?: number;
  conversionRate?: number;
  firstSendAt?: string | null;
  lastSendAt?: string | null;
  /** PHASE 2.5 — воронка. */
  total_sent?: number;
  total_read?: number;
  total_replied?: number;
  total_converted_to_shared_chat?: number;
  read_rate?: number;
  reply_rate?: number;
  conversion_rate?: number;
  /** PHASE 2.6 — среднее время от первой отправки до создания общего чата (часы). */
  avg_time_to_shared_hours?: number | null;
  /** PHASE 2.7 — Won + Revenue */
  total_won?: number;
  total_lost?: number;
  total_revenue?: number;
  win_rate?: number;
  revenue_per_sent?: number;
  revenue_per_reply?: number;
  avg_revenue_per_won?: number;
  avg_time_to_won_hours?: number | null;
}

export async function fetchCampaigns(params?: { status?: CampaignStatus }): Promise<Campaign[]> {
  const { data } = await apiClient.get<Campaign[]>('/api/campaigns', { params: params ?? {} });
  return data;
}

export async function fetchCampaign(id: string): Promise<CampaignWithDetails> {
  const { data } = await apiClient.get<CampaignWithDetails>(`/api/campaigns/${id}`);
  return data;
}

export async function createCampaign(body: {
  name: string;
  companyId?: string;
  pipelineId?: string;
  targetAudience?: CampaignTargetAudience;
  schedule?: Campaign['schedule'];
}): Promise<Campaign> {
  const { data } = await apiClient.post<Campaign>('/api/campaigns', {
    name: body.name,
    companyId: body.companyId,
    pipelineId: body.pipelineId,
    targetAudience: body.targetAudience,
    schedule: body.schedule,
  });
  return data;
}

export async function updateCampaign(
  id: string,
  body: Partial<{
    name: string;
    companyId: string | null;
    pipelineId: string | null;
    targetAudience: CampaignTargetAudience;
    schedule: Campaign['schedule'] | null;
    status: CampaignStatus;
    leadCreationSettings?: LeadCreationSettings | null;
  }>
): Promise<Campaign> {
  const { data } = await apiClient.patch<Campaign>(`/api/campaigns/${id}`, body);
  return data;
}

export async function deleteCampaign(id: string): Promise<void> {
  await apiClient.delete(`/api/campaigns/${id}`);
}

export async function startCampaign(id: string): Promise<Campaign> {
  const { data } = await apiClient.post<Campaign>(`/api/campaigns/${id}/start`);
  return data;
}

export async function pauseCampaign(id: string): Promise<Campaign> {
  const { data } = await apiClient.post<Campaign>(`/api/campaigns/${id}/pause`);
  return data;
}

export async function fetchCampaignTemplates(campaignId: string): Promise<CampaignTemplate[]> {
  const { data } = await apiClient.get<CampaignTemplate[]>(`/api/campaigns/${campaignId}/templates`);
  return data;
}

export async function createCampaignTemplate(
  campaignId: string,
  body: { name: string; channel: string; content: string; conditions?: Record<string, unknown> }
): Promise<CampaignTemplate> {
  const { data } = await apiClient.post<CampaignTemplate>(
    `/api/campaigns/${campaignId}/templates`,
    body
  );
  return data;
}

export async function updateCampaignTemplate(
  campaignId: string,
  templateId: string,
  body: Partial<{ name: string; channel: string; content: string; conditions: Record<string, unknown> }>
): Promise<CampaignTemplate> {
  const { data } = await apiClient.patch<CampaignTemplate>(
    `/api/campaigns/${campaignId}/templates/${templateId}`,
    body
  );
  return data;
}

export async function fetchCampaignSequences(campaignId: string): Promise<CampaignSequenceStep[]> {
  const { data } = await apiClient.get<CampaignSequenceStep[]>(
    `/api/campaigns/${campaignId}/sequences`
  );
  return data;
}

export async function createCampaignSequenceStep(
  campaignId: string,
  body: {
    orderIndex: number;
    templateId: string;
    delayHours: number;
    delayMinutes?: number;
    conditions?: Record<string, unknown>;
    triggerType?: CampaignStepTriggerType;
  }
): Promise<CampaignSequenceStep> {
  const { data } = await apiClient.post<CampaignSequenceStep>(
    `/api/campaigns/${campaignId}/sequences`,
    {
      orderIndex: body.orderIndex,
      templateId: body.templateId,
      delayHours: body.delayHours,
      delayMinutes: body.delayMinutes ?? 0,
      conditions: body.conditions,
      triggerType: body.triggerType,
    }
  );
  return data;
}

export async function updateCampaignSequenceStep(
  campaignId: string,
  stepId: string,
  body: Partial<{ orderIndex: number; templateId: string; delayHours: number; delayMinutes: number; conditions: Record<string, unknown>; triggerType: CampaignStepTriggerType }>
): Promise<CampaignSequenceStep> {
  const { data } = await apiClient.patch<CampaignSequenceStep>(
    `/api/campaigns/${campaignId}/sequences/${stepId}`,
    body
  );
  return data;
}

export async function deleteCampaignSequenceStep(
  campaignId: string,
  stepId: string
): Promise<void> {
  await apiClient.delete(`/api/campaigns/${campaignId}/sequences/${stepId}`);
}

export async function fetchCampaignParticipants(
  campaignId: string,
  params?: { page?: number; limit?: number; status?: string; filter?: 'all' | 'replied' | 'not_replied' | 'shared' }
): Promise<CampaignParticipant[] | CampaignParticipantRow[]> {
  const { data } = await apiClient.get<CampaignParticipant[] | CampaignParticipantRow[]>(
    `/api/campaigns/${campaignId}/participants`,
    { params: params ?? {} }
  );
  return data;
}

export async function fetchCampaignParticipantRows(
  campaignId: string,
  params?: { page?: number; limit?: number; filter?: 'all' | 'replied' | 'not_replied' | 'shared' }
): Promise<CampaignParticipantRow[]> {
  const { data } = await apiClient.get<CampaignParticipantRow[]>(
    `/api/campaigns/${campaignId}/participants`,
    { params: { ...params, limit: params?.limit ?? 50 } }
  );
  return data;
}

export async function fetchCampaignStats(campaignId: string): Promise<CampaignStats> {
  const { data } = await apiClient.get<CampaignStats>(`/api/campaigns/${campaignId}/stats`);
  return data;
}

export interface CampaignAnalytics {
  sendsByDay: { date: string; sends: number }[];
  repliedByDay: { date: string; replied: number }[];
}

export async function fetchCampaignAnalytics(
  campaignId: string,
  params?: { days?: number }
): Promise<CampaignAnalytics> {
  const { data } = await apiClient.get<CampaignAnalytics>(`/api/campaigns/${campaignId}/analytics`, {
    params: params ?? {},
  });
  return data;
}

export interface CampaignAgent {
  id: string;
  displayName: string;
  sentToday: number;
}

export async function fetchCampaignAgents(): Promise<CampaignAgent[]> {
  const { data } = await apiClient.get<CampaignAgent[]>('/api/campaigns/agents');
  return data;
}

export interface MessagePreset {
  id: string;
  name: string;
  channel: string;
  content: string;
  created_at: string;
}

export async function fetchMessagePresets(): Promise<MessagePreset[]> {
  const { data } = await apiClient.get<MessagePreset[]>('/api/campaigns/presets');
  return data;
}

export async function createMessagePreset(body: {
  name: string;
  channel?: string;
  content: string;
}): Promise<MessagePreset> {
  const { data } = await apiClient.post<MessagePreset>('/api/campaigns/presets', body);
  return data;
}

export interface ContactForPicker {
  id: string;
  first_name: string | null;
  last_name: string | null;
  display_name: string | null;
  username: string | null;
  telegram_id: string | null;
  email: string | null;
  phone: string | null;
  outreach_status: 'new' | 'in_outreach';
}

export async function fetchContactsForPicker(params?: {
  limit?: number;
  outreachStatus?: 'new' | 'in_outreach';
  search?: string;
}): Promise<ContactForPicker[]> {
  const { data } = await apiClient.get<ContactForPicker[]>('/api/campaigns/contacts-for-picker', {
    params: params ?? {},
  });
  return data;
}

/** Обогатить контакты данными из Telegram (first_name, last_name, username) через getEntity. */
export async function enrichContactsFromTelegram(
  contactIds: string[],
  bdAccountId?: string
): Promise<{ enriched: number }> {
  const { data } = await apiClient.post<{ enriched: number }>('/api/bd-accounts/enrich-contacts', {
    contactIds,
    ...(bdAccountId ? { bdAccountId } : {}),
  });
  return data;
}

export interface GroupSource {
  id: string;
  bd_account_id: string;
  telegram_chat_id: string;
  title: string | null;
  peer_type: string;
  account_name: string | null;
}

export async function fetchGroupSources(): Promise<GroupSource[]> {
  const { data } = await apiClient.get<GroupSource[]>('/api/campaigns/group-sources');
  return data;
}

export async function fetchGroupSourceContacts(params: {
  bdAccountId: string;
  telegramChatId: string;
}): Promise<{ contactIds: string[] }> {
  const { data } = await apiClient.get<{ contactIds: string[] }>('/api/campaigns/group-sources/contacts', {
    params,
  });
  return data;
}

export async function uploadAudienceFromCsv(
  campaignId: string,
  body: { content: string; hasHeader?: boolean }
): Promise<{ contactIds: string[]; created: number; matched: number }> {
  const { data } = await apiClient.post<{ contactIds: string[]; created: number; matched: number }>(
    `/api/campaigns/${campaignId}/audience/from-csv`,
    body
  );
  return data;
}
