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
