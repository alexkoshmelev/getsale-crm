import { Router } from 'express';
import { Pool } from 'pg';
import { Registry, Counter, Histogram } from 'prom-client';
import { MessageDirection, MessageStatus, ConversationSystemEvent, LeadActivityLogType } from '@getsale/types';
import { Logger } from '@getsale/logger';
import {
  asyncHandler,
  AppError,
  ErrorCodes,
  ServiceHttpClient,
  ServiceCallError,
} from '@getsale/service-core';
import { MESSAGES_FOR_AI_LIMIT, AI_INSIGHT_MODEL_VERSION } from '../helpers';

interface Deps {
  pool: Pool;
  log: Logger;
  bdAccountsClient: ServiceHttpClient;
  aiClient: ServiceHttpClient;
  registry: Registry;
}

export function conversationsRouter({ pool, log, bdAccountsClient, aiClient, registry }: Deps): Router {
  const router = Router();

  const conflicts409Total = new Counter({
    name: 'conflicts_409_total',
    help: 'Total 409 Conflict responses',
    labelNames: ['endpoint'],
    registers: [registry],
  });
  const sharedChatCreatedTotal = new Counter({
    name: 'shared_chat_created_total',
    help: 'Total shared chats created',
    registers: [registry],
  });
  const dealsWonTotal = new Counter({
    name: 'deals_won_total',
    help: 'Total deals marked as won',
    registers: [registry],
  });
  const externalCallDuration = new Histogram({
    name: 'external_call_duration_seconds',
    help: 'External HTTP call duration (e.g. bd-accounts)',
    labelNames: ['target'],
    registers: [registry],
  });

  // GET /new-leads — folder «Новые лиды»: lead_id != null AND first_manager_reply_at IS NULL
  router.get('/new-leads', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const result = await pool.query(
      `SELECT conv.id AS conversation_id, conv.organization_id, conv.bd_account_id, conv.channel, conv.channel_id,
              conv.contact_id, conv.lead_id, conv.campaign_id, conv.became_lead_at, conv.last_viewed_at,
              st.name AS lead_stage_name, p.name AS lead_pipeline_name, l.stage_id,
              c.first_name, c.last_name, c.display_name, c.username, c.telegram_id,
              (SELECT COUNT(*)::int FROM messages m WHERE m.organization_id = conv.organization_id AND m.channel = conv.channel AND m.channel_id = conv.channel_id AND m.bd_account_id IS NOT DISTINCT FROM conv.bd_account_id AND m.unread = true) AS unread_count,
              (SELECT MAX(COALESCE(m.telegram_date, m.created_at)) FROM messages m WHERE m.organization_id = conv.organization_id AND m.channel = conv.channel AND m.channel_id = conv.channel_id AND m.bd_account_id IS NOT DISTINCT FROM conv.bd_account_id) AS last_message_at,
              (SELECT COALESCE(NULLIF(TRIM(m2.content), ''), '[Media]') FROM messages m2 WHERE m2.organization_id = conv.organization_id AND m2.channel = conv.channel AND m2.channel_id = conv.channel_id AND m2.bd_account_id IS NOT DISTINCT FROM conv.bd_account_id ORDER BY COALESCE(m2.telegram_date, m2.created_at) DESC LIMIT 1) AS last_message
       FROM conversations conv
       JOIN leads l ON l.id = conv.lead_id
       JOIN stages st ON st.id = l.stage_id
       JOIN pipelines p ON p.id = l.pipeline_id
       LEFT JOIN contacts c ON c.id = conv.contact_id
       WHERE conv.organization_id = $1 AND conv.lead_id IS NOT NULL AND conv.first_manager_reply_at IS NULL
       ORDER BY conv.became_lead_at DESC NULLS LAST`,
      [organizationId]
    );
    res.json(result.rows);
  }));

  // PATCH /conversations/:id/view — set last_viewed_at
  router.patch('/conversations/:id/view', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const r = await pool.query(
      `UPDATE conversations SET last_viewed_at = NOW(), updated_at = NOW() WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [id, organizationId]
    );
    if (r.rows.length === 0) {
      throw new AppError(404, 'Conversation not found', ErrorCodes.NOT_FOUND);
    }
    res.json({ ok: true });
  }));

  // GET /resolve-contact — resolve contact to bd_account_id + channel_id
  router.get('/resolve-contact', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const contactId = req.query.contactId;
    if (!contactId || typeof contactId !== 'string') {
      throw new AppError(400, 'contactId required', ErrorCodes.VALIDATION);
    }
    const row = await pool.query(
      `SELECT bd_account_id, channel_id FROM conversations
       WHERE organization_id = $1 AND contact_id = $2
       ORDER BY updated_at DESC NULLS LAST
       LIMIT 1`,
      [organizationId, contactId]
    );
    if (row.rows.length === 0) {
      throw new AppError(404, 'No conversation for this contact', ErrorCodes.NOT_FOUND);
    }
    const r = row.rows[0] as { bd_account_id: string; channel_id: string };
    res.json({ bd_account_id: r.bd_account_id, channel_id: r.channel_id });
  }));

  // GET /conversations/:id/lead-context — lead panel context for a conversation
  router.get('/conversations/:id/lead-context', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id: conversationId } = req.params;

    const conv = await pool.query(
      `SELECT c.id AS conversation_id, c.lead_id, c.campaign_id, c.became_lead_at, c.contact_id,
              c.bd_account_id, c.channel_id,
              c.shared_chat_created_at, c.shared_chat_channel_id, c.shared_chat_invite_link,
              c.won_at, COALESCE(l.revenue_amount, c.revenue_amount) AS revenue_amount, c.lost_at, c.loss_reason,
              l.pipeline_id, l.stage_id, l.responsible_id,
              p.name AS pipeline_name,
              st.name AS stage_name,
              u.email AS responsible_email,
              COALESCE(
                NULLIF(TRIM(c2.display_name), ''),
                NULLIF(TRIM(CONCAT(COALESCE(c2.first_name,''), ' ', COALESCE(c2.last_name,''))), ''),
                c2.username,
                c2.telegram_id::text
              ) AS contact_name,
              c2.telegram_id AS contact_telegram_id,
              c2.username AS contact_username,
              camp.name AS campaign_name,
              co.name AS company_name
       FROM conversations c
       LEFT JOIN leads l ON l.id = c.lead_id
       LEFT JOIN users u ON u.id = l.responsible_id
       LEFT JOIN pipelines p ON p.id = l.pipeline_id
       LEFT JOIN stages st ON st.id = l.stage_id
       LEFT JOIN contacts c2 ON c2.id = c.contact_id
       LEFT JOIN companies co ON co.id = c2.company_id
       LEFT JOIN campaigns camp ON camp.id = c.campaign_id
       WHERE c.id = $1 AND c.organization_id = $2`,
      [conversationId, organizationId]
    );
    if (conv.rows.length === 0) {
      throw new AppError(404, 'Conversation not found', ErrorCodes.NOT_FOUND);
    }
    let row = conv.rows[0] as any;

    if (row.lead_id == null && row.contact_id) {
      const fallback = await pool.query(
        `SELECT l.id AS lead_id, l.contact_id, l.pipeline_id, l.stage_id, l.responsible_id, l.created_at AS became_lead_at,
                $3::uuid AS conversation_id, $4 AS bd_account_id, $5 AS channel_id,
                $6::uuid AS campaign_id, $7 AS campaign_name,
                l.revenue_amount,
                p.name AS pipeline_name, st.name AS stage_name,
                u.email AS responsible_email,
                COALESCE(
                  NULLIF(TRIM(c2.display_name), ''),
                  NULLIF(TRIM(CONCAT(COALESCE(c2.first_name,''), ' ', COALESCE(c2.last_name,''))), ''),
                  c2.username, c2.telegram_id::text
                ) AS contact_name,
                c2.telegram_id AS contact_telegram_id,
                c2.username AS contact_username,
                co.name AS company_name,
                NULL::timestamptz AS shared_chat_created_at, NULL AS shared_chat_channel_id, NULL AS shared_chat_invite_link,
                NULL::timestamptz AS won_at, NULL::timestamptz AS lost_at, NULL AS loss_reason
         FROM leads l
         LEFT JOIN users u ON u.id = l.responsible_id
         LEFT JOIN pipelines p ON p.id = l.pipeline_id
         LEFT JOIN stages st ON st.id = l.stage_id
         LEFT JOIN contacts c2 ON c2.id = l.contact_id
         LEFT JOIN companies co ON co.id = c2.company_id
         WHERE l.contact_id = $1 AND l.organization_id = $2
         ORDER BY l.created_at DESC LIMIT 1`,
        [row.contact_id, organizationId, row.conversation_id, row.bd_account_id, row.channel_id, row.campaign_id, row.campaign_name ?? null]
      );
      if (fallback.rows.length > 0) {
        row = fallback.rows[0];
      }
    }

    if (row.lead_id == null) {
      throw new AppError(404, 'No lead for this conversation', ErrorCodes.NOT_FOUND);
    }

    const payload = await buildLeadContextPayload(pool, organizationId, row);
    res.json(payload);
  }));

  // GET /lead-context-by-lead/:leadId — lead context by lead ID (for pipeline card)
  router.get('/lead-context-by-lead/:leadId', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { leadId } = req.params;

    const conv = await pool.query(
      `SELECT c.id AS conversation_id, c.lead_id, c.campaign_id, c.became_lead_at, c.contact_id,
              c.bd_account_id, c.channel_id,
              c.shared_chat_created_at, c.shared_chat_channel_id, c.shared_chat_invite_link,
              c.won_at, COALESCE(l.revenue_amount, c.revenue_amount) AS revenue_amount, c.lost_at, c.loss_reason,
              l.pipeline_id, l.stage_id, l.responsible_id,
              p.name AS pipeline_name,
              st.name AS stage_name,
              u.email AS responsible_email,
              COALESCE(
                NULLIF(TRIM(c2.display_name), ''),
                NULLIF(TRIM(CONCAT(COALESCE(c2.first_name,''), ' ', COALESCE(c2.last_name,''))), ''),
                c2.username,
                c2.telegram_id::text
              ) AS contact_name,
              c2.telegram_id AS contact_telegram_id,
              c2.username AS contact_username,
              camp.name AS campaign_name,
              co.name AS company_name
       FROM conversations c
       LEFT JOIN leads l ON l.id = c.lead_id
       LEFT JOIN users u ON u.id = l.responsible_id
       LEFT JOIN pipelines p ON p.id = l.pipeline_id
       LEFT JOIN stages st ON st.id = l.stage_id
       LEFT JOIN contacts c2 ON c2.id = c.contact_id
       LEFT JOIN companies co ON co.id = c2.company_id
       LEFT JOIN campaigns camp ON camp.id = c.campaign_id
       WHERE c.lead_id = $1 AND c.organization_id = $2`,
      [leadId, organizationId]
    );

    let row: any;
    if (conv.rows.length > 0 && conv.rows[0].lead_id != null) {
      row = conv.rows[0];
    } else {
      // Lead without conversation (e.g. added via "Add to funnel" from CRM) — build context from leads table only
      const leadOnly = await pool.query(
        `SELECT l.id AS lead_id, l.contact_id, l.pipeline_id, l.stage_id, l.responsible_id, l.created_at AS became_lead_at,
                NULL::uuid AS conversation_id, NULL AS bd_account_id, NULL AS channel_id,
                NULL AS campaign_id, NULL AS campaign_name,
                NULL::timestamptz AS shared_chat_created_at, NULL AS shared_chat_channel_id, NULL AS shared_chat_invite_link,
                NULL::timestamptz AS won_at, l.revenue_amount, NULL::timestamptz AS lost_at, NULL AS loss_reason,
                p.name AS pipeline_name, st.name AS stage_name,
                u.email AS responsible_email,
                COALESCE(
                  NULLIF(TRIM(c2.display_name), ''),
                  NULLIF(TRIM(CONCAT(COALESCE(c2.first_name,''), ' ', COALESCE(c2.last_name,''))), ''),
                  c2.username,
                  c2.telegram_id::text
                ) AS contact_name,
                c2.telegram_id AS contact_telegram_id,
                c2.username AS contact_username,
                co.name AS company_name
         FROM leads l
         LEFT JOIN users u ON u.id = l.responsible_id
         LEFT JOIN pipelines p ON p.id = l.pipeline_id
         LEFT JOIN stages st ON st.id = l.stage_id
         LEFT JOIN contacts c2 ON c2.id = l.contact_id AND c2.organization_id = l.organization_id
         LEFT JOIN companies co ON co.id = c2.company_id
         WHERE l.id = $1 AND l.organization_id = $2`,
        [leadId, organizationId]
      );
      if (leadOnly.rows.length === 0) {
        throw new AppError(404, 'Lead not found', ErrorCodes.NOT_FOUND);
      }
      row = leadOnly.rows[0];
    }

    const payload = await buildLeadContextPayload(pool, organizationId, row);
    res.json(payload);
  }));

  // POST /conversations/:id/ai/analysis — Conversation Intelligence analysis
  router.post('/conversations/:id/ai/analysis', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id: conversationId } = req.params;

    const convRes = await pool.query(
      `SELECT id, organization_id, bd_account_id, channel_id FROM conversations WHERE id = $1 AND organization_id = $2`,
      [conversationId, organizationId]
    );
    if (convRes.rows.length === 0) {
      throw new AppError(404, 'Conversation not found', ErrorCodes.NOT_FOUND);
    }
    const conv = convRes.rows[0] as { id: string; bd_account_id: string | null; channel_id: string };
    if (!conv.bd_account_id || !conv.channel_id) {
      throw new AppError(400, 'Conversation has no bd_account or channel', ErrorCodes.BAD_REQUEST);
    }

    const msgRes = await pool.query(
      `SELECT id, content, direction, created_at FROM messages
       WHERE organization_id = $1 AND bd_account_id = $2 AND channel = 'telegram' AND channel_id = $3
       ORDER BY COALESCE(telegram_date, created_at) DESC LIMIT $4`,
      [organizationId, conv.bd_account_id, conv.channel_id, MESSAGES_FOR_AI_LIMIT]
    );
    const rows = (msgRes.rows as { id: string; content: string; direction: string; created_at: Date }[]).reverse();
    const messages = rows.map((m) => ({
      content: m.content,
      direction: m.direction,
      created_at: m.created_at instanceof Date ? m.created_at.toISOString() : String(m.created_at),
    }));
    if (messages.length === 0) {
      throw new AppError(400, 'No messages in conversation', ErrorCodes.BAD_REQUEST);
    }

    try {
      const payload = await aiClient.post<Record<string, unknown>>(
        '/api/ai/conversations/analyze',
        { messages },
        { 'x-correlation-id': req.correlationId || '' }
      );

      await pool.query(
        `INSERT INTO conversation_ai_insights (conversation_id, account_id, type, payload_json, model_version, created_at)
         VALUES ($1, $2, 'analysis', $3, $4, NOW())`,
        [conversationId, conv.bd_account_id, JSON.stringify(payload), AI_INSIGHT_MODEL_VERSION]
      );
      res.json(payload);
    } catch (err: any) {
      if (err instanceof ServiceCallError) {
        const errBody = typeof err.body === 'object' && err.body !== null
          ? err.body as { error?: string; message?: string }
          : {};
        return res.status(err.statusCode).json({
          error: errBody.error || 'Service Unavailable',
          message: errBody.message || errBody.error || 'AI service error',
        });
      }
      throw err;
    }
  }));

  // POST /conversations/:id/ai/summary — conversation summary
  router.post('/conversations/:id/ai/summary', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id: conversationId } = req.params;
    const body = (req.body || {}) as { limit?: number };
    const MAX_SUMMARY_MESSAGES = 200;
    const msgLimit = Math.min(Math.max(Math.round(Number(body.limit) || 25), 1), MAX_SUMMARY_MESSAGES);

    const convRes = await pool.query(
      `SELECT id, organization_id, bd_account_id, channel_id FROM conversations WHERE id = $1 AND organization_id = $2`,
      [conversationId, organizationId]
    );
    if (convRes.rows.length === 0) {
      throw new AppError(404, 'Conversation not found', ErrorCodes.NOT_FOUND);
    }
    const conv = convRes.rows[0] as { id: string; bd_account_id: string | null; channel_id: string };
    if (!conv.bd_account_id || !conv.channel_id) {
      throw new AppError(400, 'Conversation has no bd_account or channel', ErrorCodes.BAD_REQUEST);
    }

    const msgRes = await pool.query(
      `SELECT id, content, direction, created_at, telegram_date FROM messages m
       WHERE m.organization_id = $1 AND m.bd_account_id = $2 AND m.channel = 'telegram' AND m.channel_id = $3
       ORDER BY COALESCE(m.telegram_date, m.created_at) DESC
       LIMIT $4`,
      [organizationId, conv.bd_account_id, conv.channel_id, msgLimit]
    );
    const rows = (msgRes.rows as { id: string; content: string; direction: string; created_at: Date; telegram_date: Date | null }[]).reverse();
    const messages = rows.map((m) => ({
      content: m.content,
      direction: m.direction,
      created_at: (m.telegram_date || m.created_at) instanceof Date ? (m.telegram_date || m.created_at)!.toISOString() : String(m.created_at),
    })).filter((m) => m.content && m.content.trim().length > 0);
    if (messages.length === 0) {
      throw new AppError(400, 'No messages to summarize', ErrorCodes.BAD_REQUEST);
    }

    try {
      const aiData = await aiClient.post<{ summary?: string }>(
        '/api/ai/chat/summarize',
        { messages },
        { 'x-correlation-id': req.correlationId || '' }
      );
      const summary = aiData.summary ?? '';

      await pool.query(
        `INSERT INTO conversation_ai_insights (conversation_id, account_id, type, payload_json, model_version, created_at)
         VALUES ($1, $2, 'summary', $3, $4, NOW())`,
        [conversationId, conv.bd_account_id, JSON.stringify({ summary }), AI_INSIGHT_MODEL_VERSION]
      );
      res.json({ summary });
    } catch (err: any) {
      if (err instanceof ServiceCallError) {
        const errBody = typeof err.body === 'object' && err.body !== null
          ? err.body as { error?: string; message?: string }
          : {};
        return res.status(err.statusCode).json({
          error: errBody.error || 'Service Unavailable',
          message: errBody.message || errBody.error || 'AI service error',
        });
      }
      throw err;
    }
  }));

  // GET /settings/shared-chat
  router.get('/settings/shared-chat', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const row = await pool.query(
      `SELECT value FROM organization_settings WHERE organization_id = $1 AND key = 'shared_chat'`,
      [organizationId]
    );
    const value = row.rows[0]?.value as Record<string, unknown> | undefined;
    const titleTemplate = typeof value?.titleTemplate === 'string' ? value.titleTemplate : 'Чат: {{contact_name}}';
    const extraUsernames = Array.isArray(value?.extraUsernames) ? value.extraUsernames.filter((u: unknown) => typeof u === 'string') : [];
    res.json({ titleTemplate, extraUsernames });
  }));

  // PATCH /settings/shared-chat
  router.patch('/settings/shared-chat', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { titleTemplate, extraUsernames } = req.body ?? {};
    const title = typeof titleTemplate === 'string' ? titleTemplate.trim() || 'Чат: {{contact_name}}' : undefined;
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
      titleTemplate: title !== undefined ? title : (typeof prev.titleTemplate === 'string' ? prev.titleTemplate : 'Чат: {{contact_name}}'),
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

  // POST /create-shared-chat — create real Telegram group chat
  router.post('/create-shared-chat', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { conversation_id: conversationId, title: titleOverride, participant_usernames: participantUsernamesOverride } = req.body ?? {};
    if (!conversationId || typeof conversationId !== 'string') {
      throw new AppError(400, 'conversation_id required', ErrorCodes.VALIDATION);
    }

    const convRow = await pool.query(
      `SELECT c.id, c.bd_account_id, c.channel_id, c.contact_id, c.shared_chat_created_at,
              COALESCE(NULLIF(TRIM(c2.display_name), ''), NULLIF(TRIM(CONCAT(COALESCE(c2.first_name,''), ' ', COALESCE(c2.last_name,''))), ''), c2.username, c2.telegram_id::text) AS contact_name
       FROM conversations c
       LEFT JOIN contacts c2 ON c2.id = c.contact_id
       WHERE c.id = $1 AND c.organization_id = $2 AND c.lead_id IS NOT NULL`,
      [conversationId, organizationId]
    );
    if (convRow.rows.length === 0) {
      throw new AppError(404, 'Conversation not found or not a lead', ErrorCodes.NOT_FOUND);
    }
    const conv = convRow.rows[0] as {
      id: string; bd_account_id: string; channel_id: string; contact_id: string | null;
      shared_chat_created_at: unknown; contact_name: string | null;
    };
    if (conv.shared_chat_created_at != null) {
      conflicts409Total.inc({ endpoint: 'create-shared-chat' });
      log.warn({ message: 'conflict_409 create-shared-chat already created', correlation_id: req.correlationId, endpoint: 'POST /create-shared-chat', conversationId, event: 'conflict_409' });
      throw new AppError(409, 'Shared chat already created for this conversation', ErrorCodes.CONFLICT);
    }
    if (!conv.bd_account_id) {
      throw new AppError(400, 'Conversation has no BD account', ErrorCodes.BAD_REQUEST);
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
      const template = typeof v?.titleTemplate === 'string' ? v.titleTemplate : 'Чат: {{contact_name}}';
      title = template.replace(/\{\{\s*contact_name\s*\}\}/gi, (conv.contact_name ?? 'Контакт').trim()).trim().slice(0, 255) || 'Общий чат';
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

    const leadTelegramUserId = conv.channel_id ? parseInt(conv.channel_id, 10) : undefined;
    if (!leadTelegramUserId || !Number.isInteger(leadTelegramUserId)) {
      throw new AppError(400, 'Lead Telegram user id (channel_id) is missing or invalid', ErrorCodes.BAD_REQUEST);
    }

    const externalCallStart = Date.now();
    let created: { channelId?: string; title?: string; inviteLink?: string | null };
    try {
      created = await bdAccountsClient.post<{ channelId?: string; title?: string; inviteLink?: string | null }>(
        `/api/bd-accounts/${conv.bd_account_id}/create-shared-chat`,
        {
          title,
          lead_telegram_user_id: leadTelegramUserId,
          extra_usernames: extraUsernames,
        },
        {
          'x-user-id': userId || '',
          'x-organization-id': organizationId || '',
          'x-correlation-id': req.correlationId || '',
        }
      );
    } catch (err: any) {
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
      log.warn({ message: 'create-shared-chat slow external call', correlation_id: req.correlationId, endpoint: 'POST /create-shared-chat', durationMs: externalCallMs, conversationId, bdAccountId: conv.bd_account_id, event: 'slow_external_call' });
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
      const systemContent = `[System] Общий чат создан: ${(created.title ?? title).slice(0, 500)}`;
      await client.query(
        `INSERT INTO messages (organization_id, bd_account_id, channel, channel_id, contact_id, direction, content, status, unread, metadata)
         VALUES ($1, $2, 'telegram', $3, $4, $5, $6, $7, false, $8)`,
        [
          organizationId,
          conv.bd_account_id,
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

  // POST /mark-shared-chat — legacy: mark only without creating
  router.post('/mark-shared-chat', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { conversation_id: conversationId } = req.body ?? {};
    if (!conversationId || typeof conversationId !== 'string') {
      throw new AppError(400, 'conversation_id required', ErrorCodes.VALIDATION);
    }
    const check = await pool.query(
      `SELECT id, shared_chat_created_at FROM conversations WHERE id = $1 AND organization_id = $2 AND lead_id IS NOT NULL`,
      [conversationId, organizationId]
    );
    if (check.rows.length === 0) {
      throw new AppError(404, 'Conversation not found or not a lead', ErrorCodes.NOT_FOUND);
    }
    const existing = check.rows[0] as { id: string; shared_chat_created_at: Date | null };
    if (existing.shared_chat_created_at != null) {
      conflicts409Total.inc({ endpoint: 'mark-shared-chat' });
      log.warn({ message: 'conflict_409 mark-shared-chat already created', correlation_id: req.correlationId, endpoint: 'POST /mark-shared-chat', conversationId, event: 'conflict_409' });
      throw new AppError(409, 'Shared chat already created for this conversation', ErrorCodes.CONFLICT);
    }
    const r = await pool.query(
      `UPDATE conversations SET shared_chat_created_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND organization_id = $2 AND lead_id IS NOT NULL
       RETURNING id, shared_chat_created_at`,
      [conversationId, organizationId]
    );
    const row = r.rows[0] as { id: string; shared_chat_created_at: Date };
    res.json({
      conversation_id: row.id,
      shared_chat_created_at: row.shared_chat_created_at instanceof Date ? row.shared_chat_created_at.toISOString() : row.shared_chat_created_at,
    });
  }));

  /** Max allowed revenue_amount in API (audit P3: business validation and contract). */
  const REVENUE_AMOUNT_MAX = 999_999_999.99;

  // POST /mark-won — close deal as won (irreversible)
  router.post('/mark-won', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { conversation_id: conversationId, revenue_amount: revenueAmountRaw } = req.body ?? {};
    if (!conversationId || typeof conversationId !== 'string') {
      throw new AppError(400, 'conversation_id required', ErrorCodes.VALIDATION);
    }
    const revenueAmount = revenueAmountRaw != null ? parseFloat(String(revenueAmountRaw)) : null;
    if (revenueAmount != null && (Number.isNaN(revenueAmount) || revenueAmount < 0)) {
      throw new AppError(400, 'revenue_amount must be a non-negative number', ErrorCodes.VALIDATION);
    }
    if (revenueAmount != null && revenueAmount > REVENUE_AMOUNT_MAX) {
      throw new AppError(400, `revenue_amount must not exceed ${REVENUE_AMOUNT_MAX}`, ErrorCodes.VALIDATION);
    }

    const check = await pool.query(
      `SELECT id, bd_account_id, channel_id, contact_id, shared_chat_created_at, won_at, lost_at
       FROM conversations WHERE id = $1 AND organization_id = $2 AND lead_id IS NOT NULL`,
      [conversationId, organizationId]
    );
    if (check.rows.length === 0) {
      throw new AppError(404, 'Conversation not found or not a lead', ErrorCodes.NOT_FOUND);
    }
    const c = check.rows[0] as {
      id: string; bd_account_id: string; channel_id: string; contact_id: string | null;
      shared_chat_created_at: Date | null; won_at: Date | null; lost_at: Date | null;
    };
    if (c.won_at != null) {
      conflicts409Total.inc({ endpoint: 'mark-won' });
      log.warn({ message: 'conflict_409 mark-won already won', correlation_id: req.correlationId, endpoint: 'POST /mark-won', conversationId, event: 'conflict_409' });
      throw new AppError(409, 'Deal already marked as won', ErrorCodes.CONFLICT);
    }
    if (c.lost_at != null) {
      conflicts409Total.inc({ endpoint: 'mark-won' });
      log.warn({ message: 'conflict_409 mark-won already lost', correlation_id: req.correlationId, endpoint: 'POST /mark-won', conversationId, event: 'conflict_409' });
      throw new AppError(409, 'Deal already marked as lost', ErrorCodes.CONFLICT);
    }
    if (c.shared_chat_created_at == null) {
      throw new AppError(400, 'Shared chat must be created before marking as won', ErrorCodes.BAD_REQUEST);
    }

    const amount = revenueAmount != null ? Math.round(revenueAmount * 100) / 100 : null;
    const systemContent = amount != null
      ? `[System] Сделка закрыта. Сумма: ${amount} €`
      : '[System] Сделка закрыта.';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE conversations SET won_at = NOW(), revenue_amount = $3, updated_at = NOW()
         WHERE id = $1 AND organization_id = $2`,
        [conversationId, organizationId, amount]
      );
      await client.query(
        `INSERT INTO messages (organization_id, bd_account_id, channel, channel_id, contact_id, direction, content, status, unread, metadata)
         VALUES ($1, $2, 'telegram', $3, $4, $5, $6, $7, false, $8)`,
        [
          organizationId,
          c.bd_account_id,
          c.channel_id,
          c.contact_id,
          MessageDirection.OUTBOUND,
          systemContent,
          MessageStatus.DELIVERED,
          JSON.stringify({ system: true, event: ConversationSystemEvent.DEAL_WON, revenue_amount: amount }),
        ]
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    dealsWonTotal.inc();
    res.json({
      conversation_id: conversationId,
      won_at: new Date().toISOString(),
      revenue_amount: amount,
    });
  }));

  // POST /mark-lost — mark deal as lost (irreversible)
  router.post('/mark-lost', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { conversation_id: conversationId, reason } = req.body ?? {};
    if (!conversationId || typeof conversationId !== 'string') {
      throw new AppError(400, 'conversation_id required', ErrorCodes.VALIDATION);
    }

    const check = await pool.query(
      `SELECT id, bd_account_id, channel_id, contact_id, won_at, lost_at
       FROM conversations WHERE id = $1 AND organization_id = $2 AND lead_id IS NOT NULL`,
      [conversationId, organizationId]
    );
    if (check.rows.length === 0) {
      throw new AppError(404, 'Conversation not found or not a lead', ErrorCodes.NOT_FOUND);
    }
    const c = check.rows[0] as {
      id: string; bd_account_id: string; channel_id: string;
      contact_id: string | null; won_at: Date | null; lost_at: Date | null;
    };
    if (c.won_at != null) {
      conflicts409Total.inc({ endpoint: 'mark-lost' });
      log.warn({ message: 'conflict_409 mark-lost already won', correlation_id: req.correlationId, endpoint: 'POST /mark-lost', conversationId, event: 'conflict_409' });
      throw new AppError(409, 'Deal already marked as won', ErrorCodes.CONFLICT);
    }
    if (c.lost_at != null) {
      conflicts409Total.inc({ endpoint: 'mark-lost' });
      log.warn({ message: 'conflict_409 mark-lost already lost', correlation_id: req.correlationId, endpoint: 'POST /mark-lost', conversationId, event: 'conflict_409' });
      throw new AppError(409, 'Deal already marked as lost', ErrorCodes.CONFLICT);
    }

    const lossReason = reason != null && typeof reason === 'string' ? reason.trim().slice(0, 2000) : null;
    const systemContent = lossReason
      ? `[System] Сделка потеряна. Причина: ${lossReason.slice(0, 500)}`
      : '[System] Сделка потеряна.';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE conversations SET lost_at = NOW(), loss_reason = $3, updated_at = NOW()
         WHERE id = $1 AND organization_id = $2`,
        [conversationId, organizationId, lossReason]
      );
      await client.query(
        `INSERT INTO messages (organization_id, bd_account_id, channel, channel_id, contact_id, direction, content, status, unread, metadata)
         VALUES ($1, $2, 'telegram', $3, $4, $5, $6, $7, false, $8)`,
        [
          organizationId,
          c.bd_account_id,
          c.channel_id,
          c.contact_id,
          MessageDirection.OUTBOUND,
          systemContent,
          MessageStatus.DELIVERED,
          JSON.stringify({ system: true, event: ConversationSystemEvent.DEAL_LOST, reason: lossReason }),
        ]
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    res.json({
      conversation_id: conversationId,
      lost_at: new Date().toISOString(),
      loss_reason: lossReason,
    });
  }));

  return router;
}

/** Shared helper to build the lead-context payload used by both lead-context endpoints. */
async function buildLeadContextPayload(pool: Pool, organizationId: string, row: any) {
  const pipelineId = row.pipeline_id;
  const leadId = row.lead_id;

  let sharedChatSettings: { titleTemplate: string; extraUsernames: string[] } = {
    titleTemplate: 'Чат: {{contact_name}}',
    extraUsernames: [],
  };
  const settingsRow = await pool.query(
    `SELECT value FROM organization_settings WHERE organization_id = $1 AND key = 'shared_chat'`,
    [organizationId]
  );
  if (settingsRow.rows.length > 0 && settingsRow.rows[0].value) {
    const v = settingsRow.rows[0].value as Record<string, unknown>;
    if (typeof v?.titleTemplate === 'string') sharedChatSettings.titleTemplate = v.titleTemplate;
    if (Array.isArray(v?.extraUsernames)) sharedChatSettings.extraUsernames = v.extraUsernames.filter((u): u is string => typeof u === 'string');
  }

  const [stagesResult, timelineResult] = await Promise.all([
    pool.query<{ id: string; name: string }>(
      `SELECT id, name FROM stages WHERE pipeline_id = $1 AND organization_id = $2 ORDER BY order_index`,
      [pipelineId, organizationId]
    ),
    pool.query(
      `SELECT lal.type, lal.created_at, lal.metadata, s.name AS to_stage_name
       FROM lead_activity_log lal
       LEFT JOIN stages s ON s.id = (lal.metadata->>'to_stage_id')::uuid
       WHERE lal.lead_id = $1 AND lal.type IN ($2, $3, $4)
       ORDER BY lal.created_at DESC
       LIMIT 10`,
      [leadId, LeadActivityLogType.LEAD_CREATED, LeadActivityLogType.STAGE_CHANGED, LeadActivityLogType.DEAL_CREATED]
    ),
  ]);

  const timeline = timelineResult.rows.map((t: any) => {
    const item: { type: string; created_at: string; stage_name?: string } = {
      type: t.type,
      created_at: t.created_at instanceof Date ? t.created_at.toISOString() : String(t.created_at),
    };
    if (t.type === 'stage_changed' && t.to_stage_name != null) {
      item.stage_name = t.to_stage_name;
    }
    return item;
  });

  return {
    conversation_id: row.conversation_id,
    lead_id: row.lead_id,
    contact_id: row.contact_id ?? null,
    contact_name: row.contact_name ?? '',
    contact_telegram_id: row.contact_telegram_id != null ? String(row.contact_telegram_id) : null,
    contact_username: typeof row.contact_username === 'string' ? row.contact_username : null,
    company_name: row.company_name != null ? String(row.company_name).trim() || null : null,
    bd_account_id: row.bd_account_id ?? null,
    channel_id: row.channel_id ?? null,
    responsible_id: row.responsible_id ?? null,
    responsible_email: row.responsible_email != null ? String(row.responsible_email).trim() || null : null,
    pipeline: { id: row.pipeline_id, name: row.pipeline_name ?? '' },
    stage: { id: row.stage_id, name: row.stage_name ?? '' },
    stages: stagesResult.rows.map((s) => ({ id: s.id, name: s.name })),
    campaign: row.campaign_id != null ? { id: row.campaign_id, name: row.campaign_name ?? '' } : null,
    became_lead_at: row.became_lead_at instanceof Date ? row.became_lead_at.toISOString() : row.became_lead_at,
    shared_chat_created_at: row.shared_chat_created_at != null && row.shared_chat_created_at instanceof Date ? row.shared_chat_created_at.toISOString() : row.shared_chat_created_at,
    shared_chat_channel_id: row.shared_chat_channel_id != null ? String(row.shared_chat_channel_id) : null,
    shared_chat_invite_link: row.shared_chat_invite_link != null ? String(row.shared_chat_invite_link).trim() || null : null,
    won_at: row.won_at != null && row.won_at instanceof Date ? row.won_at.toISOString() : row.won_at,
    revenue_amount: row.revenue_amount != null ? Number(row.revenue_amount) : null,
    lost_at: row.lost_at != null && row.lost_at instanceof Date ? row.lost_at.toISOString() : row.lost_at,
    loss_reason: row.loss_reason != null ? String(row.loss_reason) : null,
    shared_chat_settings: sharedChatSettings,
    timeline,
  };
}
