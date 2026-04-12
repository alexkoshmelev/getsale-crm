import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { AppError, ErrorCodes, requireUser, DatabasePools } from '@getsale/service-framework';
import { Logger } from '@getsale/logger';

interface Deps {
  db: DatabasePools;
  log: Logger;
}

const TemplateCreateSchema = z.object({
  name: z.string().min(1).max(500).trim(),
  channel: z.string().min(1).max(64).trim(),
  content: z.string(),
  conditions: z.record(z.unknown()).optional(),
});

const TemplateUpdateSchema = z.object({
  name: z.string().min(1).max(500).trim().optional(),
  channel: z.string().min(1).max(64).trim().optional(),
  content: z.string().optional(),
  conditions: z.record(z.unknown()).optional(),
});

export function registerTemplateRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;

  app.get('/api/campaigns/:id/templates', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const campaign = await db.read.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!campaign.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const result = await db.read.query(
      'SELECT * FROM campaign_templates WHERE campaign_id = $1 ORDER BY created_at',
      [id],
    );
    return result.rows;
  });

  app.post('/api/campaigns/:id/templates', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const body = TemplateCreateSchema.parse(request.body);

    const campaign = await db.read.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!campaign.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const templateId = randomUUID();
    await db.write.query(
      `INSERT INTO campaign_templates (id, organization_id, campaign_id, name, channel, content, conditions)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [templateId, user.organizationId, id, body.name, body.channel, body.content, JSON.stringify(body.conditions ?? {})],
    );
    const result = await db.read.query('SELECT * FROM campaign_templates WHERE id = $1', [templateId]);
    reply.code(201);
    return result.rows[0];
  });

  app.patch('/api/campaigns/:campaignId/templates/:templateId', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { campaignId, templateId } = request.params as { campaignId: string; templateId: string };
    const body = TemplateUpdateSchema.parse(request.body);

    const campaign = await db.read.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [campaignId, user.organizationId],
    );
    if (!campaign.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const updates: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
    let idx = 1;

    if (body.name !== undefined) {
      params.push(body.name);
      updates.push(`name = $${idx++}`);
    }
    if (body.channel !== undefined) {
      params.push(body.channel);
      updates.push(`channel = $${idx++}`);
    }
    if (body.content !== undefined) {
      params.push(body.content);
      updates.push(`content = $${idx++}`);
    }
    if (body.conditions !== undefined) {
      params.push(JSON.stringify(body.conditions || {}));
      updates.push(`conditions = $${idx++}`);
    }

    if (params.length === 0) {
      const r = await db.read.query(
        'SELECT * FROM campaign_templates WHERE id = $1 AND campaign_id = $2',
        [templateId, campaignId],
      );
      if (!r.rows.length) throw new AppError(404, 'Template not found', ErrorCodes.NOT_FOUND);
      return r.rows[0];
    }

    params.push(templateId, campaignId);
    const result = await db.write.query(
      `UPDATE campaign_templates SET ${updates.join(', ')} WHERE id = $${idx} AND campaign_id = $${idx + 1} RETURNING *`,
      params,
    );
    if (!result.rows.length) throw new AppError(404, 'Template not found', ErrorCodes.NOT_FOUND);
    return result.rows[0];
  });
}
