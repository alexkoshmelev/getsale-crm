import { Pool } from 'pg';
import { Logger } from '@getsale/logger';

export class ProxyManager {
  private pool: Pool;
  private log: Logger;
  private healthCheckTimer: NodeJS.Timeout | null = null;

  constructor(config: { pool: Pool; log: Logger }) {
    this.pool = config.pool;
    this.log = config.log;
  }

  start(): void {
    this.healthCheckTimer = setInterval(() => this.checkProxyHealth(), 10 * 60_000);
  }

  stop(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  async assignProxy(bdAccountId: string, organizationId: string): Promise<{ host: string; port: number; username?: string; password?: string } | null> {
    const result = await this.pool.query(
      `UPDATE proxy_pool SET assigned_account_id = $1, updated_at = NOW()
       WHERE id = (
         SELECT id FROM proxy_pool
         WHERE organization_id = $2 AND is_active = true AND assigned_account_id IS NULL
           AND health_status != 'dead'
         ORDER BY last_check_at ASC NULLS FIRST
         LIMIT 1
         FOR UPDATE SKIP LOCKED
       ) RETURNING host, port, username, password`,
      [bdAccountId, organizationId],
    );

    if (!result.rows.length) return null;
    const row = result.rows[0] as { host: string; port: number; username: string | null; password: string | null };

    await this.pool.query(
      `UPDATE bd_accounts SET proxy_config = $1, updated_at = NOW() WHERE id = $2`,
      [JSON.stringify({ host: row.host, port: row.port, username: row.username, password: row.password }), bdAccountId],
    );

    this.log.info({ message: 'Proxy assigned', bdAccountId, host: row.host });
    return { host: row.host, port: row.port, username: row.username ?? undefined, password: row.password ?? undefined };
  }

  async releaseProxy(bdAccountId: string): Promise<void> {
    await this.pool.query(
      `UPDATE proxy_pool SET assigned_account_id = NULL, updated_at = NOW() WHERE assigned_account_id = $1`,
      [bdAccountId],
    );
  }

  async reassignOnFailure(bdAccountId: string, organizationId: string): Promise<boolean> {
    const current = await this.pool.query(
      `SELECT id FROM proxy_pool WHERE assigned_account_id = $1`,
      [bdAccountId],
    );
    if (current.rows.length) {
      await this.pool.query(
        `UPDATE proxy_pool SET health_status = 'failed', assigned_account_id = NULL, last_error = 'Account reassignment', updated_at = NOW() WHERE assigned_account_id = $1`,
        [bdAccountId],
      );
    }
    const newProxy = await this.assignProxy(bdAccountId, organizationId);
    return newProxy !== null;
  }

  private async checkProxyHealth(): Promise<void> {
    try {
      const proxies = await this.pool.query(
        `SELECT id, host, port FROM proxy_pool WHERE is_active = true AND (last_check_at IS NULL OR last_check_at < NOW() - INTERVAL '30 minutes')
         LIMIT 50`,
      );

      for (const proxy of proxies.rows as { id: string; host: string; port: number }[]) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          const resp = await fetch(`http://${proxy.host}:${proxy.port}`, { signal: controller.signal });
          const healthy = resp.ok || resp.status < 500;

          await this.pool.query(
            healthy
              ? `UPDATE proxy_pool SET health_status = 'healthy', last_check_at = NOW(), last_error = NULL, updated_at = NOW() WHERE id = $1`
              : `UPDATE proxy_pool SET health_status = 'unhealthy', last_check_at = NOW(), last_error = $2, updated_at = NOW() WHERE id = $1`,
            healthy ? [proxy.id] : [proxy.id, `HTTP ${resp.status}`],
          );
        } catch (err) {
          await this.pool.query(
            `UPDATE proxy_pool SET health_status = 'unhealthy', last_check_at = NOW(), last_error = $2, updated_at = NOW() WHERE id = $1`,
            [proxy.id, String(err).slice(0, 200)],
          ).catch(() => {});
        } finally {
          clearTimeout(timeout);
        }
      }
    } catch (err) {
      this.log.warn({ message: 'Proxy health check error', error: String(err) });
    }
  }
}
