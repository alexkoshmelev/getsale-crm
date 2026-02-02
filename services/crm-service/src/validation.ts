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
  firstName: z.string().min(1, 'First name is required').max(255).trim(),
  lastName: z.string().max(255).trim().optional(),
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
  firstName: z.string().min(1).max(255).trim().optional(),
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
    pipelineId: z.string().uuid('Invalid pipeline ID'),
    stageId: z.string().uuid().optional().nullable(), // if omitted, first stage of pipeline is used
    title: z.string().min(1, 'Title is required').max(255).trim(),
    value: z.number().min(0).optional().nullable(),
    currency: z.string().length(3).optional(),
    // Сделка из чата: минимальная модель — чат + сумма
    bdAccountId: z.string().uuid().optional().nullable(),
    channel: z.string().max(50).optional().nullable(),
    channelId: z.string().max(255).optional().nullable(),
  })
  .refine(
    (data) => data.companyId != null || (data.bdAccountId != null && data.channel != null && data.channelId != null),
    { message: 'Either companyId or (bdAccountId + channel + channelId) is required' }
  );

export const DealUpdateSchema = z.object({
  title: z.string().min(1).max(255).trim().optional(),
  value: z.number().min(0).optional().nullable(),
  currency: z.string().length(3).optional().nullable(),
  contactId: z.string().uuid().optional().nullable(),
  ownerId: z.string().uuid().optional(),
});

export const DealStageUpdateSchema = z.object({
  stageId: z.string().uuid('Invalid stage ID'),
  reason: z.string().max(500).optional(),
});

export type CompanyCreateInput = z.infer<typeof CompanyCreateSchema>;
export type CompanyUpdateInput = z.infer<typeof CompanyUpdateSchema>;
export type ContactCreateInput = z.infer<typeof ContactCreateSchema>;
export type ContactUpdateInput = z.infer<typeof ContactUpdateSchema>;
export type DealCreateInput = z.infer<typeof DealCreateSchema>;
export type DealUpdateInput = z.infer<typeof DealUpdateSchema>;
export type DealStageUpdateInput = z.infer<typeof DealStageUpdateSchema>;
