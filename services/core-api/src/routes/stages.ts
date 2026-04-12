import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { EventType, type Event } from '@getsale/events';
import { AppError, ErrorCodes, requireUser } from '@getsale/service-framework';
import type { CoreDeps } from '../types';

const CreateStageSchema = z.object({
  pipelineId: z.string().uuid(),
  name: z.string().min(1).max(255),
  orderIndex: z.number().int().min(0).optional(),
  color: z.string().max(32).optional().nullable(),
  automationRules: z.unknown().optional(),
  entryRules: z.unknown().optional(),
  exitRules: z.unknown().optional(),
  allowedActions: z.unknown().optional(),
});

const UpdateStageSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  orderIndex: z.number().int().min(0).optional(),
  color: z.string().max(32).optional().nullable(),
  automationRules: z.unknown().optional(),
  entryRules: z.unknown().optional(),
  exitRules: z.unknown().optional(),
  allowedActions: z.unknown().optional(),
});

export function registerStageRoutes(app: FastifyInstance, deps: CoreDeps): void {
  const { db, rabbitmq, log, pipelineCache } = deps;

  app.get('/api/pipeline/stages', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { pipelineId } = request.query as { pipelineId?: string };
    const orgId = user.organizationId;

    if (pipelineId) {
      const result = await db.read.query(
        'SELECT * FROM stages WHERE pipeline_id = $1 AND organization_id = $2 ORDER BY order_index',
        [pipelineId, orgId],
      );
      return result.rows;
    }
    const result = await db.read.query(
      'SELECT * FROM stages WHERE organization_id = $1 ORDER BY pipeline_id, order_index',
      [orgId],
    );
    return result.rows;
  });

  app.post('/api/pipeline/stages', { preHandler: [requireUser] }, async (request, reply) => {
    const body = CreateStageSchema.parse(request.body);
    const user = request.user!;
    const { pipelineId, name, orderIndex, color, automationRules, entryRules, exitRules, allowedActions } = body;

    const result = await db.write.query(
      `INSERT INTO stages (pipeline_id, organization_id, name, order_index, color, automation_rules, entry_rules, exit_rules, allowed_actions)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [
        pipelineId, user.organizationId, name, orderIndex ?? 0, color ?? null,
        JSON.stringify(automationRules || []), JSON.stringify(entryRules || []),
        JSON.stringify(exitRules || []), JSON.stringify(allowedActions || []),
      ],
    );

    rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.STAGE_CREATED, timestamp: new Date(),
      organizationId: user.organizationId, userId: user.id,
      data: { stageId: result.rows[0].id, pipelineId },
    } as unknown as Event).catch((e) => log.warn({ message: 'Failed to publish STAGE_CREATED', error: String(e) }));

    await pipelineCache.invalidatePattern(`${user.organizationId}:*`);
    reply.code(201);
    return result.rows[0];
  });

  app.put('/api/pipeline/stages/:id', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = UpdateStageSchema.parse(request.body);
    const user = request.user!;
    const { name, orderIndex, color, automationRules, entryRules, exitRules, allowedActions } = body;

    const existing = await db.read.query(
      'SELECT * FROM stages WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!existing.rows.length) throw new AppError(404, 'Stage not found', ErrorCodes.NOT_FOUND);

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

    if (params.length === 0) return existing.rows[0];

    params.push(id, user.organizationId);
    const result = await db.write.query(
      `UPDATE stages SET ${updates.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1} RETURNING *`,
      params,
    );
    if (!result.rows.length) throw new AppError(404, 'Stage not found', ErrorCodes.NOT_FOUND);
    await pipelineCache.invalidatePattern(`${user.organizationId}:*`);
    return result.rows[0];
  });

  app.delete('/api/pipeline/stages/:id', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const existing = await db.read.query(
      'SELECT * FROM stages WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!existing.rows.length) throw new AppError(404, 'Stage not found', ErrorCodes.NOT_FOUND);

    const pipelineId = existing.rows[0].pipeline_id;

    const leadCount = await db.read.query(
      'SELECT COUNT(*)::int AS cnt FROM leads WHERE stage_id = $1 AND deleted_at IS NULL',
      [id],
    );
    if (parseInt(leadCount.rows[0]?.cnt || '0', 10) > 0) {
      const firstOther = await db.read.query(
        'SELECT id FROM stages WHERE pipeline_id = $1 AND organization_id = $2 AND id != $3 ORDER BY order_index ASC LIMIT 1',
        [pipelineId, user.organizationId, id],
      );
      if (firstOther.rows.length > 0) {
        await db.write.query(
          'UPDATE leads SET stage_id = $1, updated_at = NOW() WHERE stage_id = $2 AND deleted_at IS NULL',
          [firstOther.rows[0].id, id],
        );
      } else {
        throw new AppError(400, 'Cannot delete the only stage. Add another stage first or move leads out.', ErrorCodes.BAD_REQUEST);
      }
    }

    await db.write.query('DELETE FROM stages WHERE id = $1 AND organization_id = $2', [id, user.organizationId]);
    await pipelineCache.invalidatePattern(`${user.organizationId}:*`);
    reply.code(204).send();
  });
}
