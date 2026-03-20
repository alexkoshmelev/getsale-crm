import { z } from 'zod';

export const TmInviteMemberSchema = z.object({
  email: z.string().email().max(254).transform((s) => s.trim().toLowerCase()),
  teamId: z.union([z.string().uuid(), z.literal('default')]).optional(),
  role: z.string().max(64).optional(),
});

export const TmUpdateMemberRoleSchema = z.object({
  role: z.string().min(1).max(64),
});

export const TmCreateInviteLinkSchema = z.object({
  role: z.string().max(64).optional(),
  expiresInDays: z.coerce.number().int().min(1).max(365).optional(),
});

export const TmAssignClientSchema = z.object({
  teamId: z.string().uuid(),
  clientId: z.string().uuid(),
  assignedTo: z.string().uuid(),
});
