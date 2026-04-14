import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { AppError, ErrorCodes, requireUser, DatabasePools } from '@getsale/service-framework';
import { Logger } from '@getsale/logger';

interface Deps {
  db: DatabasePools;
  log: Logger;
}

const SequenceCreateSchema = z.object({
  orderIndex: z.number().int().min(0).optional(),
  templateId: z.string().uuid(),
  delayHours: z.number().int().min(0).optional(),
  delayMinutes: z.number().int().min(0).max(59).optional(),
  conditions: z.record(z.string(), z.unknown()).optional(),
  triggerType: z.enum(['delay', 'after_reply']).optional(),
  isHidden: z.boolean().optional(),
});

const SequenceUpdateSchema = z.object({
  orderIndex: z.number().int().min(0).optional(),
  templateId: z.string().uuid().optional(),
  delayHours: z.number().int().min(0).optional(),
  delayMinutes: z.number().int().min(0).max(59).optional(),
  conditions: z.record(z.string(), z.unknown()).optional(),
  triggerType: z.enum(['delay', 'after_reply']).optional(),
  isHidden: z.boolean().optional(),
});

export function registerSequenceRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;

  app.get('/api/campaigns/:id/sequences', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const campaign = await db.read.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!campaign.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const result = await db.read.query(
      `SELECT cs.*, ct.name as template_name, ct.channel, ct.content
       FROM campaign_sequences cs
       JOIN campaign_templates ct ON ct.id = cs.template_id
       WHERE cs.campaign_id = $1
       ORDER BY cs.order_index`,
      [id],
    );
    return result.rows;
  });

  app.post('/api/campaigns/:id/sequences', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const body = SequenceCreateSchema.parse(request.body);

    const campaign = await db.read.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!campaign.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const template = await db.read.query(
      'SELECT id FROM campaign_templates WHERE id = $1 AND campaign_id = $2',
      [body.templateId, id],
    );
    if (!template.rows.length) {
      throw new AppError(400, 'Template not found or does not belong to this campaign', ErrorCodes.BAD_REQUEST);
    }

    const seqId = randomUUID();
    const trigger = body.triggerType === 'after_reply' ? 'after_reply' : 'delay';
    const hidden = Boolean(body.isHidden);

    await db.write.query(
      `INSERT INTO campaign_sequences (id, campaign_id, order_index, template_id, delay_hours, delay_minutes, conditions, trigger_type, is_hidden)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [seqId, id, body.orderIndex ?? 0, body.templateId, body.delayHours ?? 24, body.delayMinutes ?? 0, JSON.stringify(body.conditions || {}), trigger, hidden],
    );

    const result = await db.read.query(
      `SELECT cs.*, ct.name as template_name
       FROM campaign_sequences cs
       JOIN campaign_templates ct ON ct.id = cs.template_id
       WHERE cs.id = $1`,
      [seqId],
    );
    reply.code(201);
    return result.rows[0];
  });

  app.patch('/api/campaigns/:campaignId/sequences/:stepId', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { campaignId, stepId } = request.params as { campaignId: string; stepId: string };
    const body = SequenceUpdateSchema.parse(request.body);

    const campaign = await db.read.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [campaignId, user.organizationId],
    );
    if (!campaign.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const updates: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let idx = 1;

    if (typeof body.orderIndex === 'number') {
      params.push(body.orderIndex);
      updates.push(`order_index = $${idx++}`);
    }
    if (body.templateId !== undefined) {
      params.push(body.templateId);
      updates.push(`template_id = $${idx++}`);
    }
    if (typeof body.delayHours === 'number') {
      params.push(Math.max(0, body.delayHours));
      updates.push(`delay_hours = $${idx++}`);
    }
    if (typeof body.delayMinutes === 'number') {
      params.push(Math.max(0, Math.min(59, body.delayMinutes)));
      updates.push(`delay_minutes = $${idx++}`);
    }
    if (body.conditions !== undefined) {
      params.push(JSON.stringify(body.conditions || {}));
      updates.push(`conditions = $${idx++}`);
    }
    if (body.triggerType !== undefined) {
      params.push(body.triggerType === 'after_reply' ? 'after_reply' : 'delay');
      updates.push(`trigger_type = $${idx++}`);
    }
    if (body.isHidden !== undefined) {
      params.push(body.isHidden === true);
      updates.push(`is_hidden = $${idx++}`);
    }

    if (params.length === 0) {
      const r = await db.read.query(
        `SELECT cs.*, ct.name as template_name, ct.channel, ct.content
         FROM campaign_sequences cs
         JOIN campaign_templates ct ON ct.id = cs.template_id
         WHERE cs.id = $1 AND cs.campaign_id = $2`,
        [stepId, campaignId],
      );
      if (!r.rows.length) throw new AppError(404, 'Sequence step not found', ErrorCodes.NOT_FOUND);
      return r.rows[0];
    }

    params.push(stepId, campaignId);
    const result = await db.write.query(
      `UPDATE campaign_sequences SET ${updates.join(', ')} WHERE id = $${idx} AND campaign_id = $${idx + 1} RETURNING *`,
      params,
    );
    if (!result.rows.length) throw new AppError(404, 'Sequence step not found', ErrorCodes.NOT_FOUND);

    const row = await db.read.query(
      `SELECT cs.*, ct.name as template_name, ct.channel, ct.content
       FROM campaign_sequences cs
       JOIN campaign_templates ct ON ct.id = cs.template_id
       WHERE cs.id = $1`,
      [stepId],
    );
    return row.rows[0];
  });

  app.delete('/api/campaigns/:campaignId/sequences/:stepId', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const { campaignId, stepId } = request.params as { campaignId: string; stepId: string };

    const campaign = await db.read.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [campaignId, user.organizationId],
    );
    if (!campaign.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    await db.write.query(
      'DELETE FROM campaign_sequences WHERE id = $1 AND campaign_id = $2',
      [stepId, campaignId],
    );
    reply.code(204).send();
  });
}
