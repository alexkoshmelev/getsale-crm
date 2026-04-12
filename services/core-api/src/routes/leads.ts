import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { EventType, type Event } from '@getsale/events';
import { AppError, ErrorCodes, requireUser } from '@getsale/service-framework';
import type { CoreDeps } from '../types';

const CreateLeadSchema = z.object({
  contactId: z.string().uuid('contactId must be a valid UUID'),
  pipelineId: z.string().uuid('pipelineId must be a valid UUID'),
  stageId: z.string().uuid().optional(),
  responsibleId: z.string().uuid().optional(),
});

const PatchLeadSchema = z.object({
  stageId: z.string().uuid().optional(),
  orderIndex: z.number().int().min(0).optional(),
  responsibleId: z.string().uuid().nullable().optional(),
  revenueAmount: z.number().nullable().optional(),
});

export function registerLeadRoutes(app: FastifyInstance, deps: CoreDeps): void {
  const { db, rabbitmq, log } = deps;

  // List leads for a pipeline
  app.get('/api/pipeline/leads', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const q = request.query as { stageId?: string; pipelineId?: string; page?: number; limit?: number };

    if (!q.pipelineId || typeof q.pipelineId !== 'string') {
      throw new AppError(400, 'pipelineId is required', ErrorCodes.BAD_REQUEST);
    }

    const page = Math.max(1, Number(q.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(q.limit) || 20));
    const offset = (page - 1) * limit;

    const params: unknown[] = [user.organizationId, q.pipelineId.trim()];
    let where = 'l.organization_id = $1 AND l.pipeline_id = $2 AND l.deleted_at IS NULL';

    if (q.stageId) {
      params.push(q.stageId);
      where += ` AND l.stage_id = $${params.length}`;
    }

    const countParams = [...params];
    params.push(limit, offset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    const [data, count] = await Promise.all([
      db.read.query(
        `SELECT l.id, l.contact_id, l.pipeline_id, l.stage_id, l.order_index,
                l.created_at, l.updated_at, l.responsible_id, l.revenue_amount,
                c.first_name, c.last_name, c.display_name, c.username, c.email, c.telegram_id,
                ps.name AS stage_name,
                u.email AS responsible_email
         FROM leads l
         JOIN contacts c ON c.id = l.contact_id AND c.organization_id = l.organization_id
         LEFT JOIN stages ps ON ps.id = l.stage_id
         LEFT JOIN users u ON u.id = l.responsible_id
         WHERE ${where}
         ORDER BY l.order_index ASC, l.created_at ASC
         LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
        params,
      ),
      db.read.query(`SELECT COUNT(*)::int AS total FROM leads l WHERE ${where}`, countParams),
    ]);

    const total = count.rows[0]?.total ?? 0;
    return {
      items: data.rows,
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    };
  });

  // Create lead (add contact to pipeline)
  app.post('/api/pipeline/leads', { preHandler: [requireUser] }, async (request, reply) => {
    const body = CreateLeadSchema.parse(request.body);
    const user = request.user!;
    const { contactId, pipelineId, responsibleId } = body;

    const contactCheck = await db.read.query(
      'SELECT 1 FROM contacts WHERE id = $1 AND organization_id = $2',
      [contactId, user.organizationId],
    );
    if (!contactCheck.rows.length) throw new AppError(404, 'Contact not found', ErrorCodes.NOT_FOUND);

    const pipelineCheck = await db.read.query(
      'SELECT 1 FROM pipelines WHERE id = $1 AND organization_id = $2',
      [pipelineId, user.organizationId],
    );
    if (!pipelineCheck.rows.length) throw new AppError(404, 'Pipeline not found', ErrorCodes.NOT_FOUND);

    let targetStageId = body.stageId;
    if (!targetStageId) {
      const firstStage = await db.read.query(
        'SELECT id FROM stages WHERE pipeline_id = $1 AND organization_id = $2 ORDER BY order_index ASC LIMIT 1',
        [pipelineId, user.organizationId],
      );
      if (!firstStage.rows.length) throw new AppError(400, 'Pipeline has no stages', ErrorCodes.BAD_REQUEST);
      targetStageId = firstStage.rows[0].id;
    } else {
      const stageCheck = await db.read.query(
        'SELECT 1 FROM stages WHERE id = $1 AND pipeline_id = $2 AND organization_id = $3',
        [targetStageId, pipelineId, user.organizationId],
      );
      if (!stageCheck.rows.length) throw new AppError(400, 'Stage not found or does not belong to pipeline', ErrorCodes.BAD_REQUEST);
    }

    const existing = await db.read.query(
      'SELECT id FROM leads WHERE organization_id = $1 AND contact_id = $2 AND pipeline_id = $3 AND deleted_at IS NULL',
      [user.organizationId, contactId, pipelineId],
    );
    if (existing.rows.length > 0) {
      throw new AppError(409, 'Contact is already in this pipeline', ErrorCodes.CONFLICT, {
        leadId: existing.rows[0].id,
      });
    }

    const maxOrder = await db.read.query(
      'SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM leads WHERE stage_id = $1',
      [targetStageId],
    );
    const orderIndex = maxOrder.rows[0]?.next ?? 0;

    const responsibleIdValid = responsibleId ?? user.id;

    const result = await db.write.query(
      `INSERT INTO leads (organization_id, contact_id, pipeline_id, stage_id, order_index, responsible_id)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [user.organizationId, contactId, pipelineId, targetStageId, orderIndex, responsibleIdValid],
    );

    rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.LEAD_CREATED, timestamp: new Date(),
      organizationId: user.organizationId, userId: user.id,
      data: { contactId, pipelineId, stageId: targetStageId, leadId: result.rows[0].id },
    } as unknown as Event).catch((e) => log.warn({ message: 'Failed to publish LEAD_CREATED', error: String(e) }));

    reply.code(201);
    return result.rows[0];
  });

  // Update lead (move stage / reorder / responsible / amount)
  app.patch('/api/pipeline/leads/:id', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = PatchLeadSchema.parse(request.body);
    const user = request.user!;
    const { stageId, orderIndex, responsibleId, revenueAmount } = body;

    const existing = await db.read.query(
      'SELECT l.*, s.name AS stage_name FROM leads l JOIN stages s ON s.id = l.stage_id WHERE l.id = $1 AND l.organization_id = $2 AND l.deleted_at IS NULL',
      [id, user.organizationId],
    );
    if (!existing.rows.length) throw new AppError(404, 'Lead not found', ErrorCodes.NOT_FOUND);

    if (stageId != null && String(existing.rows[0].stage_name) === 'Converted') {
      throw new AppError(400, 'Cannot move lead from Converted stage', ErrorCodes.BAD_REQUEST);
    }

    const updates: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let idx = 1;

    if (stageId != null) {
      const stageCheck = await db.read.query(
        'SELECT 1 FROM stages WHERE id = $1 AND pipeline_id = $2 AND organization_id = $3',
        [stageId, existing.rows[0].pipeline_id, user.organizationId],
      );
      if (!stageCheck.rows.length) throw new AppError(400, 'Stage not found', ErrorCodes.BAD_REQUEST);
      params.push(stageId);
      updates.push(`stage_id = $${idx++}`);
    }
    if (typeof orderIndex === 'number') {
      params.push(orderIndex);
      updates.push(`order_index = $${idx++}`);
    }
    if (responsibleId !== undefined) {
      if (responsibleId === null) {
        updates.push('responsible_id = NULL');
      } else {
        params.push(responsibleId);
        updates.push(`responsible_id = $${idx++}`);
      }
    }
    if (revenueAmount !== undefined) {
      if (revenueAmount === null) {
        updates.push('revenue_amount = NULL');
      } else {
        params.push(revenueAmount);
        updates.push(`revenue_amount = $${idx++}`);
      }
    }

    if (params.length === 0) return existing.rows[0];

    params.push(id, user.organizationId);
    const result = await db.write.query(
      `UPDATE leads SET ${updates.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1} AND deleted_at IS NULL RETURNING *`,
      params,
    );
    if (!result.rows.length) throw new AppError(404, 'Lead not found', ErrorCodes.NOT_FOUND);

    const fromStageId = existing.rows[0].stage_id;
    if (stageId != null && fromStageId !== stageId) {
      await publishStageChange(deps, {
        leadId: id, organizationId: user.organizationId, userId: user.id,
        contactId: existing.rows[0].contact_id, pipelineId: existing.rows[0].pipeline_id,
        fromStageId, toStageId: stageId,
      });
    }

    return result.rows[0];
  });

  // Stage change (narrow contract)
  const StageUpdateSchema = z.object({
    stageId: z.string().uuid().optional(),
    stage_id: z.string().uuid().optional(),
  }).transform(data => ({ stageId: data.stageId || data.stage_id }))
    .refine(data => !!data.stageId, { message: 'stageId or stage_id required' });

  app.patch('/api/pipeline/leads/:id/stage', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const { stageId } = StageUpdateSchema.parse(request.body);
    const user = request.user!;

    const existing = await db.read.query(
      'SELECT l.*, s.name AS stage_name FROM leads l JOIN stages s ON s.id = l.stage_id WHERE l.id = $1 AND l.organization_id = $2 AND l.deleted_at IS NULL',
      [id, user.organizationId],
    );
    if (!existing.rows.length) throw new AppError(404, 'Lead not found', ErrorCodes.NOT_FOUND);
    if (String(existing.rows[0].stage_name) === 'Converted') {
      throw new AppError(400, 'Cannot move lead from Converted stage', ErrorCodes.BAD_REQUEST);
    }

    const stageCheck = await db.read.query(
      'SELECT id, name FROM stages WHERE id = $1 AND pipeline_id = $2 AND organization_id = $3',
      [stageId, existing.rows[0].pipeline_id, user.organizationId],
    );
    if (!stageCheck.rows.length) throw new AppError(400, 'Stage not found', ErrorCodes.BAD_REQUEST);

    const fromStageId = existing.rows[0].stage_id;
    const result = await db.write.query(
      'UPDATE leads SET stage_id = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3 RETURNING *',
      [stageId, id, user.organizationId],
    );

    if (fromStageId !== stageId) {
      await publishStageChange(deps, {
        leadId: id, organizationId: user.organizationId, userId: user.id,
        contactId: existing.rows[0].contact_id, pipelineId: existing.rows[0].pipeline_id,
        fromStageId, toStageId: stageId!,
      });
    }

    const stageRow = stageCheck.rows[0] as { id: string; name: string };
    return { success: true, stage: { id: stageRow.id, name: stageRow.name }, ...result.rows[0] };
  });

  // Lead activity timeline
  app.get('/api/pipeline/leads/:id/activity', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id: leadId } = request.params as { id: string };
    const q = request.query as { limit?: string };
    const limit = Math.min(Math.max(parseInt(q.limit || '50', 10) || 50, 1), 100);

    const leadCheck = await db.read.query(
      'SELECT 1 FROM leads WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [leadId, user.organizationId],
    );
    if (!leadCheck.rows.length) throw new AppError(404, 'Lead not found', ErrorCodes.NOT_FOUND);

    const rows = await db.read.query(
      `SELECT id, lead_id, type, metadata, created_at, correlation_id
       FROM lead_activity_log WHERE lead_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [leadId, limit],
    );
    return rows.rows;
  });

  // Delete lead (soft delete)
  app.delete('/api/pipeline/leads/:id', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const result = await db.write.query(
      'UPDATE leads SET deleted_at = NOW() WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL RETURNING id',
      [id, user.organizationId],
    );
    if (!result.rows.length) throw new AppError(404, 'Lead not found', ErrorCodes.NOT_FOUND);
    reply.code(204).send();
  });

  // Pipelines that contain a contact — returns only pipelineIds (v1 compat)
  app.get('/api/pipeline/contacts/:contactId/pipelines', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { contactId } = request.params as { contactId: string };
    const result = await db.read.query(
      'SELECT l.pipeline_id FROM leads l WHERE l.organization_id = $1 AND l.contact_id = $2 AND l.deleted_at IS NULL',
      [user.organizationId, contactId],
    );
    return { pipelineIds: result.rows.map((r: Record<string, unknown>) => r.pipeline_id) };
  });

  // Move client (contact) to a stage — used by automation engine and INTERNAL_API
  app.put('/api/pipeline/clients/:clientId/stage', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { clientId } = request.params as { clientId: string };
    const { stageId, stage_id } = request.body as { stageId?: string; stage_id?: string };
    const resolvedStageId = stageId || stage_id;
    if (!resolvedStageId) throw new AppError(400, 'stageId is required', ErrorCodes.BAD_REQUEST);

    const lead = await db.read.query(
      'SELECT l.id, l.stage_id, l.pipeline_id, l.contact_id FROM leads l WHERE l.contact_id = $1 AND l.organization_id = $2 AND l.deleted_at IS NULL ORDER BY l.created_at DESC LIMIT 1',
      [clientId, user.organizationId],
    );
    if (!lead.rows.length) throw new AppError(404, 'Lead not found for this client', ErrorCodes.NOT_FOUND);
    const l = lead.rows[0] as { id: string; stage_id: string; pipeline_id: string; contact_id: string };

    const stageCheck = await db.read.query(
      'SELECT id, name FROM stages WHERE id = $1 AND pipeline_id = $2 AND organization_id = $3',
      [resolvedStageId, l.pipeline_id, user.organizationId],
    );
    if (!stageCheck.rows.length) throw new AppError(400, 'Stage not found or not in pipeline', ErrorCodes.BAD_REQUEST);

    const fromStageId = l.stage_id;
    await db.write.query(
      'UPDATE leads SET stage_id = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3',
      [resolvedStageId, l.id, user.organizationId],
    );

    if (fromStageId !== resolvedStageId) {
      await publishStageChange(deps, {
        leadId: l.id, organizationId: user.organizationId, userId: user.id,
        contactId: l.contact_id, pipelineId: l.pipeline_id,
        fromStageId, toStageId: resolvedStageId,
      });
    }

    return { success: true, leadId: l.id, stageId: resolvedStageId };
  });
}

// --- Shared: publish lead stage change + activity log ---
interface StageChangeParams {
  leadId: string; organizationId: string; userId: string;
  contactId: string; pipelineId: string; fromStageId: string; toStageId: string;
}

async function publishStageChange(deps: CoreDeps, p: StageChangeParams) {
  const { db, rabbitmq, log } = deps;
  const eventId = randomUUID();

  try {
    await db.write.query(
      `INSERT INTO lead_activity_log (id, lead_id, type, metadata, created_at, correlation_id)
       VALUES (gen_random_uuid(), $1, 'stage_changed', $2, NOW(), $3)`,
      [p.leadId, JSON.stringify({ from_stage_id: p.fromStageId, to_stage_id: p.toStageId }), eventId],
    );
  } catch (logErr) {
    log.warn({ message: 'lead_activity_log insert failed', entity_id: p.leadId, error: String(logErr) });
  }

  try {
    await db.write.query(
      `INSERT INTO stage_history (organization_id, entity_type, entity_id, pipeline_id, from_stage_id, to_stage_id, changed_by, source, correlation_id)
       VALUES ($1, 'lead', $2, $3, $4, $5, $6, 'manual', $7)`,
      [p.organizationId, p.leadId, p.pipelineId, p.fromStageId, p.toStageId, p.userId, eventId],
    );
  } catch (histErr) {
    log.warn({ message: 'stage_history insert failed', entity_id: p.leadId, error: String(histErr) });
  }

  const event = {
    id: eventId, type: EventType.LEAD_STAGE_CHANGED, timestamp: new Date(),
    organizationId: p.organizationId, userId: p.userId,
    data: {
      contactId: p.contactId, pipelineId: p.pipelineId,
      fromStageId: p.fromStageId, toStageId: p.toStageId,
      leadId: p.leadId, correlationId: eventId,
    },
  } as unknown as Event;

  try {
    await rabbitmq.publishEvent(event);
  } catch (e) {
    log.warn({ message: 'Failed to publish LEAD_STAGE_CHANGED', event_id: eventId, error: e instanceof Error ? e.message : String(e) });
  }
}
