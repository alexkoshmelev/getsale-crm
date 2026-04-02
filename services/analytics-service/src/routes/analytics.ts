import { Router } from 'express';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { asyncHandler, requireUser, validate } from '@getsale/service-core';
import type { z } from 'zod';
import { AnPeriodQuerySchema, AnBdAnalyticsQuerySchema, AnBdTeamWeekQuerySchema, type AnPeriodKey } from '../validation';

interface Deps {
  pool: Pool;
  log: Logger;
}

export type PeriodKey = AnPeriodKey;

/** Compute start and end (ISO strings) for a period. End is now; start is beginning of period. */
export function getPeriodBounds(period: PeriodKey): { startDate: string; endDate: string } {
  const end = new Date();
  const start = new Date(end);
  switch (period) {
    case 'today':
      start.setUTCHours(0, 0, 0, 0);
      break;
    case 'week':
      start.setUTCDate(start.getUTCDate() - 7);
      break;
    case 'month':
      start.setUTCDate(start.getUTCDate() - 30);
      break;
    case 'year':
      start.setUTCDate(start.getUTCDate() - 365);
      break;
    default:
      start.setUTCDate(start.getUTCDate() - 30);
  }
  return {
    startDate: start.toISOString(),
    endDate: end.toISOString(),
  };
}

function weekDaysUtc(weekStart: string): string[] {
  const base = new Date(`${weekStart}T00:00:00.000Z`);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

function sanitizeCsvCell(value: unknown): string {
  if (value == null) return '';
  const str = typeof value === 'string' ? value : String(value);
  if (/^[=+\-@\t\r]/.test(str)) {
    return `'${str}`;
  }
  if (str.includes(',') || str.includes('\n') || str.includes('"')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function analyticsRouter({ pool, log }: Deps): Router {
  const router = Router();

  router.use(requireUser());

  // Summary for cards (Q18: period validated via Zod)
  router.get('/summary', validate(AnPeriodQuerySchema, 'query'), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { period } = req.query as z.infer<typeof AnPeriodQuerySchema>;
    const { startDate, endDate } = getPeriodBounds(period);

    // Match default pipeline stage names: "Closed Won", "Closed Lost" (see auth-service signup, pipeline-service defaults)
    const closedIdsRes = await pool.query(
      `SELECT id FROM stages WHERE organization_id = $1 AND name IN ('Closed Won', 'Closed Lost')`,
      [organizationId]
    );
    const closedIds = (closedIdsRes.rows as { id: string }[]).map((r) => r.id);
    const closedPlaceholders = closedIds.length ? closedIds.map((_, i) => `$${i + 2}`).join(',') : 'NULL';

    const [totalRes, periodRes, createdRes] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(l.revenue_amount), 0) as total_pipeline_value
         FROM leads l
         WHERE l.organization_id = $1`,
        [organizationId]
      ),
      closedIds.length
        ? pool.query(
            `SELECT
               COALESCE(SUM(l.revenue_amount), 0) as revenue_in_period,
               COUNT(DISTINCT l.id)::int as leads_closed_in_period,
               COUNT(DISTINCT l.responsible_id) FILTER (WHERE l.responsible_id IS NOT NULL)::int as participants_count
             FROM leads l
             WHERE l.organization_id = $1 AND l.stage_id IN (${closedPlaceholders})
               AND l.updated_at >= $${closedIds.length + 2} AND l.updated_at <= $${closedIds.length + 3}`,
            [organizationId, ...closedIds, startDate, endDate]
          )
        : Promise.resolve({ rows: [{ revenue_in_period: 0, leads_closed_in_period: 0, participants_count: 0 }] }),
      pool.query(
        `SELECT COUNT(DISTINCT l.id)::int as leads_created_in_period
         FROM leads l
         WHERE l.organization_id = $1 AND l.created_at >= $2 AND l.created_at <= $3`,
        [organizationId, startDate, endDate]
      ),
    ]);

    const totalPipelineValue = parseFloat(totalRes.rows[0]?.total_pipeline_value ?? 0);
    const revenueInPeriod = parseFloat(periodRes.rows[0]?.revenue_in_period ?? 0);
    const leadsClosedInPeriod = Number(periodRes.rows[0]?.leads_closed_in_period ?? 0);
    const participantsCount = Number(periodRes.rows[0]?.participants_count ?? 0);
    const leadsCreatedInPeriod = Number(createdRes.rows[0]?.leads_created_in_period ?? 0);

    res.json({
      total_pipeline_value: totalPipelineValue,
      revenue_in_period: revenueInPeriod,
      leads_closed_in_period: leadsClosedInPeriod,
      participants_count: participantsCount,
      leads_created_in_period: leadsCreatedInPeriod,
      start_date: startDate,
      end_date: endDate,
    });
  }));

  // Conversion rates
  router.get('/conversion-rates', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    let { fromStage, toStage, startDate, endDate } = req.query;
    const period = req.query.period as PeriodKey | undefined;
    if (period) {
      const bounds = getPeriodBounds(period);
      startDate = bounds.startDate;
      endDate = bounds.endDate;
    }

    let query = `
      WITH stage_transitions AS (
        SELECT 
          sh.*,
          fs.name as from_stage,
          ts.name as to_stage,
          LAG(sh.created_at) OVER (PARTITION BY sh.entity_type, sh.entity_id ORDER BY sh.created_at) as prev_created_at
        FROM stage_history sh
        LEFT JOIN stages fs ON sh.from_stage_id = fs.id
        LEFT JOIN stages ts ON sh.to_stage_id = ts.id
        WHERE sh.organization_id = $1 AND sh.entity_type = 'lead'
    `;
    const params: unknown[] = [organizationId];

    if (fromStage && typeof fromStage === 'string') {
      params.push(fromStage);
      query += ` AND fs.name = $${params.length}`;
    }

    if (toStage && typeof toStage === 'string') {
      params.push(toStage);
      query += ` AND ts.name = $${params.length}`;
    }

    if (startDate && typeof startDate === 'string') {
      params.push(startDate);
      query += ` AND sh.created_at >= $${params.length}`;
    }

    if (endDate && typeof endDate === 'string') {
      params.push(endDate);
      query += ` AND sh.created_at <= $${params.length}`;
    }

    query += `
      )
      SELECT 
        from_stage,
        to_stage,
        COUNT(*) as transitions,
        AVG(EXTRACT(EPOCH FROM (created_at - prev_created_at))) / 3600 as avg_hours
      FROM stage_transitions
      WHERE prev_created_at IS NOT NULL
      GROUP BY from_stage, to_stage
    `;

    const result = await pool.query(query, params);
    res.json(result.rows);
  }));

  // Pipeline value (by leads per stage)
  router.get('/pipeline-value', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;

    const result = await pool.query(
      `SELECT 
        s.name as stage_name,
        COUNT(l.id) as lead_count,
        COALESCE(SUM(l.revenue_amount), 0) as total_value,
        COALESCE(AVG(l.revenue_amount), 0) as avg_value
       FROM leads l
       JOIN stages s ON l.stage_id = s.id
       WHERE l.organization_id = $1
       GROUP BY s.id, s.name, s.order_index
       ORDER BY s.order_index`,
      [organizationId]
    );

    res.json(result.rows);
  }));

  // Team performance (leads in closed/won, with display names and avg lead value)
  router.get('/team-performance', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    let { startDate, endDate } = req.query;
    const period = req.query.period as PeriodKey | undefined;
    if (period) {
      const bounds = getPeriodBounds(period);
      startDate = bounds.startDate;
      endDate = bounds.endDate;
    }

    // Match default pipeline stage names: "Closed Won", "Closed Lost"
    const closedIdsRes = await pool.query(
      `SELECT id FROM stages WHERE organization_id = $1 AND name IN ('Closed Won', 'Closed Lost')`,
      [organizationId]
    );
    const closedIds = (closedIdsRes.rows as { id: string }[]).map((r) => r.id);
    const closedPlaceholders = closedIds.length ? closedIds.map((_, i) => `$${i + 2}`).join(',') : 'NULL';

    let query = `
      SELECT 
        u.id as user_id,
        u.email as user_email,
        up.first_name,
        up.last_name,
        COUNT(DISTINCT l.id) as leads_closed,
        COALESCE(SUM(l.revenue_amount), 0) as revenue,
        COALESCE(AVG(l.revenue_amount), 0) as avg_lead_value,
        AVG(EXTRACT(EPOCH FROM (l.updated_at - l.created_at)) / 86400) as avg_days_to_close
      FROM leads l
      JOIN users u ON l.responsible_id = u.id
      LEFT JOIN user_profiles up ON up.user_id = u.id AND up.organization_id = l.organization_id
      WHERE l.organization_id = $1 AND l.stage_id IN (${closedPlaceholders})
    `;
    const params: unknown[] = [organizationId, ...closedIds];

    if (startDate && typeof startDate === 'string') {
      params.push(startDate);
      query += ` AND l.updated_at >= $${params.length}`;
    }

    if (endDate && typeof endDate === 'string') {
      params.push(endDate);
      query += ` AND l.updated_at <= $${params.length}`;
    }

    query += ' GROUP BY u.id, u.email, up.first_name, up.last_name';

    const result = await pool.query(query, params);
    const rows = result.rows.map((row: Record<string, unknown>) => {
      const firstName = (row.first_name as string) ?? '';
      const lastName = (row.last_name as string) ?? '';
      const email = (row.user_email as string) ?? '';
      const displayName = [firstName, lastName].filter(Boolean).join(' ').trim() || email || String(row.user_id);
      return {
        ...row,
        user_display_name: displayName,
      };
    });
    res.json(rows);
  }));

  // ─── BD Analytics ───────────────────────────────────────────────────────
  router.get('/bd/new-chats', validate(AnBdAnalyticsQuerySchema, 'query'), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { period, bd_account_id: bdAccountIdParam, folder_id: folderIdParam } = req.query as unknown as z.infer<typeof AnBdAnalyticsQuerySchema>;
    const { startDate, endDate } = getPeriodBounds(period);

    const params: unknown[] = [organizationId, startDate, endDate];
    let accountFilter = '';
    if (bdAccountIdParam) {
      params.push(bdAccountIdParam);
      accountFilter = `AND m.bd_account_id = $${params.length}`;
    }
    if (folderIdParam !== undefined) {
      params.push(folderIdParam);
      accountFilter += ` AND EXISTS (
        SELECT 1 FROM bd_account_sync_chats s
        WHERE s.bd_account_id = m.bd_account_id AND s.telegram_chat_id::text = m.channel_id
          AND s.folder_id = $${params.length}
      )`;
    }

    /** Cohort matches contact-metrics: distinct (bd, channel) with ≥1 outbound in [start,end]. */
    const newChatsQuery = `
      WITH cohort AS (
        SELECT DISTINCT m.bd_account_id, m.channel_id
        FROM messages m
        WHERE m.organization_id = $1 AND m.channel = 'telegram' AND m.direction = 'outbound'
          AND m.bd_account_id IS NOT NULL
          AND m.bd_account_id IN (SELECT id FROM bd_accounts WHERE organization_id = $1)
          AND COALESCE(m.telegram_date, m.created_at) >= $2
          AND COALESCE(m.telegram_date, m.created_at) <= $3
          ${accountFilter}
      ),
      first_day AS (
        SELECT
          c.bd_account_id,
          c.channel_id,
          (MIN(COALESCE(m.telegram_date, m.created_at)) AT TIME ZONE 'UTC')::date AS first_date
        FROM cohort c
        JOIN messages m ON m.organization_id = $1 AND m.bd_account_id = c.bd_account_id AND m.channel_id = c.channel_id
          AND m.channel = 'telegram' AND m.direction = 'outbound'
          AND COALESCE(m.telegram_date, m.created_at) >= $2
          AND COALESCE(m.telegram_date, m.created_at) <= $3
        GROUP BY c.bd_account_id, c.channel_id
      )
      SELECT bd_account_id, first_date, COUNT(*)::int AS new_chats
      FROM first_day
      GROUP BY bd_account_id, first_date
      ORDER BY bd_account_id, first_date
    `;
    const newChatsRes = await pool.query(newChatsQuery, params);
    const rows = newChatsRes.rows as { bd_account_id: string; first_date: string; new_chats: number }[];

    const byAccount = new Map<string, { new_chats: number; by_day: Map<string, number> }>();
    for (const r of rows) {
      const cur = byAccount.get(r.bd_account_id);
      if (!cur) {
        const byDay = new Map<string, number>([[r.first_date, r.new_chats]]);
        byAccount.set(r.bd_account_id, { new_chats: r.new_chats, by_day: byDay });
      } else {
        cur.new_chats += r.new_chats;
        cur.by_day.set(r.first_date, (cur.by_day.get(r.first_date) ?? 0) + r.new_chats);
      }
    }

    const allAccountsRes = await pool.query(
      `SELECT a.id, COALESCE(NULLIF(TRIM(a.display_name), ''), a.username, a.phone_number, a.telegram_id::text) AS display_name
       FROM bd_accounts a WHERE a.organization_id = $1`,
      [organizationId]
    );
    const allAccounts = allAccountsRes.rows as { id: string; display_name: string }[];
    const displayByName = new Map(allAccounts.map((a) => [a.id, a.display_name || a.id]));

    const accounts = allAccounts.map((a) => {
      const data = byAccount.get(a.id);
      return {
        bd_account_id: a.id,
        account_display_name: displayByName.get(a.id) ?? a.id,
        new_chats: data?.new_chats ?? 0,
        by_day: data
          ? [...data.by_day.entries()]
              .map(([date, new_chats]) => ({ date: typeof date === 'string' ? date : new Date(date).toISOString().slice(0, 10), new_chats }))
              .sort((x, y) => x.date.localeCompare(y.date))
          : [],
      };
    });

    res.json({ accounts, period: { start_date: startDate, end_date: endDate } });
  }));

  router.get('/bd/contact-metrics', validate(AnBdAnalyticsQuerySchema, 'query'), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { period, bd_account_id: bdAccountIdParam } = req.query as unknown as z.infer<typeof AnBdAnalyticsQuerySchema>;
    const { startDate, endDate } = getPeriodBounds(period);

    const params: unknown[] = [organizationId, startDate, endDate];
    let accountFilter = '';
    if (bdAccountIdParam) {
      params.push(bdAccountIdParam);
      accountFilter = `AND cohort.bd_account_id = $${params.length}`;
    }

    const metricsQuery = `
      WITH cohort AS (
        SELECT DISTINCT m.bd_account_id, m.channel_id
        FROM messages m
        WHERE m.organization_id = $1 AND m.channel = 'telegram' AND m.direction = 'outbound'
          AND m.bd_account_id IS NOT NULL
          AND (COALESCE(m.telegram_date, m.created_at) >= $2 AND COALESCE(m.telegram_date, m.created_at) <= $3)
          ${accountFilter}
      ),
      per_chat AS (
        SELECT
          c.bd_account_id,
          c.channel_id,
          (EXISTS (
            SELECT 1 FROM messages m2
            WHERE m2.bd_account_id = c.bd_account_id AND m2.channel_id = c.channel_id
              AND m2.organization_id = $1 AND m2.direction = 'inbound'
          )) AS has_replied,
          (EXISTS (
            SELECT 1 FROM messages m2
            WHERE m2.bd_account_id = c.bd_account_id AND m2.channel_id = c.channel_id
              AND m2.organization_id = $1 AND m2.direction = 'outbound'
              AND LOWER(COALESCE(m2.status, '')) IN ('read', 'delivered')
          )) AS has_read_receipt
        FROM cohort c
      )
      SELECT
        bd_account_id,
        COUNT(*)::int AS total_contacts,
        COUNT(*) FILTER (WHERE NOT has_replied AND NOT has_read_receipt)::int AS not_read,
        COUNT(*) FILTER (WHERE NOT has_replied AND has_read_receipt)::int AS read_no_reply,
        COUNT(*) FILTER (WHERE has_replied)::int AS replied
      FROM per_chat
      GROUP BY bd_account_id
    `;
    const metricsRes = await pool.query(metricsQuery, params);
    const rows = metricsRes.rows as { bd_account_id: string; total_contacts: number; not_read: number; read_no_reply: number; replied: number }[];
    const metricsByAccount = new Map(rows.map((r) => [r.bd_account_id, r]));

    const allAccountsRes = await pool.query(
      `SELECT a.id, COALESCE(NULLIF(TRIM(a.display_name), ''), a.username, a.phone_number, a.telegram_id::text) AS display_name
       FROM bd_accounts a WHERE a.organization_id = $1`,
      [organizationId]
    );
    const allAccounts = allAccountsRes.rows as { id: string; display_name: string }[];
    const displayByName = new Map(allAccounts.map((a) => [a.id, a.display_name || a.id]));

    const accounts = allAccounts.map((a) => {
      const r = metricsByAccount.get(a.id);
      const total = r?.total_contacts ?? 0;
      const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);
      return {
        bd_account_id: a.id,
        account_display_name: displayByName.get(a.id) ?? a.id,
        total_contacts: total,
        not_read: r?.not_read ?? 0,
        read_no_reply: r?.read_no_reply ?? 0,
        replied: r?.replied ?? 0,
        pct_not_read: r ? pct(r.not_read) : 0,
        pct_read_no_reply: r ? pct(r.read_no_reply) : 0,
        pct_replied: r ? pct(r.replied) : 0,
      };
    });

    res.json({ accounts, period: { start_date: startDate, end_date: endDate } });
  }));

  router.get('/bd/team-week', validate(AnBdTeamWeekQuerySchema, 'query'), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { week_start: weekStart } = req.query as z.infer<typeof AnBdTeamWeekQuerySchema>;
    const days = weekDaysUtc(weekStart);

    const params: unknown[] = [organizationId, weekStart];

    const teamWeekQuery = `
      WITH dm AS (
        SELECT DISTINCT s.bd_account_id, s.telegram_chat_id::text AS channel_id
        FROM bd_account_sync_chats s
        INNER JOIN bd_accounts a ON a.id = s.bd_account_id AND a.organization_id = $1
        WHERE s.peer_type = 'user'
      ),
      first_outbound AS (
        SELECT
          m.bd_account_id,
          m.channel_id,
          (MIN(COALESCE(m.telegram_date, m.created_at)) AT TIME ZONE 'UTC')::date AS first_date
        FROM messages m
        INNER JOIN dm ON dm.bd_account_id = m.bd_account_id AND dm.channel_id = m.channel_id
        WHERE m.organization_id = $1
          AND m.channel = 'telegram'
          AND m.direction = 'outbound'
          AND m.bd_account_id IS NOT NULL
          AND m.channel_id IS NOT NULL
          AND m.bd_account_id IN (SELECT id FROM bd_accounts WHERE organization_id = $1)
        GROUP BY m.bd_account_id, m.channel_id
      ),
      week_cohort AS (
        SELECT fo.bd_account_id, fo.channel_id, fo.first_date
        FROM first_outbound fo
        WHERE fo.first_date >= $2::date
          AND fo.first_date < ($2::date + interval '7 days')
      ),
      per_chat AS (
        SELECT
          wc.bd_account_id,
          wc.channel_id,
          wc.first_date,
          (EXISTS (
            SELECT 1 FROM messages m2
            WHERE m2.bd_account_id = wc.bd_account_id AND m2.channel_id = wc.channel_id
              AND m2.organization_id = $1 AND m2.direction = 'inbound'
          )) AS has_replied,
          (EXISTS (
            SELECT 1 FROM messages m2
            WHERE m2.bd_account_id = wc.bd_account_id AND m2.channel_id = wc.channel_id
              AND m2.organization_id = $1 AND m2.direction = 'outbound'
              AND LOWER(COALESCE(m2.status, '')) IN ('read', 'delivered')
          )) AS has_read_receipt
        FROM week_cohort wc
      )
      SELECT
        bd_account_id,
        first_date,
        COUNT(*)::int AS new_chats,
        COUNT(*) FILTER (WHERE NOT has_replied AND NOT has_read_receipt)::int AS not_read,
        COUNT(*) FILTER (WHERE NOT has_replied AND has_read_receipt)::int AS read_no_reply,
        COUNT(*) FILTER (WHERE has_replied)::int AS replied
      FROM per_chat
      GROUP BY bd_account_id, first_date
      ORDER BY bd_account_id, first_date
    `;

    const dataFromQuery = `
      WITH dm AS (
        SELECT DISTINCT s.bd_account_id, s.telegram_chat_id::text AS channel_id
        FROM bd_account_sync_chats s
        INNER JOIN bd_accounts a ON a.id = s.bd_account_id AND a.organization_id = $1
        WHERE s.peer_type = 'user'
      )
      SELECT MIN(COALESCE(m.telegram_date, m.created_at)) AS min_ts
      FROM messages m
      INNER JOIN dm ON dm.bd_account_id = m.bd_account_id AND dm.channel_id = m.channel_id
      WHERE m.organization_id = $1
        AND m.channel = 'telegram'
        AND m.direction = 'outbound'
        AND m.bd_account_id IS NOT NULL
        AND m.channel_id IS NOT NULL
    `;

    const [aggRes, accountsRes, minRes] = await Promise.all([
      pool.query(teamWeekQuery, params),
      pool.query(
        `SELECT a.id, COALESCE(NULLIF(TRIM(a.display_name), ''), a.username, a.phone_number, a.telegram_id::text) AS display_name
         FROM bd_accounts a WHERE a.organization_id = $1 ORDER BY display_name NULLS LAST, a.id`,
        [organizationId]
      ),
      pool.query(dataFromQuery, [organizationId]),
    ]);

    const rawRows = aggRes.rows as {
      bd_account_id: string;
      first_date: Date | string;
      new_chats: number;
      not_read: number;
      read_no_reply: number;
      replied: number;
    }[];

    const normDate = (d: Date | string): string =>
      typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);

    type Cell = {
      new_chats: number;
      not_read: number;
      read_no_reply: number;
      replied: number;
      pct_not_read: number;
      pct_read_no_reply: number;
      pct_replied: number;
    };

    const pct = (n: number, total: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);

    const toCell = (r: { new_chats: number; not_read: number; read_no_reply: number; replied: number }): Cell => ({
      new_chats: r.new_chats,
      not_read: r.not_read,
      read_no_reply: r.read_no_reply,
      replied: r.replied,
      pct_not_read: pct(r.not_read, r.new_chats),
      pct_read_no_reply: pct(r.read_no_reply, r.new_chats),
      pct_replied: pct(r.replied, r.new_chats),
    });

    const cells = new Map<string, Map<string, Cell>>();
    for (const row of rawRows) {
      const dateStr = normDate(row.first_date);
      const bd = row.bd_account_id;
      if (!cells.has(bd)) cells.set(bd, new Map());
      cells.get(bd)!.set(dateStr, toCell(row));
    }

    const emptyCell = (): Cell => ({
      new_chats: 0,
      not_read: 0,
      read_no_reply: 0,
      replied: 0,
      pct_not_read: 0,
      pct_read_no_reply: 0,
      pct_replied: 0,
    });

    const accounts = (accountsRes.rows as { id: string; display_name: string }[]).map((a) => ({
      bd_account_id: a.id,
      account_display_name: a.display_name || a.id,
    }));

    const matrix: { bd_account_id: string; by_date: Record<string, Cell> }[] = accounts.map((a) => {
      const byDate: Record<string, Cell> = {};
      const row = cells.get(a.bd_account_id);
      for (const d of days) {
        byDate[d] = row?.get(d) ?? emptyCell();
      }
      return { bd_account_id: a.bd_account_id, by_date: byDate };
    });

    const dayTotals: Record<string, Cell> = {};
    for (const d of days) {
      let nc = 0;
      let nr = 0;
      let rnr = 0;
      let rep = 0;
      for (const a of accounts) {
        const c = cells.get(a.bd_account_id)?.get(d);
        if (c) {
          nc += c.new_chats;
          nr += c.not_read;
          rnr += c.read_no_reply;
          rep += c.replied;
        }
      }
      dayTotals[d] = toCell({ new_chats: nc, not_read: nr, read_no_reply: rnr, replied: rep });
    }

    const avgPctOverDays = (getter: (c: Cell) => number): number => {
      const sum = days.reduce((s, d) => s + getter(dayTotals[d] ?? emptyCell()), 0);
      return Math.round((sum / 7) * 10) / 10;
    };

    const weekGrand: Cell = {
      new_chats: days.reduce((s, d) => s + (dayTotals[d]?.new_chats ?? 0), 0),
      not_read: 0,
      read_no_reply: 0,
      replied: 0,
      pct_not_read: avgPctOverDays((c) => c.pct_not_read),
      pct_read_no_reply: avgPctOverDays((c) => c.pct_read_no_reply),
      pct_replied: avgPctOverDays((c) => c.pct_replied),
    };

    const bdWeek: { bd_account_id: string; week: Cell }[] = accounts.map((a) => {
      let sumChats = 0;
      let pnr = 0;
      let prnr = 0;
      let pr = 0;
      const row = cells.get(a.bd_account_id);
      for (const d of days) {
        const c = row?.get(d) ?? emptyCell();
        sumChats += c.new_chats;
        pnr += c.pct_not_read;
        prnr += c.pct_read_no_reply;
        pr += c.pct_replied;
      }
      return {
        bd_account_id: a.bd_account_id,
        week: {
          new_chats: sumChats,
          not_read: 0,
          read_no_reply: 0,
          replied: 0,
          pct_not_read: Math.round((pnr / 7) * 10) / 10,
          pct_read_no_reply: Math.round((prnr / 7) * 10) / 10,
          pct_replied: Math.round((pr / 7) * 10) / 10,
        },
      };
    });

    const minTs = minRes.rows[0]?.min_ts as Date | string | null | undefined;
    const dataAvailableFrom =
      minTs == null
        ? null
        : typeof minTs === 'string'
          ? minTs.slice(0, 10)
          : minTs.toISOString().slice(0, 10);

    res.json({
      week_start: weekStart,
      days,
      accounts,
      matrix,
      day_totals: dayTotals,
      bd_week: bdWeek,
      week_grand: weekGrand,
      data_available_from: dataAvailableFrom,
    });
  }));

  // Export data
  router.get('/export', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { format, startDate, endDate } = req.query;

    const start = typeof startDate === 'string' ? startDate : '1970-01-01';
    const end = typeof endDate === 'string' ? endDate : new Date().toISOString();

    const result = await pool.query(
      `SELECT * FROM analytics_metrics 
       WHERE organization_id = $1 
       AND recorded_at >= $2 
       AND recorded_at <= $3
       ORDER BY recorded_at DESC`,
      [organizationId, start, end]
    );

    if (format === 'csv') {
      const headers = ['id', 'organization_id', 'metric_type', 'metric_name', 'value', 'dimensions', 'recorded_at'];
      const csv = [
        headers.join(','),
        ...result.rows.map((row: Record<string, unknown>) =>
          headers.map((h) => sanitizeCsvCell(h === 'dimensions' ? JSON.stringify(row[h]) : row[h])).join(',')
        ),
      ].join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename=analytics-export.csv');
      res.send(csv);
    } else {
      res.json(result.rows);
    }
  }));

  return router;
}
