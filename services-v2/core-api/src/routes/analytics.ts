import { FastifyInstance } from 'fastify';
import { AppError, ErrorCodes, requireUser } from '@getsale/service-framework';
import type { CoreDeps } from '../types';

type PeriodKey = 'today' | 'week' | 'month' | 'year';

function getPeriodBounds(period: PeriodKey): { startDate: string; endDate: string } {
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
  return { startDate: start.toISOString(), endDate: end.toISOString() };
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

function weekDaysUtc(weekStart: string): string[] {
  const base = new Date(`${weekStart}T00:00:00.000Z`);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(base);
    d.setUTCDate(base.getUTCDate() + i);
    return d.toISOString().slice(0, 10);
  });
}

export function registerAnalyticsRoutes(app: FastifyInstance, deps: CoreDeps): void {
  const { db } = deps;

  app.get('/api/analytics/summary', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const orgId = user.organizationId;
    const { period = 'month' } = request.query as { period?: PeriodKey };
    const { startDate, endDate } = getPeriodBounds(period);

    const closedIdsRes = await db.read.query(
      `SELECT id FROM stages WHERE organization_id = $1 AND name IN ('Closed Won', 'Closed Lost')`,
      [orgId],
    );
    const closedIds = (closedIdsRes.rows as { id: string }[]).map((r) => r.id);
    const closedPlaceholders = closedIds.length ? closedIds.map((_, i) => `$${i + 2}`).join(',') : 'NULL';

    const [totalRes, periodRes, createdRes] = await Promise.all([
      db.read.query(
        'SELECT COALESCE(SUM(l.revenue_amount), 0) as total_pipeline_value FROM leads l WHERE l.organization_id = $1',
        [orgId],
      ),
      closedIds.length
        ? db.read.query(
            `SELECT
               COALESCE(SUM(l.revenue_amount), 0) as revenue_in_period,
               COUNT(DISTINCT l.id)::int as leads_closed_in_period,
               COUNT(DISTINCT l.responsible_id) FILTER (WHERE l.responsible_id IS NOT NULL)::int as participants_count
             FROM leads l
             WHERE l.organization_id = $1 AND l.stage_id IN (${closedPlaceholders})
               AND l.updated_at >= $${closedIds.length + 2} AND l.updated_at <= $${closedIds.length + 3}`,
            [orgId, ...closedIds, startDate, endDate],
          )
        : Promise.resolve({ rows: [{ revenue_in_period: 0, leads_closed_in_period: 0, participants_count: 0 }] }),
      db.read.query(
        'SELECT COUNT(DISTINCT l.id)::int as leads_created_in_period FROM leads l WHERE l.organization_id = $1 AND l.created_at >= $2 AND l.created_at <= $3',
        [orgId, startDate, endDate],
      ),
    ]);

    return {
      total_pipeline_value: parseFloat(totalRes.rows[0]?.total_pipeline_value ?? 0),
      revenue_in_period: parseFloat(periodRes.rows[0]?.revenue_in_period ?? 0),
      leads_closed_in_period: Number(periodRes.rows[0]?.leads_closed_in_period ?? 0),
      participants_count: Number(periodRes.rows[0]?.participants_count ?? 0),
      leads_created_in_period: Number(createdRes.rows[0]?.leads_created_in_period ?? 0),
      start_date: startDate,
      end_date: endDate,
    };
  });

  app.get('/api/analytics/team-performance', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const orgId = user.organizationId;
    const { period = 'month' } = request.query as { period?: PeriodKey };
    const { startDate, endDate } = getPeriodBounds(period);

    const closedIdsRes = await db.read.query(
      `SELECT id FROM stages WHERE organization_id = $1 AND name IN ('Closed Won', 'Closed Lost')`,
      [orgId],
    );
    const closedIds = (closedIdsRes.rows as { id: string }[]).map((r) => r.id);
    if (!closedIds.length) return [];

    const closedPlaceholders = closedIds.map((_, i) => `$${i + 2}`).join(',');
    const params: unknown[] = [orgId, ...closedIds, startDate, endDate];

    const result = await db.read.query(
      `SELECT
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
         AND l.updated_at >= $${closedIds.length + 2} AND l.updated_at <= $${closedIds.length + 3}
       GROUP BY u.id, u.email, up.first_name, up.last_name`,
      params,
    );

    return result.rows.map((row: Record<string, unknown>) => {
      const firstName = (row.first_name as string) ?? '';
      const lastName = (row.last_name as string) ?? '';
      const email = (row.user_email as string) ?? '';
      const displayName = [firstName, lastName].filter(Boolean).join(' ').trim() || email || String(row.user_id);
      return { ...row, user_display_name: displayName };
    });
  });

  app.get('/api/crm/analytics/conversion', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const orgId = user.organizationId;
    const result = await db.read.query(
      `SELECT * FROM mv_conversion_funnel WHERE organization_id = $1 ORDER BY pipeline_id, stage_order`,
      [orgId],
    );
    return result.rows;
  });

  app.get('/api/analytics/messages/daily', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const orgId = user.organizationId;
    const { days = 30 } = request.query as { days?: number };
    const result = await db.read.query(
      `SELECT * FROM mv_daily_message_counts WHERE organization_id = $1 AND day >= CURRENT_DATE - $2::int ORDER BY day DESC`,
      [orgId, Math.min(days, 365)],
    );
    return result.rows;
  });

  app.get('/api/analytics/campaigns', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const orgId = user.organizationId;
    const result = await db.read.query(
      'SELECT * FROM mv_campaign_stats WHERE organization_id = $1',
      [orgId],
    );
    return result.rows;
  });

  app.get('/api/analytics/pipeline-value', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const result = await db.read.query(
      `SELECT
        s.name as stage_name,
        COUNT(l.id)::int as lead_count,
        COALESCE(SUM(l.revenue_amount), 0) as total_value,
        COALESCE(AVG(l.revenue_amount), 0) as avg_value
       FROM leads l
       JOIN stages s ON l.stage_id = s.id
       WHERE l.organization_id = $1
       GROUP BY s.id, s.name, s.order_index
       ORDER BY s.order_index`,
      [user.organizationId],
    );
    return result.rows;
  });

  app.get('/api/analytics/bd/new-chats', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { period = 'month', bd_account_id, folder_id } = request.query as {
      period?: PeriodKey;
      bd_account_id?: string;
      folder_id?: string;
    };
    const { startDate, endDate } = getPeriodBounds(period as PeriodKey);

    const params: unknown[] = [user.organizationId, startDate, endDate];
    let accountFilter = '';
    if (bd_account_id) {
      params.push(bd_account_id);
      accountFilter = `AND m.bd_account_id = $${params.length}`;
    }
    if (folder_id !== undefined) {
      params.push(parseInt(String(folder_id), 10));
      accountFilter += ` AND EXISTS (
        SELECT 1 FROM bd_account_sync_chats s
        WHERE s.bd_account_id = m.bd_account_id AND s.telegram_chat_id::text = m.channel_id
          AND s.folder_id = $${params.length}
      )`;
    }

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
    const newChatsRes = await db.read.query(newChatsQuery, params);
    const rows = newChatsRes.rows as { bd_account_id: string; first_date: string; new_chats: number }[];

    const byAccount = new Map<string, { new_chats: number; by_day: Map<string, number> }>();
    for (const r of rows) {
      const cur = byAccount.get(r.bd_account_id);
      if (!cur) {
        byAccount.set(r.bd_account_id, { new_chats: r.new_chats, by_day: new Map([[r.first_date, r.new_chats]]) });
      } else {
        cur.new_chats += r.new_chats;
        cur.by_day.set(r.first_date, (cur.by_day.get(r.first_date) ?? 0) + r.new_chats);
      }
    }

    const allAccountsRes = await db.read.query(
      `SELECT a.id, COALESCE(NULLIF(TRIM(a.display_name), ''), a.username, a.phone_number, a.telegram_id::text) AS display_name
       FROM bd_accounts a WHERE a.organization_id = $1`,
      [user.organizationId],
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

    return { accounts, period: { start_date: startDate, end_date: endDate } };
  });

  app.get('/api/analytics/bd/contact-metrics', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { period = 'month', bd_account_id } = request.query as {
      period?: PeriodKey;
      bd_account_id?: string;
    };
    const { startDate, endDate } = getPeriodBounds(period as PeriodKey);

    const params: unknown[] = [user.organizationId, startDate, endDate];
    let accountFilter = '';
    if (bd_account_id) {
      params.push(bd_account_id);
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
    const metricsRes = await db.read.query(metricsQuery, params);
    const metricsRows = metricsRes.rows as { bd_account_id: string; total_contacts: number; not_read: number; read_no_reply: number; replied: number }[];
    const metricsByAccount = new Map(metricsRows.map((r) => [r.bd_account_id, r]));

    const allAccountsRes = await db.read.query(
      `SELECT a.id, COALESCE(NULLIF(TRIM(a.display_name), ''), a.username, a.phone_number, a.telegram_id::text) AS display_name
       FROM bd_accounts a WHERE a.organization_id = $1`,
      [user.organizationId],
    );
    const allAccounts = allAccountsRes.rows as { id: string; display_name: string }[];

    const accounts = allAccounts.map((a) => {
      const r = metricsByAccount.get(a.id);
      const total = r?.total_contacts ?? 0;
      const pct = (n: number) => (total > 0 ? Math.round((n / total) * 1000) / 10 : 0);
      return {
        bd_account_id: a.id,
        account_display_name: a.display_name || a.id,
        total_contacts: total,
        not_read: r?.not_read ?? 0,
        read_no_reply: r?.read_no_reply ?? 0,
        replied: r?.replied ?? 0,
        pct_not_read: r ? pct(r.not_read) : 0,
        pct_read_no_reply: r ? pct(r.read_no_reply) : 0,
        pct_replied: r ? pct(r.replied) : 0,
      };
    });

    return { accounts, period: { start_date: startDate, end_date: endDate } };
  });

  app.get('/api/analytics/bd/team-week', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { week_start } = request.query as { week_start?: string };

    if (!week_start || !/^\d{4}-\d{2}-\d{2}$/.test(week_start)) {
      return { error: 'week_start required (YYYY-MM-DD, must be a Monday)' };
    }

    const days = weekDaysUtc(week_start);
    const params: unknown[] = [user.organizationId, week_start];

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

    const [aggRes, accountsRes] = await Promise.all([
      db.read.query(teamWeekQuery, params),
      db.read.query(
        `SELECT a.id, COALESCE(NULLIF(TRIM(a.display_name), ''), a.username, a.phone_number, a.telegram_id::text) AS display_name
         FROM bd_accounts a WHERE a.organization_id = $1 ORDER BY display_name NULLS LAST, a.id`,
        [user.organizationId],
      ),
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
      new_chats: 0, not_read: 0, read_no_reply: 0, replied: 0,
      pct_not_read: 0, pct_read_no_reply: 0, pct_replied: 0,
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
      let nc = 0, nr = 0, rnr = 0, rep = 0;
      for (const a of accounts) {
        const c = cells.get(a.bd_account_id)?.get(d);
        if (c) { nc += c.new_chats; nr += c.not_read; rnr += c.read_no_reply; rep += c.replied; }
      }
      dayTotals[d] = toCell({ new_chats: nc, not_read: nr, read_no_reply: rnr, replied: rep });
    }

    const bdWeek = accounts.map((a) => {
      let nc = 0, nr = 0, rnr = 0, rep = 0;
      const row = cells.get(a.bd_account_id);
      if (row) for (const c of row.values()) {
        nc += c.new_chats; nr += c.not_read; rnr += c.read_no_reply; rep += c.replied;
      }
      return { bd_account_id: a.bd_account_id, week: toCell({ new_chats: nc, not_read: nr, read_no_reply: rnr, replied: rep }) };
    });

    let gnc = 0, gnr = 0, grnr = 0, grep = 0;
    for (const dt of Object.values(dayTotals)) { gnc += dt.new_chats; gnr += dt.not_read; grnr += dt.read_no_reply; grep += dt.replied; }
    const weekGrand = toCell({ new_chats: gnc, not_read: gnr, read_no_reply: grnr, replied: grep });

    const dafRes = await db.read.query(
      `SELECT MIN(COALESCE(telegram_date, created_at))::text AS earliest FROM messages WHERE organization_id = $1 AND channel = 'telegram'`,
      [user.organizationId],
    );
    const dataAvailableFrom: string | null = dafRes.rows[0]?.earliest?.slice(0, 10) ?? null;

    return {
      week_start,
      days,
      accounts,
      matrix,
      day_totals: dayTotals,
      bd_week: bdWeek,
      week_grand: weekGrand,
      data_available_from: dataAvailableFrom,
    };
  });

  app.get('/api/analytics/conversion-rates', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const orgId = user.organizationId;
    const { fromStage, toStage, startDate, endDate, period } = request.query as {
      fromStage?: string;
      toStage?: string;
      startDate?: string;
      endDate?: string;
      period?: PeriodKey;
    };

    let effectiveStart = startDate;
    let effectiveEnd = endDate;
    if (period) {
      const bounds = getPeriodBounds(period);
      effectiveStart = bounds.startDate;
      effectiveEnd = bounds.endDate;
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
    const params: unknown[] = [orgId];

    if (fromStage && typeof fromStage === 'string') {
      params.push(fromStage);
      query += ` AND fs.name = $${params.length}`;
    }

    if (toStage && typeof toStage === 'string') {
      params.push(toStage);
      query += ` AND ts.name = $${params.length}`;
    }

    if (effectiveStart && typeof effectiveStart === 'string') {
      params.push(effectiveStart);
      query += ` AND sh.created_at >= $${params.length}`;
    }

    if (effectiveEnd && typeof effectiveEnd === 'string') {
      params.push(effectiveEnd);
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

    const result = await db.read.query(query, params);
    return result.rows;
  });

  app.get('/api/analytics/export', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const orgId = user.organizationId;
    const { format, startDate, endDate } = request.query as {
      format?: 'csv' | 'json';
      startDate?: string;
      endDate?: string;
    };

    const start = typeof startDate === 'string' ? startDate : '1970-01-01';
    const end = typeof endDate === 'string' ? endDate : new Date().toISOString();

    const result = await db.read.query(
      `SELECT * FROM analytics_metrics
       WHERE organization_id = $1
       AND recorded_at >= $2
       AND recorded_at <= $3
       ORDER BY recorded_at DESC`,
      [orgId, start, end],
    );

    if (format === 'csv') {
      const headers = ['id', 'organization_id', 'metric_type', 'metric_name', 'value', 'dimensions', 'recorded_at'];
      const csv = [
        headers.join(','),
        ...result.rows.map((row: Record<string, unknown>) =>
          headers.map((h) => sanitizeCsvCell(h === 'dimensions' ? JSON.stringify(row[h]) : row[h])).join(','),
        ),
      ].join('\n');

      reply.header('Content-Type', 'text/csv');
      reply.header('Content-Disposition', 'attachment; filename=analytics-export.csv');
      return reply.send(csv);
    }

    return result.rows;
  });

  // ─── Frontend-compatible CRM analytics aliases ──────────────────────────

  // GET /api/crm/analytics/dashboard — KPIs: total leads, conversion rate, revenue, active campaigns
  app.get('/api/crm/analytics/dashboard', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const orgId = user.organizationId;
    const { period = 'month' } = request.query as { period?: PeriodKey };
    const { startDate, endDate } = getPeriodBounds(period);

    const closedIdsRes = await db.read.query(
      `SELECT id FROM stages WHERE organization_id = $1 AND name IN ('Closed Won', 'Closed Lost')`,
      [orgId],
    );
    const closedIds = (closedIdsRes.rows as { id: string }[]).map((r) => r.id);
    const wonIdsRes = await db.read.query(
      `SELECT id FROM stages WHERE organization_id = $1 AND name = 'Closed Won'`,
      [orgId],
    );
    const wonIds = (wonIdsRes.rows as { id: string }[]).map((r) => r.id);

    const closedPlaceholders = closedIds.length ? closedIds.map((_, i) => `$${i + 2}`).join(',') : 'NULL';
    const wonPlaceholders = wonIds.length ? wonIds.map((_, i) => `$${i + 2}`).join(',') : 'NULL';

    const [
      totalLeadsRes,
      totalRevenueRes,
      periodClosedRes,
      periodCreatedRes,
      activeCampaignsRes,
      totalContactsRes,
    ] = await Promise.all([
      db.read.query('SELECT COUNT(*)::int AS total_leads FROM leads WHERE organization_id = $1', [orgId]),
      db.read.query('SELECT COALESCE(SUM(revenue_amount), 0) AS total_revenue FROM leads WHERE organization_id = $1', [orgId]),
      closedIds.length
        ? db.read.query(
            `SELECT
               COUNT(DISTINCT l.id)::int AS closed_count,
               COALESCE(SUM(l.revenue_amount), 0) AS closed_revenue
             FROM leads l
             WHERE l.organization_id = $1 AND l.stage_id IN (${closedPlaceholders})
               AND l.updated_at >= $${closedIds.length + 2} AND l.updated_at <= $${closedIds.length + 3}`,
            [orgId, ...closedIds, startDate, endDate],
          )
        : Promise.resolve({ rows: [{ closed_count: 0, closed_revenue: 0 }] }),
      db.read.query(
        'SELECT COUNT(*)::int AS created_count FROM leads WHERE organization_id = $1 AND created_at >= $2 AND created_at <= $3',
        [orgId, startDate, endDate],
      ),
      db.read.query(
        `SELECT COUNT(*)::int AS active_campaigns FROM campaigns WHERE organization_id = $1 AND status IN ('active', 'running')`,
        [orgId],
      ),
      db.read.query('SELECT COUNT(*)::int AS total_contacts FROM contacts WHERE organization_id = $1', [orgId]),
    ]);

    const totalLeads = totalLeadsRes.rows[0]?.total_leads ?? 0;
    const createdInPeriod = periodCreatedRes.rows[0]?.created_count ?? 0;

    let conversionRate = 0;
    if (wonIds.length && totalLeads > 0) {
      const wonRes = await db.read.query(
        `SELECT COUNT(*)::int AS won FROM leads WHERE organization_id = $1 AND stage_id IN (${wonPlaceholders})`,
        [orgId, ...wonIds],
      );
      conversionRate = totalLeads > 0 ? Math.round(((wonRes.rows[0]?.won ?? 0) / totalLeads) * 10000) / 10000 : 0;
    }

    return {
      total_leads: totalLeads,
      total_contacts: totalContactsRes.rows[0]?.total_contacts ?? 0,
      total_revenue: parseFloat(totalRevenueRes.rows[0]?.total_revenue ?? 0),
      conversion_rate: conversionRate,
      active_campaigns: activeCampaignsRes.rows[0]?.active_campaigns ?? 0,
      leads_created_in_period: createdInPeriod,
      leads_closed_in_period: Number(periodClosedRes.rows[0]?.closed_count ?? 0),
      revenue_in_period: parseFloat(periodClosedRes.rows[0]?.closed_revenue ?? 0),
      start_date: startDate,
      end_date: endDate,
    };
  });

  // GET /api/crm/analytics/pipeline/:pipelineId — leads per stage with conversion rates
  app.get('/api/crm/analytics/pipeline/:pipelineId', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const orgId = user.organizationId;
    const { pipelineId } = request.params as { pipelineId: string };

    const pipelineCheck = await db.read.query(
      'SELECT id, name FROM pipelines WHERE id = $1 AND organization_id = $2',
      [pipelineId, orgId],
    );
    if (!pipelineCheck.rows.length) {
      throw new AppError(404, 'Pipeline not found', ErrorCodes.NOT_FOUND);
    }

    const stagesRes = await db.read.query(
      `SELECT
         s.id AS stage_id,
         s.name AS stage_name,
         s.order_index,
         COUNT(l.id)::int AS lead_count,
         COALESCE(SUM(l.revenue_amount), 0) AS total_value,
         COALESCE(AVG(l.revenue_amount), 0) AS avg_value
       FROM stages s
       LEFT JOIN leads l ON l.stage_id = s.id AND l.organization_id = $1
       WHERE s.pipeline_id = $2 AND s.organization_id = $1
       GROUP BY s.id, s.name, s.order_index
       ORDER BY s.order_index`,
      [orgId, pipelineId],
    );

    const stages = stagesRes.rows as { stage_id: string; stage_name: string; order_index: number; lead_count: number; total_value: string; avg_value: string }[];
    const totalLeads = stages.reduce((sum, s) => sum + s.lead_count, 0);

    const stagesWithConversion = stages.map((s, i) => ({
      ...s,
      total_value: parseFloat(String(s.total_value)),
      avg_value: parseFloat(String(s.avg_value)),
      conversion_from_first: totalLeads > 0 ? Math.round((s.lead_count / totalLeads) * 10000) / 10000 : 0,
      conversion_from_prev: i === 0
        ? 1
        : stages[i - 1].lead_count > 0
          ? Math.round((s.lead_count / stages[i - 1].lead_count) * 10000) / 10000
          : 0,
    }));

    return {
      pipeline: pipelineCheck.rows[0],
      stages: stagesWithConversion,
      total_leads: totalLeads,
      total_value: stagesWithConversion.reduce((sum, s) => sum + s.total_value, 0),
    };
  });

  // GET /api/crm/analytics/campaigns — aggregated campaign metrics
  app.get('/api/crm/analytics/campaigns', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const orgId = user.organizationId;

    const result = await db.read.query(
      `SELECT
         c.id AS campaign_id,
         c.name AS campaign_name,
         c.status,
         c.created_at,
         COUNT(DISTINCT m.id) FILTER (WHERE m.direction = 'outbound')::int AS sent,
         COUNT(DISTINCT m.id) FILTER (WHERE m.direction = 'inbound')::int AS replies,
         COUNT(DISTINCT m.channel_id) FILTER (WHERE m.direction = 'outbound')::int AS contacts_reached,
         COUNT(DISTINCT l.id)::int AS leads_created
       FROM campaigns c
       LEFT JOIN messages m ON m.campaign_id = c.id AND m.organization_id = $1
       LEFT JOIN leads l ON l.campaign_id = c.id AND l.organization_id = $1
       WHERE c.organization_id = $1
       GROUP BY c.id, c.name, c.status, c.created_at
       ORDER BY c.created_at DESC`,
      [orgId],
    );

    return result.rows.map((r: Record<string, unknown>) => ({
      ...r,
      reply_rate: Number(r.sent) > 0
        ? Math.round((Number(r.replies) / Number(r.sent)) * 10000) / 10000
        : 0,
    }));
  });

  // GET /api/crm/analytics/team — per-member performance stats
  app.get('/api/crm/analytics/team', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const orgId = user.organizationId;
    const { period = 'month' } = request.query as { period?: PeriodKey };
    const { startDate, endDate } = getPeriodBounds(period);

    const closedIdsRes = await db.read.query(
      `SELECT id FROM stages WHERE organization_id = $1 AND name IN ('Closed Won', 'Closed Lost')`,
      [orgId],
    );
    const closedIds = (closedIdsRes.rows as { id: string }[]).map((r) => r.id);
    if (!closedIds.length) return [];

    const closedPlaceholders = closedIds.map((_, i) => `$${i + 2}`).join(',');
    const params: unknown[] = [orgId, ...closedIds, startDate, endDate];

    const result = await db.read.query(
      `SELECT
        u.id AS user_id,
        u.email AS user_email,
        up.first_name,
        up.last_name,
        COUNT(DISTINCT l.id)::int AS leads_closed,
        COALESCE(SUM(l.revenue_amount), 0) AS revenue,
        COALESCE(AVG(l.revenue_amount), 0) AS avg_lead_value,
        AVG(EXTRACT(EPOCH FROM (l.updated_at - l.created_at)) / 86400) AS avg_days_to_close
       FROM leads l
       JOIN users u ON l.responsible_id = u.id
       LEFT JOIN user_profiles up ON up.user_id = u.id AND up.organization_id = l.organization_id
       WHERE l.organization_id = $1 AND l.stage_id IN (${closedPlaceholders})
         AND l.updated_at >= $${closedIds.length + 2} AND l.updated_at <= $${closedIds.length + 3}
       GROUP BY u.id, u.email, up.first_name, up.last_name`,
      params,
    );

    return result.rows.map((row: Record<string, unknown>) => {
      const firstName = (row.first_name as string) ?? '';
      const lastName = (row.last_name as string) ?? '';
      const email = (row.user_email as string) ?? '';
      const displayName = [firstName, lastName].filter(Boolean).join(' ').trim() || email || String(row.user_id);
      return { ...row, user_display_name: displayName };
    });
  });
}
