import { Counter } from 'prom-client';

/** Incremented when a due participant is deferred because CAMPAIGN_MIN_GAP_MS_SAME_BD_ACCOUNT has not elapsed. */
export const campaignMinGapDeferTotal = new Counter({
  name: 'campaign_min_gap_defer_total',
  help: 'Campaign worker deferred send: min gap per bd_account_id not satisfied',
  registers: [],
});
