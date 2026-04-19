import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { EventType, type Event } from '@getsale/events';
import { AppError, ErrorCodes, requireUser } from '@getsale/service-framework';
import type { CoreDeps } from '../types';

const CreateCompanySchema = z.object({
  name: z.string().min(1).max(500),
  website: z.string().url().max(500).optional(),
  industry: z.string().max(200).optional(),
  description: z.string().max(5000).optional(),
  size: z.string().max(100).optional(),
  goals: z.array(z.unknown()).optional(),
  policies: z.record(z.string(), z.unknown()).optional(),
});

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().max(200).optional(),
  industry: z.string().max(200).optional(),
});

export function registerCompanyRoutes(app: FastifyInstance, deps: CoreDeps): void {
  const { db, rabbitmq } = deps;

  app.get('/api/crm/companies', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const q = ListQuerySchema.parse(request.query);
    const page = q.page;
    const limit = q.limit;
    const offset = (page - 1) * limit;

    const conditions = ['organization_id = $1', 'deleted_at IS NULL'];
    const params: unknown[] = [user.organizationId];
    let idx = 2;

    if (q.search) {
      conditions.push(`(name ILIKE $${idx} OR industry ILIKE $${idx})`);
      params.push(`%${q.search}%`);
      idx++;
    }
    if (q.industry) {
      conditions.push(`industry = $${idx}`);
      params.push(q.industry);
      idx++;
    }

    const where = conditions.join(' AND ');
    const [data, count] = await Promise.all([
      db.read.query(
        `SELECT * FROM companies WHERE ${where} ORDER BY updated_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset],
      ),
      db.read.query(`SELECT COUNT(*) FROM companies WHERE ${where}`, params),
    ]);
    const total = parseInt(count.rows[0].count, 10);
    return { items: data.rows, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
  });

  app.get('/api/crm/companies/:id', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const result = await db.read.query(
      'SELECT * FROM companies WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, user.organizationId],
    );
    if (!result.rows.length) throw new AppError(404, 'Company not found', ErrorCodes.NOT_FOUND);
    return result.rows[0];
  });

  app.post('/api/crm/companies', { preHandler: [requireUser] }, async (request, reply) => {
    const body = CreateCompanySchema.parse(request.body);
    const user = request.user!;
    const result = await db.write.query(
      'INSERT INTO companies (organization_id, name, website, industry, description, size, goals, policies) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *',
      [user.organizationId, body.name, body.website ?? null, body.industry ?? null, body.description ?? null,
       body.size ?? null, JSON.stringify(body.goals ?? []), JSON.stringify(body.policies ?? {})],
    );
    rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.COMPANY_CREATED, timestamp: new Date(),
      organizationId: user.organizationId, userId: user.id,
      data: { companyId: result.rows[0].id, entityType: 'company', entityId: result.rows[0].id },
    } as unknown as Event).catch(() => {});
    reply.code(201);
    return result.rows[0];
  });

  app.put('/api/crm/companies/:id', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const body = CreateCompanySchema.partial().parse(request.body);

    const existing = await db.read.query(
      'SELECT * FROM companies WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, user.organizationId],
    );
    if (!existing.rows.length) throw new AppError(404, 'Company not found', ErrorCodes.NOT_FOUND);
    const prev = existing.rows[0] as Record<string, unknown>;

    const result = await db.write.query(
      `UPDATE companies SET
        name = COALESCE($2, name), industry = $3, size = $4, description = $5,
        website = $6, goals = COALESCE($7, goals), policies = COALESCE($8, policies), updated_at = NOW()
       WHERE id = $1 AND organization_id = $9 AND deleted_at IS NULL RETURNING *`,
      [id,
       body.name ?? prev.name,
       body.industry !== undefined ? body.industry : prev.industry,
       body.size !== undefined ? body.size : prev.size,
       body.description !== undefined ? body.description : prev.description,
       body.website !== undefined ? body.website : prev.website,
       body.goals !== undefined ? JSON.stringify(body.goals) : null,
       body.policies !== undefined ? JSON.stringify(body.policies) : null,
       user.organizationId],
    );
    if (!result.rows.length) throw new AppError(404, 'Company not found', ErrorCodes.NOT_FOUND);

    rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.COMPANY_UPDATED, timestamp: new Date(),
      organizationId: user.organizationId, userId: user.id,
      data: { companyId: id, entityType: 'company', entityId: id },
    } as unknown as Event).catch(() => {});

    return result.rows[0];
  });

  app.delete('/api/crm/companies/:id', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const existing = await db.read.query(
      'SELECT 1 FROM companies WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, user.organizationId],
    );
    if (!existing.rows.length) throw new AppError(404, 'Company not found', ErrorCodes.NOT_FOUND);

    const dealsCount = await db.read.query(
      'SELECT COUNT(*)::int AS c FROM deals WHERE company_id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (dealsCount.rows[0].c > 0) {
      throw new AppError(409, 'Cannot delete company that has deals. Move or delete deals first.', ErrorCodes.CONFLICT);
    }

    await db.write.query(
      'UPDATE contacts SET company_id = NULL, updated_at = NOW() WHERE company_id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    await db.write.query(
      'UPDATE companies SET deleted_at = NOW() WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, user.organizationId],
    );

    reply.code(204).send();
  });
}
