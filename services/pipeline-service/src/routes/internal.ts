import { Router } from 'express';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes } from '@getsale/service-core';

interface Deps {
  pool: Pool;
  log: Logger;
}

const DEFAULT_STAGES = [
  { name: 'Lead', order_index: 0, color: '#3B82F6' },
  { name: 'Qualified', order_index: 1, color: '#10B981' },
  { name: 'Proposal', order_index: 2, color: '#F59E0B' },
  { name: 'Negotiation', order_index: 3, color: '#EF4444' },
  { name: 'Closed Won', order_index: 4, color: '#8B5CF6' },
  { name: 'Closed Lost', order_index: 5, color: '#6B7280' },
  { name: 'Converted', order_index: 6, color: '#059669' },
];

/**
 * Internal router for service-to-service calls (e.g. auth-service creating default pipeline on signup).
 * Protected by internalAuth middleware at app level.
 */
export function internalPipelineRouter({ pool, log }: Deps): Router {
  const router = Router();

  router.post('/pipeline/default-for-org', asyncHandler(async (req, res) => {
    const organizationId = req.body?.organizationId;
    if (!organizationId || typeof organizationId !== 'string' || !organizationId.trim()) {
      throw new AppError(400, 'organizationId is required', ErrorCodes.BAD_REQUEST);
    }
    const orgId = organizationId.trim();

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const existing = await client.query(
        'SELECT id FROM pipelines WHERE organization_id = $1 AND is_default = true LIMIT 1',
        [orgId]
      );
      if (existing.rows.length > 0) {
        await client.query('ROLLBACK').catch(() => {});
        return res.status(200).json(existing.rows[0]);
      }

      const pipelineResult = await client.query(
        `INSERT INTO pipelines (organization_id, name, description, is_default)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [orgId, 'Default Pipeline', 'Default sales pipeline', true]
      );
      const pipeline = pipelineResult.rows[0];

      for (const stage of DEFAULT_STAGES) {
        await client.query(
          `INSERT INTO stages (pipeline_id, organization_id, name, order_index, color)
           VALUES ($1, $2, $3, $4, $5)`,
          [pipeline.id, orgId, stage.name, stage.order_index, stage.color]
        );
      }

      await client.query('COMMIT');
      res.status(201).json(pipeline);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }));

  return router;
}
