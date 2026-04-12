import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { EventType, type Event } from '@getsale/events';
import { AppError, ErrorCodes, requireUser } from '@getsale/service-framework';
import type { CoreDeps } from '../types';

const CreateDealSchema = z.object({
  title: z.string().min(1).max(500),
  value: z.number().optional(),
  contactId: z.string().uuid().optional(),
  companyId: z.string().uuid().optional(),
  stageId: z.string().uuid().optional(),
  pipelineId: z.string().uuid().optional(),
  description: z.string().max(5000).optional(),
  leadId: z.string().uuid().optional(),
  bdAccountId: z.string().uuid().optional(),
  channel: z.string().max(100).optional(),
  channelId: z.string().max(500).optional(),
  history: z.array(z.unknown()).optional(),
  currency: z.string().max(10).optional(),
  probability: z.number().min(0).max(100).optional(),
  expectedCloseDate: z.string().optional(),
  comments: z.string().max(5000).optional(),
});

const UpdateDealSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  value: z.number().optional().nullable(),
  contactId: z.string().uuid().optional().nullable(),
  companyId: z.string().uuid().optional().nullable(),
  description: z.string().max(5000).optional().nullable(),
  currency: z.string().max(10).optional().nullable(),
  probability: z.number().min(0).max(100).optional().nullable(),
  expectedCloseDate: z.string().optional().nullable(),
  comments: z.string().max(5000).optional().nullable(),
  ownerId: z.string().uuid().optional(),
});

const StageUpdateSchema = z.object({
  stageId: z.string().uuid(),
  reason: z.string().max(1000).optional(),
  autoMoved: z.boolean().optional().default(false),
});

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  companyId: z.string().uuid().optional(),
  contactId: z.string().uuid().optional(),
  pipelineId: z.string().uuid().optional(),
  stageId: z.string().uuid().optional(),
  ownerId: z.string().uuid().optional(),
  createdBy: z.string().uuid().optional(),
  search: z.string().max(200).optional(),
});

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
    companyName: company_name ?? null, pipelineName: pipeline_name ?? null,
    stageName: stage_name ?? null, stageOrder: stage_order ?? null,
    contactName: contactName || undefined,
    ownerEmail: owner_email || undefined,
    creatorEmail: creator_email || undefined,
  };
}

export function registerDealRoutes(app: FastifyInstance, deps: CoreDeps): void {
  const { db, rabbitmq } = deps;

  app.get('/api/crm/deals', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const q = ListQuerySchema.parse(request.query);
    const page = q.page;
    const limit = q.limit;
    const offset = (page - 1) * limit;

    const conditions = ['d.organization_id = $1'];
    const params: unknown[] = [user.organizationId];
    let idx = 2;

    const filters: [string, string][] = [
      ['companyId', 'd.company_id'], ['contactId', 'd.contact_id'],
      ['pipelineId', 'd.pipeline_id'], ['stageId', 'd.stage_id'],
      ['ownerId', 'd.owner_id'], ['createdBy', 'd.created_by_id'],
    ];
    for (const [key, col] of filters) {
      const val = q[key as keyof typeof q] as string | undefined;
      if (val) {
        conditions.push(`${col} = $${idx}`);
        params.push(val);
        idx++;
      }
    }
    if (q.search) {
      conditions.push(`d.title ILIKE $${idx}`);
      params.push(`%${q.search}%`);
      idx++;
    }

    const where = conditions.join(' AND ');
    const [data, count] = await Promise.all([
      db.read.query(
        `SELECT d.*${DEAL_EXTRA_COLS} FROM deals d ${DEAL_JOINS} WHERE ${where} ORDER BY d.updated_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset],
      ),
      db.read.query(`SELECT COUNT(*) FROM deals d WHERE ${where}`, params),
    ]);
    const total = parseInt(count.rows[0].count, 10);
    return { items: data.rows.map(mapDealRow), pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
  });

  app.get('/api/crm/deals/:id', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const result = await db.read.query(
      `SELECT d.*${DEAL_EXTRA_COLS} FROM deals d ${DEAL_JOINS} WHERE d.id = $1 AND d.organization_id = $2`,
      [id, user.organizationId],
    );
    if (!result.rows.length) throw new AppError(404, 'Deal not found', ErrorCodes.NOT_FOUND);
    return mapDealRow(result.rows[0]);
  });

  app.post('/api/crm/deals', { preHandler: [requireUser] }, async (request, reply) => {
    const body = CreateDealSchema.parse(request.body);
    const user = request.user!;

    if (body.leadId) {
      const leadRow = await db.read.query(
        'SELECT id, contact_id, pipeline_id, stage_id FROM leads WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
        [body.leadId, user.organizationId],
      );
      if (!leadRow.rows.length) throw new AppError(404, 'Lead not found', ErrorCodes.NOT_FOUND);
      const lead = leadRow.rows[0] as { id: string; contact_id: string; pipeline_id: string; stage_id: string };

      const existingDeal = await db.read.query(
        'SELECT 1 FROM deals WHERE lead_id = $1 AND organization_id = $2',
        [body.leadId, user.organizationId],
      );
      if (existingDeal.rows.length > 0) throw new AppError(409, 'This lead is already linked to a deal', ErrorCodes.CONFLICT);

      const convertedStage = await db.read.query(
        "SELECT id FROM stages WHERE pipeline_id = $1 AND organization_id = $2 AND name = 'Converted' LIMIT 1",
        [lead.pipeline_id, user.organizationId],
      );
      if (!convertedStage.rows.length) throw new AppError(400, 'Pipeline must have a Converted stage', ErrorCodes.BAD_REQUEST);
      const convertedStageId = convertedStage.rows[0].id;

      let resolvedCompanyId = body.companyId ?? null;
      if (!resolvedCompanyId) {
        const cr = await db.read.query('SELECT company_id FROM contacts WHERE id = $1 AND organization_id = $2', [lead.contact_id, user.organizationId]);
        if (cr.rows.length > 0 && cr.rows[0].company_id) resolvedCompanyId = cr.rows[0].company_id;
      }

      let resolvedStageId = body.stageId ?? null;
      if (!resolvedStageId) {
        const firstStage = await db.read.query(
          'SELECT id FROM stages WHERE pipeline_id = $1 AND organization_id = $2 ORDER BY order_index ASC LIMIT 1',
          [lead.pipeline_id, user.organizationId],
        );
        resolvedStageId = firstStage.rows[0]?.id ?? null;
      }

      const client = await db.write.connect();
      try {
        await client.query('BEGIN');
        const insertResult = await client.query(
          `INSERT INTO deals (organization_id, company_id, contact_id, pipeline_id, stage_id, owner_id, created_by_id,
            lead_id, title, value, currency, probability, expected_close_date, comments, history)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [user.organizationId, resolvedCompanyId, lead.contact_id, lead.pipeline_id, resolvedStageId, user.id, user.id,
           body.leadId, body.title, body.value ?? null, body.currency ?? null, body.probability ?? null,
           body.expectedCloseDate ?? null, body.comments ?? null,
           JSON.stringify([{ id: randomUUID(), action: 'created_from_lead', toStageId: resolvedStageId, performedBy: user.id, timestamp: new Date() }])],
        );
        const deal = insertResult.rows[0];

        await client.query('UPDATE leads SET stage_id = $1, updated_at = NOW() WHERE id = $2', [convertedStageId, body.leadId]);
        await client.query(
          `INSERT INTO stage_history (organization_id, entity_type, entity_id, pipeline_id, from_stage_id, to_stage_id, changed_by, reason, source)
           VALUES ($1, 'lead', $2, $3, $4, $5, $6, 'Converted to deal', 'manual')`,
          [user.organizationId, body.leadId, lead.pipeline_id, lead.stage_id, convertedStageId, user.id],
        );
        await client.query('COMMIT');

        rabbitmq.publishEvent({
          id: randomUUID(), type: EventType.DEAL_CREATED, timestamp: new Date(),
          organizationId: user.organizationId, userId: user.id,
          correlationId: (request as any).correlationId || randomUUID(),
          data: { dealId: deal.id, leadId: body.leadId, pipelineId: lead.pipeline_id, stageId: resolvedStageId },
        } as unknown as Event).catch(() => {});

        reply.code(201);
        return deal;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }

    const stageId = body.stageId ?? null;
    const pipelineId = body.pipelineId ?? null;

    if (!pipelineId && !body.leadId) {
      throw new AppError(400, 'pipelineId is required when leadId is not provided', ErrorCodes.BAD_REQUEST);
    }

    let resolvedStageId = stageId;
    let resolvedPipelineId = pipelineId;

    if (pipelineId && !stageId) {
      const firstStage = await db.read.query(
        'SELECT id FROM stages WHERE pipeline_id = $1 AND organization_id = $2 ORDER BY order_index ASC LIMIT 1',
        [pipelineId, user.organizationId],
      );
      if (!firstStage.rows.length) throw new AppError(400, 'Pipeline has no stages', ErrorCodes.BAD_REQUEST);
      resolvedStageId = firstStage.rows[0].id;
    }

    if (stageId && !pipelineId) {
      const stageRow = await db.read.query(
        'SELECT pipeline_id FROM stages WHERE id = $1 AND organization_id = $2',
        [stageId, user.organizationId],
      );
      if (stageRow.rows.length) resolvedPipelineId = stageRow.rows[0].pipeline_id;
    }

    const historyEntry = [{
      id: randomUUID(), action: 'created', toStageId: resolvedStageId,
      performedBy: user.id, timestamp: new Date(),
    }];

    const result = await db.write.query(
      `INSERT INTO deals (organization_id, title, value, contact_id, company_id, stage_id, description,
        owner_id, created_by_id, pipeline_id, lead_id, bd_account_id, channel, channel_id,
        history, currency, probability, expected_close_date, comments)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [user.organizationId, body.title, body.value ?? null, body.contactId ?? null,
       body.companyId ?? null, resolvedStageId, body.description ?? null, user.id,
       resolvedPipelineId, body.leadId ?? null, body.bdAccountId ?? null,
       body.channel ?? null, body.channelId ?? null, JSON.stringify(body.history ?? historyEntry),
       body.currency ?? null, body.probability ?? null, body.expectedCloseDate ?? null,
       body.comments ?? null],
    );

    rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.DEAL_CREATED, timestamp: new Date(),
      organizationId: user.organizationId, userId: user.id,
      correlationId: (request as any).correlationId || randomUUID(),
      data: { dealId: result.rows[0].id, pipelineId: resolvedPipelineId, stageId: resolvedStageId, entityType: 'deal', entityId: result.rows[0].id },
    } as unknown as Event).catch(() => {});

    reply.code(201);
    return result.rows[0];
  });

  app.put('/api/crm/deals/:id', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const body = UpdateDealSchema.parse(request.body);

    const existing = await db.read.query(
      'SELECT * FROM deals WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!existing.rows.length) throw new AppError(404, 'Deal not found', ErrorCodes.NOT_FOUND);
    const prev = existing.rows[0] as Record<string, unknown>;

    const result = await db.write.query(
      `UPDATE deals SET
        title = COALESCE($2, title), value = $3, currency = $4, contact_id = $5,
        company_id = $6, description = $7, owner_id = COALESCE($8, owner_id),
        probability = $9, expected_close_date = $10, comments = $11, updated_at = NOW()
       WHERE id = $1 AND organization_id = $12 RETURNING *`,
      [id,
       body.title ?? prev.title,
       body.value !== undefined ? body.value : prev.value,
       body.currency !== undefined ? body.currency : prev.currency,
       body.contactId !== undefined ? body.contactId : prev.contact_id,
       body.companyId !== undefined ? body.companyId : prev.company_id,
       body.description !== undefined ? body.description : prev.description,
       body.ownerId ?? prev.owner_id,
       body.probability !== undefined ? body.probability : prev.probability,
       body.expectedCloseDate !== undefined ? body.expectedCloseDate : prev.expected_close_date,
       body.comments !== undefined ? body.comments : prev.comments,
       user.organizationId],
    );
    if (!result.rows.length) throw new AppError(404, 'Deal not found', ErrorCodes.NOT_FOUND);

    rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.DEAL_UPDATED, timestamp: new Date(),
      organizationId: user.organizationId, userId: user.id,
      correlationId: (request as any).correlationId || randomUUID(),
      data: { dealId: id, entityType: 'deal', entityId: id },
    } as unknown as Event).catch(() => {});

    return result.rows[0];
  });

  app.patch('/api/crm/deals/:id/stage', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const { stageId, reason, autoMoved } = StageUpdateSchema.parse(request.body);
    const user = request.user!;

    const dealResult = await db.write.query(
      'SELECT * FROM deals WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!dealResult.rows.length) throw new AppError(404, 'Deal not found', ErrorCodes.NOT_FOUND);
    const deal = dealResult.rows[0] as Record<string, unknown>;

    const history = Array.isArray(deal.history) ? [...(deal.history as unknown[])] : [];
    history.push({
      id: randomUUID(), action: 'stage_changed', fromStageId: deal.stage_id,
      toStageId: stageId, performedBy: user.id, timestamp: new Date(),
      reason: reason ?? undefined,
    });

    await db.write.query(
      'UPDATE deals SET stage_id = $1, history = $2, updated_at = NOW() WHERE id = $3',
      [stageId, JSON.stringify(history), id],
    );

    await db.write.query(
      `INSERT INTO stage_history (organization_id, entity_type, entity_id, pipeline_id, from_stage_id, to_stage_id, changed_by, reason, source)
       VALUES ($1, 'deal', $2, $3, $4, $5, $6, $7, $8)`,
      [user.organizationId, id, deal.pipeline_id, deal.stage_id, stageId, user.id,
       reason ?? null, autoMoved ? 'automation' : 'manual'],
    );

    rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.DEAL_STAGE_CHANGED, timestamp: new Date(),
      organizationId: user.organizationId, userId: user.id,
      correlationId: (request as any).correlationId || randomUUID(),
      data: { dealId: id, fromStageId: deal.stage_id, toStageId: stageId, reason, autoMoved },
    } as unknown as Event).catch(() => {});

    return { success: true };
  });

  app.delete('/api/crm/deals/:id', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const existing = await db.read.query(
      'SELECT 1 FROM deals WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!existing.rows.length) throw new AppError(404, 'Deal not found', ErrorCodes.NOT_FOUND);

    await db.write.query(
      "DELETE FROM stage_history WHERE entity_type = 'deal' AND entity_id = $1 AND organization_id = $2",
      [id, user.organizationId],
    );
    await db.write.query(
      'DELETE FROM deals WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );

    reply.code(204).send();
  });
}
