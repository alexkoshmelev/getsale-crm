import { FastifyInstance } from 'fastify';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { RedisClient } from '@getsale/cache';

export function registerAccountHealthRoutes(
  app: FastifyInstance,
  deps: { pool: Pool; log: Logger; redis: RedisClient },
) {
  const { pool, log, redis } = deps;

  app.get('/api/accounts/health', async (request, reply) => {
    const { organizationId } = (request as any).user;
    const cacheKey = `account:health:${organizationId}`;
    const cached = await redis.get<Record<string, unknown>[]>(cacheKey);
    if (cached) return reply.send(cached);

    const result = await pool.query(
      'SELECT * FROM mv_account_health WHERE organization_id = $1 ORDER BY last_activity DESC NULLS LAST',
      [organizationId],
    );

    await redis.set(cacheKey, result.rows, 60);
    return reply.send(result.rows);
  });

  app.post('/api/accounts/health/refresh', async (request, reply) => {
    try {
      await pool.query('REFRESH MATERIALIZED VIEW CONCURRENTLY mv_account_health');
      log.info({ message: 'Account health view refreshed manually' });
      return reply.send({ status: 'refreshed' });
    } catch (err) {
      log.warn({ message: 'Health view refresh failed', error: String(err) });
      return reply.status(500).send({ error: 'refresh_failed' });
    }
  });
}
