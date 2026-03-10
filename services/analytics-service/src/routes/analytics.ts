import { Router } from 'express';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { asyncHandler, requireUser } from '@getsale/service-core';

interface Deps {
  pool: Pool;
  log: Logger;
}

export type PeriodKey = 'today' | 'week' | 'month' | 'year';

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

export function analyticsRouter({ pool, log }: Deps): Router {
  const router = Router();

  router.use(requireUser());

  // Summary for cards (total pipeline value, revenue in period, deals closed in period, participants count)
  router.get('/summary', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const period = (req.query.period as PeriodKey) || 'month';
    const { startDate, endDate } = getPeriodBounds(period);

    const closedStageSubquery = `SELECT id FROM stages WHERE name = 'closed' OR name = 'won'`;

    const [totalRes, periodRes] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(d.value), 0) as total_pipeline_value
         FROM deals d
         WHERE d.organization_id = $1`,
        [organizationId]
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(d.value), 0) as revenue_in_period,
           COUNT(DISTINCT d.id)::int as deals_closed_in_period,
           COUNT(DISTINCT d.owner_id)::int as participants_count
         FROM deals d
         WHERE d.organization_id = $1 AND d.stage_id IN (${closedStageSubquery})
           AND d.updated_at >= $2 AND d.updated_at <= $3`,
        [organizationId, startDate, endDate]
      ),
    ]);

    const totalPipelineValue = parseFloat(totalRes.rows[0]?.total_pipeline_value ?? 0);
    const revenueInPeriod = parseFloat(periodRes.rows[0]?.revenue_in_period ?? 0);
    const dealsClosedInPeriod = Number(periodRes.rows[0]?.deals_closed_in_period ?? 0);
    const participantsCount = Number(periodRes.rows[0]?.participants_count ?? 0);

    res.json({
      total_pipeline_value: totalPipelineValue,
      revenue_in_period: revenueInPeriod,
      deals_closed_in_period: dealsClosedInPeriod,
      participants_count: participantsCount,
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
        WHERE sh.organization_id = $1
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

  // Pipeline value
  router.get('/pipeline-value', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;

    const result = await pool.query(
      `SELECT 
        s.name as stage_name,
        COUNT(d.id) as deal_count,
        SUM(d.value) as total_value,
        AVG(d.value) as avg_value
       FROM deals d
       JOIN stages s ON d.stage_id = s.id
       WHERE d.organization_id = $1
       GROUP BY s.id, s.name, s.order_index
       ORDER BY s.order_index`,
      [organizationId]
    );

    res.json(result.rows);
  }));

  // Team performance (with display names and avg deal value)
  router.get('/team-performance', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    let { startDate, endDate } = req.query;
    const period = req.query.period as PeriodKey | undefined;
    if (period) {
      const bounds = getPeriodBounds(period);
      startDate = bounds.startDate;
      endDate = bounds.endDate;
    }

    let query = `
      SELECT 
        u.id as user_id,
        u.email as user_email,
        up.first_name,
        up.last_name,
        COUNT(DISTINCT d.id) as deals_closed,
        SUM(d.value) as revenue,
        AVG(d.value) as avg_deal_value,
        AVG(EXTRACT(EPOCH FROM (d.updated_at - d.created_at)) / 86400) as avg_days_to_close
      FROM deals d
      JOIN users u ON d.owner_id = u.id
      LEFT JOIN user_profiles up ON up.user_id = u.id AND up.organization_id = d.organization_id
      WHERE d.organization_id = $1 AND d.stage_id IN (
        SELECT id FROM stages WHERE name = 'closed' OR name = 'won'
      )
    `;
    const params: unknown[] = [organizationId];

    if (startDate && typeof startDate === 'string') {
      params.push(startDate);
      query += ` AND d.updated_at >= $${params.length}`;
    }

    if (endDate && typeof endDate === 'string') {
      params.push(endDate);
      query += ` AND d.updated_at <= $${params.length}`;
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
      const csv = [
        'id,organization_id,metric_type,metric_name,value,dimensions,recorded_at',
        ...result.rows.map((row: Record<string, unknown>) =>
          `${row.id},${row.organization_id},${row.metric_type},${row.metric_name},${row.value},"${JSON.stringify(row.dimensions)}",${row.recorded_at}`
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
