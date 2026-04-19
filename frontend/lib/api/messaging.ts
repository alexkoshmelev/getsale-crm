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
  timeline: LeadTimelineEvent[];
}

/** Matches messaging-api lead-context enriched timeline (lead_activity_log + stage names). */
export interface LeadTimelineEvent {
  id: string;
  lead_id: string;
  type: string;
  metadata?: unknown;
  created_at: string;
  from_stage_name?: string | null;
  to_stage_name?: string | null;
  stage_name?: string | null;
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

/** API queues work to TSM; DB is updated when Telegram creation finishes. */
export interface SharedChatQueuedResult {
  status: 'queued';
  conversation_id: string;
  title: string;
  shared_chat_created_at: null;
  shared_chat_channel_id: null;
  shared_chat_invite_link: null;
  channel_id?: string;
}

export type SharedChatResult = SharedChatQueuedResult;

const SHARED_CHAT_POLL_MAX_MS = 60_000;
const SHARED_CHAT_POLL_INITIAL_MS = 1500;
const SHARED_CHAT_POLL_MAX_DELAY_MS = 5000;

/** Poll lead-context until shared chat fields appear or timeout; returns last snapshot. */
export async function pollLeadContextUntilSharedChatReady(conversationId: string): Promise<LeadContextByLead> {
  const start = Date.now();
  let delay = SHARED_CHAT_POLL_INITIAL_MS;
  while (Date.now() - start < SHARED_CHAT_POLL_MAX_MS) {
    const ctx = await fetchLeadContext(conversationId);
    if (ctx.shared_chat_created_at != null || (ctx.shared_chat_invite_link != null && ctx.shared_chat_invite_link !== '')) {
      return ctx;
    }
    await new Promise((r) => setTimeout(r, delay));
    delay = Math.min(Math.round(delay * 1.5), SHARED_CHAT_POLL_MAX_DELAY_MS);
  }
  return fetchLeadContext(conversationId);
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
