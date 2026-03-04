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
  conversation_id: string;
  lead_id: string;
  contact_id?: string | null;
  contact_name: string;
  contact_telegram_id?: string | null;
  contact_username?: string | null;
  company_name?: string | null;
  bd_account_id?: string | null;
  channel_id?: string | null;
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
