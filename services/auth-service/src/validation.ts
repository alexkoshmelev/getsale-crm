import { z } from 'zod';

export const AU_ORG_NAME_MAX_LEN = 200;
export const AU_ORG_SLUG_MAX_LEN = 100;

export const SignupSchema = z.object({
  email: z.string().email().max(254).trim().toLowerCase(),
  password: z.string().min(8).max(128)
    .refine((p) => /[a-z]/.test(p), 'Must contain a lowercase letter')
    .refine((p) => /[A-Z]/.test(p), 'Must contain an uppercase letter')
    .refine((p) => /[0-9]/.test(p), 'Must contain a digit'),
  organizationName: z.string().max(AU_ORG_NAME_MAX_LEN).trim().optional(),
  inviteToken: z.string().min(1).optional(),
});

export const SigninSchema = z.object({
  email: z.string().email().max(254).trim().toLowerCase(),
  password: z.string().min(1),
});

export const VerifyBodySchema = z.object({
  token: z.string().min(1).optional(),
});

export const SwitchWorkspaceSchema = z.object({
  organizationId: z.string().uuid(),
});

export const CreateWorkspaceSchema = z.object({
  name: z.string().min(1, 'Name is required').max(AU_ORG_NAME_MAX_LEN).trim(),
});

export const OrgUpdateSchema = z
  .object({
    name: z.string().max(AU_ORG_NAME_MAX_LEN).trim().optional(),
    slug: z.string().max(AU_ORG_SLUG_MAX_LEN).trim().optional(),
  })
  .refine((d) => (d.name != null && d.name.length > 0) || (d.slug != null && d.slug.length > 0), {
    message: 'At least one of name or slug is required and non-empty',
  });

export const TransferOwnershipSchema = z.object({
  newOwnerUserId: z.string().uuid(),
});

export const WorkspaceIdParamSchema = z.object({
  organizationId: z.string().uuid(),
});

export const InviteTokenParamSchema = z.object({
  token: z.string().min(1).max(512).regex(/^[a-zA-Z0-9_-]+$/),
});

export const TwoFactorVerifySetupSchema = z.object({
  token: z.string().min(6).max(10),
  secret: z.string().min(1),
});

export const TwoFactorDisableSchema = z.object({
  token: z.string().min(6).max(10),
});

export const TwoFactorValidateSchema = z
  .object({
    tempToken: z.string().min(1),
    token: z.string().min(6).max(10).optional(),
    recoveryCode: z.string().min(1).optional(),
  })
  .refine((d) => d.token != null || d.recoveryCode != null, {
    message: 'Verification code or recovery code is required',
    path: ['token'],
  });
