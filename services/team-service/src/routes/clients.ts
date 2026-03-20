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
    const { teamId, clientId, assignedTo } = req.body;

    const result = await pool.query(
      `INSERT INTO team_client_assignments (team_id, client_id, assigned_to)
       VALUES ($1, $2, $3)
       ON CONFLICT (team_id, client_id) 
       DO UPDATE SET assigned_to = EXCLUDED.assigned_to, assigned_at = NOW()
       RETURNING *`,
      [teamId, clientId, assignedTo]
    );

    res.json(result.rows[0]);
  }));

  router.get('/shared', asyncHandler(async (req, res) => {
    const user = req.user;
    const { teamId } = req.query;

    let query = `
      SELECT DISTINCT c.*, tca.assigned_to, tca.assigned_at
      FROM contacts c
      JOIN team_client_assignments tca ON c.id = tca.client_id
      JOIN teams t ON tca.team_id = t.id
      WHERE t.organization_id = $1
    `;
    const params: unknown[] = [user.organizationId];

    if (teamId) {
      params.push(teamId);
      query += ` AND t.id = $${params.length}`;
    }

    query += ' ORDER BY tca.assigned_at DESC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  }));

  return router;
}
