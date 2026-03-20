import { z } from 'zod';

export const UsProfileUpdateSchema = z.object({
  firstName: z.string().max(200).trim().optional().nullable(),
  lastName: z.string().max(200).trim().optional().nullable(),
  avatarUrl: z.string().max(2000).trim().optional().nullable(),
  timezone: z.string().max(128).optional().nullable(),
  preferences: z.record(z.unknown()).optional(),
});

export const UsSubscriptionUpgradeSchema = z.object({
  plan: z.string().min(1, 'plan is required').max(64).trim(),
  paymentMethodId: z.string().max(256).optional(),
});

export type UsSubscriptionUpgradeInput = z.infer<typeof UsSubscriptionUpgradeSchema>;
