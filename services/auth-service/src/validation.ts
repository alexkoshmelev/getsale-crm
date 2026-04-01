import { z } from 'zod';

/** Shared limits for org name/slug (signup + PATCH organization). */
export const AU_ORG_NAME_MAX_LEN = 200;
export const AU_ORG_SLUG_MAX_LEN = 100;

export const AuSignupSchema = z.object({
  email: z.string().email('Invalid email format').max(254).trim().toLowerCase(),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128, 'Password must be at most 128 characters')
    .refine((p) => /[a-z]/.test(p), 'Password must contain a lowercase letter')
    .refine((p) => /[A-Z]/.test(p), 'Password must contain an uppercase letter')
    .refine((p) => /[0-9]/.test(p), 'Password must contain a digit'),
  organizationName: z.string().max(AU_ORG_NAME_MAX_LEN).trim().optional(),
  inviteToken: z.string().min(1).optional(),
});

export const AuSigninSchema = z.object({
  email: z.string().email('Invalid email format').max(254).trim().toLowerCase(),
  password: z.string().min(1, 'Password is required'),
});

export const AuVerifyBodySchema = z.object({
  token: z.string().min(1).optional(),
});

/** Used by `validateEmailAndPassword` in routes/auth.ts */
export const auEmailSchema = z.string().email('Invalid email format').max(254).trim().toLowerCase();

export const AuOrgUpdateSchema = z
  .object({
    name: z.string().max(AU_ORG_NAME_MAX_LEN).trim().optional(),
    slug: z.string().max(AU_ORG_SLUG_MAX_LEN).trim().optional(),
  })
  .refine((d) => (d.name != null && d.name.length > 0) || (d.slug != null && d.slug.length > 0), {
    message: 'At least one of name or slug is required and non-empty',
  });

export const AuTransferOwnershipSchema = z.object({
  newOwnerUserId: z.string().uuid(),
});

export const AuSwitchWorkspaceSchema = z.object({
  organizationId: z.string().uuid(),
});

export const AuCreateWorkspaceSchema = z.object({
  name: z.string().min(1, 'Name is required').max(AU_ORG_NAME_MAX_LEN).trim(),
});

export const AuWorkspaceIdParamSchema = z.object({
  organizationId: z.string().uuid(),
});

export const AuInviteTokenParamSchema = z.object({
  token: z.string().min(1, 'Token is required').max(512).regex(/^[a-zA-Z0-9_-]+$/, 'Invalid token format'),
});

export const AuTwoFactorVerifySetupSchema = z.object({
  token: z.string().min(6).max(10),
  secret: z.string().min(1),
});

export const AuTwoFactorDisableSchema = z.object({
  token: z.string().min(6).max(10),
});

export const AuTwoFactorValidateSchema = z
  .object({
    tempToken: z.string().min(1),
    token: z.string().min(6).max(10).optional(),
    recoveryCode: z.string().min(1).optional(),
  })
  .refine((d) => d.token != null || d.recoveryCode != null, {
    message: 'Verification code or recovery code is required',
    path: ['token'],
  });
