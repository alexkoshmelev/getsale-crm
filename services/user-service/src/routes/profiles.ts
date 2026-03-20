import { Router } from 'express';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { asyncHandler, requireUser, validate } from '@getsale/service-core';
import { UsProfileUpdateSchema } from '../validation';

interface Deps {
  pool: Pool;
  log: Logger;
}

export function profileRouter({ pool, log }: Deps): Router {
  const router = Router();

  router.use(requireUser());

  router.get('/profile', asyncHandler(async (req, res) => {
    const { id, organizationId } = req.user;

    let result = await pool.query('SELECT * FROM user_profiles WHERE user_id = $1', [id]);

    if (result.rows.length === 0) {
      log.info({ message: 'Creating default profile', user_id: id, correlation_id: req.correlationId });
      const insertResult = await pool.query(
        `INSERT INTO user_profiles (user_id, organization_id, first_name, last_name, preferences)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [id, organizationId, null, null, JSON.stringify({})]
      );
      result = insertResult;
    }

    res.json(result.rows[0]);
  }));

  router.put('/profile', validate(UsProfileUpdateSchema), asyncHandler(async (req, res) => {
    const { id, organizationId } = req.user;
    const { firstName, lastName, avatarUrl, timezone, preferences } = req.body;

    const result = await pool.query(
      `INSERT INTO user_profiles (user_id, organization_id, first_name, last_name, avatar_url, timezone, preferences)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id)
       DO UPDATE SET
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         avatar_url = EXCLUDED.avatar_url,
         timezone = EXCLUDED.timezone,
         preferences = EXCLUDED.preferences,
         updated_at = NOW()
       RETURNING *`,
      [id, organizationId, firstName, lastName, avatarUrl, timezone, JSON.stringify(preferences || {})]
    );

    res.json(result.rows[0]);
  }));

  return router;
}
