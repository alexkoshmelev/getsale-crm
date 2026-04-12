import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, ErrorCodes, requireUser } from '@getsale/service-framework';
import type { CoreDeps } from '../types';

const DEFAULT_STAGES = [
  { name: 'New', order_index: 0, color: '#3B82F6' },
  { name: 'Qualified', order_index: 1, color: '#8B5CF6' },
  { name: 'Meeting', order_index: 2, color: '#F59E0B' },
  { name: 'Proposal', order_index: 3, color: '#10B981' },
  { name: 'Negotiation', order_index: 4, color: '#EF4444' },
  { name: 'Converted', order_index: 5, color: '#6366F1' },
  { name: 'Won', order_index: 6, color: '#22C55E' },
  { name: 'Lost', order_index: 7, color: '#EF4444' },
];

const CreatePipelineSchema = z.object({
  name: z.string().max(200).trim().optional(),
  description: z.string().max(2000).trim().optional().nullable(),
  isDefault: z.boolean().optional(),
});

export function registerPipelineRoutes(app: FastifyInstance, deps: CoreDeps): void {
  const { db, pipelineCache } = deps;

  app.get('/api/pipeline', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const orgId = user.organizationId;
    const cacheKey = `${orgId}:list`;
    const cached = await pipelineCache.get(cacheKey);
    if (cached) return cached;

    const result = await db.read.query(
      `SELECT p.*, (SELECT json_agg(s ORDER BY s.order_index) FROM stages s WHERE s.pipeline_id = p.id) as stages
       FROM pipelines p WHERE p.organization_id = $1 ORDER BY p.is_default DESC, p.created_at`,
      [orgId],
    );
    await pipelineCache.set(cacheKey, result.rows);
    return result.rows;
  });

  app.post('/api/pipeline', { preHandler: [requireUser] }, async (request, reply) => {
    const body = CreatePipelineSchema.parse(request.body);
    const user = request.user!;
    const orgId = user.organizationId;

    if (body.isDefault === true) {
      await db.write.query('UPDATE pipelines SET is_default = false WHERE organization_id = $1', [orgId]);
    }

    const result = await db.write.query(
      `INSERT INTO pipelines (organization_id, name, description, is_default)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [orgId, body.name ?? 'New Pipeline', body.description ?? null, body.isDefault || false],
    );
    const pipeline = result.rows[0];

    for (const stage of DEFAULT_STAGES) {
      await db.write.query(
        'INSERT INTO stages (pipeline_id, organization_id, name, order_index, color) VALUES ($1, $2, $3, $4, $5)',
        [pipeline.id, orgId, stage.name, stage.order_index, stage.color],
      );
    }

    await pipelineCache.invalidatePattern(`${orgId}:*`);
    reply.code(201);
    return pipeline;
  });

  app.put('/api/pipeline/:id', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = CreatePipelineSchema.partial().parse(request.body);
    const user = request.user!;

    const existing = await db.read.query(
      'SELECT id FROM pipelines WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!existing.rows.length) throw new AppError(404, 'Pipeline not found', ErrorCodes.NOT_FOUND);

    const sets: string[] = ['updated_at = NOW()'];
    const vals: unknown[] = [];
    let i = 1;
    if (body.name !== undefined) { sets.push(`name = $${i}`); vals.push(body.name); i++; }
    if (body.description !== undefined) { sets.push(`description = $${i}`); vals.push(body.description ?? null); i++; }
    if (body.isDefault !== undefined) { sets.push(`is_default = $${i}`); vals.push(!!body.isDefault); i++; }

    if (vals.length === 0) {
      const r = await db.read.query('SELECT * FROM pipelines WHERE id = $1 AND organization_id = $2', [id, user.organizationId]);
      return r.rows[0];
    }

    if (body.isDefault === true) {
      await db.write.query('UPDATE pipelines SET is_default = false WHERE organization_id = $1', [user.organizationId]);
    }

    vals.push(id, user.organizationId);
    const result = await db.write.query(
      `UPDATE pipelines SET ${sets.join(', ')} WHERE id = $${i} AND organization_id = $${i + 1} RETURNING *`,
      vals,
    );
    if (!result.rows.length) throw new AppError(404, 'Pipeline not found', ErrorCodes.NOT_FOUND);
    await pipelineCache.invalidatePattern(`${user.organizationId}:*`);
    return result.rows[0];
  });

  app.delete('/api/pipeline/:id', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const existing = await db.read.query(
      'SELECT id FROM pipelines WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!existing.rows.length) throw new AppError(404, 'Pipeline not found', ErrorCodes.NOT_FOUND);

    await db.write.query('DELETE FROM leads WHERE pipeline_id = $1', [id]);
    await db.write.query('DELETE FROM stages WHERE pipeline_id = $1', [id]);
    await db.write.query('DELETE FROM pipelines WHERE id = $1 AND organization_id = $2', [id, user.organizationId]);

    await pipelineCache.invalidatePattern(`${user.organizationId}:*`);
    reply.code(204).send();
  });
}
