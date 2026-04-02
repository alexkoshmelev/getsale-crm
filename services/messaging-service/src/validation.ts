import { z } from 'zod';

// --- Public: POST /send (messages-send)

export const MsgSendMessageSchema = z
  .object({
    /** Optional for group/channel chats (e.g. shared chat); required for 1-1. */
    contactId: z
      .union([z.string().uuid(), z.literal(''), z.null()])
      .optional()
      .nullable()
      .transform((v) => (v === '' || v == null ? null : v)),
    channel: z.string().min(1).max(64),
    channelId: z.string().min(1).max(128),
    content: z.string().max(100_000).optional(),
    bdAccountId: z.string().uuid().optional().nullable(),
    fileBase64: z.string().optional(),
    fileName: z.string().max(512).optional(),
    replyToMessageId: z.string().max(128).optional().nullable(),
    source: z.string().max(64).optional(),
    idempotencyKey: z.string().max(256).optional(),
    /** Optional Telegram @username for GramJS entity resolution when channel_id is numeric but not in session cache */
    usernameHint: z.string().min(1).max(256).optional().nullable(),
  })
  .refine((data) => (data.content != null && data.content !== '') || (data.fileBase64 != null && data.fileBase64 !== ''), {
    message: 'Either content or fileBase64 is required',
    path: ['content'],
  });

// --- Public: shared-chats routes

export const MsgSharedChatSettingsSchema = z.object({
  titleTemplate: z.string().max(500).optional(),
  extraUsernames: z.array(z.string().max(255)).max(50).optional(),
});

export const MsgCreateSharedChatSchema = z
  .object({
    conversation_id: z.string().uuid().nullable().optional(),
    lead_id: z.string().uuid().nullable().optional(),
    title: z.string().max(255).optional(),
    participant_usernames: z.array(z.string().max(255)).max(50).optional(),
    /** BD account to use when conversation has none or when creating by lead_id. */
    bd_account_id: z.string().uuid().optional(),
  })
  .refine((d) => (d.conversation_id != null && d.conversation_id !== '') || (d.lead_id != null && d.lead_id !== ''), {
    message: 'Provide conversation_id or lead_id',
    path: ['conversation_id'],
  });

export const MsgMarkSharedChatSchema = z.object({
  conversation_id: z.string().uuid(),
});

// --- Public: conversation-deals

export const MsgMarkWonSchema = z.object({
  conversation_id: z.string().uuid(),
  revenue_amount: z.number().nonnegative().max(999_999_999.99).optional().nullable(),
  currency: z.string().min(1).max(10).default('EUR'),
});

export const MsgMarkLostSchema = z.object({
  conversation_id: z.string().uuid(),
  reason: z.string().max(2000).optional().nullable(),
});

// --- Internal API (safeParse in routes/internal.ts)

export const MsgInternalEnsureConversationSchema = z.object({
  organizationId: z.string().uuid(),
  bdAccountId: z.string().uuid(),
  channel: z.string().min(1).max(64),
  channelId: z.string().min(1).max(256),
  contactId: z.string().uuid().nullable(),
});

/** Accept string or number from bd-accounts (SerializedTelegramMessage uses string); normalize to number for DB. */
export const msgInternalTelegramIdSchema = z
  .union([z.string(), z.number()])
  .optional()
  .nullable()
  .transform((v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return Number.isNaN(v) ? null : v;
    const n = parseInt(String(v), 10);
    return Number.isNaN(n) ? null : n;
  });

export const MsgInternalSerializedTelegramSchema = z.object({
  telegram_message_id: msgInternalTelegramIdSchema,
  telegram_date: z.union([z.string(), z.date(), z.number()]).nullable().optional(),
  content: z.string(),
  telegram_entities: z.unknown().nullable().optional(),
  telegram_media: z.unknown().nullable().optional(),
  reply_to_telegram_id: msgInternalTelegramIdSchema,
  telegram_extra: z.record(z.unknown()).optional(),
});

export const MsgInternalCreateMessageSchema = z.object({
  organizationId: z.string().uuid(),
  bdAccountId: z.string().uuid(),
  contactId: z.string().uuid().nullable(),
  channel: z.string().min(1).max(64),
  channelId: z.string().min(1).max(256),
  direction: z.string().min(1).max(32),
  status: z.string().min(1).max(32),
  unread: z.boolean(),
  serialized: MsgInternalSerializedTelegramSchema,
  metadata: z.record(z.unknown()).optional(),
  /** Pre-computed by caller (e.g. bd-accounts) from telegram_extra */
  reactions: z.unknown().optional(),
  our_reactions: z.unknown().optional(),
});

export const MsgInternalEditByTelegramSchema = z.object({
  bdAccountId: z.string().uuid(),
  channelId: z.string().min(1).max(256),
  telegramMessageId: z.number().int(),
  content: z.string(),
  telegram_entities: z.unknown().nullable().optional(),
  telegram_media: z.unknown().nullable().optional(),
});

export const MsgInternalDeleteByTelegramSchema = z.object({
  bdAccountId: z.string().uuid(),
  /** Required for channel/supergroup deletes (UpdateDeleteChannelMessages) */
  channelId: z.string().min(1).max(256).optional(),
  telegramMessageIds: z.array(z.number().int()).min(1).max(500),
});

export const MsgInternalOrphanByBdAccountSchema = z.object({
  bdAccountId: z.string().uuid(),
});
