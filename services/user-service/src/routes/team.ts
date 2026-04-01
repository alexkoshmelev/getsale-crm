import { Router } from 'express';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { asyncHandler, requireUser } from '@getsale/service-core';

interface Deps {
  pool: Pool;
  log: Logger;
}

/** @deprecated Use GET /api/team/members (team-service) — workspace members from organization_members. */
export function teamRouter({ pool }: Deps): Router {
  const router = Router();
  router.use(requireUser());

  router.get('/team/members', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const result = await pool.query(
      `SELECT u.id AS user_id, u.email, om.role, up.first_name, up.last_name, up.avatar_url
       FROM organization_members om
       JOIN users u ON u.id = om.user_id
       LEFT JOIN user_profiles up ON up.user_id = u.id
       WHERE om.organization_id = $1
       ORDER BY LOWER(u.email)`,
      [organizationId]
    );
    res.json(result.rows);
  }));

  router.post('/team/invite', asyncHandler(async (_req, res) => {
    res.status(410).json({
      error: 'Use POST /api/team/members/invite or workspace invite links',
    });
  }));

  return router;
}
