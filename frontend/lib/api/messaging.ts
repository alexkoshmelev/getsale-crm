import { apiClient } from './client';

export interface MessagingChatSearchItem {
  channel: string;
  channel_id: string;
  bd_account_id: string;
  name: string | null;
}

export interface MessagingSearchResponse {
  items: MessagingChatSearchItem[];
}

export async function searchChats(q: string, limit = 5): Promise<MessagingSearchResponse> {
  if (!q || q.trim().length < 2) return { items: [] };
  const { data } = await apiClient.get<MessagingSearchResponse>('/api/messaging/search', {
    params: { q: q.trim(), limit },
  });
  return data;
}

/** Ответ resolve-contact: bd_account_id и channel_id для перехода в messaging */
export async function resolveContact(contactId: string): Promise<{ bd_account_id: string; channel_id: string }> {
  const { data } = await apiClient.get<{ bd_account_id: string; channel_id: string }>('/api/messaging/resolve-contact', {
    params: { contactId },
  });
  return data;
}

/** Контекст лида по lead_id (тот же контракт, что и GET .../conversations/:id/lead-context) */
export interface LeadContextByLead {
  conversation_id?: string | null;
  lead_id: string;
  contact_id?: string | null;
  contact_name: string;
  contact_telegram_id?: string | null;
  contact_username?: string | null;
  company_name?: string | null;
  bd_account_id?: string | null;
  channel_id?: string | null;
  responsible_id?: string | null;
  responsible_email?: string | null;
  pipeline: { id: string; name: string };
  stage: { id: string; name: string };
  stages: Array<{ id: string; name: string }>;
  campaign: { id: string; name: string } | null;
  became_lead_at: string;
  shared_chat_created_at?: string | null;
  shared_chat_channel_id?: string | null;
  shared_chat_invite_link?: string | null;
  won_at?: string | null;
  revenue_amount?: number | null;
  lost_at?: string | null;
  loss_reason?: string | null;
  timeline: Array<{ type: string; created_at: string; stage_name?: string }>;
}

export async function fetchLeadContextByLeadId(leadId: string): Promise<LeadContextByLead> {
  const { data } = await apiClient.get<LeadContextByLead>(`/api/messaging/lead-context-by-lead/${leadId}`);
  return data;
}

export async function fetchLeadContext(conversationId: string): Promise<LeadContextByLead> {
  const { data } = await apiClient.get<LeadContextByLead>(`/api/messaging/conversations/${conversationId}/lead-context`);
  return data;
}

// Shared Chats

export interface CreateSharedChatParams {
  /** When opening from a chat with conversation — pass this. */
  conversation_id?: string | null;
  /** When lead has no conversation yet (e.g. opened by lead_id) — pass lead_id and bd_account_id. */
  lead_id?: string | null;
  title?: string;
  participant_usernames?: string[];
  /** BD account to use when conversation has none or when creating by lead_id. */
  bd_account_id?: string;
}

export interface SharedChatResult {
  conversation_id: string;
  shared_chat_created_at: string;
  shared_chat_channel_id: string | null;
  shared_chat_invite_link: string | null;
  channel_id?: string;
  title?: string;
}

export async function createSharedChat(params: CreateSharedChatParams): Promise<SharedChatResult> {
  const { data } = await apiClient.post<SharedChatResult>('/api/messaging/create-shared-chat', params);
  return data;
}

// Deal operations

export interface MarkDealWonParams {
  conversation_id: string;
  revenue_amount?: number | null;
}

export interface MarkWonResult {
  conversation_id: string;
  won_at: string;
  revenue_amount: number | null;
}

export async function markDealWon(params: MarkDealWonParams): Promise<MarkWonResult> {
  const { data } = await apiClient.post<MarkWonResult>('/api/messaging/mark-won', params);
  return data;
}

export interface MarkDealLostParams {
  conversation_id: string;
  reason?: string;
}

export interface MarkLostResult {
  conversation_id: string;
  lost_at: string;
  loss_reason: string | null;
}

export async function markDealLost(params: MarkDealLostParams): Promise<MarkLostResult> {
  const { data } = await apiClient.post<MarkLostResult>('/api/messaging/mark-lost', params);
  return data;
}

// Lead stage change

export async function updateLeadStage(leadId: string, body: { stageId: string }): Promise<{ success: boolean }> {
  const { data } = await apiClient.patch<{ success: boolean }>(`/api/pipeline/leads/${leadId}/stage`, body);
  return data;
}

// Conversation view

export async function markConversationViewed(conversationId: string): Promise<{ ok: boolean }> {
  const { data } = await apiClient.patch<{ ok: boolean }>(`/api/messaging/conversations/${conversationId}/view`);
  return data;
}
