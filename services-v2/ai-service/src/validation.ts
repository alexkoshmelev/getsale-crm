import { z } from 'zod';

export const AiDraftGenerateSchema = z.object({
  contactId: z.string().uuid().optional(),
  context: z.string().max(100_000).optional(),
});

export const AiGenerateSearchQueriesSchema = z.object({
  topic: z.string().min(1).max(500).trim(),
});

export const AiCampaignRephraseSchema = z.object({
  text: z.string().min(1).max(4000),
});

export type AiCampaignRephraseInput = z.infer<typeof AiCampaignRephraseSchema>;

const historyEntrySchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(8000),
  date: z.string().max(64).optional(),
});

export const AiAutoRespondSchema = z.object({
  systemPrompt: z.string().min(1).max(8000),
  conversationHistory: z.array(historyEntrySchema).max(100),
  incomingMessage: z.string().min(1).max(4000),
});
