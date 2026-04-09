import { apiClient } from './client';
import { enrichContactsViaBdAccounts } from './bd-accounts';

export type CampaignStatus = 'draft' | 'active' | 'paused' | 'completed';

export interface CampaignTargetAudience {
  filters?: Record<string, unknown>;
  limit?: number;
  onlyNew?: boolean;
  contactIds?: string[];
  /** Single account (legacy). Prefer bdAccountIds when multiple. */
  bdAccountId?: string;
  /** Multiple BD accounts for the campaign; system distributes participants round-robin. */
  bdAccountIds?: string[];
  sendDelaySeconds?: number;
  sendDelayMinSeconds?: number;
  sendDelayMaxSeconds?: number;
  /** Rephrase message text via AI (OpenRouter) for randomization. */
  randomizeWithAI?: boolean;
  /** Resolve username -> telegram_id via Telegram API before starting the campaign. */
  enrichContactsBeforeStart?: boolean;
  /** Dynamic campaign: auto-add leads when they enter one of these stages in the given pipeline */
  dynamicPipelineId?: string;
  dynamicStageIds?: string[];
  /** Overrides BD account daily cap for staggering (1–500). */
  dailySendTarget?: number;
}

export interface LeadCreationSettings {
  trigger?: 'on_first_send' | 'on_reply';
  default_stage_id?: string;
  /** User ID to set as lead responsible when creating lead from campaign. */
  default_responsible_id?: string;
}

/** BD account snapshot on campaign list/detail (from campaign-service). */
export interface CampaignBdAccount {
  id: string;
  displayName: string;
  floodWaitUntil?: string | null;
  floodWaitSeconds?: number | null;
  floodReason?: string | null;
  floodLastAt?: string | null;
  spamRestrictedAt?: string | null;
  spamRestrictionSource?: string | null;
  peerFloodCount1h?: number | null;
  photoFileId?: string | null;
  isActive: boolean;
  connectionState?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  phoneNumber?: string | null;
  telegramId?: string | null;
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
  created_by_user_id?: string | null;
  owner_name?: string | null;
  bd_account_name?: string | null;
  /** Enriched BD accounts for this campaign (order matches audience). */
  bd_accounts?: CampaignBdAccount[];
  total_participants?: number;
  total_sent?: number;
  total_read?: number;
  total_replied?: number;
  total_converted_to_shared_chat?: number;
  total_won?: number;
  total_revenue?: number;
}

export interface CampaignListResponse {
  data: Campaign[];
  total: number;
  page: number;
  limit: number;
  summary: { total_sent: number; total_replied: number; total_won: number };
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
  /** Skipped at send time; kept in sequence editor. */
  is_hidden?: boolean;
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

/** Simplified participant phase for UI display (5 statuses). */
export type CampaignParticipantPhase =
  | 'waiting'
  | 'sent'
  | 'read'
  | 'replied'
  | 'failed';

export interface CampaignParticipantRow {
  participant_id: string;
  contact_id: string;
  contact_name: string;
  conversation_id: string | null;
  bd_account_id: string | null;
  /** Display name of the BD account that sends to this participant. */
  bd_account_display_name?: string | null;
  channel_id: string | null;
  status_phase: CampaignParticipantPhase;
  /** Last delivery error (e.g. PEER_FLOOD) when status_phase is 'failed'. */
  last_error?: string | null;
  pipeline_stage_name: string | null;
  sent_at: string | null;
  replied_at: string | null;
  shared_chat_created_at: string | null;
  /** Current sequence step index (0-based; next message to send). */
  current_step?: number;
  /** When the next message in the sequence is scheduled (ISO string or null if waiting for reply). */
  next_send_at?: string | null;
  /** Total number of steps in the campaign sequence. */
  sequence_total_steps?: number;
  /** When the latest sent message was read by the contact. */
  read_at?: string | null;
}

export interface CampaignStats {
  total: number;
  byStatus: Record<string, number>;
  byPhase?: { waiting: number; sent: number; replied: number; failed: number };
  /** When there are failed participants, a sample error message (e.g. PEER_FLOOD). */
  error_summary?: { count: number; sample?: string };
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

export async function fetchCampaigns(params?: { status?: CampaignStatus; page?: number; limit?: number }): Promise<CampaignListResponse> {
  const { data } = await apiClient.get<CampaignListResponse>('/api/campaigns', { params: params ?? {} });
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

export async function duplicateCampaign(id: string): Promise<Campaign> {
  const { data } = await apiClient.post<Campaign>(`/api/campaigns/${id}/duplicate`);
  return data;
}

/** Remove all participants and send records; set status to draft. Keeps target_audience, schedule, templates, sequences. */
export async function resetCampaignProgress(id: string): Promise<Campaign> {
  const { data } = await apiClient.post<Campaign>(`/api/campaigns/${id}/reset-progress`);
  return data;
}

export async function pauseCampaignAccount(
  campaignId: string,
  accountId: string
): Promise<{ ok: boolean; sendBlockedUntil?: string }> {
  const { data } = await apiClient.post(`/api/campaigns/${campaignId}/accounts/${accountId}/pause`);
  return data as { ok: boolean; sendBlockedUntil?: string };
}

export async function resumeCampaignAccount(campaignId: string, accountId: string): Promise<{ ok: boolean }> {
  const { data } = await apiClient.post(`/api/campaigns/${campaignId}/accounts/${accountId}/resume`);
  return data as { ok: boolean };
}

export async function removeCampaignAccount(
  campaignId: string,
  accountId: string
): Promise<{ ok: boolean; reassignedParticipants: number; remainingBdAccountIds: string[] }> {
  const { data } = await apiClient.delete(`/api/campaigns/${campaignId}/accounts/${accountId}`);
  return data as { ok: boolean; reassignedParticipants: number; remainingBdAccountIds: string[] };
}

export interface AudienceConflictRow {
  contact_id: string;
  contact_name: string | null;
  contact_username: string | null;
  campaign_id: string;
  campaign_name: string;
  participant_status: string;
  last_sent_at: string | null;
  is_current_campaign: boolean;
}

export async function checkCampaignAudienceConflicts(
  campaignId: string,
  contactIds: string[]
): Promise<{ conflicts: AudienceConflictRow[] }> {
  const { data } = await apiClient.post<{ conflicts: AudienceConflictRow[] }>(
    `/api/campaigns/${campaignId}/audience/conflicts`,
    { contactIds }
  );
  return data;
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
  body: Partial<{
    orderIndex: number;
    templateId: string;
    delayHours: number;
    delayMinutes: number;
    conditions: Record<string, unknown>;
    triggerType: CampaignStepTriggerType;
    isHidden: boolean;
  }>
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

export interface CampaignParticipantAccount {
  id: string;
  displayName: string;
}

export async function fetchCampaignParticipantAccounts(campaignId: string): Promise<CampaignParticipantAccount[]> {
  const { data } = await apiClient.get<CampaignParticipantAccount[]>(
    `/api/campaigns/${campaignId}/participant-accounts`
  );
  return Array.isArray(data) ? data : [];
}

export async function fetchCampaignParticipantRows(
  campaignId: string,
  params?: {
    page?: number;
    limit?: number;
    filter?: 'all' | 'replied' | 'not_replied' | 'shared';
    bdAccountId?: string;
    sentFrom?: string;
    sentTo?: string;
  }
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
  /** Sends grouped by date and account (last 14 days). */
  sendsByAccountByDay?: { date: string; accountId: string; accountDisplayName: string; sends: number }[];
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

export interface CampaignAgent extends CampaignBdAccount {
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
  sourceKeyword?: string;
  sourceTelegramChatId?: string;
  sourceBdAccountId?: string;
}): Promise<ContactForPicker[]> {
  const { data } = await apiClient.get<ContactForPicker[]>('/api/campaigns/contacts-for-picker', {
    params: params ?? {},
  });
  return data;
}

export async function fetchTelegramSourceKeywords(): Promise<string[]> {
  const { data } = await apiClient.get<string[]>('/api/campaigns/telegram-source-keywords');
  return Array.isArray(data) ? data : [];
}

export interface TelegramSourceGroup {
  bdAccountId: string;
  telegramChatId: string;
  telegramChatTitle?: string;
}

export async function fetchTelegramSourceGroups(): Promise<TelegramSourceGroup[]> {
  const { data } = await apiClient.get<TelegramSourceGroup[]>('/api/campaigns/telegram-source-groups');
  return Array.isArray(data) ? data : [];
}

/** Обогатить контакты данными из Telegram (first_name, last_name, username) через getEntity. */
export async function enrichContactsFromTelegram(
  contactIds: string[],
  bdAccountId?: string
): Promise<{ enriched: number }> {
  return enrichContactsViaBdAccounts(contactIds, bdAccountId);
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

export async function uploadAudienceFromUsernameList(
  campaignId: string,
  body: { text: string }
): Promise<{
  contactIds: string[];
  created: number;
  matched: number;
  skipped: number;
  invalidSamples?: string[];
}> {
  const { data } = await apiClient.post<{
    contactIds: string[];
    created: number;
    matched: number;
    skipped: number;
    invalidSamples?: string[];
  }>(`/api/campaigns/${campaignId}/audience/from-usernames`, body);
  return data;
}

export interface AddCampaignParticipantsResult {
  inserted: number;
  requested: number;
  eligibleWithTelegram: number;
  campaignStatus: CampaignStatus;
}

export async function addCampaignParticipants(campaignId: string, contactIds: string[]): Promise<AddCampaignParticipantsResult> {
  const { data } = await apiClient.post<AddCampaignParticipantsResult>(`/api/campaigns/${campaignId}/participants/add`, {
    contactIds,
  });
  return data;
}

export interface CampaignSendHistoryRow {
  sendId: string;
  sentAt: string;
  sequenceStep: number;
  status: string;
  participantStatus?: string | null;
  messageId: string | null;
  /** Delivery / deferral details (e.g. event: min_gap, rate_limit_429). */
  metadata?: Record<string, unknown> | null;
  participantId: string;
  contactId: string;
  contactName: string;
  messageContent: string | null;
  messageStatus: string | null;
  messageDirection?: string | null;
}

export interface CampaignSendsPage {
  data: CampaignSendHistoryRow[];
  /** total = all rows (sent, deferred, failed); sentTotal = delivered messages only */
  pagination: { page: number; limit: number; total: number; sentTotal: number; totalPages: number };
}

export interface CampaignParticipantExportRow {
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  phone: string | null;
  email: string | null;
  status: string;
  display_status: string;
  first_sent_at: string | null;
  sender_account: string | null;
  is_read: boolean;
  replied_at: string | null;
  first_reply_text: string | null;
}

export async function fetchCampaignParticipantsExport(campaignId: string): Promise<CampaignParticipantExportRow[]> {
  const { data } = await apiClient.get<CampaignParticipantExportRow[]>(`/api/campaigns/${campaignId}/participants/export`);
  return data;
}

export async function fetchCampaignSends(
  campaignId: string,
  params?: { page?: number; limit?: number }
): Promise<CampaignSendsPage> {
  const { data } = await apiClient.get<CampaignSendsPage>(`/api/campaigns/${campaignId}/sends`, {
    params: params ?? {},
  });
  return data;
}
