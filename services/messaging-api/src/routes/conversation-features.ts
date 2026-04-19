import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { AppError, ErrorCodes, requireUser, ServiceCallError } from '@getsale/service-framework';
import type { MessagingDeps } from '../types';

const MESSAGES_FOR_AI_LIMIT = 200;
const AI_INSIGHT_MODEL_VERSION = 'gpt-4';
const UNFURL_TIMEOUT_MS = 4000;
const UNFURL_MAX_BODY = 300_000;
const URL_REGEX = /^https?:\/\/[^\s<>"']+$/i;

function isUrlAllowedForUnfurl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();

  if (host === 'localhost' || host === '::1' || host === '[::1]' || host.endsWith('.local') || host.endsWith('.internal')) {
    return false;
  }
  const blockedHosts = [
    'redis', 'postgres', 'rabbitmq', 'api-gateway', 'auth-service', 'crm-service',
    'messaging-service', 'websocket-service', 'ai-service', 'user-service', 'bd-accounts-service',
    'pipeline-service', 'automation-service', 'analytics-service', 'team-service', 'campaign-service',
  ];
  if (blockedHosts.includes(host)) return false;

  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 127 || a === 10 || a === 0) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 169 && b === 254) return false;
  }
  if (host === '::1' || host === '[::1]' || host.startsWith('fd') || host.startsWith('fe80')) return false;

  return true;
}

const SYSTEM_MESSAGES = {
  SHARED_CHAT_TITLE_TEMPLATE: 'Chat: {{contact_name}}',
  SHARED_CHAT_DEFAULT_CONTACT: 'Contact',
  SHARED_CHAT_FALLBACK_TITLE: 'Shared Chat',
  SHARED_CHAT_CREATED: (title: string) => `[System] Shared chat created: ${title}`,
  DEAL_WON_WITH_AMOUNT: (amount: number, currency: string) => `[System] Deal closed. Amount: ${amount} ${currency}`,
  DEAL_WON: '[System] Deal closed.',
  DEAL_LOST_WITH_REASON: (reason: string) => `[System] Deal lost. Reason: ${reason}`,
  DEAL_LOST: '[System] Deal lost.',
} as const;

function parseStageIdsFromStageChangedMetadata(metadata: unknown): { from?: string; to?: string } {
  if (metadata == null) return {};
  let obj: Record<string, unknown>;
  if (typeof metadata === 'string') {
    try {
      obj = JSON.parse(metadata) as Record<string, unknown>;
    } catch {
      return {};
    }
  } else if (typeof metadata === 'object') {
    obj = metadata as Record<string, unknown>;
  } else {
    return {};
  }
  const from = typeof obj.from_stage_id === 'string' ? obj.from_stage_id : undefined;
  const to = typeof obj.to_stage_id === 'string' ? obj.to_stage_id : undefined;
  return { from, to };
}

function timelineCreatedAtIso(v: unknown): string {
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'string') {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? v : d.toISOString();
  }
  return String(v);
}

export type LeadTimelineItem = {
  id: string;
  lead_id: string;
  type: string;
  metadata: unknown;
  created_at: string;
  from_stage_name?: string | null;
  to_stage_name?: string | null;
  /** Alias for to_stage_name (UI / i18n). */
  stage_name?: string | null;
};

async function buildLeadContext(
  db: MessagingDeps['db'],
  user: { id: string; organizationId: string },
  row: Record<string, unknown>,
) {
  const leadId = row.lead_id as string | null;
  const contactId = row.contact_id as string | null;
  const campaignId = row.campaign_id as string | null;

  /** Deal closure (won/lost/revenue/loss_reason) lives on `conversations`, not `leads`. */
  const isoFromRow = (v: unknown): string | null => {
    if (v == null) return null;
    if (v instanceof Date) return v.toISOString();
    const d = new Date(v as string);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  };
  let wonAt: string | null = isoFromRow(row.won_at);
  let lostAt: string | null = isoFromRow(row.lost_at);
  let revenueAmount: number | null = row.revenue_amount != null ? Number(row.revenue_amount) : null;
  let lossReason: string | null =
    row.loss_reason != null && String(row.loss_reason).trim() !== '' ? String(row.loss_reason) : null;

  let contactName = '';
  let contactTelegramId: string | null = null;
  let contactUsername: string | null = null;
  if (contactId) {
    const ct = await db.read.query(
      'SELECT first_name, last_name, telegram_id, username FROM contacts WHERE id = $1 AND organization_id = $2',
      [contactId, user.organizationId],
    );
    if (ct.rows.length) {
      const c = ct.rows[0] as Record<string, unknown>;
      contactName = [c.first_name, c.last_name].filter(Boolean).join(' ') || '';
      contactTelegramId = (c.telegram_id as string) ?? null;
      contactUsername = (c.username as string) ?? null;
    }
  }

  let pipeline = { id: '', name: '' };
  let stage = { id: '', name: '' };
  let stages: { id: string; name: string }[] = [];
  let responsibleId: string | null = null;
  let responsibleEmail: string | null = null;
  let timeline: LeadTimelineItem[] = [];
  let companyName: string | null = null;

  if (leadId) {
    const leadRes = await db.read.query(
      `SELECT l.id, l.stage_id, l.pipeline_id, l.responsible_id, l.revenue_amount, l.created_at,
              s.name AS stage_name, p.name AS pipeline_name
       FROM leads l
       LEFT JOIN stages s ON s.id = l.stage_id
       LEFT JOIN pipelines p ON p.id = l.pipeline_id
       WHERE l.id = $1 AND l.organization_id = $2`,
      [leadId, user.organizationId],
    );
    if (leadRes.rows.length) {
      const l = leadRes.rows[0] as Record<string, unknown>;
      pipeline = { id: String(l.pipeline_id ?? ''), name: String(l.pipeline_name ?? '') };
      stage = { id: String(l.stage_id ?? ''), name: String(l.stage_name ?? '') };
      responsibleId = (l.responsible_id as string) ?? null;
      if (revenueAmount == null && l.revenue_amount != null) revenueAmount = Number(l.revenue_amount);

      if (l.pipeline_id) {
        const stagesRes = await db.read.query(
          'SELECT id, name FROM stages WHERE pipeline_id = $1 ORDER BY order_index ASC',
          [l.pipeline_id],
        );
        stages = (stagesRes.rows as { id: string; name: string }[]).map((s) => ({ id: s.id, name: s.name }));
      }

      if (responsibleId) {
        const userRes = await db.read.query('SELECT email FROM users WHERE id = $1', [responsibleId]);
        responsibleEmail = (userRes.rows[0] as { email?: string })?.email ?? null;
      }

      const timelineResult = await db.read.query(
        'SELECT id, lead_id, type, metadata, created_at FROM lead_activity_log WHERE lead_id = $1 ORDER BY created_at DESC LIMIT 50',
        [leadId],
      );
      const rawRows = timelineResult.rows as Array<{
        id: string;
        lead_id: string;
        type: string;
        metadata: unknown;
        created_at: unknown;
      }>;

      const stageIds = new Set<string>();
      for (const r of rawRows) {
        if (r.type !== 'stage_changed') continue;
        const { from, to } = parseStageIdsFromStageChangedMetadata(r.metadata);
        if (from) stageIds.add(from);
        if (to) stageIds.add(to);
      }

      let stageNameById = new Map<string, string>();
      if (stageIds.size > 0) {
        const ids = [...stageIds];
        const stageRes = await db.read.query(
          'SELECT id, name FROM stages WHERE organization_id = $1 AND id = ANY($2::uuid[])',
          [user.organizationId, ids],
        );
        for (const sr of stageRes.rows as { id: string; name: string }[]) {
          stageNameById.set(sr.id, sr.name);
        }
      }

      timeline = rawRows.map((r) => {
        const base: LeadTimelineItem = {
          id: r.id,
          lead_id: r.lead_id,
          type: r.type,
          metadata: r.metadata,
          created_at: timelineCreatedAtIso(r.created_at),
        };
        if (r.type !== 'stage_changed') return base;
        const { from, to } = parseStageIdsFromStageChangedMetadata(r.metadata);
        const fromName = from != null ? stageNameById.get(from) ?? null : null;
        const toName = to != null ? stageNameById.get(to) ?? null : null;
        return {
          ...base,
          from_stage_name: fromName,
          to_stage_name: toName,
          stage_name: toName,
        };
      });

      const companyResult = await db.read.query(
        `SELECT comp.name FROM contacts c
         JOIN companies comp ON comp.id = c.company_id
         WHERE c.id = (SELECT contact_id FROM leads WHERE id = $1)`,
        [leadId],
      );
      companyName = (companyResult.rows[0] as { name?: string })?.name ?? null;
    }
  }

  let campaign: { id: string; name: string } | null = null;
  if (campaignId) {
    const campRes = await db.read.query('SELECT id, name FROM campaigns WHERE id = $1', [campaignId]);
    if (campRes.rows.length) {
      const c = campRes.rows[0] as { id: string; name: string };
      campaign = { id: c.id, name: c.name };
    }
  }

  return {
    conversation_id: row.conversation_id ?? null,
    lead_id: leadId,
    contact_id: contactId,
    contact_name: contactName,
    contact_telegram_id: contactTelegramId,
    contact_username: contactUsername,
    bd_account_id: row.bd_account_id ?? null,
    channel_id: row.channel_id ?? null,
    responsible_id: responsibleId,
    responsible_email: responsibleEmail,
    pipeline,
    stage,
    stages,
    campaign,
    became_lead_at: row.became_lead_at ? new Date(row.became_lead_at as string).toISOString() : new Date().toISOString(),
    shared_chat_created_at: row.shared_chat_created_at ? new Date(row.shared_chat_created_at as string).toISOString() : null,
    shared_chat_channel_id: (row.shared_chat_channel_id as string) ?? null,
    shared_chat_invite_link: (row.shared_chat_invite_link as string) ?? null,
    won_at: wonAt,
    revenue_amount: revenueAmount,
    lost_at: lostAt,
    loss_reason: lossReason,
    company_name: companyName,
    timeline,
  };
}

export function registerConversationFeatureRoutes(app: FastifyInstance, deps: MessagingDeps): void {
  const { db, rabbitmq, log, aiClient, redis } = deps;

  // GET /api/messaging/resolve-contact
  app.get('/api/messaging/resolve-contact', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { contactId, channelId, bdAccountId } = request.query as { contactId?: string; channelId?: string; bdAccountId?: string };

    if (contactId?.trim()) {
      const result = await db.read.query(
        `SELECT c.bd_account_id, c.channel_id
         FROM conversations c
         WHERE c.contact_id = $1 AND c.organization_id = $2
         ORDER BY c.updated_at DESC LIMIT 1`,
        [contactId.trim(), user.organizationId],
      );
      if (!result.rows.length) {
        throw new AppError(404, 'No conversation found for this contact', ErrorCodes.NOT_FOUND);
      }
      return { bd_account_id: result.rows[0].bd_account_id, channel_id: result.rows[0].channel_id };
    }

    if (!channelId?.trim() || !bdAccountId?.trim()) {
      throw new AppError(400, 'contactId or (channelId + bdAccountId) are required', ErrorCodes.VALIDATION);
    }

    const result = await db.read.query(
      `SELECT c.id, c.contact_id, ct.first_name, ct.last_name, ct.username, ct.email, ct.phone
       FROM conversations c
       LEFT JOIN contacts ct ON c.contact_id = ct.id
       WHERE c.channel_id = $1 AND c.bd_account_id = $2 AND c.organization_id = $3 LIMIT 1`,
      [channelId.trim(), bdAccountId.trim(), user.organizationId],
    );
    if (!result.rows.length) return { contact: null };
    return { contact: result.rows[0] };
  });

  // PATCH /api/messaging/conversations/:id/view
  app.patch('/api/messaging/conversations/:id/view', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const result = await db.write.query(
      `UPDATE conversations SET last_viewed_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [id, user.organizationId],
    );
    if (!result.rows.length) {
      throw new AppError(404, 'Conversation not found', ErrorCodes.NOT_FOUND);
    }
    return { ok: true };
  });

  // GET /api/messaging/conversations/:id/lead-context
  app.get('/api/messaging/conversations/:id/lead-context', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const conv = await db.read.query(
      `SELECT c.id AS conversation_id, c.lead_id, c.contact_id, c.campaign_id, c.became_lead_at,
              c.bd_account_id, c.channel_id,
              c.shared_chat_created_at, c.shared_chat_channel_id, c.shared_chat_invite_link,
              c.won_at, c.lost_at, c.revenue_amount, c.loss_reason
       FROM conversations c WHERE c.id = $1 AND c.organization_id = $2`,
      [id, user.organizationId],
    );
    if (!conv.rows.length) throw new AppError(404, 'Conversation not found', ErrorCodes.NOT_FOUND);
    return buildLeadContext(db, user, conv.rows[0] as Record<string, unknown>);
  });

  // GET /api/messaging/lead-context-by-lead/:leadId
  app.get('/api/messaging/lead-context-by-lead/:leadId', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { leadId } = request.params as { leadId: string };
    const conv = await db.read.query(
      `SELECT c.id AS conversation_id, c.lead_id, c.contact_id, c.campaign_id, c.became_lead_at,
              c.bd_account_id, c.channel_id,
              c.shared_chat_created_at, c.shared_chat_channel_id, c.shared_chat_invite_link,
              c.won_at, c.lost_at, c.revenue_amount, c.loss_reason
       FROM conversations c
       WHERE c.lead_id = $1 AND c.organization_id = $2
       ORDER BY c.updated_at DESC LIMIT 1`,
      [leadId, user.organizationId],
    );
    if (!conv.rows.length) throw new AppError(404, 'No conversation found for this lead', ErrorCodes.NOT_FOUND);
    return buildLeadContext(db, user, conv.rows[0] as Record<string, unknown>);
  });

  // GET /api/messaging/new-leads — enriched with pipeline/stage, unread counts, last message (v1 parity)
  app.get('/api/messaging/new-leads', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { limit = 50, offset = 0 } = request.query as { limit?: number; offset?: number };
    const safeLimit = Math.min(Number(limit) || 50, 100);
    const safeOffset = Number(offset) || 0;

    const result = await db.read.query(
      `SELECT DISTINCT ON (conv.lead_id)
              conv.id AS conversation_id, conv.organization_id, conv.bd_account_id, conv.channel, conv.channel_id,
              conv.contact_id, conv.lead_id, conv.campaign_id, conv.became_lead_at, conv.last_viewed_at,
              st.name AS lead_stage_name, p.name AS lead_pipeline_name, l.stage_id,
              ct.first_name, ct.last_name, ct.display_name, ct.username, ct.telegram_id,
              (SELECT COUNT(*)::int FROM messages m
               WHERE m.organization_id = conv.organization_id AND m.channel = conv.channel
                 AND m.channel_id = conv.channel_id AND m.bd_account_id IS NOT DISTINCT FROM conv.bd_account_id
                 AND m.unread = true) AS unread_count,
              (SELECT MAX(COALESCE(m.telegram_date, m.created_at)) FROM messages m
               WHERE m.organization_id = conv.organization_id AND m.channel = conv.channel
                 AND m.channel_id = conv.channel_id AND m.bd_account_id IS NOT DISTINCT FROM conv.bd_account_id) AS last_message_at,
              (SELECT COALESCE(NULLIF(TRIM(m2.content), ''), '[Media]') FROM messages m2
               WHERE m2.organization_id = conv.organization_id AND m2.channel = conv.channel
                 AND m2.channel_id = conv.channel_id AND m2.bd_account_id IS NOT DISTINCT FROM conv.bd_account_id
               ORDER BY COALESCE(m2.telegram_date, m2.created_at) DESC LIMIT 1) AS last_message
       FROM conversations conv
       JOIN leads l ON l.id = conv.lead_id
       JOIN stages st ON st.id = l.stage_id
       JOIN pipelines p ON p.id = l.pipeline_id
       LEFT JOIN contacts ct ON ct.id = conv.contact_id
       WHERE conv.organization_id = $1 AND conv.lead_id IS NOT NULL AND conv.first_manager_reply_at IS NULL
       ORDER BY conv.lead_id, conv.became_lead_at DESC NULLS LAST`,
      [user.organizationId],
    );

    const rows = (result.rows as Array<{ became_lead_at: string | Date | null; [k: string]: unknown }>)
      .sort((a, b) => {
        const at = a.became_lead_at ? new Date(a.became_lead_at as string).getTime() : 0;
        const bt = b.became_lead_at ? new Date(b.became_lead_at as string).getTime() : 0;
        return bt - at;
      })
      .slice(safeOffset, safeOffset + safeLimit);

    return rows;
  });

  // GET /api/messaging/settings/shared-chat — org shared chat settings (v1 parity)
  app.get('/api/messaging/settings/shared-chat', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const row = await db.read.query(
      "SELECT value FROM organization_settings WHERE organization_id = $1 AND key = 'shared_chat'",
      [user.organizationId],
    );
    const value = row.rows[0]?.value as Record<string, unknown> | undefined;
    const titleTemplate = typeof value?.titleTemplate === 'string' ? value.titleTemplate : SYSTEM_MESSAGES.SHARED_CHAT_TITLE_TEMPLATE;
    const extraUsernames = Array.isArray(value?.extraUsernames) ? value.extraUsernames.filter((u: unknown) => typeof u === 'string') : [];
    return { titleTemplate, extraUsernames };
  });

  // PATCH /api/messaging/settings/shared-chat — update org shared chat settings (v1 parity)
  app.patch('/api/messaging/settings/shared-chat', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { titleTemplate, extraUsernames } = (request.body || {}) as { titleTemplate?: string; extraUsernames?: string[] };

    const title = typeof titleTemplate === 'string' ? titleTemplate.trim() || SYSTEM_MESSAGES.SHARED_CHAT_TITLE_TEMPLATE : undefined;
    const usernames = Array.isArray(extraUsernames)
      ? extraUsernames.filter((u): u is string => typeof u === 'string').map((u) => u.trim().replace(/^@/, ''))
      : undefined;

    if (title === undefined && usernames === undefined) {
      throw new AppError(400, 'Provide titleTemplate and/or extraUsernames', ErrorCodes.VALIDATION);
    }

    const existing = await db.read.query(
      "SELECT value FROM organization_settings WHERE organization_id = $1 AND key = 'shared_chat'",
      [user.organizationId],
    );
    const prev = (existing.rows[0]?.value as Record<string, unknown>) ?? {};
    const value = {
      titleTemplate: title !== undefined ? title : (typeof prev.titleTemplate === 'string' ? prev.titleTemplate : SYSTEM_MESSAGES.SHARED_CHAT_TITLE_TEMPLATE),
      extraUsernames: usernames !== undefined ? usernames : (Array.isArray(prev.extraUsernames) ? prev.extraUsernames : []),
    };
    await db.write.query(
      `INSERT INTO organization_settings (organization_id, key, value, updated_at)
       VALUES ($1, 'shared_chat', $2::jsonb, NOW())
       ON CONFLICT (organization_id, key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
      [user.organizationId, JSON.stringify(value)],
    );
    return { titleTemplate: value.titleTemplate, extraUsernames: value.extraUsernames };
  });

  // POST /api/messaging/create-shared-chat — create shared chat via TSM (v1 parity)
  app.post('/api/messaging/create-shared-chat', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const body = request.body as {
      conversation_id?: string;
      lead_id?: string;
      title?: string;
      participant_usernames?: string[];
      bd_account_id?: string;
    };

    if (!body.conversation_id?.trim() && !body.lead_id?.trim()) {
      throw new AppError(400, 'conversation_id or lead_id is required', ErrorCodes.VALIDATION);
    }

    let convId = body.conversation_id?.trim() ?? null;

    if (!convId && body.lead_id) {
      const convByLead = await db.read.query(
        'SELECT id FROM conversations WHERE lead_id = $1 AND organization_id = $2 ORDER BY updated_at DESC LIMIT 1',
        [body.lead_id.trim(), user.organizationId],
      );
      if (convByLead.rows.length) {
        convId = (convByLead.rows[0] as { id: string }).id;
      }
    }

    if (!convId) throw new AppError(404, 'Conversation not found', ErrorCodes.NOT_FOUND);

    const conv = await db.read.query(
      'SELECT id, channel_id, bd_account_id, contact_id, shared_chat_created_at FROM conversations WHERE id = $1 AND organization_id = $2',
      [convId, user.organizationId],
    );
    if (!conv.rows.length) throw new AppError(404, 'Conversation not found', ErrorCodes.NOT_FOUND);

    const c = conv.rows[0] as {
      id: string; channel_id: string; bd_account_id: string | null;
      contact_id: string | null; shared_chat_created_at: Date | null;
    };

    if (c.shared_chat_created_at != null) {
      throw new AppError(409, 'Shared chat already created for this conversation', ErrorCodes.CONFLICT);
    }

    const effectiveBdAccountId = c.bd_account_id || body.bd_account_id;
    if (!effectiveBdAccountId) {
      throw new AppError(400, 'Conversation has no BD account. Pass bd_account_id.', ErrorCodes.VALIDATION);
    }

    let contactName: string | null = null;
    let leadUsername: string | null = null;
    if (c.contact_id) {
      const contactRow = await db.read.query(
        `SELECT COALESCE(NULLIF(TRIM(display_name), ''), NULLIF(TRIM(CONCAT(COALESCE(first_name,''), ' ', COALESCE(last_name,''))), ''), username, telegram_id::text) AS contact_name,
                username AS contact_username
         FROM contacts WHERE id = $1 AND organization_id = $2`,
        [c.contact_id, user.organizationId],
      );
      const row = contactRow.rows[0] as { contact_name?: string; contact_username?: string | null } | undefined;
      contactName = row?.contact_name ?? null;
      leadUsername = row?.contact_username?.trim().replace(/^@/, '') || null;
    }

    let title: string;
    if (body.title?.trim()) {
      title = body.title.trim().slice(0, 255);
    } else {
      const settingsRow = await db.read.query(
        "SELECT value FROM organization_settings WHERE organization_id = $1 AND key = 'shared_chat'",
        [user.organizationId],
      );
      const v = settingsRow.rows[0]?.value as Record<string, unknown> | undefined;
      const template = typeof v?.titleTemplate === 'string' ? v.titleTemplate : SYSTEM_MESSAGES.SHARED_CHAT_TITLE_TEMPLATE;
      title = template.replace(/\{\{\s*contact_name\s*\}\}/gi,
        (contactName ?? SYSTEM_MESSAGES.SHARED_CHAT_DEFAULT_CONTACT).trim(),
      ).trim().slice(0, 255) || SYSTEM_MESSAGES.SHARED_CHAT_FALLBACK_TITLE;
    }

    const extraUsernames = Array.isArray(body.participant_usernames)
      ? body.participant_usernames.filter((u): u is string => typeof u === 'string').map((u) => u.trim().replace(/^@/, ''))
      : [];

    const parsedLeadId = c.channel_id ? parseInt(c.channel_id, 10) : NaN;
    const leadTelegramUserId = Number.isInteger(parsedLeadId) && parsedLeadId > 0 ? parsedLeadId : undefined;

    if (leadTelegramUserId == null && !leadUsername) {
      throw new AppError(400, 'Lead Telegram user id or contact username is required', ErrorCodes.VALIDATION);
    }

    const lockKey = `create_shared_chat:${convId}`;
    const lockToken = randomUUID();
    const lockOk = await redis.tryLock(lockKey, lockToken, 120);
    if (!lockOk) {
      throw new AppError(409, 'Shared chat creation already in progress for this conversation', ErrorCodes.CONFLICT, {
        conversation_id: convId,
      });
    }

    const commandQueue = `telegram:commands:${effectiveBdAccountId}`;
    try {
      await rabbitmq.publishCommand(commandQueue, {
        type: 'CREATE_SHARED_CHAT',
        id: randomUUID(),
        priority: 6,
        payload: {
          organizationId: user.organizationId,
          conversationId: convId,
          title,
          leadTelegramUserId: leadTelegramUserId ?? undefined,
          leadUsername: leadUsername ?? undefined,
          extraUsernames,
        },
      });
    } catch (err) {
      await redis.releaseLock(lockKey, lockToken).catch(() => {});
      log.error({ message: 'Failed to publish CREATE_SHARED_CHAT command', error: String(err) });
      throw err;
    }

    return {
      status: 'queued' as const,
      conversation_id: convId,
      shared_chat_created_at: null,
      shared_chat_channel_id: null,
      shared_chat_invite_link: null,
      channel_id: c.channel_id,
      title,
    };
  });

  // POST /api/messaging/mark-shared-chat — mark conversation as having shared chat without creating one (v1 parity)
  app.post('/api/messaging/mark-shared-chat', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { conversation_id } = (request.body || {}) as { conversation_id?: string };

    if (!conversation_id?.trim()) {
      throw new AppError(400, 'conversation_id is required', ErrorCodes.VALIDATION);
    }

    const existing = await db.read.query(
      'SELECT id, shared_chat_created_at FROM conversations WHERE id = $1 AND organization_id = $2 AND lead_id IS NOT NULL',
      [conversation_id.trim(), user.organizationId],
    );
    if (!existing.rows.length) {
      throw new AppError(404, 'Lead conversation not found', ErrorCodes.NOT_FOUND);
    }
    const conv = existing.rows[0] as { id: string; shared_chat_created_at: Date | null };
    if (conv.shared_chat_created_at != null) {
      throw new AppError(409, 'Shared chat already created for this conversation', ErrorCodes.CONFLICT);
    }

    const r = await db.write.query(
      `UPDATE conversations SET shared_chat_created_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND organization_id = $2 AND lead_id IS NOT NULL
       RETURNING id, shared_chat_created_at`,
      [conv.id, user.organizationId],
    );
    const row = r.rows[0] as { id: string; shared_chat_created_at: Date };
    return {
      conversation_id: row.id,
      shared_chat_created_at: row.shared_chat_created_at instanceof Date ? row.shared_chat_created_at.toISOString() : row.shared_chat_created_at,
    };
  });

  // POST /api/messaging/mark-won — v1 parity: conflict checks + system messages
  app.post('/api/messaging/mark-won', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { conversation_id, revenue_amount, currency } = request.body as {
      conversation_id?: string;
      revenue_amount?: number | null;
      currency?: string;
    };

    if (!conversation_id?.trim()) {
      throw new AppError(400, 'conversation_id is required', ErrorCodes.VALIDATION);
    }

    const conv = await db.read.query(
      `SELECT c.id, c.lead_id, c.bd_account_id, c.channel_id, c.contact_id, c.won_at, c.lost_at
       FROM conversations c WHERE c.id = $1 AND c.organization_id = $2 AND c.lead_id IS NOT NULL`,
      [conversation_id.trim(), user.organizationId],
    );
    if (!conv.rows.length) {
      throw new AppError(404, 'Lead conversation not found', ErrorCodes.NOT_FOUND);
    }

    const c = conv.rows[0] as {
      id: string; lead_id: string; bd_account_id: string | null;
      channel_id: string; contact_id: string | null; won_at: Date | null; lost_at: Date | null;
    };

    if (c.won_at != null) throw new AppError(409, 'Deal already marked as won', ErrorCodes.CONFLICT);
    if (c.lost_at != null) throw new AppError(409, 'Deal already marked as lost', ErrorCodes.CONFLICT);

    const revenueVal = revenue_amount != null ? Math.round(Number(revenue_amount) * 100) / 100 : null;
    const systemContent = revenueVal != null
      ? SYSTEM_MESSAGES.DEAL_WON_WITH_AMOUNT(revenueVal, currency || 'USD')
      : SYSTEM_MESSAGES.DEAL_WON;

    await db.write.query('BEGIN');
    try {
      await db.write.query(
        'UPDATE conversations SET won_at = NOW(), revenue_amount = $3, updated_at = NOW() WHERE id = $1 AND organization_id = $2',
        [conversation_id.trim(), user.organizationId, revenueVal],
      );
      await db.write.query(
        `INSERT INTO messages (id, organization_id, bd_account_id, channel, channel_id, contact_id, direction, content, status, unread, metadata)
         VALUES (gen_random_uuid(), $1, $2, 'telegram', $3, $4, 'outbound', $5, 'delivered', false, $6)`,
        [
          user.organizationId,
          c.bd_account_id,
          c.channel_id,
          c.contact_id,
          systemContent,
          JSON.stringify({ system: true, event: 'deal_won', revenue_amount: revenueVal }),
        ],
      );
      await db.write.query('COMMIT');
    } catch (txErr) {
      await db.write.query('ROLLBACK').catch(() => {});
      throw txErr;
    }

    return {
      conversation_id: conversation_id.trim(),
      won_at: new Date().toISOString(),
      revenue_amount: revenueVal,
    };
  });

  // POST /api/messaging/mark-lost — v1 parity: conflict checks + system messages
  app.post('/api/messaging/mark-lost', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { conversation_id, reason } = request.body as { conversation_id?: string; reason?: string };

    if (!conversation_id?.trim()) {
      throw new AppError(400, 'conversation_id is required', ErrorCodes.VALIDATION);
    }

    const conv = await db.read.query(
      `SELECT c.id, c.lead_id, c.bd_account_id, c.channel_id, c.contact_id, c.won_at, c.lost_at
       FROM conversations c WHERE c.id = $1 AND c.organization_id = $2 AND c.lead_id IS NOT NULL`,
      [conversation_id.trim(), user.organizationId],
    );
    if (!conv.rows.length) {
      throw new AppError(404, 'Lead conversation not found', ErrorCodes.NOT_FOUND);
    }

    const c = conv.rows[0] as {
      id: string; lead_id: string; bd_account_id: string | null;
      channel_id: string; contact_id: string | null; won_at: Date | null; lost_at: Date | null;
    };

    if (c.won_at != null) throw new AppError(409, 'Deal already marked as won', ErrorCodes.CONFLICT);
    if (c.lost_at != null) throw new AppError(409, 'Deal already marked as lost', ErrorCodes.CONFLICT);

    const lossReason = reason?.trim().slice(0, 2000) || null;
    const systemContent = lossReason
      ? SYSTEM_MESSAGES.DEAL_LOST_WITH_REASON(lossReason.slice(0, 500))
      : SYSTEM_MESSAGES.DEAL_LOST;

    await db.write.query('BEGIN');
    try {
      await db.write.query(
        'UPDATE conversations SET lost_at = NOW(), loss_reason = $3, updated_at = NOW() WHERE id = $1 AND organization_id = $2',
        [conversation_id.trim(), user.organizationId, lossReason],
      );
      await db.write.query(
        `INSERT INTO messages (id, organization_id, bd_account_id, channel, channel_id, contact_id, direction, content, status, unread, metadata)
         VALUES (gen_random_uuid(), $1, $2, 'telegram', $3, $4, 'outbound', $5, 'delivered', false, $6)`,
        [
          user.organizationId,
          c.bd_account_id,
          c.channel_id,
          c.contact_id,
          systemContent,
          JSON.stringify({ system: true, event: 'deal_lost', reason: lossReason }),
        ],
      );
      await db.write.query('COMMIT');
    } catch (txErr) {
      await db.write.query('ROLLBACK').catch(() => {});
      throw txErr;
    }

    return {
      conversation_id: conversation_id.trim(),
      lost_at: new Date().toISOString(),
      loss_reason: lossReason,
    };
  });

  // GET /api/messaging/unfurl — full OG tag extraction with SSRF protection (v1 parity)
  app.get('/api/messaging/unfurl', { preHandler: [requireUser] }, async (request) => {
    const rawUrl = typeof (request.query as Record<string, unknown>).url === 'string'
      ? ((request.query as Record<string, unknown>).url as string).trim()
      : '';

    if (!rawUrl || !URL_REGEX.test(rawUrl)) {
      throw new AppError(400, 'Valid url query parameter is required', ErrorCodes.VALIDATION);
    }
    if (!isUrlAllowedForUnfurl(rawUrl)) {
      throw new AppError(400, 'URL is not allowed for preview', ErrorCodes.VALIDATION);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UNFURL_TIMEOUT_MS);
    try {
      const response = await fetch(rawUrl, {
        signal: controller.signal,
        headers: { 'User-Agent': 'GetSale-CRM-Bot/1.0 (link preview)' },
        redirect: 'follow',
      });
      clearTimeout(timeout);
      if (!response.ok || !response.body) {
        return { title: null, description: null, image: null };
      }
      const contentLength = response.headers.get('content-length');
      if (contentLength && parseInt(contentLength, 10) > UNFURL_MAX_BODY) {
        return { title: null, description: null, image: null };
      }

      const chunks: Buffer[] = [];
      let total = 0;
      const reader = (response.body as ReadableStream<Uint8Array>).getReader();
      try {
        while (total < UNFURL_MAX_BODY) {
          const { done, value } = await reader.read();
          if (done) break;
          const buf = Buffer.from(value);
          total += buf.length;
          chunks.push(total <= UNFURL_MAX_BODY ? buf : buf.subarray(0, UNFURL_MAX_BODY - (total - buf.length)));
          if (total >= UNFURL_MAX_BODY) break;
        }
      } finally {
        reader.releaseLock?.();
      }

      const html = Buffer.concat(chunks).toString('utf8', 0, Math.min(total, UNFURL_MAX_BODY));
      const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1];
      const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1]
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)?.[1];
      const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
        || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];

      const title = ogTitle ? ogTitle.replace(/&amp;/g, '&').replace(/&#39;/g, "'").slice(0, 200) : null;
      const description = ogDesc ? ogDesc.replace(/&amp;/g, '&').replace(/&#39;/g, "'").slice(0, 300) : null;
      let image: string | null = ogImage ? ogImage.replace(/&amp;/g, '&').trim() : null;
      if (image && !/^https?:\/\//i.test(image)) {
        try { image = new URL(image, rawUrl).href; } catch { image = null; }
      }
      return { title, description, image };
    } catch {
      clearTimeout(timeout);
      return { title: null, description: null, image: null };
    }
  });

  // POST /api/messaging/conversations/:id/ai/analysis — real AI via HTTP (v1 parity)
  app.post('/api/messaging/conversations/:id/ai/analysis', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const { id: conversationId } = request.params as { id: string };

    const convRes = await db.read.query(
      'SELECT id, bd_account_id, channel_id FROM conversations WHERE id = $1 AND organization_id = $2',
      [conversationId, user.organizationId],
    );
    if (!convRes.rows.length) throw new AppError(404, 'Conversation not found', ErrorCodes.NOT_FOUND);

    const conv = convRes.rows[0] as { id: string; bd_account_id: string | null; channel_id: string };
    if (!conv.bd_account_id || !conv.channel_id) {
      throw new AppError(400, 'Conversation has no bd_account or channel', ErrorCodes.VALIDATION);
    }

    const msgRes = await db.read.query(
      `SELECT id, content, direction, created_at FROM messages
       WHERE organization_id = $1 AND bd_account_id = $2 AND channel = 'telegram' AND channel_id = $3
       ORDER BY COALESCE(telegram_date, created_at) DESC LIMIT $4`,
      [user.organizationId, conv.bd_account_id, conv.channel_id, MESSAGES_FOR_AI_LIMIT],
    );
    const rows = (msgRes.rows as { id: string; content: string; direction: string; created_at: Date }[]).reverse();
    const messages = rows.map((m) => ({
      content: m.content,
      direction: m.direction,
      created_at: m.created_at instanceof Date ? m.created_at.toISOString() : String(m.created_at),
    }));
    if (messages.length === 0) {
      throw new AppError(400, 'No messages in conversation', ErrorCodes.VALIDATION);
    }

    try {
      const payload = await aiClient.post<Record<string, unknown>>(
        '/api/ai/conversations/analyze',
        { messages },
        undefined,
        { userId: user.id, organizationId: user.organizationId, userRole: user.role, correlationId: request.correlationId },
      );

      await db.write.query(
        `INSERT INTO conversation_ai_insights (conversation_id, account_id, type, payload_json, model_version, created_at)
         VALUES ($1, $2, 'analysis', $3, $4, NOW())`,
        [conversationId, conv.bd_account_id, JSON.stringify(payload), AI_INSIGHT_MODEL_VERSION],
      );
      return payload;
    } catch (err: unknown) {
      if (err instanceof ServiceCallError) {
        const errBody = typeof err.body === 'object' && err.body !== null
          ? err.body as { error?: string; message?: string }
          : {};
        return reply.code(err.statusCode).send({
          error: errBody.error || 'Service Unavailable',
          message: errBody.message || errBody.error || 'AI service error',
        });
      }
      throw err;
    }
  });

  // POST /api/messaging/conversations/:id/ai/summary — real AI summary via HTTP (v1 parity)
  app.post('/api/messaging/conversations/:id/ai/summary', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const { id: conversationId } = request.params as { id: string };
    const body = (request.body || {}) as { limit?: number };
    const MAX_SUMMARY_MESSAGES = 200;
    const msgLimit = Math.min(Math.max(Math.round(Number(body.limit) || 25), 1), MAX_SUMMARY_MESSAGES);

    const convRes = await db.read.query(
      'SELECT id, bd_account_id, channel_id FROM conversations WHERE id = $1 AND organization_id = $2',
      [conversationId, user.organizationId],
    );
    if (!convRes.rows.length) throw new AppError(404, 'Conversation not found', ErrorCodes.NOT_FOUND);

    const conv = convRes.rows[0] as { id: string; bd_account_id: string | null; channel_id: string };
    if (!conv.bd_account_id || !conv.channel_id) {
      throw new AppError(400, 'Conversation has no bd_account or channel', ErrorCodes.VALIDATION);
    }

    const msgRes = await db.read.query(
      `SELECT id, content, direction, created_at, telegram_date FROM messages
       WHERE organization_id = $1 AND bd_account_id = $2 AND channel = 'telegram' AND channel_id = $3
       ORDER BY COALESCE(telegram_date, created_at) DESC LIMIT $4`,
      [user.organizationId, conv.bd_account_id, conv.channel_id, msgLimit],
    );
    const rows = (msgRes.rows as { id: string; content: string; direction: string; created_at: Date; telegram_date: Date | null }[]).reverse();
    const messages = rows
      .map((m) => ({
        content: m.content,
        direction: m.direction,
        created_at: (m.telegram_date || m.created_at) instanceof Date
          ? (m.telegram_date || m.created_at)!.toISOString()
          : String(m.created_at),
      }))
      .filter((m) => m.content && m.content.trim().length > 0);

    if (messages.length === 0) {
      throw new AppError(400, 'No messages to summarize', ErrorCodes.VALIDATION);
    }

    try {
      const aiData = await aiClient.post<{ summary?: string }>(
        '/api/ai/chat/summarize',
        { messages },
        undefined,
        { userId: user.id, organizationId: user.organizationId, userRole: user.role, correlationId: request.correlationId },
      );
      const summary = aiData.summary ?? '';

      await db.write.query(
        `INSERT INTO conversation_ai_insights (conversation_id, account_id, type, payload_json, model_version, created_at)
         VALUES ($1, $2, 'summary', $3, $4, NOW())`,
        [conversationId, conv.bd_account_id, JSON.stringify({ summary }), AI_INSIGHT_MODEL_VERSION],
      );
      return { summary };
    } catch (err: unknown) {
      if (err instanceof ServiceCallError) {
        const errBody = typeof err.body === 'object' && err.body !== null
          ? err.body as { error?: string; message?: string }
          : {};
        return reply.code(err.statusCode).send({
          error: errBody.error || 'Service Unavailable',
          message: errBody.message || errBody.error || 'AI service error',
        });
      }
      throw err;
    }
  });
}
