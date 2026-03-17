import { Router } from 'express';
import { Pool } from 'pg';
import { Counter, Histogram } from 'prom-client';
import { MessageDirection, MessageStatus, ConversationSystemEvent } from '@getsale/types';
import { Logger } from '@getsale/logger';
import {
  asyncHandler,
  AppError,
  ErrorCodes,
  ServiceHttpClient,
  ServiceCallError,
  validate,
} from '@getsale/service-core';
import { z } from 'zod';
import { getLeadConversationOrThrow } from '../queries/conversation-queries';
import { ensureConversation } from '../helpers';
import { SYSTEM_MESSAGES } from '../system-messages';

const SharedChatSettingsSchema = z.object({
  titleTemplate: z.string().max(500).optional(),
  extraUsernames: z.array(z.string().max(255)).max(50).optional(),
});

const CreateSharedChatSchema = z.object({
  conversation_id: z.string().uuid().nullable().optional(),
  lead_id: z.string().uuid().nullable().optional(),
  title: z.string().max(255).optional(),
  participant_usernames: z.array(z.string().max(255)).max(50).optional(),
  /** BD account to use when conversation has none or when creating by lead_id. */
  bd_account_id: z.string().uuid().optional(),
}).refine((d) => (d.conversation_id != null && d.conversation_id !== '') || (d.lead_id != null && d.lead_id !== ''), {
  message: 'Provide conversation_id or lead_id',
  path: ['conversation_id'],
});

const MarkSharedChatSchema = z.object({
  conversation_id: z.string().uuid(),
});

interface Deps {
  pool: Pool;
  log: Logger;
  bdAccountsClient: ServiceHttpClient;
  conflicts409Total: Counter;
  sharedChatCreatedTotal: Counter;
  externalCallDuration: Histogram;
}

export function sharedChatsRouter({ pool, log, bdAccountsClient, conflicts409Total, sharedChatCreatedTotal, externalCallDuration }: Deps): Router {
  const router = Router();

  router.get('/settings/shared-chat', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const row = await pool.query(
      `SELECT value FROM organization_settings WHERE organization_id = $1 AND key = 'shared_chat'`,
      [organizationId]
    );
    const value = row.rows[0]?.value as Record<string, unknown> | undefined;
    const titleTemplate = typeof value?.titleTemplate === 'string' ? value.titleTemplate : SYSTEM_MESSAGES.SHARED_CHAT_TITLE_TEMPLATE;
    const extraUsernames = Array.isArray(value?.extraUsernames) ? value.extraUsernames.filter((u: unknown) => typeof u === 'string') : [];
    res.json({ titleTemplate, extraUsernames });
  }));

  router.patch('/settings/shared-chat', validate(SharedChatSettingsSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { titleTemplate, extraUsernames } = req.body ?? {};
    const title = typeof titleTemplate === 'string' ? titleTemplate.trim() || SYSTEM_MESSAGES.SHARED_CHAT_TITLE_TEMPLATE : undefined;
    const usernames = Array.isArray(extraUsernames) ? extraUsernames.filter((u: unknown) => typeof u === 'string').map((u: string) => String(u).trim().replace(/^@/, '')) : undefined;
    if (title === undefined && usernames === undefined) {
      throw new AppError(400, 'Provide titleTemplate and/or extraUsernames', ErrorCodes.VALIDATION);
    }

    const existing = await pool.query(
      `SELECT value FROM organization_settings WHERE organization_id = $1 AND key = 'shared_chat'`,
      [organizationId]
    );
    const prev = (existing.rows[0]?.value as Record<string, unknown>) ?? {};
    const value = {
      titleTemplate: title !== undefined ? title : (typeof prev.titleTemplate === 'string' ? prev.titleTemplate : SYSTEM_MESSAGES.SHARED_CHAT_TITLE_TEMPLATE),
      extraUsernames: usernames !== undefined ? usernames : (Array.isArray(prev.extraUsernames) ? prev.extraUsernames : []),
    };
    await pool.query(
      `INSERT INTO organization_settings (organization_id, key, value, updated_at)
       VALUES ($1, 'shared_chat', $2::jsonb, NOW())
       ON CONFLICT (organization_id, key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
      [organizationId, JSON.stringify(value)]
    );
    res.json({ titleTemplate: value.titleTemplate, extraUsernames: value.extraUsernames });
  }));

  router.post('/create-shared-chat', validate(CreateSharedChatSchema), asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { conversation_id: bodyConversationId, lead_id: bodyLeadId, title: titleOverride, participant_usernames: participantUsernamesOverride, bd_account_id: requestBdAccountId } = req.body ?? {};
    let conversationId: string;
    let conv: { id: string; bd_account_id: string | null; channel_id: string; contact_id: string | null; shared_chat_created_at: Date | null };

    if (bodyConversationId && String(bodyConversationId).trim()) {
      conversationId = String(bodyConversationId).trim();
      conv = await getLeadConversationOrThrow<typeof conv>(pool, conversationId, organizationId, 'id, bd_account_id, channel_id, contact_id, shared_chat_created_at');
    } else if (bodyLeadId && String(bodyLeadId).trim() && requestBdAccountId) {
      const leadId = String(bodyLeadId).trim();
      const leadRow = await pool.query(
        `SELECT l.contact_id, c2.telegram_id FROM leads l
         JOIN contacts c2 ON c2.id = l.contact_id AND c2.organization_id = l.organization_id
         WHERE l.id = $1 AND l.organization_id = $2`,
        [leadId, organizationId]
      );
      if (leadRow.rows.length === 0) {
        throw new AppError(404, 'Lead not found', ErrorCodes.NOT_FOUND);
      }
      const contactId = (leadRow.rows[0] as { contact_id: string }).contact_id;
      const telegramId = (leadRow.rows[0] as { telegram_id: string | number | null }).telegram_id;
      if (contactId == null || telegramId == null) {
        throw new AppError(400, 'Lead contact has no Telegram id', ErrorCodes.BAD_REQUEST);
      }
      const channelId = String(telegramId);
      await ensureConversation(pool, {
        organizationId,
        bdAccountId: requestBdAccountId,
        channel: 'telegram',
        channelId,
        contactId,
      });
      const convRow = await pool.query(
        `SELECT id, bd_account_id, channel_id, contact_id, shared_chat_created_at
         FROM conversations WHERE organization_id = $1 AND bd_account_id = $2 AND channel = 'telegram' AND channel_id = $3`,
        [organizationId, requestBdAccountId, channelId]
      );
      if (convRow.rows.length === 0) {
        throw new AppError(500, 'Conversation not created', ErrorCodes.INTERNAL_ERROR);
      }
      conv = convRow.rows[0] as typeof conv;
      conversationId = conv.id;
    } else {
      throw new AppError(400, 'Provide conversation_id or (lead_id and bd_account_id)', ErrorCodes.VALIDATION);
    }
    let contactName: string | null = null;
    let leadUsername: string | null = null;
    if (conv.contact_id) {
      const contactRow = await pool.query(
        `SELECT COALESCE(NULLIF(TRIM(display_name), ''), NULLIF(TRIM(CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,''))), ''), username, telegram_id::text) AS contact_name, username AS contact_username FROM contacts WHERE id = $1 AND organization_id = $2`,
        [conv.contact_id, organizationId]
      );
      const row = contactRow.rows[0] as { contact_name?: string; contact_username?: string | null } | undefined;
      contactName = row?.contact_name ?? null;
      leadUsername = row?.contact_username && String(row.contact_username).trim() ? String(row.contact_username).trim().replace(/^@/, '') : null;
    }
    if (conv.shared_chat_created_at != null) {
      conflicts409Total.inc({ endpoint: 'create-shared-chat' });
      log.warn({ message: 'conflict_409 create-shared-chat already created', correlation_id: req.correlationId, endpoint: 'POST /create-shared-chat', conversationId, event: 'conflict_409' });
      throw new AppError(409, 'Shared chat already created for this conversation', ErrorCodes.CONFLICT);
    }

    let effectiveBdAccountId: string;
    if (conv.bd_account_id) {
      effectiveBdAccountId = conv.bd_account_id;
    } else if (requestBdAccountId) {
      const accountRow = await pool.query(
        `SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2`,
        [requestBdAccountId, organizationId]
      );
      if (accountRow.rows.length === 0) {
        throw new AppError(400, 'BD account not found or not in organization', ErrorCodes.BAD_REQUEST);
      }
      effectiveBdAccountId = requestBdAccountId;
    } else {
      throw new AppError(400, 'Conversation has no BD account. Pass bd_account_id (e.g. selected account).', ErrorCodes.BAD_REQUEST);
    }

    let title: string;
    if (titleOverride && typeof titleOverride === 'string' && titleOverride.trim()) {
      title = titleOverride.trim().slice(0, 255);
    } else {
      const settingsRow = await pool.query(
        `SELECT value FROM organization_settings WHERE organization_id = $1 AND key = 'shared_chat'`,
        [organizationId]
      );
      const v = settingsRow.rows[0]?.value as Record<string, unknown> | undefined;
      const template = typeof v?.titleTemplate === 'string' ? v.titleTemplate : SYSTEM_MESSAGES.SHARED_CHAT_TITLE_TEMPLATE;
      title = template.replace(/\{\{\s*contact_name\s*\}\}/gi, (contactName ?? SYSTEM_MESSAGES.SHARED_CHAT_DEFAULT_CONTACT).trim()).trim().slice(0, 255) || SYSTEM_MESSAGES.SHARED_CHAT_FALLBACK_TITLE;
    }

    let extraUsernames: string[];
    if (Array.isArray(participantUsernamesOverride)) {
      extraUsernames = participantUsernamesOverride.filter((u: unknown) => typeof u === 'string').map((u: string) => String(u).trim().replace(/^@/, ''));
    } else {
      const settingsRow = await pool.query(
        `SELECT value FROM organization_settings WHERE organization_id = $1 AND key = 'shared_chat'`,
        [organizationId]
      );
      const v = settingsRow.rows[0]?.value as Record<string, unknown> | undefined;
      extraUsernames = Array.isArray(v?.extraUsernames) ? v.extraUsernames.filter((u: unknown) => typeof u === 'string').map((u: string) => String(u).trim().replace(/^@/, '')) : [];
    }

    // For DMs, channel_id is the Telegram user id (positive). Do not treat negative/zero as valid user id.
    const parsedLeadId = conv.channel_id ? parseInt(conv.channel_id, 10) : NaN;
    const leadTelegramUserId =
      Number.isInteger(parsedLeadId) && parsedLeadId > 0 ? parsedLeadId : undefined;
    if (leadTelegramUserId == null && !leadUsername) {
      throw new AppError(
        400,
        'Lead Telegram user id (channel_id) is missing or invalid, or provide contact username',
        ErrorCodes.BAD_REQUEST
      );
    }

    const externalCallStart = Date.now();
    let created: { channelId?: string; title?: string; inviteLink?: string | null };
    try {
      created = await bdAccountsClient.post<{ channelId?: string; title?: string; inviteLink?: string | null }>(
        `/api/bd-accounts/${effectiveBdAccountId}/create-shared-chat`,
        {
          title,
          lead_telegram_user_id: leadTelegramUserId ?? undefined,
          lead_username: leadUsername ?? undefined,
          extra_usernames: extraUsernames,
        },
        undefined,
        { userId: userId || undefined, organizationId: organizationId || undefined, correlationId: req.correlationId }
      );
    } catch (err: unknown) {
      const externalCallMs = Date.now() - externalCallStart;
      externalCallDuration.observe({ target: 'bd-accounts' }, externalCallMs / 1000);
      if (err instanceof ServiceCallError) {
        const errBody = typeof err.body === 'object' && err.body !== null
          ? err.body as { error?: string; message?: string }
          : {};
        const status = err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
        return res.status(status).json({
          error: errBody.error || 'Failed to create shared chat',
          message: errBody.message || String(err.body),
        });
      }
      throw err;
    }
    const externalCallMs = Date.now() - externalCallStart;
    externalCallDuration.observe({ target: 'bd-accounts' }, externalCallMs / 1000);
    if (externalCallMs > 5000) {
      log.warn({ message: 'create-shared-chat slow external call', correlation_id: req.correlationId, endpoint: 'POST /create-shared-chat', durationMs: externalCallMs, conversationId, bdAccountId: effectiveBdAccountId, event: 'slow_external_call' });
    }

    const channelIdRaw = created.channelId;
    const sharedChatChannelId = channelIdRaw != null ? (typeof channelIdRaw === 'string' ? parseInt(channelIdRaw, 10) : Number(channelIdRaw)) : null;
    const sharedChatChannelIdDb = sharedChatChannelId != null && !Number.isNaN(sharedChatChannelId) ? sharedChatChannelId : null;
    const inviteLink = created.inviteLink && typeof created.inviteLink === 'string' && created.inviteLink.trim() ? created.inviteLink.trim() : null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE conversations SET shared_chat_created_at = NOW(), shared_chat_channel_id = $3, shared_chat_invite_link = $4, updated_at = NOW()
         WHERE id = $1 AND organization_id = $2
         RETURNING id, shared_chat_created_at, shared_chat_channel_id, shared_chat_invite_link`,
        [conversationId, organizationId, sharedChatChannelIdDb, inviteLink]
      );
      const systemContent = SYSTEM_MESSAGES.SHARED_CHAT_CREATED((created.title ?? title).slice(0, 500));
      await client.query(
        `INSERT INTO messages (organization_id, bd_account_id, channel, channel_id, contact_id, direction, content, status, unread, metadata)
         VALUES ($1, $2, 'telegram', $3, $4, $5, $6, $7, false, $8)`,
        [
          organizationId,
          effectiveBdAccountId,
          conv.channel_id,
          conv.contact_id,
          MessageDirection.OUTBOUND,
          systemContent,
          MessageStatus.DELIVERED,
          JSON.stringify({ system: true, event: ConversationSystemEvent.SHARED_CHAT_CREATED, title: created.title ?? title }),
        ]
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    sharedChatCreatedTotal.inc();
    res.json({
      conversation_id: conversationId,
      shared_chat_created_at: new Date().toISOString(),
      shared_chat_channel_id: sharedChatChannelIdDb != null ? String(sharedChatChannelIdDb) : null,
      shared_chat_invite_link: inviteLink,
      channel_id: created.channelId,
      title: created.title ?? title,
    });
  }));

  router.post('/mark-shared-chat', validate(MarkSharedChatSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { conversation_id: conversationId } = req.body ?? {};
    const existing = await getLeadConversationOrThrow<{ id: string; shared_chat_created_at: Date | null }>(
      pool, conversationId, organizationId, 'id, shared_chat_created_at'
    );
    if (existing.shared_chat_created_at != null) {
      conflicts409Total.inc({ endpoint: 'mark-shared-chat' });
      log.warn({ message: 'conflict_409 mark-shared-chat already created', correlation_id: req.correlationId, endpoint: 'POST /mark-shared-chat', conversationId: existing.id, event: 'conflict_409' });
      throw new AppError(409, 'Shared chat already created for this conversation', ErrorCodes.CONFLICT);
    }
    const r = await pool.query(
      `UPDATE conversations SET shared_chat_created_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND organization_id = $2 AND lead_id IS NOT NULL
       RETURNING id, shared_chat_created_at`,
      [existing.id, organizationId]
    );
    const row = r.rows[0] as { id: string; shared_chat_created_at: Date };
    res.json({
      conversation_id: row.id,
      shared_chat_created_at: row.shared_chat_created_at instanceof Date ? row.shared_chat_created_at.toISOString() : row.shared_chat_created_at,
    });
  }));

  return router;
}
