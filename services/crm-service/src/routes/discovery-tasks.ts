import { Router } from 'express';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, validate } from '@getsale/service-core';
import { DiscoveryTaskCreateSchema, DiscoveryTaskActionSchema } from '../validation';
import { ServiceHttpClient } from '@getsale/service-core';
import { randomUUID } from 'crypto';
import { EventType } from '@getsale/events';
import type { RabbitMQClient } from '@getsale/utils';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  campaignServiceClient: ServiceHttpClient;
}

export function discoveryTasksRouter({ pool, rabbitmq, log, campaignServiceClient }: Deps): Router {
  const router = Router();

  // GET /api/crm/discovery-tasks
  router.get('/', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { limit = 50, offset = 0 } = req.query;

    const query = `
      SELECT id, name, type, status, progress, total, params, results, created_at, updated_at
      FROM contact_discovery_tasks
      WHERE organization_id = $1
      ORDER BY created_at DESC
      LIMIT $2 OFFSET $3
    `;
    const result = await pool.query(query, [organizationId, Number(limit), Number(offset)]);
    
    const countQuery = `SELECT COUNT(*) FROM contact_discovery_tasks WHERE organization_id = $1`;
    const countResult = await pool.query(countQuery, [organizationId]);
    
    res.json({
      tasks: result.rows,
      total: Number(countResult.rows[0].count)
    });
  }));

  // GET /api/crm/discovery-tasks/:id
  router.get('/:id', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;

    const result = await pool.query(
      `SELECT id, name, type, status, progress, total, params, results, created_at, updated_at
       FROM contact_discovery_tasks
       WHERE id = $1 AND organization_id = $2`,
      [id, organizationId]
    );

    if (result.rows.length === 0) {
      throw new AppError(404, 'Task not found', ErrorCodes.NOT_FOUND);
    }

    res.json(result.rows[0]);
  }));

  // POST /api/crm/discovery-tasks
  router.post('/', validate(DiscoveryTaskCreateSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { name, type, params } = req.body;

    // Handle new campaign creation for parse task if requested
    let finalParams = { ...params };
    if (type === 'parse' && params.campaignName && !params.campaignId) {
       try {
         // Call campaign-service to create a new campaign
         const createCampRes = await campaignServiceClient.post<any>('/api/campaigns', {
            name: params.campaignName,
         }, undefined, { organizationId, userId: req.user?.id });
         finalParams.campaignId = createCampRes.id;
         delete finalParams.campaignName;
       } catch (err: any) {
         log.warn({ message: 'Failed to create campaign for discovery task', error: err?.message });
         throw new AppError(500, 'Failed to create campaign for export', ErrorCodes.INTERNAL_ERROR);
       }
    }

    let total = 0;
    if (type === 'search' && Array.isArray(finalParams.queries)) {
      total = finalParams.queries.length;
    } else if (type === 'parse' && Array.isArray(finalParams.chats)) {
      total = finalParams.chats.length;
    }

    const taskId = randomUUID();
    const result = await pool.query(
      `INSERT INTO contact_discovery_tasks (id, organization_id, name, type, status, progress, total, params, results)
       VALUES ($1, $2, $3, $4, 'pending', 0, $5, $6, '{}'::jsonb)
       RETURNING id, name, type, status, progress, total, params, results, created_at, updated_at`,
      [taskId, organizationId, name, type, total, JSON.stringify(finalParams)]
    );

    res.status(201).json(result.rows[0]);
  }));

  // POST /api/crm/discovery-tasks/:id/action
  router.post('/:id/action', validate(DiscoveryTaskActionSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { action } = req.body;

    const task = await pool.query(
      'SELECT id, name, status FROM contact_discovery_tasks WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );

    if (task.rows.length === 0) {
      throw new AppError(404, 'Task not found', ErrorCodes.NOT_FOUND);
    }

    const currentStatus = task.rows[0].status;
    let newStatus = currentStatus;

    if (action === 'start') {
      if (currentStatus === 'pending' || currentStatus === 'paused' || currentStatus === 'failed') {
        newStatus = 'running';
      } else {
        throw new AppError(400, `Cannot start task in status ${currentStatus}`, ErrorCodes.BAD_REQUEST);
      }
    } else if (action === 'pause') {
      if (currentStatus === 'running') {
        newStatus = 'paused';
      } else {
        throw new AppError(400, `Cannot pause task in status ${currentStatus}`, ErrorCodes.BAD_REQUEST);
      }
    } else if (action === 'stop') {
      if (currentStatus === 'running' || currentStatus === 'paused' || currentStatus === 'pending') {
        newStatus = 'stopped';
      } else {
        throw new AppError(400, `Cannot stop task in status ${currentStatus}`, ErrorCodes.BAD_REQUEST);
      }
    }

    const updated = await pool.query(
      'UPDATE contact_discovery_tasks SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, status, updated_at',
      [newStatus, id]
    );

    if (action === 'start' && updated.rows.length > 0) {
      const taskName = (task.rows[0] as { name?: string }).name;
      try {
        await rabbitmq.publishEvent({
          id: randomUUID(),
          type: EventType.DISCOVERY_TASK_STARTED,
          timestamp: new Date(),
          organizationId,
          userId: (req as any).user?.id,
          data: { taskId: id, name: taskName },
        } as any);
      } catch (err) {
        log.warn({ message: 'Failed to publish DISCOVERY_TASK_STARTED', taskId: id, error: (err as Error)?.message });
      }
    }

    res.json(updated.rows[0]);
  }));

  return router;
}
