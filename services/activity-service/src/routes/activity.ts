import { Router } from 'express';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { asyncHandler, requireUser, validate } from '@getsale/service-core';
import type { z } from 'zod';
import { AcActivityListQuerySchema } from '../validation';

interface Deps {
  pool: Pool;
  log: Logger;
}

export function activityRouter({ pool, log }: Deps): Router {
  const router = Router();

  router.use(requireUser());

  router.get('/', validate(AcActivityListQuerySchema, 'query'), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const q = req.query as z.infer<typeof AcActivityListQuerySchema>;
    const limit = Math.min(q.limit ?? 50, 100);

    const result = await pool.query(
      `SELECT 
        oa.id,
        oa.user_id,
        oa.action_type,
        oa.entity_type,
        oa.entity_id,
        oa.metadata,
        oa.created_at,
        u.email AS user_email,
        up.first_name,
        up.last_name
       FROM organization_activity oa
       JOIN users u ON u.id = oa.user_id
       LEFT JOIN user_profiles up ON up.user_id = u.id AND up.organization_id = oa.organization_id
       WHERE oa.organization_id = $1
       ORDER BY oa.created_at DESC
       LIMIT $2`,
      [organizationId, limit]
    );

    const rows = result.rows.map((row: Record<string, unknown>) => {
      const firstName = row.first_name as string | null;
      const lastName = row.last_name as string | null;
      const email = row.user_email as string;
      const displayName =
        [firstName, lastName].filter(Boolean).join(' ').trim() || email || String(row.user_id);
      return {
        id: row.id,
        user_id: row.user_id,
        user_email: email,
        user_display_name: displayName,
        action_type: row.action_type,
        entity_type: row.entity_type,
        entity_id: row.entity_id,
        metadata: row.metadata,
        created_at: row.created_at,
      };
    });

    res.json(rows);
  }));

  return router;
}
