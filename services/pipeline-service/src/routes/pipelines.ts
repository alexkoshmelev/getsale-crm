import { Router } from 'express';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, validate, withOrgContext } from '@getsale/service-core';
import { PlPipelineCreateSchema, PlPipelineUpdateSchema } from '../validation';

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

export function pipelinesRouter({ pool, log }: Deps): Router {
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const result = await pool.query(
      'SELECT * FROM pipelines WHERE organization_id = $1 ORDER BY created_at DESC',
      [organizationId]
    );
    res.json(result.rows);
  }));

  router.post('/', validate(PlPipelineCreateSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { name, description, isDefault } = req.body;

    const pipeline = await withOrgContext(pool, organizationId, async (client) => {
      if (isDefault === true) {
        await client.query('UPDATE pipelines SET is_default = false WHERE organization_id = $1', [organizationId]);
      }
      const result = await client.query(
        `INSERT INTO pipelines (organization_id, name, description, is_default)
         VALUES ($1, $2, $3, $4) RETURNING *`,
        [organizationId, name ?? 'New Pipeline', description ?? null, isDefault || false]
      );
      const row = result.rows[0] as { id: string };
      for (const stage of DEFAULT_STAGES) {
        await client.query(
          `INSERT INTO stages (pipeline_id, organization_id, name, order_index, color)
           VALUES ($1, $2, $3, $4, $5)`,
          [row.id, organizationId, stage.name, stage.order_index, stage.color]
        );
      }
      return row;
    });

    res.status(201).json(pipeline);
  }));

  router.put('/:id', validate(PlPipelineUpdateSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { name, description, isDefault } = req.body;

    const existing = await pool.query(
      'SELECT id FROM pipelines WHERE id = $1 AND organization_id = $2', [id, organizationId]
    );
    if (existing.rows.length === 0) throw new AppError(404, 'Pipeline not found', ErrorCodes.NOT_FOUND);

    const updates: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let idx = 1;

    if (name !== undefined) { params.push(name); updates.push(`name = $${idx++}`); }
    if (description !== undefined) { params.push(description ?? null); updates.push(`description = $${idx++}`); }
    if (isDefault !== undefined) {
      params.push(!!isDefault);
      updates.push(`is_default = $${idx++}`);
    }

    if (params.length === 0) {
      const r = await pool.query('SELECT * FROM pipelines WHERE id = $1 AND organization_id = $2', [id, organizationId]);
      return res.json(r.rows[0]);
    }

    params.push(id, organizationId);
    const result = await withOrgContext(pool, organizationId, async (client) => {
      if (isDefault === true) {
        await client.query('UPDATE pipelines SET is_default = false WHERE organization_id = $1', [organizationId]);
      }
      return client.query(
        `UPDATE pipelines SET ${updates.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1} RETURNING *`,
        params
      );
    });
    res.json(result.rows[0]);
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;

    const existing = await pool.query('SELECT id FROM pipelines WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    if (existing.rows.length === 0) throw new AppError(404, 'Pipeline not found', ErrorCodes.NOT_FOUND);

    await withOrgContext(pool, organizationId, async (client) => {
      await client.query('DELETE FROM leads WHERE pipeline_id = $1', [id]);
      await client.query('DELETE FROM stages WHERE pipeline_id = $1', [id]);
      await client.query('DELETE FROM pipelines WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    });
    res.status(204).send();
  }));

  return router;
}
