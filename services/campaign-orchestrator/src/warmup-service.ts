import { Pool } from 'pg';
import { Logger } from '@getsale/logger';

const DEFAULT_SCHEDULE = [3, 5, 8, 10, 12, 14, 16, 18, 20, 20, 20, 20, 20, 20];

export class WarmupService {
  private pool: Pool;
  private log: Logger;
  private timer: NodeJS.Timeout | null = null;

  constructor(config: { pool: Pool; log: Logger }) {
    this.pool = config.pool;
    this.log = config.log;
  }

  start(): void {
    this.timer = setInterval(() => this.advanceWarmup(), 60 * 60_000);
    this.advanceWarmup();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  async initWarmup(bdAccountId: string, organizationId: string, schedule?: number[]): Promise<void> {
    await this.pool.query(
      `INSERT INTO bd_account_warmup (bd_account_id, organization_id, warmup_status, daily_limit_schedule, started_at)
       VALUES ($1, $2, 'active', $3, NOW())
       ON CONFLICT (bd_account_id) DO UPDATE SET
         warmup_status = 'active', current_day = 0,
         daily_limit_schedule = $3, started_at = NOW(),
         completed_at = NULL, updated_at = NOW()`,
      [bdAccountId, organizationId, JSON.stringify(schedule || DEFAULT_SCHEDULE)],
    );
    this.log.info({ message: 'Warmup initiated', bdAccountId });
  }

  async getCurrentLimit(bdAccountId: string): Promise<number | null> {
    const res = await this.pool.query(
      `SELECT daily_limit_schedule, current_day, warmup_status FROM bd_account_warmup WHERE bd_account_id = $1`,
      [bdAccountId],
    );
    if (!res.rows.length) return null;
    const row = res.rows[0] as { daily_limit_schedule: number[]; current_day: number; warmup_status: string };
    if (row.warmup_status !== 'active') return null;
    const schedule = Array.isArray(row.daily_limit_schedule) ? row.daily_limit_schedule : DEFAULT_SCHEDULE;
    return schedule[Math.min(row.current_day, schedule.length - 1)] ?? schedule[schedule.length - 1] ?? 20;
  }

  private async advanceWarmup(): Promise<void> {
    try {
      const active = await this.pool.query(
        `SELECT id, bd_account_id, current_day, daily_limit_schedule FROM bd_account_warmup WHERE warmup_status = 'active'`,
      );

      for (const row of active.rows as { id: string; bd_account_id: string; current_day: number; daily_limit_schedule: number[] }[]) {
        const schedule = Array.isArray(row.daily_limit_schedule) ? row.daily_limit_schedule : DEFAULT_SCHEDULE;
        const nextDay = row.current_day + 1;

        if (nextDay >= schedule.length) {
          await this.pool.query(
            `UPDATE bd_account_warmup SET warmup_status = 'completed', completed_at = NOW(), current_day = $2, updated_at = NOW() WHERE id = $1`,
            [row.id, nextDay],
          );
          this.log.info({ message: 'Warmup completed', bdAccountId: row.bd_account_id });
        } else {
          await this.pool.query(
            `UPDATE bd_account_warmup SET current_day = $2, updated_at = NOW() WHERE id = $1`,
            [row.id, nextDay],
          );
        }
      }
    } catch (err) {
      this.log.warn({ message: 'Warmup advance error', error: String(err) });
    }
  }
}
