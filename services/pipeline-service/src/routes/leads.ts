import { Router } from 'express';
import { Pool } from 'pg';
import crypto from 'crypto';
import { Counter } from 'prom-client';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, Event } from '@getsale/events';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, validate, withOrgContext, parsePageLimit, buildPagedResponse } from '@getsale/service-core';
import { PlLeadCreateSchema, type PlLeadCreateInput } from '../validation';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  eventPublishTotal: Counter;
}

export function leadsRouter({ pool, rabbitmq, log, eventPublishTotal }: Deps): Router {
  const router = Router();

  // Pipelines that contain a contact
  router.get('/contacts/:contactId/pipelines', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const contactId = req.params.contactId?.trim();
    if (!contactId) throw new AppError(400, 'contactId is required', ErrorCodes.BAD_REQUEST);

    const result = await pool.query(
      'SELECT l.pipeline_id FROM leads l WHERE l.organization_id = $1 AND l.contact_id = $2 AND l.deleted_at IS NULL',
      [organizationId, contactId]
    );
    res.json({ pipelineIds: result.rows.map((r: Record<string, unknown>) => r.pipeline_id) });
  }));

  // List leads for a pipeline
  router.get('/leads', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { pipelineId, stageId, page, limit } = req.query;

    if (!pipelineId || typeof pipelineId !== 'string') {
      throw new AppError(400, 'pipelineId is required', ErrorCodes.BAD_REQUEST);
    }

    const stageIdTrim = typeof stageId === 'string' ? stageId.trim() : null;
    const { page: pageNum, limit: limitNum, offset } = parsePageLimit(
      { page, limit } as Record<string, unknown>,
      20,
      100
    );

    const params: unknown[] = [organizationId, pipelineId.trim()];
    let where = 'l.organization_id = $1 AND l.pipeline_id = $2 AND l.deleted_at IS NULL';
    if (stageIdTrim) {
      params.push(stageIdTrim);
      where += ` AND l.stage_id = $${params.length}`;
    }

    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM leads l WHERE ${where}`, params);
    const total = countResult.rows[0]?.total ?? 0;

    params.push(limitNum, offset);
    const limitIdx = params.length - 1;
    const offsetIdx = params.length;

    const result = await pool.query(
      `SELECT l.id, l.contact_id, l.pipeline_id, l.stage_id, l.order_index, l.created_at, l.updated_at, l.responsible_id, l.revenue_amount,
        c.first_name, c.last_name, c.display_name, c.username, c.email, c.telegram_id,
        u.email AS responsible_email
       FROM leads l
       JOIN contacts c ON c.id = l.contact_id AND c.organization_id = l.organization_id
       LEFT JOIN users u ON u.id = l.responsible_id
       WHERE ${where}
       ORDER BY l.order_index ASC, l.created_at ASC
       LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
      params
    );

    res.json(buildPagedResponse(result.rows, total, pageNum, limitNum));
  }));

  // Add contact to funnel
  router.post('/leads', validate(PlLeadCreateSchema), asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { contactId, pipelineId, stageId, responsibleId } = req.body as PlLeadCreateInput;

    const contactCheck = await pool.query('SELECT 1 FROM contacts WHERE id = $1 AND organization_id = $2', [contactId, organizationId]);
    if (contactCheck.rows.length === 0) throw new AppError(404, 'Contact not found', ErrorCodes.NOT_FOUND);

    const pipelineCheck = await pool.query('SELECT 1 FROM pipelines WHERE id = $1 AND organization_id = $2', [pipelineId, organizationId]);
    if (pipelineCheck.rows.length === 0) throw new AppError(404, 'Pipeline not found', ErrorCodes.NOT_FOUND);

    let targetStageId = stageId;
    if (!targetStageId) {
      const firstStage = await pool.query(
        'SELECT id FROM stages WHERE pipeline_id = $1 AND organization_id = $2 ORDER BY order_index ASC LIMIT 1',
        [pipelineId, organizationId]
      );
      if (firstStage.rows.length === 0) throw new AppError(400, 'Pipeline has no stages', ErrorCodes.BAD_REQUEST);
      targetStageId = firstStage.rows[0].id;
    } else {
      const stageCheck = await pool.query(
        'SELECT 1 FROM stages WHERE id = $1 AND pipeline_id = $2 AND organization_id = $3',
        [targetStageId, pipelineId, organizationId]
      );
      if (stageCheck.rows.length === 0) throw new AppError(400, 'Stage not found or does not belong to pipeline', ErrorCodes.BAD_REQUEST);
    }

    let responsibleIdValid: string | null = null;
    const candidateId = (responsibleId && typeof responsibleId === 'string' ? responsibleId : userId) as string;
    const userCheck = await pool.query(
      'SELECT id FROM users WHERE id = $1 AND id IN (SELECT user_id FROM organization_members WHERE organization_id = $2)',
      [candidateId, organizationId]
    );
    if (userCheck.rows.length > 0) responsibleIdValid = candidateId;

    const insert = await withOrgContext(pool, organizationId, async (client) => {
      const existing = await client.query(
        'SELECT id FROM leads WHERE organization_id = $1 AND contact_id = $2 AND pipeline_id = $3 AND deleted_at IS NULL',
        [organizationId, contactId, pipelineId]
      );
      if (existing.rows.length > 0) {
        const existingLeadId = (existing.rows[0] as { id: string }).id;
        throw new AppError(409, 'Contact is already in this pipeline', ErrorCodes.CONFLICT, {
          leadId: existingLeadId,
        });
      }
      const maxOrder = await client.query('SELECT COALESCE(MAX(order_index), -1) + 1 AS next FROM leads WHERE stage_id = $1', [targetStageId]);
      const orderIndex = maxOrder.rows[0]?.next ?? 0;
      const result = await client.query(
        `INSERT INTO leads (organization_id, contact_id, pipeline_id, stage_id, order_index, responsible_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [organizationId, contactId, pipelineId, targetStageId, orderIndex, responsibleIdValid]
      );
      return result.rows[0];
    });

    await rabbitmq.publishEvent({
      id: crypto.randomUUID(), type: EventType.LEAD_CREATED, timestamp: new Date(),
      organizationId, userId, correlationId: req.correlationId,
      data: { contactId, pipelineId, stageId: targetStageId, leadId: (insert as { id: string }).id },
    } as Event).catch((e) => log.warn({ message: 'Failed to publish LEAD_CREATED', error: String(e) }));

    res.status(201).json(insert);
  }));

  // Update lead (move stage / reorder / responsible / amount)
  router.patch('/leads/:id', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { id } = req.params;
    const { stageId, orderIndex, responsibleId, revenueAmount } = req.body;

    const existing = await pool.query(
      'SELECT l.*, s.name AS stage_name FROM leads l JOIN stages s ON s.id = l.stage_id WHERE l.id = $1 AND l.organization_id = $2 AND l.deleted_at IS NULL',
      [id, organizationId]
    );
    if (existing.rows.length === 0) throw new AppError(404, 'Lead not found', ErrorCodes.NOT_FOUND);

    if (stageId != null && String(existing.rows[0].stage_name) === 'Converted') {
      throw new AppError(400, 'Cannot move lead from Converted stage', ErrorCodes.BAD_REQUEST);
    }

    const updates: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let idx = 1;

    if (stageId != null) {
      const stageCheck = await pool.query(
        'SELECT 1 FROM stages WHERE id = $1 AND pipeline_id = $2 AND organization_id = $3',
        [stageId, existing.rows[0].pipeline_id, organizationId]
      );
      if (stageCheck.rows.length === 0) throw new AppError(400, 'Stage not found', ErrorCodes.BAD_REQUEST);
      params.push(stageId);
      updates.push(`stage_id = $${idx++}`);
    }
    if (typeof orderIndex === 'number') {
      params.push(orderIndex);
      updates.push(`order_index = $${idx++}`);
    }
    if (responsibleId !== undefined) {
      const newResponsible = responsibleId === null || (typeof responsibleId === 'string' && responsibleId.trim() === '')
        ? null
        : String(responsibleId).trim();
      if (newResponsible === null) {
        updates.push('responsible_id = NULL');
      } else {
        const respCheck = await pool.query(
          'SELECT id FROM users WHERE id = $1 AND id IN (SELECT user_id FROM organization_members WHERE organization_id = $2)',
          [newResponsible, organizationId]
        );
        if (respCheck.rows.length === 0) throw new AppError(400, 'Responsible user not found in organization', ErrorCodes.BAD_REQUEST);
        params.push(newResponsible);
        updates.push(`responsible_id = $${idx++}`);
      }
    }
    if (revenueAmount !== undefined) {
      if (revenueAmount === null || revenueAmount === '') {
        updates.push('revenue_amount = NULL');
      } else {
        const num = Number(revenueAmount);
        if (Number.isNaN(num)) throw new AppError(400, 'Invalid revenue amount', ErrorCodes.BAD_REQUEST);
        params.push(num);
        updates.push(`revenue_amount = $${idx++}`);
      }
    }

    if (params.length === 0) return res.json(existing.rows[0]);

    params.push(id, organizationId);
    const result = await withOrgContext(pool, organizationId, async (client) => {
      return client.query(
        `UPDATE leads SET ${updates.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1} RETURNING *`,
        params
      );
    });

    const fromStageId = existing.rows[0].stage_id;
    if (stageId != null && fromStageId !== stageId) {
      await publishStageChange({ pool, rabbitmq, log, eventPublishTotal,
        leadId: id, organizationId, userId, contactId: existing.rows[0].contact_id,
        pipelineId: existing.rows[0].pipeline_id, fromStageId, toStageId: stageId, correlationId: req.correlationId });
    }

    res.json(result.rows[0]);
  }));

  // Narrow contract: stage change only
  router.patch('/leads/:id/stage', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { id } = req.params;
    const stageId = req.body?.stage_id ?? req.body?.stageId;
    if (stageId == null || typeof stageId !== 'string') {
      throw new AppError(400, 'stage_id required', ErrorCodes.BAD_REQUEST);
    }
    const stage = await applyLeadStageChange(
      { pool, rabbitmq, log, eventPublishTotal },
      { leadId: id, organizationId, userId, stageId, correlationId: req.correlationId }
    );
    res.json({ stage: { id: stage.id, name: stage.name } });
  }));

  // Move lead stage by contact id (for automation / service-to-service). Requires X-Organization-Id (context).
  router.put('/clients/:clientId/stage', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const clientId = req.params.clientId?.trim();
    if (!clientId) throw new AppError(400, 'clientId (contactId) is required', ErrorCodes.BAD_REQUEST);

    const body = req.body as { stageId?: string; stage_id?: string; pipelineId?: string };
    const stageId = body?.stageId ?? body?.stage_id;
    if (stageId == null || typeof stageId !== 'string') {
      throw new AppError(400, 'stageId is required', ErrorCodes.BAD_REQUEST);
    }

    const pipelineId = typeof body?.pipelineId === 'string' ? body.pipelineId.trim() : null;
    let leadRow: { id: string; pipeline_id: string; contact_id: string; stage_id: string };
    if (pipelineId) {
      const r = await pool.query(
        'SELECT id, pipeline_id, contact_id, stage_id FROM leads WHERE organization_id = $1 AND contact_id = $2 AND pipeline_id = $3 AND deleted_at IS NULL LIMIT 1',
        [organizationId, clientId, pipelineId]
      );
      if (r.rows.length === 0) throw new AppError(404, 'Lead not found for this contact and pipeline', ErrorCodes.NOT_FOUND);
      leadRow = r.rows[0] as { id: string; pipeline_id: string; contact_id: string; stage_id: string };
    } else {
      const r = await pool.query(
        'SELECT id, pipeline_id, contact_id, stage_id FROM leads WHERE organization_id = $1 AND contact_id = $2 AND deleted_at IS NULL ORDER BY updated_at DESC LIMIT 1',
        [organizationId, clientId]
      );
      if (r.rows.length === 0) throw new AppError(404, 'Lead not found for this contact', ErrorCodes.NOT_FOUND);
      leadRow = r.rows[0] as { id: string; pipeline_id: string; contact_id: string; stage_id: string };
    }

    const stage = await applyLeadStageChange(
      { pool, rabbitmq, log, eventPublishTotal },
      { leadId: leadRow.id, organizationId, userId, stageId, correlationId: req.correlationId }
    );
    res.json({ stage: { id: stage.id, name: stage.name } });
  }));

  // Lead activity timeline
  router.get('/leads/:id/activity', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id: leadId } = req.params;
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '50'), 10) || 50, 1), 100);

    const leadCheck = await pool.query('SELECT 1 FROM leads WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [leadId, organizationId]);
    if (leadCheck.rows.length === 0) throw new AppError(404, 'Lead not found', ErrorCodes.NOT_FOUND);

    const rows = await pool.query(
      `SELECT id, lead_id, type, metadata, created_at, correlation_id
       FROM lead_activity_log WHERE lead_id = $1 ORDER BY created_at DESC LIMIT $2`,
      [leadId, limit]
    );
    res.json(rows.rows);
  }));

  // Delete lead
  router.delete('/leads/:id', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const result = await withOrgContext(pool, organizationId, (client) =>
      client.query(
        'UPDATE leads SET deleted_at = NOW() WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL RETURNING id',
        [id, organizationId]
      )
    );
    if (result.rows.length === 0) throw new AppError(404, 'Lead not found', ErrorCodes.NOT_FOUND);
    res.status(204).send();
  }));

  return router;
}

// --- Shared: apply stage change to a lead (validation + update + publish) ---
interface ApplyStageChangeDeps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  eventPublishTotal: Counter;
}

async function applyLeadStageChange(
  deps: ApplyStageChangeDeps,
  params: { leadId: string; organizationId: string; userId: string; stageId: string; correlationId?: string }
): Promise<{ id: string; name: string }> {
  const { pool, rabbitmq, log, eventPublishTotal } = deps;
  const { leadId, organizationId, userId, stageId, correlationId } = params;

  const existing = await pool.query(
    'SELECT l.*, s.name AS stage_name FROM leads l JOIN stages s ON s.id = l.stage_id WHERE l.id = $1 AND l.organization_id = $2 AND l.deleted_at IS NULL',
    [leadId, organizationId]
  );
  if (existing.rows.length === 0) throw new AppError(404, 'Lead not found', ErrorCodes.NOT_FOUND);
  if (String(existing.rows[0].stage_name) === 'Converted') {
    throw new AppError(400, 'Cannot move lead from Converted stage', ErrorCodes.BAD_REQUEST);
  }

  const stageCheck = await pool.query(
    'SELECT id, name FROM stages WHERE id = $1 AND pipeline_id = $2 AND organization_id = $3',
    [stageId, existing.rows[0].pipeline_id, organizationId]
  );
  if (stageCheck.rows.length === 0) throw new AppError(400, 'Stage not found', ErrorCodes.BAD_REQUEST);

  const fromStageId = existing.rows[0].stage_id;
  await pool.query('UPDATE leads SET stage_id = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3',
    [stageId, leadId, organizationId]);

  await publishStageChange({ pool, rabbitmq, log, eventPublishTotal,
    leadId, organizationId, userId, contactId: existing.rows[0].contact_id,
    pipelineId: existing.rows[0].pipeline_id, fromStageId, toStageId: stageId, correlationId });

  const stageRow = stageCheck.rows[0] as { id: string; name: string };
  return { id: stageRow.id, name: stageRow.name };
}

// --- Shared: publish lead stage change + activity log ---
interface StageChangeParams {
  pool: Pool; rabbitmq: RabbitMQClient; log: Logger;
  eventPublishTotal: Counter;
  leadId: string; organizationId: string; userId: string;
  contactId: string; pipelineId: string; fromStageId: string; toStageId: string;
  correlationId?: string;
}

async function publishStageChange(p: StageChangeParams) {
  const eventId = crypto.randomUUID();

  try {
    await p.pool.query(
      `INSERT INTO lead_activity_log (id, lead_id, type, metadata, created_at, correlation_id)
       VALUES (gen_random_uuid(), $1, 'stage_changed', $2, NOW(), $3)`,
      [p.leadId, JSON.stringify({ from_stage_id: p.fromStageId, to_stage_id: p.toStageId }), eventId]
    );
  } catch (logErr) {
    p.log.warn({ message: 'lead_activity_log insert failed', entity_id: p.leadId, error: String(logErr) });
  }

  try {
    await p.pool.query(
      `INSERT INTO stage_history (organization_id, entity_type, entity_id, pipeline_id, from_stage_id, to_stage_id, changed_by, source, correlation_id)
       VALUES ($1, 'lead', $2, $3, $4, $5, $6, 'manual', $7)`,
      [p.organizationId, p.leadId, p.pipelineId, p.fromStageId, p.toStageId, p.userId, eventId]
    );
  } catch (histErr) {
    p.log.warn({ message: 'stage_history insert failed', entity_id: p.leadId, error: String(histErr) });
  }

  const event = {
    id: eventId, type: EventType.LEAD_STAGE_CHANGED, timestamp: new Date(),
    organizationId: p.organizationId, userId: p.userId, correlationId: p.correlationId,
    data: {
      contactId: p.contactId, pipelineId: p.pipelineId,
      fromStageId: p.fromStageId, toStageId: p.toStageId,
      leadId: p.leadId, correlationId: eventId,
    },
  } as Event;

  try {
    p.log.info({ message: 'publish lead.stage.changed', event_id: eventId, correlation_id: eventId, entity_type: 'lead', entity_id: p.leadId });
    await p.rabbitmq.publishEvent(event);
    p.eventPublishTotal.inc({ event_type: EventType.LEAD_STAGE_CHANGED });
  } catch (e) {
    p.log.error({ message: 'Failed to publish LEAD_STAGE_CHANGED', event_id: eventId, correlation_id: eventId, error: e instanceof Error ? e.message : String(e) });
  }
}
