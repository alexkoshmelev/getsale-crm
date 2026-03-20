import { z } from 'zod';

export const AcActivityListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
