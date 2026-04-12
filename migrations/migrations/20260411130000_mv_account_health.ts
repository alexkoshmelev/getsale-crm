import { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE MATERIALIZED VIEW IF NOT EXISTS mv_account_health AS
    SELECT
      ba.id AS bd_account_id,
      ba.organization_id,
      ba.connection_state,
      ba.last_activity,
      ba.flood_wait_until,
      ba.spam_restricted_at,
      ba.last_spambot_check_at,
      ba.last_spambot_result,
      ba.send_blocked_until,
      COALESCE(sends_7d.cnt, 0) AS sends_last_7_days,
      COALESCE(sends_today.cnt, 0) AS sends_today,
      COALESCE(replies_7d.cnt, 0) AS replies_last_7_days,
      CASE WHEN COALESCE(sends_7d.cnt, 0) > 0
        THEN ROUND(COALESCE(replies_7d.cnt, 0)::numeric / sends_7d.cnt * 100, 1)
        ELSE 0
      END AS reply_rate_7d,
      floods_7d.cnt AS flood_events_7_days,
      warmup.warmup_status,
      warmup.current_day AS warmup_day
    FROM bd_accounts ba
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS cnt FROM campaign_sends cs
      JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
      WHERE cp.bd_account_id = ba.id AND cs.status IN ('sent','queued') AND cs.sent_at >= NOW() - INTERVAL '7 days'
    ) sends_7d ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS cnt FROM campaign_sends cs
      JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
      WHERE cp.bd_account_id = ba.id AND cs.status IN ('sent','queued') AND cs.sent_at >= CURRENT_DATE
    ) sends_today ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS cnt FROM campaign_participants cp
      JOIN campaigns c ON c.id = cp.campaign_id
      WHERE cp.bd_account_id = ba.id AND cp.status = 'replied' AND cp.replied_at >= NOW() - INTERVAL '7 days'
    ) replies_7d ON true
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS cnt FROM bd_accounts ba2
      WHERE ba2.id = ba.id AND ba2.flood_wait_until > NOW() - INTERVAL '7 days'
    ) floods_7d ON true
    LEFT JOIN bd_account_warmup warmup ON warmup.bd_account_id = ba.id
    WHERE ba.is_active = true;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_mv_account_health_pk ON mv_account_health(bd_account_id);
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP MATERIALIZED VIEW IF EXISTS mv_account_health;');
}
