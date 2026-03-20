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
