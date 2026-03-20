import { z } from 'zod';
import { CampaignStatus } from '@getsale/types';

const targetAudienceSchema = z
  .object({
    contactIds: z.array(z.string().uuid()).optional(),
    limit: z.number().int().min(0).optional(),
    sendDelaySeconds: z.number().min(0).optional(),
    sendDelayMinSeconds: z.number().int().min(0).max(3600).optional(),
    sendDelayMaxSeconds: z.number().int().min(0).max(3600).optional(),
    dynamicPipelineId: z.string().uuid().optional(),
    dynamicStageIds: z.array(z.string().uuid()).optional(),
    bdAccountId: z.string().uuid().optional(),
    bdAccountIds: z.array(z.string().uuid()).optional(),
    randomizeWithAI: z.boolean().optional(),
  })
  .passthrough()
  .superRefine((val, ctx) => {
    const min = val.sendDelayMinSeconds;
    const max = val.sendDelayMaxSeconds;
    if (min != null && max != null && min > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sendDelayMinSeconds must be <= sendDelayMaxSeconds',
        path: ['sendDelayMinSeconds'],
      });
    }
  })
  .optional()
  .nullable();

const scheduleSchema = z
  .object({
    timezone: z.string().max(64).optional(),
    workingHours: z
      .object({
        start: z.string().max(16).optional(),
        end: z.string().max(16).optional(),
      })
      .optional(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  })
  .passthrough()
  .optional()
  .nullable();

const leadCreationSettingsSchema = z
  .object({
    trigger: z.string().max(64).optional(),
    default_stage_id: z.string().uuid().optional(),
    default_responsible_id: z.string().uuid().optional(),
  })
  .passthrough()
  .optional()
  .nullable();

const campaignStatusSchema = z.enum([
  CampaignStatus.DRAFT,
  CampaignStatus.ACTIVE,
  CampaignStatus.PAUSED,
  CampaignStatus.COMPLETED,
]);

export const CampaignCreateSchema = z.object({
  name: z.string().min(1, 'Name is required').max(500).trim(),
  companyId: z.string().uuid().optional().nullable(),
  pipelineId: z.string().uuid().optional().nullable(),
  targetAudience: targetAudienceSchema,
  schedule: scheduleSchema,
});

export const CampaignPatchSchema = z.object({
  name: z.string().min(1).max(500).trim().optional(),
  companyId: z.string().uuid().optional().nullable(),
  pipelineId: z.string().uuid().optional().nullable(),
  targetAudience: targetAudienceSchema,
  schedule: scheduleSchema,
  status: campaignStatusSchema.optional(),
  leadCreationSettings: leadCreationSettingsSchema,
});

export const FromCsvBodySchema = z.object({
  content: z.string().min(1, 'content (CSV text) is required').max(5_000_000),
  hasHeader: z.boolean().optional().default(true),
});

/** One Telegram @username or numeric user id per line (pasted list). */
export const FromUsernameListBodySchema = z.object({
  text: z.string().min(1, 'text is required').max(500_000),
});

export const ParticipantsBulkSchema = z.object({
  contactIds: z.array(z.string().uuid()).min(1).max(5000),
  bdAccountId: z.string().uuid().optional(),
});

export const PresetCreateSchema = z.object({
  name: z.string().min(1, 'Name is required').max(500).trim(),
  channel: z.string().max(64).optional().default('telegram'),
  content: z.string().min(1, 'Content is required').max(50_000),
});

export type CampaignCreateInput = z.infer<typeof CampaignCreateSchema>;
export type CampaignPatchInput = z.infer<typeof CampaignPatchSchema>;
export type FromCsvBodyInput = z.infer<typeof FromCsvBodySchema>;
export type FromUsernameListBodyInput = z.infer<typeof FromUsernameListBodySchema>;
export type ParticipantsBulkInput = z.infer<typeof ParticipantsBulkSchema>;
export type PresetCreateInput = z.infer<typeof PresetCreateSchema>;
