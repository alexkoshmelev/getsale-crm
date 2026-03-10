import { z } from 'zod';

const companySizeEnum = z.enum(['1-10', '11-50', '51-100', '101-500', '500+']);

export const CompanyCreateSchema = z.object({
  name: z.string().min(1, 'Name is required').max(255).trim(),
  industry: z.string().max(100).optional(),
  size: companySizeEnum.optional(),
  description: z.string().max(5000).optional(),
  goals: z.array(z.unknown()).optional(),
  policies: z.record(z.unknown()).optional(),
});

export const CompanyUpdateSchema = CompanyCreateSchema.partial();

export const ContactCreateSchema = z.object({
  firstName: z.string().max(255).trim().optional(),
  lastName: z.string().max(255).trim().optional(),
  displayName: z.string().max(255).trim().optional(),
  username: z.string().max(255).trim().optional(),
  email: z.string().email().max(255).optional().or(z.literal('')),
  phone: z.string().max(50).optional(),
  telegramId: z.string().max(100).optional(),
  companyId: z.string().uuid().optional().nullable(),
  consentFlags: z
    .object({
      email: z.boolean().optional(),
      sms: z.boolean().optional(),
      telegram: z.boolean().optional(),
      marketing: z.boolean().optional(),
    })
    .optional(),
});

export const ContactUpdateSchema = z.object({
  firstName: z.string().max(255).trim().optional().nullable(),
  lastName: z.string().max(255).trim().optional().nullable(),
  email: z.string().email().max(255).optional().nullable().or(z.literal('')),
  phone: z.string().max(50).optional().nullable(),
  telegramId: z.string().max(100).optional().nullable(),
  companyId: z.string().uuid().optional().nullable(),
  displayName: z.string().max(255).optional().nullable(),
  username: z.string().max(255).optional().nullable(),
  consentFlags: z
    .object({
      email: z.boolean().optional(),
      sms: z.boolean().optional(),
      telegram: z.boolean().optional(),
      marketing: z.boolean().optional(),
    })
    .optional(),
});

export const DealCreateSchema = z
  .object({
    companyId: z.string().uuid('Invalid company ID').optional().nullable(),
    contactId: z.string().uuid().optional().nullable(),
    pipelineId: z.string().uuid('Invalid pipeline ID').optional().nullable(), // required when no leadId; when leadId present taken from lead
    stageId: z.string().uuid().optional().nullable(), // if omitted, first stage of pipeline is used
    leadId: z.string().uuid('Invalid lead ID').optional().nullable(),
    title: z.string().min(1, 'Title is required').max(255).trim(),
    value: z.number().min(0).optional().nullable(),
    currency: z.string().length(3).optional(),
    probability: z.number().min(0).max(100).optional().nullable(),
    expectedCloseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    comments: z.string().max(5000).optional().nullable(),
    bdAccountId: z.string().uuid().optional().nullable(),
    channel: z.string().max(50).optional().nullable(),
    channelId: z.string().max(255).optional().nullable(),
  })
  .refine(
    (data) =>
      data.companyId != null ||
      (data.bdAccountId != null && data.channel != null && data.channelId != null) ||
      data.contactId != null ||
      data.leadId != null,
    { message: 'Either companyId, (bdAccountId + channel + channelId), contactId, or leadId is required' }
  );

export const DealUpdateSchema = z.object({
  title: z.string().min(1).max(255).trim().optional(),
  value: z.number().min(0).optional().nullable(),
  currency: z.string().length(3).optional().nullable(),
  contactId: z.string().uuid().optional().nullable(),
  ownerId: z.string().uuid().optional(),
  probability: z.number().min(0).max(100).optional().nullable(),
  expectedCloseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
  comments: z.string().max(5000).optional().nullable(),
});

export const DealStageUpdateSchema = z.object({
  stageId: z.string().uuid('Invalid stage ID'),
  reason: z.string().max(500).optional(),
  autoMoved: z.boolean().optional(),
});

export type CompanyCreateInput = z.infer<typeof CompanyCreateSchema>;
export type CompanyUpdateInput = z.infer<typeof CompanyUpdateSchema>;
export type ContactCreateInput = z.infer<typeof ContactCreateSchema>;
export type ContactUpdateInput = z.infer<typeof ContactUpdateSchema>;
export type DealCreateInput = z.infer<typeof DealCreateSchema>;
export type DealUpdateInput = z.infer<typeof DealUpdateSchema>;
export const ContactImportSchema = z.object({
  content: z.string().min(1, 'content (CSV string) is required').max(5_000_000),
  hasHeader: z.boolean().optional().default(true),
  mapping: z
    .record(z.number().int().min(0))
    .optional()
    .default({ firstName: 0, lastName: 1, email: 2, phone: 3, telegramId: 4 }),
});

export type DealStageUpdateInput = z.infer<typeof DealStageUpdateSchema>;
export const ImportFromTelegramGroupSchema = z.object({
  bdAccountId: z.string().uuid(),
  telegramChatId: z.string().min(1).max(128),
  telegramChatTitle: z.string().max(512).optional().nullable(),
  searchKeyword: z.string().max(256).optional().nullable(),
  excludeAdmins: z.boolean().optional(),
  leaveAfter: z.boolean().optional(),
  postDepth: z.number().min(1).max(500).optional(),
});

export type ContactImportInput = z.infer<typeof ContactImportSchema>;
export type ImportFromTelegramGroupInput = z.infer<typeof ImportFromTelegramGroupSchema>;

export const DiscoveryTaskCreateSchema = z.object({
  name: z.string().min(1).max(255).trim(),
  type: z.enum(['search', 'parse']),
  params: z.record(z.unknown()), // Depending on type, could be refined further
});

export const DiscoveryTaskActionSchema = z.object({
  action: z.enum(['start', 'pause', 'stop']),
});

export type DiscoveryTaskCreateInput = z.infer<typeof DiscoveryTaskCreateSchema>;
export type DiscoveryTaskActionInput = z.infer<typeof DiscoveryTaskActionSchema>;

// ─── Parse flow (Contact Discovery) ───────────────────────────────────────

export const TelegramSourceTypeSchema = z.enum(['channel', 'public_group', 'private_group', 'comment_group', 'unknown']);
export type TelegramSourceType = z.infer<typeof TelegramSourceTypeSchema>;

export const ResolvedSourceSchema = z.object({
  input: z.string(),
  type: TelegramSourceTypeSchema,
  title: z.string(),
  username: z.string().optional(),
  chatId: z.string(),
  membersCount: z.number().optional(),
  linkedChatId: z.number().optional(),
  canGetMembers: z.boolean(),
  canGetMessages: z.boolean(),
});
export type ResolvedSourceInput = z.infer<typeof ResolvedSourceSchema>;

export const ParseSettingsSchema = z.object({
  depth: z.enum(['fast', 'standard', 'deep']).default('standard'),
  excludeAdmins: z.boolean().default(true),
  maxMessages: z.number().optional(),
  maxMembers: z.number().optional(),
});
export type ParseSettingsInput = z.infer<typeof ParseSettingsSchema>;

export const ParseResolveSchema = z.object({
  sources: z.array(z.string().min(1)).min(1).max(20),
  bdAccountId: z.string().uuid(),
});
export const ParseStartSchema = z.object({
  sources: z.array(ResolvedSourceSchema).min(1).max(50),
  settings: ParseSettingsSchema.optional(),
  accountIds: z.array(z.string().uuid()).min(1).max(10),
  listName: z.string().max(255).optional(),
});
export type ParseResolveInput = z.infer<typeof ParseResolveSchema>;
export type ParseStartInput = z.infer<typeof ParseStartSchema>;
