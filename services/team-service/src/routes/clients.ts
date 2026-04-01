import { Router } from 'express';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { asyncHandler, requireUser, AppError, ErrorCodes, validate } from '@getsale/service-core';
import { TmAssignClientSchema } from '../validation';

interface Deps {
  pool: Pool;
  log: Logger;
}

export function clientsRouter({ pool }: Deps): Router {
  const router = Router();
  router.use(requireUser());

  router.post('/assign', validate(TmAssignClientSchema), asyncHandler(async (req, res) => {
    const user = req.user;
    const { clientId, assignedTo } = req.body;

    const result = await pool.query(
      `INSERT INTO organization_client_assignments (organization_id, client_id, assigned_to, assigned_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (organization_id, client_id)
       DO UPDATE SET assigned_to = EXCLUDED.assigned_to, assigned_at = NOW(), assigned_by = EXCLUDED.assigned_by
       RETURNING *`,
      [user.organizationId, clientId, assignedTo, user.id]
    );

    res.json(result.rows[0]);
  }));

  router.get('/shared', asyncHandler(async (req, res) => {
    const user = req.user;

    const query = `
      SELECT DISTINCT c.*, oca.assigned_to, oca.assigned_at
      FROM contacts c
      JOIN organization_client_assignments oca ON c.id = oca.client_id AND oca.organization_id = $1
      ORDER BY oca.assigned_at DESC
    `;

    const result = await pool.query(query, [user.organizationId]);
    res.json(result.rows);
  }));

  return router;
}
