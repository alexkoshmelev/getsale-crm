import { Router } from 'express';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, Event } from '@getsale/events';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, validate, withOrgContext } from '@getsale/service-core';
import crypto from 'crypto';
import { PlStageCreateSchema, PlStageUpdateSchema } from '../validation';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
}

export function stagesRouter({ pool, rabbitmq, log }: Deps): Router {
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { pipelineId } = req.query;

    let query = 'SELECT * FROM stages WHERE organization_id = $1';
    const params: unknown[] = [organizationId];

    if (pipelineId) {
      query += ' AND pipeline_id = $2';
      params.push(pipelineId);
    }
    query += ' ORDER BY order_index ASC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  }));

  router.post('/', validate(PlStageCreateSchema), asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { pipelineId, name, orderIndex, color, automationRules, entryRules, exitRules, allowedActions } = req.body;

    const row = await withOrgContext(pool, organizationId, async (client) => {
      const result = await client.query(
        `INSERT INTO stages (pipeline_id, organization_id, name, order_index, color, automation_rules, entry_rules, exit_rules, allowed_actions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
        [pipelineId, organizationId, name, orderIndex, color,
         JSON.stringify(automationRules || []), JSON.stringify(entryRules || []),
         JSON.stringify(exitRules || []), JSON.stringify(allowedActions || [])]
      );
      return result.rows[0];
    });

    await rabbitmq.publishEvent({
      id: crypto.randomUUID(), type: EventType.STAGE_CREATED, timestamp: new Date(),
      organizationId, userId, correlationId: req.correlationId, data: { stageId: (row as { id: string }).id, pipelineId },
    } as Event);

    res.json(row);
  }));

  router.put('/:id', validate(PlStageUpdateSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { name, orderIndex, color, automationRules, entryRules, exitRules, allowedActions } = req.body;

    const existing = await pool.query('SELECT * FROM stages WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    if (existing.rows.length === 0) throw new AppError(404, 'Stage not found', ErrorCodes.NOT_FOUND);

    const updates: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let idx = 1;

    if (name !== undefined) { params.push(name); updates.push(`name = $${idx++}`); }
    if (typeof orderIndex === 'number') { params.push(orderIndex); updates.push(`order_index = $${idx++}`); }
    if (color !== undefined) { params.push(color ?? null); updates.push(`color = $${idx++}`); }
    if (automationRules !== undefined) { params.push(JSON.stringify(automationRules || [])); updates.push(`automation_rules = $${idx++}`); }
    if (entryRules !== undefined) { params.push(JSON.stringify(entryRules || [])); updates.push(`entry_rules = $${idx++}`); }
    if (exitRules !== undefined) { params.push(JSON.stringify(exitRules || [])); updates.push(`exit_rules = $${idx++}`); }
    if (allowedActions !== undefined) { params.push(JSON.stringify(allowedActions || [])); updates.push(`allowed_actions = $${idx++}`); }

    if (params.length === 0) return res.json(existing.rows[0]);

    params.push(id, organizationId);
    const result = await withOrgContext(pool, organizationId, (client) =>
      client.query(
        `UPDATE stages SET ${updates.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1} RETURNING *`,
        params
      )
    );
    res.json(result.rows[0]);
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;

    const existing = await pool.query('SELECT * FROM stages WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    if (existing.rows.length === 0) throw new AppError(404, 'Stage not found', ErrorCodes.NOT_FOUND);
    const pipelineId = existing.rows[0].pipeline_id;

    await withOrgContext(pool, organizationId, async (client) => {
      const leadCount = await client.query('SELECT COUNT(*) AS cnt FROM leads WHERE stage_id = $1', [id]);
      if (parseInt(leadCount.rows[0]?.cnt || '0', 10) > 0) {
        const firstOther = await client.query(
          'SELECT id FROM stages WHERE pipeline_id = $1 AND organization_id = $2 AND id != $3 ORDER BY order_index ASC LIMIT 1',
          [pipelineId, organizationId, id]
        );
        if (firstOther.rows.length > 0) {
          await client.query('UPDATE leads SET stage_id = $1, updated_at = NOW() WHERE stage_id = $2', [firstOther.rows[0].id, id]);
        } else {
          throw new AppError(400, 'Cannot delete the only stage. Add another stage first or move leads out.', ErrorCodes.BAD_REQUEST);
        }
      }
      await client.query('DELETE FROM stages WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    });
    res.status(204).send();
  }));

  return router;
}
