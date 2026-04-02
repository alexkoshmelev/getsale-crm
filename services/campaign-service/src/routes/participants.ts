import { Router } from 'express';
import { Pool } from 'pg';
import { CampaignParticipantFilter } from '@getsale/types';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, parsePageLimit } from '@getsale/service-core';

interface Deps {
  pool: Pool;
  log: Logger;
}

export function participantsRouter({ pool, log }: Deps): Router {
  const router = Router();

  router.get('/:id/stats', asyncHandler(async (req, res) => {
    const statsStartMs = Date.now();
    const { organizationId } = req.user;
    const { id } = req.params;
    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (campaign.rows.length === 0) {
      throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);
    }
    const totalRes = await pool.query(
      'SELECT COUNT(*)::int AS total FROM campaign_participants WHERE campaign_id = $1',
      [id]
    );
    const byStatusRes = await pool.query(
      `SELECT status, COUNT(*)::int AS cnt FROM campaign_participants WHERE campaign_id = $1 GROUP BY status`,
      [id]
    );
    const totalSendsRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM campaign_sends cs JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id WHERE cp.campaign_id = $1`,
      [id]
    );
    const contactsSentRes = await pool.query(
      `SELECT COUNT(DISTINCT cp.id)::int AS cnt
       FROM campaign_sends cs
       JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
       WHERE cp.campaign_id = $1`,
      [id]
    );
    const dateRangeRes = await pool.query(
      `SELECT MIN(cs.sent_at) AS first_send_at, MAX(cs.sent_at) AS last_send_at
       FROM campaign_sends cs
       JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
       WHERE cp.campaign_id = $1`,
      [id]
    );
    const totalReadRes = await pool.query(
      `SELECT COUNT(DISTINCT cp.id)::int AS cnt
       FROM campaign_participants cp
       INNER JOIN campaign_sends cs ON cs.campaign_participant_id = cp.id
       INNER JOIN messages m ON m.id = cs.message_id AND m.status = 'read'
       WHERE cp.campaign_id = $1`,
      [id]
    );
    const totalSharedRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM conversations WHERE campaign_id = $1 AND shared_chat_created_at IS NOT NULL`,
      [id]
    );
    const avgTimeToSharedRes = await pool.query(
      `SELECT AVG(EXTRACT(EPOCH FROM (c.shared_chat_created_at - fs.first_sent_at)) / 3600.0) AS avg_hours
       FROM conversations c
       JOIN LATERAL (
         SELECT MIN(cs.sent_at) AS first_sent_at
         FROM campaign_sends cs
         JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
         WHERE cp.campaign_id = c.campaign_id AND cp.bd_account_id = c.bd_account_id AND cp.channel_id = c.channel_id
       ) fs ON fs.first_sent_at IS NOT NULL
       WHERE c.campaign_id = $1 AND c.shared_chat_created_at IS NOT NULL`,
      [id]
    );
    const [totalWonRes, totalLostRes, totalRevenueRes, avgTimeToWonRes] = await Promise.all([
      pool.query(`SELECT COUNT(*)::int AS cnt FROM conversations WHERE campaign_id = $1 AND won_at IS NOT NULL`, [id]),
      pool.query(`SELECT COUNT(*)::int AS cnt FROM conversations WHERE campaign_id = $1 AND lost_at IS NOT NULL`, [id]),
      pool.query(`SELECT COALESCE(SUM(revenue_amount), 0)::numeric AS total FROM conversations WHERE campaign_id = $1 AND won_at IS NOT NULL`, [id]),
      pool.query(
        `SELECT AVG(EXTRACT(EPOCH FROM (c.won_at - fs.first_sent_at)) / 3600.0) AS avg_hours
         FROM conversations c
         JOIN LATERAL (
           SELECT MIN(cs.sent_at) AS first_sent_at
           FROM campaign_sends cs
           JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
           WHERE cp.campaign_id = c.campaign_id AND cp.bd_account_id = c.bd_account_id AND cp.channel_id = c.channel_id
         ) fs ON fs.first_sent_at IS NOT NULL
         WHERE c.campaign_id = $1 AND c.won_at IS NOT NULL`,
        [id]
      ),
    ]);
    const total = totalRes.rows[0]?.total ?? 0;
    const byStatus: Record<string, number> = {};
    for (const r of byStatusRes.rows as { status: string; cnt: number }[]) {
      byStatus[r.status] = r.cnt;
    }
    const totalSends = totalSendsRes.rows[0]?.cnt ?? 0;
    const contactsSent = contactsSentRes.rows[0]?.cnt ?? 0;
    const totalSent = contactsSent;
    const totalRead = totalReadRes.rows[0]?.cnt ?? 0;
    const replied = byStatus.replied ?? 0;
    const totalReplied = replied;
    const totalConvertedToSharedChat = totalSharedRes.rows[0]?.cnt ?? 0;
    const conversionRate = total > 0 ? Math.round((replied / total) * 100) : 0;
    const readRate = totalSent > 0 ? Math.round((totalRead / totalSent) * 1000) / 10 : 0;
    const replyRate = totalRead > 0 ? Math.round((totalReplied / totalRead) * 1000) / 10 : 0;
    const sharedConversionRate = totalReplied > 0 ? Math.round((totalConvertedToSharedChat / totalReplied) * 1000) / 10 : 0;
    const avgHoursRaw = avgTimeToSharedRes.rows[0] as { avg_hours: string | null } | undefined;
    const avgTimeToSharedHours = avgHoursRaw?.avg_hours != null ? Math.round(parseFloat(avgHoursRaw.avg_hours) * 10) / 10 : null;
    const totalWon = (totalWonRes.rows[0] as { cnt: number } | undefined)?.cnt ?? 0;
    const totalLost = (totalLostRes.rows[0] as { cnt: number } | undefined)?.cnt ?? 0;
    const totalRevenue = Number((totalRevenueRes.rows[0] as { total: string } | undefined)?.total ?? 0);
    const avgTimeToWonRaw = avgTimeToWonRes.rows[0] as { avg_hours: string | null } | undefined;
    const avgTimeToWonHours = avgTimeToWonRaw?.avg_hours != null ? Math.round(parseFloat(avgTimeToWonRaw.avg_hours) * 10) / 10 : null;
    const winRate = totalReplied > 0 ? Math.round((totalWon / totalReplied) * 1000) / 10 : 0;
    const revenuePerSent = totalSent > 0 ? Math.round((totalRevenue / totalSent) * 100) / 100 : 0;
    const revenuePerReply = totalReplied > 0 ? Math.round((totalRevenue / totalReplied) * 100) / 100 : 0;
    const avgRevenuePerWon = totalWon > 0 ? Math.round((totalRevenue / totalWon) * 100) / 100 : 0;
    const dr = dateRangeRes.rows[0] as { first_send_at: string | null; last_send_at: string | null };
    const failedCount = byStatus.failed ?? 0;
    let errorSummarySample: string | null = null;
    if (failedCount > 0) {
      const sampleRes = await pool.query(
        `SELECT metadata->>'lastError' AS last_error FROM campaign_participants WHERE campaign_id = $1 AND status = 'failed' AND (metadata->>'lastError') IS NOT NULL ORDER BY updated_at DESC LIMIT 1`,
        [id]
      );
      const val = (sampleRes.rows[0] as { last_error: string | null } | undefined)?.last_error;
      if (typeof val === 'string' && val.trim()) errorSummarySample = val;
    }

    const statsDurationMs = Date.now() - statsStartMs;
    if (statsDurationMs > 2000) {
      log.warn({ message: 'GET /campaigns/:id/stats slow', correlation_id: req.correlationId, endpoint: 'GET /campaigns/:id/stats', campaignId: id, durationMs: statsDurationMs, participantsTotal: total, event: 'slow_stats' });
    }
    res.json({
      total,
      byStatus,
      ...(failedCount > 0 && { error_summary: { count: failedCount, sample: errorSummarySample ?? undefined } }),
      totalSends,
      contactsSent,
      conversionRate,
      firstSendAt: dr?.first_send_at ?? null,
      lastSendAt: dr?.last_send_at ?? null,
      total_sent: totalSent,
      total_read: totalRead,
      total_replied: totalReplied,
      total_converted_to_shared_chat: totalConvertedToSharedChat,
      read_rate: readRate,
      reply_rate: replyRate,
      conversion_rate: sharedConversionRate,
      avg_time_to_shared_hours: avgTimeToSharedHours,
      total_won: totalWon,
      total_lost: totalLost,
      total_revenue: totalRevenue,
      win_rate: winRate,
      revenue_per_sent: revenuePerSent,
      revenue_per_reply: revenuePerReply,
      avg_revenue_per_won: avgRevenuePerWon,
      avg_time_to_won_hours: avgTimeToWonHours,
    });
  }));

  router.get('/:id/participant-accounts', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (campaign.rows.length === 0) {
      throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);
    }
    const accounts = await pool.query(
      `SELECT DISTINCT cp.bd_account_id AS id,
         COALESCE(NULLIF(TRIM(ba.display_name), ''), NULLIF(TRIM(CONCAT(COALESCE(ba.first_name,''), ' ', COALESCE(ba.last_name,''))), ''), ba.phone_number, ba.telegram_id::text, cp.bd_account_id::text) AS display_name
       FROM campaign_participants cp
       LEFT JOIN bd_accounts ba ON ba.id = cp.bd_account_id
       WHERE cp.campaign_id = $1 AND cp.bd_account_id IS NOT NULL
       ORDER BY display_name`,
      [id]
    );
    res.json((accounts.rows as { id: string; display_name: string }[]).map((r) => ({ id: r.id, displayName: r.display_name ?? r.id })));
  }));

  router.get('/:id/analytics', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { days = 14 } = req.query;
    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (campaign.rows.length === 0) {
      throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);
    }
    const daysNum = Math.min(90, Math.max(1, parseInt(String(days), 10)));
    const [sendsByDayRes, repliedByDayRes, sendsByAccountByDayRes] = await Promise.all([
      pool.query(
        `SELECT cs.sent_at::date AS day, COUNT(DISTINCT cp.id)::int AS sends
         FROM campaign_sends cs
         JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
         WHERE cp.campaign_id = $1 AND cs.sent_at >= NOW() - ($2::int || ' days')::interval
         GROUP BY cs.sent_at::date
         ORDER BY day`,
        [id, daysNum]
      ),
      pool.query(
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
        [id, daysNum]
      ),
      pool.query(
        `SELECT cs.sent_at::date AS date, cp.bd_account_id AS account_id,
          MAX(COALESCE(NULLIF(TRIM(ba.display_name), ''), NULLIF(TRIM(CONCAT(COALESCE(ba.first_name,''), ' ', COALESCE(ba.last_name,''))), ''), ba.telegram_id::text, cp.bd_account_id::text)) AS account_display_name,
          COUNT(*)::int AS sends
         FROM campaign_sends cs
         JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
         LEFT JOIN bd_accounts ba ON ba.id = cp.bd_account_id
         WHERE cp.campaign_id = $1 AND cs.sent_at >= NOW() - ($2::int || ' days')::interval
         GROUP BY cs.sent_at::date, cp.bd_account_id
         ORDER BY date, cp.bd_account_id`,
        [id, daysNum]
      ),
    ]);
    res.json({
      sendsByDay: (sendsByDayRes.rows as { day: string; sends: number }[]).map((r) => ({ date: r.day, sends: r.sends })),
      repliedByDay: (repliedByDayRes.rows as { day: string; replied: number }[]).map((r) => ({ date: r.day, replied: r.replied })),
      sendsByAccountByDay: (sendsByAccountByDayRes.rows as { date: string; account_id: string; account_display_name: string; sends: number }[]).map((r) => ({
        date: r.date,
        accountId: r.account_id,
        accountDisplayName: r.account_display_name ?? r.account_id,
        sends: r.sends,
      })),
    });
  }));

  router.get('/:id/participants', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { page: pageQ, limit: limitQ, status, filter, bdAccountId, sentFrom, sentTo } = req.query;
    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (campaign.rows.length === 0) {
      throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);
    }
    const { page: pageNum, limit: limitNum, offset } = parsePageLimit(
      { page: pageQ, limit: limitQ } as Record<string, unknown>,
      50,
      100
    );
    let whereStatus = '';
    let whereFilter = '';
    const params: any[] = [id];
    let paramIdx = 2;
    const statusParam = status && typeof status === 'string' ? status : (filter && typeof filter === 'string' ? filter : null);
    if (statusParam === CampaignParticipantFilter.REPLIED) {
      whereStatus = ` AND cp.status = $${paramIdx}`;
      params.push(CampaignParticipantFilter.REPLIED);
      paramIdx++;
    } else if (statusParam === CampaignParticipantFilter.NOT_REPLIED) {
      whereStatus = " AND (cp.status IS NULL OR cp.status != 'replied')";
    } else if (statusParam === CampaignParticipantFilter.SHARED) {
      whereFilter = ' AND conv.shared_chat_created_at IS NOT NULL';
    }
    if (bdAccountId && typeof bdAccountId === 'string') {
      whereFilter += ` AND cp.bd_account_id = $${paramIdx}`;
      params.push(bdAccountId);
      paramIdx++;
    }
    if (sentFrom && typeof sentFrom === 'string') {
      whereFilter += ` AND fs.first_sent_at IS NOT NULL AND fs.first_sent_at::date >= $${paramIdx}::date`;
      params.push(sentFrom);
      paramIdx++;
    }
    if (sentTo && typeof sentTo === 'string') {
      whereFilter += ` AND fs.first_sent_at IS NOT NULL AND fs.first_sent_at::date <= $${paramIdx}::date`;
      params.push(sentTo);
      paramIdx++;
    }
    const limitIdx = paramIdx;
    const offsetIdx = paramIdx + 1;
    params.push(limitNum, offset);
    const result = await pool.query(
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
         FROM campaign_sends cs WHERE cs.campaign_participant_id = cp.id ORDER BY cs.sent_at LIMIT 1
       ) fs ON true
       LEFT JOIN messages m_first ON m_first.id = fs.first_message_id
       LEFT JOIN conversations conv ON conv.campaign_id = cp.campaign_id AND conv.bd_account_id = cp.bd_account_id AND conv.channel = 'telegram' AND conv.channel_id = cp.channel_id
       LEFT JOIN leads l ON l.id = conv.lead_id
       LEFT JOIN stages st ON st.id = l.stage_id
       WHERE cp.campaign_id = $1 ${whereStatus} ${whereFilter}
       ORDER BY fs.first_sent_at DESC NULLS LAST, cp.enqueue_order ASC NULLS LAST, cp.created_at ASC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );
    const rows = (result.rows as any[]).map((r) => {
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
          const meta = typeof r.participant_metadata === 'string' ? JSON.parse(r.participant_metadata) : r.participant_metadata;
          if (meta && typeof meta.lastError === 'string') last_error = meta.lastError;
        } catch {
          // ignore
        }
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
        sent_at: r.sent_at instanceof Date ? r.sent_at.toISOString() : r.sent_at,
        replied_at: r.replied_at instanceof Date ? r.replied_at.toISOString() : r.replied_at,
        shared_chat_created_at: r.shared_chat_created_at instanceof Date ? r.shared_chat_created_at.toISOString() : r.shared_chat_created_at,
        current_step: r.current_step ?? 0,
        next_send_at:
          st === 'failed'
            ? null
            : r.next_send_at instanceof Date
              ? r.next_send_at.toISOString()
              : r.next_send_at,
        sequence_total_steps: r.sequence_total_steps ?? 0,
      };
    });
    res.json(rows);
  }));

  router.get('/:id/sends', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { page: pageQ, limit: limitQ } = req.query;
    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (campaign.rows.length === 0) {
      throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);
    }
    const { page: pageNum, limit: limitNum, offset } = parsePageLimit(
      { page: pageQ, limit: limitQ } as Record<string, unknown>,
      50,
      100
    );
    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS c
       FROM campaign_sends cs
       JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
       WHERE cp.campaign_id = $1`,
      [id]
    );
    const total = Number((countRes.rows[0] as { c?: number })?.c ?? 0);
    const listRes = await pool.query(
      `SELECT cs.id AS send_id,
              cs.sent_at,
              cs.sequence_step,
              cs.status AS delivery_status,
              cs.message_id,
              cs.metadata AS send_metadata,
              cp.id AS participant_id,
              cp.contact_id,
              COALESCE(NULLIF(TRIM(c.display_name), ''), NULLIF(TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))), ''), c.username, c.telegram_id::text, cp.contact_id::text) AS contact_name,
              m.content AS message_content,
              m.status AS message_status
       FROM campaign_sends cs
       JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
       JOIN contacts c ON c.id = cp.contact_id
       LEFT JOIN messages m ON m.id = cs.message_id
       WHERE cp.campaign_id = $1
       ORDER BY cs.sent_at ASC, cs.id ASC
       LIMIT $2 OFFSET $3`,
      [id, limitNum, offset]
    );
    const items = (listRes.rows as Record<string, unknown>[]).map((r) => ({
      sendId: r.send_id,
      sentAt: r.sent_at instanceof Date ? r.sent_at.toISOString() : r.sent_at,
      sequenceStep: r.sequence_step,
      status: r.delivery_status,
      messageId: r.message_id,
      metadata: r.send_metadata && typeof r.send_metadata === 'object' ? r.send_metadata : null,
      participantId: r.participant_id,
      contactId: r.contact_id,
      contactName: r.contact_name ?? '',
      messageContent: r.message_content != null ? String(r.message_content) : null,
      messageStatus: r.message_status ?? null,
    }));
    res.json({
      data: items,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.max(1, Math.ceil(total / limitNum)),
      },
    });
  }));

  return router;
}
