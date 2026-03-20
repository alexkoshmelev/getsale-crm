import { z } from 'zod';

export const PlPipelineCreateSchema = z.object({
  name: z.string().max(200).trim().optional(),
  description: z.string().max(2000).trim().optional().nullable(),
  isDefault: z.boolean().optional(),
});

export const PlPipelineUpdateSchema = z.object({
  name: z.string().max(200).trim().optional(),
  description: z.string().max(2000).trim().optional().nullable(),
  isDefault: z.boolean().optional(),
});

export const PlStageCreateSchema = z.object({
  pipelineId: z.string().uuid(),
  name: z.string().min(1).max(255),
  orderIndex: z.number().int().min(0).optional(),
  color: z.string().max(32).optional().nullable(),
  automationRules: z.unknown().optional(),
  entryRules: z.unknown().optional(),
  exitRules: z.unknown().optional(),
  allowedActions: z.unknown().optional(),
});

export const PlStageUpdateSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  orderIndex: z.number().int().min(0).optional(),
  color: z.string().max(32).optional().nullable(),
  automationRules: z.unknown().optional(),
  entryRules: z.unknown().optional(),
  exitRules: z.unknown().optional(),
  allowedActions: z.unknown().optional(),
});

export const PlLeadCreateSchema = z.object({
  contactId: z.string().uuid('contactId must be a valid UUID'),
  pipelineId: z.string().uuid('pipelineId must be a valid UUID'),
  stageId: z.string().uuid().optional(),
  responsibleId: z.string().uuid().optional(),
});

export type PlLeadCreateInput = z.infer<typeof PlLeadCreateSchema>;
