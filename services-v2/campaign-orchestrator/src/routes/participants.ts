import { FastifyInstance } from 'fastify';
import { AppError, ErrorCodes, requireUser, DatabasePools } from '@getsale/service-framework';
import { Logger } from '@getsale/logger';

interface Deps {
  db: DatabasePools;
  log: Logger;
}

function parsePageLimit(query: Record<string, unknown>, defaultLimit: number, maxLimit: number) {
  const page = Math.max(1, parseInt(String(query.page ?? 1), 10) || 1);
  const limit = Math.min(maxLimit, Math.max(1, parseInt(String(query.limit ?? defaultLimit), 10) || defaultLimit));
  return { page, limit, offset: (page - 1) * limit };
}

export function registerParticipantRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, log } = deps;

  app.get('/api/campaigns/:id/participants', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, unknown>;

    const campaign = await db.read.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!campaign.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const { page, limit, offset } = parsePageLimit(query, 50, 100);
    const statusParam = (query.status || query.filter) as string | undefined;

    let whereStatus = '';
    let whereFilter = '';
    const params: unknown[] = [id];
    let paramIdx = 2;

    if (statusParam === 'replied') {
      whereStatus = ` AND cp.status = $${paramIdx}`;
      params.push('replied');
      paramIdx++;
    } else if (statusParam === 'not_replied') {
      whereStatus = " AND (cp.status IS NULL OR cp.status != 'replied')";
    } else if (statusParam === 'shared') {
      whereFilter = ' AND conv.shared_chat_created_at IS NOT NULL';
    }

    if (query.bdAccountId && typeof query.bdAccountId === 'string') {
      whereFilter += ` AND cp.bd_account_id = $${paramIdx}`;
      params.push(query.bdAccountId);
      paramIdx++;
    }
    if (query.sentFrom && typeof query.sentFrom === 'string') {
      whereFilter += ` AND fs.first_sent_at IS NOT NULL AND fs.first_sent_at::date >= $${paramIdx}::date`;
      params.push(query.sentFrom);
      paramIdx++;
    }
    if (query.sentTo && typeof query.sentTo === 'string') {
      whereFilter += ` AND fs.first_sent_at IS NOT NULL AND fs.first_sent_at::date <= $${paramIdx}::date`;
      params.push(query.sentTo);
      paramIdx++;
    }

    const limitIdx = paramIdx;
    const offsetIdx = paramIdx + 1;
    params.push(limit, offset);

    const result = await db.read.query(
      `SELECT
         cp.id AS participant_id,
         cp.contact_id,
         cp.bd_account_id,
         cp.channel_id,
         cp.status AS participant_status,
         cp.metadata AS participant_metadata,
         cp.current_step,
         cp.next_send_at,
         (SELECT COUNT(*)::int FROM campaign_sequences WHERE campaign_id = cp.campaign_id) AS sequence_total_steps,
         cp.created_at AS participant_created_at,
         cp.updated_at AS participant_updated_at,
         COALESCE(NULLIF(TRIM(c.display_name), ''), NULLIF(TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))), ''), c.username, c.telegram_id::text) AS contact_name,
         COALESCE(NULLIF(TRIM(ba.display_name), ''), NULLIF(TRIM(CONCAT(COALESCE(ba.first_name,''), ' ', COALESCE(ba.last_name,''))), ''), ba.phone_number, ba.telegram_id::text, cp.bd_account_id::text) AS bd_account_display_name,
         conv.id AS conversation_id,
         conv.shared_chat_created_at,
         st.name AS pipeline_stage_name,
         fs.first_sent_at AS sent_at,
         CASE WHEN cp.status = 'replied' THEN cp.updated_at ELSE NULL END AS replied_at,
         (m_first.status = 'read') AS first_message_read
       FROM campaign_participants cp
       JOIN contacts c ON c.id = cp.contact_id
       LEFT JOIN bd_accounts ba ON ba.id = cp.bd_account_id
       LEFT JOIN LATERAL (
         SELECT cs.sent_at AS first_sent_at, cs.message_id AS first_message_id
         FROM campaign_sends cs WHERE cs.campaign_participant_id = cp.id AND cs.status = 'sent' ORDER BY cs.sent_at LIMIT 1
       ) fs ON true
       LEFT JOIN messages m_first ON m_first.id = fs.first_message_id
       LEFT JOIN conversations conv ON conv.campaign_id = cp.campaign_id AND conv.bd_account_id = cp.bd_account_id AND conv.channel = 'telegram' AND conv.channel_id = cp.channel_id
       LEFT JOIN leads l ON l.id = conv.lead_id
       LEFT JOIN stages st ON st.id = l.stage_id
       WHERE cp.campaign_id = $1 ${whereStatus} ${whereFilter}
       ORDER BY fs.first_sent_at DESC NULLS LAST, cp.enqueue_order ASC NULLS LAST, cp.created_at ASC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params,
    );

    const rows = (result.rows as Record<string, unknown>[]).map((r) => {
      const st = String(r.participant_status ?? '');
      const hasSent = r.sent_at != null;
      const phase = (() => {
        if (st === 'failed') return 'failed';
        if (r.shared_chat_created_at) return 'shared';
        if (st === 'replied') return 'replied';
        if (hasSent && r.first_message_read) return 'read';
        if (hasSent) return 'sent';
        if (st === 'completed') return 'skipped';
        if (st === 'pending') return 'pending';
        return 'scheduled';
      })();

      let last_error: string | null = null;
      if (r.participant_metadata != null) {
        try {
          const meta = typeof r.participant_metadata === 'string' ? JSON.parse(r.participant_metadata as string) : r.participant_metadata;
          if (meta && typeof meta.lastError === 'string') last_error = meta.lastError;
        } catch { /* ignore */ }
      }

      return {
        participant_id: r.participant_id,
        contact_id: r.contact_id,
        contact_name: r.contact_name ?? '',
        conversation_id: r.conversation_id,
        bd_account_id: r.bd_account_id ?? null,
        bd_account_display_name: r.bd_account_display_name ?? null,
        channel_id: r.channel_id ?? null,
        status_phase: phase,
        last_error: last_error ?? null,
        pipeline_stage_name: r.pipeline_stage_name ?? null,
        sent_at: r.sent_at instanceof Date ? (r.sent_at as Date).toISOString() : r.sent_at,
        replied_at: r.replied_at instanceof Date ? (r.replied_at as Date).toISOString() : r.replied_at,
        shared_chat_created_at: r.shared_chat_created_at instanceof Date ? (r.shared_chat_created_at as Date).toISOString() : r.shared_chat_created_at,
        current_step: r.current_step ?? 0,
        next_send_at: st === 'failed' ? null : (r.next_send_at instanceof Date ? (r.next_send_at as Date).toISOString() : r.next_send_at),
        sequence_total_steps: r.sequence_total_steps ?? 0,
      };
    });

    return rows;
  });

  app.get('/api/campaigns/:id/participant-accounts', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const campaign = await db.read.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!campaign.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const accounts = await db.read.query(
      `SELECT DISTINCT cp.bd_account_id AS id,
         COALESCE(NULLIF(TRIM(ba.display_name), ''), NULLIF(TRIM(CONCAT(COALESCE(ba.first_name,''), ' ', COALESCE(ba.last_name,''))), ''), ba.phone_number, ba.telegram_id::text, cp.bd_account_id::text) AS display_name
       FROM campaign_participants cp
       LEFT JOIN bd_accounts ba ON ba.id = cp.bd_account_id
       WHERE cp.campaign_id = $1 AND cp.bd_account_id IS NOT NULL
       ORDER BY display_name`,
      [id],
    );

    return (accounts.rows as { id: string; display_name: string }[]).map((r) => ({ id: r.id, displayName: r.display_name ?? r.id }));
  });

  app.get('/api/campaigns/:id/analytics', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const { days = 14 } = request.query as { days?: number };

    const campaign = await db.read.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!campaign.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const daysNum = Math.min(90, Math.max(1, parseInt(String(days), 10)));

    const [sendsByDayRes, repliedByDayRes, sendsByAccountByDayRes] = await Promise.all([
      db.read.query(
        `SELECT cs.sent_at::date AS day, COUNT(DISTINCT cp.id)::int AS sends
         FROM campaign_sends cs
         JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
         WHERE cp.campaign_id = $1 AND cs.status = 'sent' AND cs.sent_at >= NOW() - ($2::int || ' days')::interval
         GROUP BY cs.sent_at::date
         ORDER BY day`,
        [id, daysNum],
      ),
      db.read.query(
        `SELECT day, COUNT(*)::int AS replied
         FROM (
           SELECT COALESCE(l.first_reply::date, cp.updated_at::date) AS day
           FROM campaign_participants cp
           JOIN campaigns c ON c.id = cp.campaign_id
           LEFT JOIN LATERAL (
             SELECT MIN(m.sent_at) AS first_reply
             FROM messages m
             WHERE m.contact_id = cp.contact_id
               AND (m.bd_account_id IS NOT DISTINCT FROM cp.bd_account_id)
               AND m.direction = 'inbound'
               AND m.organization_id = c.organization_id
           ) l ON true
           WHERE cp.campaign_id = $1 AND cp.status = 'replied'
             AND COALESCE(l.first_reply, cp.updated_at) >= NOW() - ($2::int || ' days')::interval
         ) sub
         GROUP BY day
         ORDER BY day`,
        [id, daysNum],
      ),
      db.read.query(
        `SELECT cs.sent_at::date AS date, cp.bd_account_id AS account_id,
          MAX(COALESCE(NULLIF(TRIM(ba.display_name), ''), NULLIF(TRIM(CONCAT(COALESCE(ba.first_name,''), ' ', COALESCE(ba.last_name,''))), ''), ba.telegram_id::text, cp.bd_account_id::text)) AS account_display_name,
          COUNT(*)::int AS sends
         FROM campaign_sends cs
         JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
         LEFT JOIN bd_accounts ba ON ba.id = cp.bd_account_id
         WHERE cp.campaign_id = $1 AND cs.status = 'sent' AND cs.sent_at >= NOW() - ($2::int || ' days')::interval
         GROUP BY cs.sent_at::date, cp.bd_account_id
         ORDER BY date, cp.bd_account_id`,
        [id, daysNum],
      ),
    ]);

    return {
      sendsByDay: (sendsByDayRes.rows as { day: string; sends: number }[]).map((r) => ({ date: r.day, sends: r.sends })),
      repliedByDay: (repliedByDayRes.rows as { day: string; replied: number }[]).map((r) => ({ date: r.day, replied: r.replied })),
      sendsByAccountByDay: (sendsByAccountByDayRes.rows as { date: string; account_id: string; account_display_name: string; sends: number }[]).map((r) => ({
        date: r.date,
        accountId: r.account_id,
        accountDisplayName: r.account_display_name ?? r.account_id,
        sends: r.sends,
      })),
    };
  });

  app.get('/api/campaigns/:id/sends', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, unknown>;

    const campaign = await db.read.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!campaign.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const { page, limit, offset } = parsePageLimit(query, 50, 100);

    const [countRes, sentCountRes] = await Promise.all([
      db.read.query(
        `SELECT COUNT(*)::int AS c
         FROM campaign_sends cs
         JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
         WHERE cp.campaign_id = $1`,
        [id],
      ),
      db.read.query(
        `SELECT COUNT(*)::int AS c
         FROM campaign_sends cs
         JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
         WHERE cp.campaign_id = $1 AND cs.status = 'sent'`,
        [id],
      ),
    ]);
    const total = Number((countRes.rows[0] as { c?: number })?.c ?? 0);
    const sentTotal = Number((sentCountRes.rows[0] as { c?: number })?.c ?? 0);

    const listRes = await db.read.query(
      `SELECT cs.id AS send_id,
              cs.sent_at,
              cs.sequence_step,
              cs.status AS delivery_status,
              cs.message_id,
              cs.metadata AS send_metadata,
              cp.id AS participant_id,
              cp.contact_id,
              cp.bd_account_id,
              cp.channel_id,
              cp.status AS participant_status,
              COALESCE(NULLIF(TRIM(c.display_name), ''), NULLIF(TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))), ''), c.username, c.telegram_id::text, cp.contact_id::text) AS contact_name,
              COALESCE(m.content, m_last.content) AS message_content,
              COALESCE(m.status, m_last.status) AS message_status,
              COALESCE(m.direction, m_last.direction) AS message_direction
       FROM campaign_sends cs
       JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
       JOIN contacts c ON c.id = cp.contact_id
       LEFT JOIN messages m ON m.id = cs.message_id
       LEFT JOIN LATERAL (
         SELECT ml.content, ml.status, ml.direction FROM messages ml
         WHERE ml.bd_account_id = cp.bd_account_id AND ml.channel_id = cp.channel_id
           AND ml.organization_id = (SELECT organization_id FROM campaigns WHERE id = cp.campaign_id)
         ORDER BY COALESCE(ml.telegram_date, ml.created_at) DESC LIMIT 1
       ) m_last ON cs.message_id IS NULL
       WHERE cp.campaign_id = $1
       ORDER BY cs.sent_at DESC, cs.id ASC
       LIMIT $2 OFFSET $3`,
      [id, limit, offset],
    );

    const items = (listRes.rows as Record<string, unknown>[]).map((r) => {
      const meta = r.send_metadata && typeof r.send_metadata === 'object' ? r.send_metadata as Record<string, unknown> : null;
      const hasUsefulMeta = meta && Object.keys(meta).some((k) => k !== 'event' || meta[k]);
      return {
        sendId: r.send_id,
        sentAt: r.sent_at instanceof Date ? (r.sent_at as Date).toISOString() : r.sent_at,
        sequenceStep: r.sequence_step,
        status: r.delivery_status,
        participantStatus: r.participant_status ?? null,
        messageId: r.message_id,
        metadata: hasUsefulMeta ? meta : null,
        participantId: r.participant_id,
        contactId: r.contact_id,
        contactName: r.contact_name ?? '',
        messageContent: r.message_content != null ? String(r.message_content) : null,
        messageStatus: r.message_status ?? null,
        messageDirection: r.message_direction ?? null,
      };
    });

    return {
      data: items,
      pagination: {
        page,
        limit,
        total,
        sentTotal,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    };
  });

  // stats route is registered in campaigns.ts — not duplicated here
}
