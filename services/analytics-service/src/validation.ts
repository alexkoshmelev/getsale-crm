import { z } from 'zod';

export type AnPeriodKey = 'today' | 'week' | 'month' | 'year';

export const AnPeriodQuerySchema = z.object({
  period: z.enum(['today', 'week', 'month', 'year']).default('month'),
});

export const AnBdAnalyticsQuerySchema = z.object({
  period: z.enum(['today', 'week', 'month', 'year']).default('month'),
  bd_account_id: z.string().uuid().optional(),
  folder_id: z.coerce.number().int().min(0).optional(),
});
