import type { Knex } from 'knex';

/**
 * v2: Analytics materialized views for CQRS read model.
 * These are refreshed periodically by the analytics-worker.
 */
export async function up(knex: Knex): Promise<void> {
  // Daily message counts per organization
  await knex.raw(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS mv_daily_message_counts AS
    SELECT
      organization_id,
      DATE(created_at) AS day,
      COUNT(*) AS total_messages,
      COUNT(*) FILTER (WHERE direction = 'outbound') AS outbound,
      COUNT(*) FILTER (WHERE direction = 'inbound') AS inbound
    FROM messages
    GROUP BY organization_id, DATE(created_at)
    WITH DATA
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_daily_msg_org_day
    ON mv_daily_message_counts (organization_id, day)
  `);

  // Campaign stats per campaign
  await knex.raw(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS mv_campaign_stats AS
    SELECT
      cp.campaign_id,
      c.organization_id,
      COUNT(*) AS total_participants,
      COUNT(*) FILTER (WHERE cp.status = 'sent') AS sent,
      COUNT(*) FILTER (WHERE cp.status = 'replied') AS replied,
      COUNT(*) FILTER (WHERE cp.status = 'failed') AS failed,
      COUNT(*) FILTER (WHERE cp.status = 'pending') AS pending
    FROM campaign_participants cp
    JOIN campaigns c ON c.id = cp.campaign_id
    GROUP BY cp.campaign_id, c.organization_id
    WITH DATA
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_campaign_stats_id
    ON mv_campaign_stats (campaign_id)
  `);

  // Conversion funnel: leads by stage per pipeline
  await knex.raw(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS mv_conversion_funnel AS
    SELECT
      s.pipeline_id,
      p.organization_id,
      s.id AS stage_id,
      s.name AS stage_name,
      s.order_index AS stage_order,
      COUNT(l.id) AS lead_count,
      COALESCE(SUM(l.revenue_amount), 0) AS total_value
    FROM stages s
    JOIN pipelines p ON p.id = s.pipeline_id
    LEFT JOIN leads l ON l.stage_id = s.id AND l.deleted_at IS NULL
    GROUP BY s.pipeline_id, p.organization_id, s.id, s.name, s.order_index
    WITH DATA
  `);

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_conversion_funnel_stage
    ON mv_conversion_funnel (pipeline_id, stage_id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS mv_conversion_funnel');
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS mv_campaign_stats');
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS mv_daily_message_counts');
}
