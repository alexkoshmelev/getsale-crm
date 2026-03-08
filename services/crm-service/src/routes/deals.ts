import { Router } from 'express';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { Counter } from 'prom-client';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, Event } from '@getsale/events';
import { Logger } from '@getsale/logger';
import { asyncHandler, validate, AppError, ErrorCodes } from '@getsale/service-core';
import { DealCreateSchema, DealUpdateSchema, DealStageUpdateSchema } from '../validation';
import { getFirstStageId, ensureStageInPipeline } from '../helpers';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  dealCreatedTotal: Counter;
  dealStageChangedTotal: Counter;
}

const DEAL_JOINS = `
  LEFT JOIN companies c ON d.company_id = c.id
  LEFT JOIN pipelines p ON d.pipeline_id = p.id
  LEFT JOIN stages s ON d.stage_id = s.id
  LEFT JOIN contacts cont ON d.contact_id = cont.id
  LEFT JOIN users u ON d.owner_id = u.id
  LEFT JOIN users creator ON d.created_by_id = creator.id`;

const DEAL_EXTRA_COLS = `,
  c.name AS company_name, p.name AS pipeline_name, s.name AS stage_name,
  s.order_index AS stage_order, cont.display_name AS contact_display_name,
  cont.first_name AS contact_first_name, cont.last_name AS contact_last_name,
  cont.email AS contact_email, u.email AS owner_email, creator.email AS creator_email`;

function mapDealRow(r: Record<string, unknown>) {
  const { company_name, pipeline_name, stage_name, stage_order,
    contact_display_name, contact_first_name, contact_last_name,
    contact_email, owner_email, creator_email, lead_id, ...deal } = r as Record<string, any>;
  const contactName =
    contact_display_name?.trim() ||
    [contact_first_name?.trim(), contact_last_name?.trim()].filter(Boolean).join(' ') ||
    contact_email?.trim() || null;
  return {
    ...deal,
    leadId: lead_id ?? undefined,
    companyName: company_name, pipelineName: pipeline_name,
    stageName: stage_name, stageOrder: stage_order,
    contactName: contactName || undefined,
    ownerEmail: owner_email || undefined,
    creatorEmail: creator_email || undefined,
  };
}

export function dealsRouter({ pool, rabbitmq, log, dealCreatedTotal, dealStageChangedTotal }: Deps): Router {
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));

    let where = 'WHERE d.organization_id = $1';
    const params: unknown[] = [organizationId];

    for (const [key, col] of [
      ['companyId', 'd.company_id'], ['contactId', 'd.contact_id'],
      ['pipelineId', 'd.pipeline_id'], ['stageId', 'd.stage_id'],
      ['ownerId', 'd.owner_id'], ['createdBy', 'd.created_by_id'],
    ] as const) {
      const val = typeof req.query[key] === 'string' ? req.query[key] : undefined;
      if (val) { params.push(val); where += ` AND ${col} = $${params.length}`; }
    }
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    if (search) { params.push(`%${search}%`); where += ` AND d.title ILIKE $${params.length}`; }

    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM deals d ${where}`, params);
    const total = countResult.rows[0].total;

    const offset = (page - 1) * limit;
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT d.*${DEAL_EXTRA_COLS} FROM deals d ${DEAL_JOINS} ${where}
       ORDER BY d.updated_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      items: result.rows.map(mapDealRow),
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const result = await pool.query(
      `SELECT d.*${DEAL_EXTRA_COLS} FROM deals d ${DEAL_JOINS}
       WHERE d.id = $1 AND d.organization_id = $2`,
      [req.params.id, organizationId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'Deal not found', ErrorCodes.NOT_FOUND);
    res.json(mapDealRow(result.rows[0]));
  }));

  router.post('/', validate(DealCreateSchema), asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const data = req.body;
    const { companyId, contactId, pipelineId, stageId: bodyStageId, leadId,
      title, value, currency, probability, expectedCloseDate, comments,
      bdAccountId, channel, channelId } = data;

    const fromChat = bdAccountId != null && channel != null && channelId != null;
    const fromContactOnly = contactId != null && !fromChat && (companyId == null || companyId === '');

    // --- Lead-based deal creation ---
    if (leadId) {
      const deal = await createDealFromLead({
        pool, rabbitmq, log, dealCreatedTotal,
        userId, organizationId, leadId, companyId, contactId,
        pipelineId, bodyStageId, title, value, currency, probability,
        expectedCloseDate, comments, bdAccountId, channel, channelId,
        correlationId: req.correlationId,
      });
      return res.status(201).json(deal);
    }

    // --- Standard deal creation ---
    if (!fromChat && !fromContactOnly && (pipelineId == null || pipelineId === '')) {
      throw new AppError(400, 'pipelineId is required when leadId is not provided', ErrorCodes.VALIDATION);
    }

    let resolvedCompanyId = companyId ?? null;
    if (!fromChat && !fromContactOnly && companyId) {
      const check = await pool.query('SELECT 1 FROM companies WHERE id = $1 AND organization_id = $2', [companyId, organizationId]);
      if (check.rows.length === 0) throw new AppError(400, 'Company not found or access denied', ErrorCodes.VALIDATION);
    }
    if (fromContactOnly && contactId) {
      const cr = await pool.query('SELECT company_id FROM contacts WHERE id = $1 AND organization_id = $2', [contactId, organizationId]);
      if (cr.rows.length > 0 && cr.rows[0].company_id) resolvedCompanyId = cr.rows[0].company_id;
    }

    const pipeCheck = await pool.query('SELECT 1 FROM pipelines WHERE id = $1 AND organization_id = $2', [pipelineId, organizationId]);
    if (pipeCheck.rows.length === 0) throw new AppError(400, 'Pipeline not found or access denied', ErrorCodes.VALIDATION);

    let stageId = bodyStageId ?? null;
    if (!stageId) {
      stageId = await getFirstStageId(pool, pipelineId!, organizationId);
      if (!stageId) throw new AppError(400, 'Pipeline has no stages. Create at least one stage first.', ErrorCodes.VALIDATION);
    } else {
      await ensureStageInPipeline(pool, stageId, pipelineId!, organizationId);
    }

    if (contactId) {
      const cc = await pool.query('SELECT 1 FROM contacts WHERE id = $1 AND organization_id = $2', [contactId, organizationId]);
      if (cc.rows.length === 0) throw new AppError(400, 'Contact not found or access denied', ErrorCodes.VALIDATION);
    }

    const result = await pool.query(
      `INSERT INTO deals (organization_id, company_id, contact_id, pipeline_id, stage_id, owner_id, created_by_id,
        title, value, currency, probability, expected_close_date, comments, history, bd_account_id, channel, channel_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
      [organizationId, resolvedCompanyId, contactId ?? null, pipelineId, stageId, userId, userId,
       title, value ?? null, currency ?? null, probability ?? null, expectedCloseDate ?? null, comments ?? null,
       JSON.stringify([{ id: randomUUID(), action: 'created', toStageId: stageId, performedBy: userId, timestamp: new Date() }]),
       bdAccountId ?? null, channel ?? null, channelId ?? null]
    );

    dealCreatedTotal.inc();
    await rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.DEAL_CREATED, timestamp: new Date(),
      organizationId, userId, data: { dealId: result.rows[0].id, pipelineId, stageId },
    } as Event);

    res.status(201).json(result.rows[0]);
  }));

  router.put('/:id', validate(DealUpdateSchema), asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { id } = req.params;
    const existing = await pool.query('SELECT * FROM deals WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    if (existing.rows.length === 0) throw new AppError(404, 'Deal not found', ErrorCodes.NOT_FOUND);

    const d = req.body;
    const row = existing.rows[0];
    const result = await pool.query(
      `UPDATE deals SET title = COALESCE($2, title), value = $3, currency = $4, contact_id = $5,
        owner_id = COALESCE($6, owner_id), probability = $7, expected_close_date = $8, comments = $9, updated_at = NOW()
       WHERE id = $1 AND organization_id = $10 RETURNING *`,
      [id, d.title ?? row.title, d.value !== undefined ? d.value : row.value,
       d.currency !== undefined ? d.currency : row.currency,
       d.contactId !== undefined ? d.contactId : row.contact_id,
       d.ownerId ?? row.owner_id, d.probability !== undefined ? d.probability : row.probability,
       d.expectedCloseDate !== undefined ? d.expectedCloseDate : row.expected_close_date,
       d.comments !== undefined ? d.comments : row.comments, organizationId]
    );

    await rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.DEAL_UPDATED, timestamp: new Date(),
      organizationId, userId, data: { dealId: id },
    } as Event);
    res.json(result.rows[0]);
  }));

  router.patch('/:id/stage', validate(DealStageUpdateSchema), asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { id } = req.params;
    const { stageId, reason, autoMoved = false } = req.body;

    const dealResult = await pool.query('SELECT * FROM deals WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    if (dealResult.rows.length === 0) throw new AppError(404, 'Deal not found', ErrorCodes.NOT_FOUND);
    const deal = dealResult.rows[0];

    await ensureStageInPipeline(pool, stageId, deal.pipeline_id, organizationId);

    const history = Array.isArray(deal.history) ? [...deal.history] : [];
    history.push({
      id: randomUUID(), action: 'stage_changed', fromStageId: deal.stage_id,
      toStageId: stageId, performedBy: userId, timestamp: new Date(), reason: reason ?? undefined,
    });

    await pool.query('UPDATE deals SET stage_id = $1, history = $2, updated_at = NOW() WHERE id = $3',
      [stageId, JSON.stringify(history), id]);

    dealStageChangedTotal.inc();
    await pool.query(
      `INSERT INTO stage_history (organization_id, entity_type, entity_id, pipeline_id, from_stage_id, to_stage_id, changed_by, reason, source, correlation_id)
       VALUES ($1, 'deal', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [organizationId, id, deal.pipeline_id, deal.stage_id, stageId, userId, reason ?? null,
       autoMoved ? 'automation' : 'manual', req.correlationId]
    );

    await rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.DEAL_STAGE_CHANGED, timestamp: new Date(),
      organizationId, userId,
      data: { dealId: id, fromStageId: deal.stage_id, toStageId: stageId, reason, autoMoved },
    } as Event);

    res.json({ success: true });
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const existing = await pool.query('SELECT 1 FROM deals WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    if (existing.rows.length === 0) throw new AppError(404, 'Deal not found', ErrorCodes.NOT_FOUND);
    await pool.query(
      "DELETE FROM stage_history WHERE entity_type = 'deal' AND entity_id = $1 AND organization_id = $2",
      [id, organizationId]
    );
    await pool.query('DELETE FROM deals WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    res.status(204).send();
  }));

  return router;
}

// --- Lead → Deal conversion (transactional) ---
interface CreateFromLeadParams {
  pool: Pool; rabbitmq: RabbitMQClient; log: Logger; dealCreatedTotal: Counter;
  userId: string; organizationId: string; leadId: string;
  companyId?: string | null; contactId?: string | null;
  pipelineId?: string | null; bodyStageId?: string | null;
  title: string; value?: number | null; currency?: string | null;
  probability?: number | null; expectedCloseDate?: string | null;
  comments?: string | null; bdAccountId?: string | null;
  channel?: string | null; channelId?: string | null;
  correlationId: string;
}

async function createDealFromLead(p: CreateFromLeadParams) {
  const { pool, rabbitmq, log, dealCreatedTotal } = p;

  const leadRow = await pool.query(
    'SELECT id, contact_id, pipeline_id, stage_id FROM leads WHERE id = $1 AND organization_id = $2',
    [p.leadId, p.organizationId]
  );
  if (leadRow.rows.length === 0) throw new AppError(404, 'Lead not found', ErrorCodes.NOT_FOUND);
  const lead = leadRow.rows[0];

  const existingDeal = await pool.query(
    'SELECT 1 FROM deals WHERE lead_id = $1 AND organization_id = $2',
    [p.leadId, p.organizationId]
  );
  if (existingDeal.rows.length > 0) throw new AppError(409, 'This lead is already linked to a deal', ErrorCodes.CONFLICT);

  if (p.pipelineId != null && p.pipelineId !== lead.pipeline_id) {
    throw new AppError(400, "pipelineId must match lead's pipeline", ErrorCodes.VALIDATION);
  }

  const convertedStage = await pool.query(
    "SELECT id FROM stages WHERE pipeline_id = $1 AND organization_id = $2 AND name = 'Converted' LIMIT 1",
    [lead.pipeline_id, p.organizationId]
  );
  if (convertedStage.rows.length === 0) throw new AppError(400, 'Pipeline must have a Converted stage', ErrorCodes.VALIDATION);
  const convertedStageId = convertedStage.rows[0].id;

  let resolvedCompanyId = p.companyId ?? null;
  if (!p.companyId) {
    const cr = await pool.query('SELECT company_id FROM contacts WHERE id = $1 AND organization_id = $2', [lead.contact_id, p.organizationId]);
    if (cr.rows.length > 0 && cr.rows[0].company_id) resolvedCompanyId = cr.rows[0].company_id;
  }

  let stageId = p.bodyStageId ?? null;
  if (!stageId) {
    stageId = await getFirstStageId(pool, lead.pipeline_id, p.organizationId);
    if (!stageId) throw new AppError(400, 'Pipeline has no stages', ErrorCodes.VALIDATION);
  } else {
    await ensureStageInPipeline(pool, stageId, lead.pipeline_id, p.organizationId);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const insertResult = await client.query(
      `INSERT INTO deals (organization_id, company_id, contact_id, pipeline_id, stage_id, owner_id, created_by_id,
        lead_id, title, value, currency, probability, expected_close_date, comments, history, bd_account_id, channel, channel_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [p.organizationId, resolvedCompanyId, lead.contact_id, lead.pipeline_id, stageId, p.userId, p.userId,
       p.leadId, p.title, p.value ?? null, p.currency ?? null, p.probability ?? null,
       p.expectedCloseDate ?? null, p.comments ?? null,
       JSON.stringify([{ id: randomUUID(), action: 'created', toStageId: stageId, performedBy: p.userId, timestamp: new Date() }]),
       p.bdAccountId ?? null, p.channel ?? null, p.channelId ?? null]
    );
    const deal = insertResult.rows[0];

    await client.query('UPDATE leads SET stage_id = $1, updated_at = NOW() WHERE id = $2', [convertedStageId, p.leadId]);
    await client.query(
      `INSERT INTO stage_history (organization_id, entity_type, entity_id, pipeline_id, from_stage_id, to_stage_id, changed_by, reason, source, correlation_id)
       VALUES ($1, 'lead', $2, $3, $4, $5, $6, $7, 'manual', $8)`,
      [p.organizationId, p.leadId, lead.pipeline_id, lead.stage_id, convertedStageId, p.userId, 'Converted to deal', p.correlationId]
    );
    await client.query('COMMIT');

    dealCreatedTotal.inc();
    log.info({
      message: 'Deal created from lead',
      correlation_id: p.correlationId,
      entity_type: 'deal', entity_id: deal.id, lead_id: p.leadId,
    });

    await rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.DEAL_CREATED, timestamp: new Date(),
      organizationId: p.organizationId, userId: p.userId,
      data: { dealId: deal.id, pipelineId: lead.pipeline_id, stageId, leadId: p.leadId },
    } as Event).catch((err) => log.warn({ message: 'Failed to publish deal.created', error: String(err) }));

    await rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.LEAD_CONVERTED, timestamp: new Date(),
      organizationId: p.organizationId, userId: p.userId,
      data: { leadId: p.leadId, dealId: deal.id, pipelineId: lead.pipeline_id, convertedAt: new Date().toISOString() },
    } as Event).catch((err) => log.warn({ message: 'Failed to publish lead.converted', error: String(err) }));

    const { lead_id, ...rest } = deal;
    return { ...rest, leadId: lead_id ?? undefined };
  } catch (txErr) {
    await client.query('ROLLBACK').catch(() => {});
    throw txErr;
  } finally {
    client.release();
  }
}
