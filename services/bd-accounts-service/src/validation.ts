import { z } from 'zod';

// --- Sync (folders, chats, discovery) — formerly sync-schemas.ts

export const SyncChatItemSchema = z
  .object({
    id: z.string().optional(),
    telegram_chat_id: z.string().optional(),
    name: z.string().optional(),
    title: z.string().optional(),
    folderId: z.number().optional().nullable(),
    folderIds: z.array(z.number()).optional(),
    isChannel: z.boolean().optional(),
    isGroup: z.boolean().optional(),
  })
  .refine((d) => (d.id ?? d.telegram_chat_id ?? '').toString().trim().length > 0, { message: 'id or telegram_chat_id required' });

export const SyncChatsBodySchema = z.object({
  chats: z.array(SyncChatItemSchema).min(0).max(2000),
});

export const SyncFoldersOrderSchema = z.object({
  order: z.array(z.union([z.string(), z.number()])).min(1).max(500),
});

export const SyncFolderCustomSchema = z.object({
  folder_title: z.string().max(12).trim().optional(),
  icon: z.string().max(20).trim().optional().nullable(),
});

export const SyncFolderPatchSchema = z
  .object({
    icon: z.string().max(20).trim().nullable().optional(),
    folder_title: z.string().max(12).trim().optional(),
  })
  .refine((d) => d.icon !== undefined || d.folder_title !== undefined, { message: 'At least one of icon or folder_title required' });

export const ResolveChatsSchema = z.object({
  inputs: z.array(z.string().min(1).max(512)).max(20).optional(),
});

export const ParseResolveSchema = z.object({
  sources: z.array(z.string().min(1).max(512)).max(20).optional(),
});

/** GET .../comment-participants — authors from replies under recent channel posts (B4). */
export const CommentParticipantsQuerySchema = z.object({
  linkedChatId: z.string().min(1).max(32),
  postLimit: z.coerce.number().int().min(5).max(100).optional(),
  maxRepliesPerPost: z.coerce.number().int().min(20).max(500).optional(),
  excludeAdmins: z.enum(['true', 'false', '1', '0']).optional(),
});

export const ReactionParticipantsQuerySchema = z.object({
  depth: z.coerce.number().int().min(20).max(200).optional(),
});

export const ChatFolderPatchSchema = z.object({
  folder_ids: z.array(z.coerce.number().int().min(0)).optional(),
  folder_id: z.coerce.number().int().min(0).optional().nullable(),
});

export const SyncFolderItemSchema = z.object({
  folderId: z.number().optional(),
  folder_id: z.number().optional(),
  folderTitle: z.string().max(200).trim().optional(),
  folder_title: z.string().max(200).trim().optional(),
  is_user_created: z.boolean().optional(),
  isUserCreated: z.boolean().optional(),
  icon: z.string().max(20).trim().optional().nullable(),
});

export const SyncFoldersBodySchema = z.object({
  folders: z.array(SyncFolderItemSchema).min(0).max(500),
  extraChats: z.array(SyncChatItemSchema).max(1000).optional(),
});

// --- Accounts

export const BdAccountPurchaseSchema = z.object({
  platform: z.string().min(1).max(64),
  durationDays: z.number().int().min(1).max(3650),
});

export const BdAccountEnrichContactsSchema = z.object({
  contactIds: z.array(z.string()).optional(),
  bdAccountId: z.string().uuid().optional().nullable(),
});

export const BdAccountPatchSchema = z
  .object({
    display_name: z.string().max(500).trim().optional().nullable(),
    proxy_config: z
      .object({
        type: z.enum(['socks5']).optional(),
        host: z.string().min(1).max(256),
        port: z.number().int().min(1).max(65535),
        username: z.string().max(256).optional(),
        password: z.string().max(512).optional(),
      })
      .nullable()
      .optional(),
    /** IANA timezone e.g. Europe/Moscow */
    timezone: z.string().max(64).trim().nullable().optional(),
    working_hours_start: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    working_hours_end: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
    working_days: z.array(z.number().int().min(0).max(6)).max(7).nullable().optional(),
    auto_responder_enabled: z.boolean().optional(),
    auto_responder_system_prompt: z.string().max(16000).nullable().optional(),
    auto_responder_history_count: z
      .number()
      .int()
      .refine((n) => [10, 25, 50, 100].includes(n), { message: 'Must be 10, 25, 50, or 100' })
      .optional(),
  })
  .optional();

export const ProxyConfigSchema = z
  .object({
    type: z.enum(['socks5']).optional(),
    host: z.string().min(1).max(256),
    port: z.number().int().min(1).max(65535),
    username: z.string().max(256).optional(),
    password: z.string().max(512).optional(),
  })
  .optional();

export const BdAccountConfigSchema = z
  .object({
    limits: z.record(z.unknown()).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .optional();

// --- Auth (Telegram connect / QR)

export const BdAuthSendCodeSchema = z.object({
  platform: z.literal('telegram'),
  phoneNumber: z.string().min(1).max(32).trim(),
  proxyConfig: ProxyConfigSchema,
});

export const BdAuthVerifyCodeSchema = z.object({
  accountId: z.string().uuid(),
  phoneNumber: z.string().min(1).max(32).trim(),
  phoneCode: z.string().min(1).max(16).trim(),
  phoneCodeHash: z.string().min(1).max(512),
  password: z.string().max(256).optional(),
});

export const BdAuthQrLoginPasswordSchema = z.object({
  sessionId: z.string().min(1).max(256),
  password: z.string().min(1).max(256),
});

export const BdAuthConnectSchema = z.object({
  platform: z.literal('telegram'),
  phoneNumber: z.string().min(1).max(32).trim(),
  sessionString: z.string().max(10000).optional(),
  proxyConfig: ProxyConfigSchema,
});

export const BdAuthStartQrLoginSchema = z.object({
  proxyConfig: ProxyConfigSchema,
});

// --- Messaging (Telegram send / draft / shared chat)

export const BdSendMessageSchema = z
  .object({
    chatId: z.string().min(1).max(256),
    text: z.string().optional(),
    fileBase64: z.string().optional(),
    fileName: z.string().max(512).optional(),
    replyToMessageId: z.union([z.string(), z.number()]).optional(),
    idempotencyKey: z.string().max(256).optional(),
    /** Retry send with this peer string if chatId fails with entity-not-found (e.g. numeric id vs username) */
    usernameHint: z.string().min(1).max(256).optional().nullable(),
  })
  .refine((d) => (d.text != null && d.text !== '') || (d.fileBase64 != null && d.fileBase64 !== ''), { message: 'text or fileBase64 is required' });

export const BdSendBulkSchema = z.object({
  channelIds: z.array(z.string().min(1).max(256)).min(1).max(100),
  text: z.string().min(1).max(100_000),
});

export const BdForwardMessageSchema = z.object({
  fromChatId: z.string().min(1).max(256),
  toChatId: z.string().min(1).max(256),
  telegramMessageId: z.coerce.number().int().positive(),
});

export const BdDraftSchema = z.object({
  channelId: z.string().min(1).max(256),
  text: z.string().max(100_000).optional(),
  replyToMsgId: z.union([z.string(), z.number()]).optional(),
});

export const BdDeleteMessageSchema = z.object({
  channelId: z.string().min(1).max(256),
  telegramMessageId: z.coerce.number().int().nonnegative(),
});

export const BdCreateSharedChatSchema = z.object({
  title: z.string().min(1).max(255).trim(),
  lead_telegram_user_id: z.coerce.number().int().positive().optional().nullable(),
  lead_username: z.string().max(128).trim().optional().nullable(),
  extra_usernames: z.array(z.string().max(128).trim()).optional(),
});

export const BdReactionBodySchema = z.object({
  chatId: z.string().min(1).max(256),
  reaction: z.array(z.string().max(64)).optional(),
});

export const BdChatIdBodySchema = z.object({
  chatId: z.string().min(1).max(256),
  /** Last read inbound message id (Telegram). Omit to use 0 (client default). */
  maxId: z.number().int().nonnegative().optional(),
});

/** Lazy resolve for campaigns: username or numeric id → stable string peer id (primes GramJS cache). */
export const BdResolvePeerSchema = z.object({
  chatId: z.string().min(1).max(256),
  usernameHint: z.string().max(128).trim().optional().nullable(),
});
