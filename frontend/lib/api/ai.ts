import { apiClient } from './client';

export async function previewAutoResponderReply(body: {
  systemPrompt: string;
  conversationHistory: { role: 'user' | 'assistant'; content: string; date?: string }[];
  incomingMessage: string;
}): Promise<{ text: string }> {
  const { data } = await apiClient.post<{ text: string }>('/api/ai/auto-respond', body);
  return data;
}
