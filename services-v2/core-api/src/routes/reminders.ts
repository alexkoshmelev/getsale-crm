import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, ErrorCodes, requireUser } from '@getsale/service-framework';
import type { CoreDeps } from '../types';

const CreateReminderSchema = z.object({
  title: z.string().max(500).optional().nullable(),
  remindAt: z.string().datetime().optional(),
  remind_at: z.string().datetime().optional(),
}).transform(data => ({
  title: data.title,
  remindAt: data.remindAt || data.remind_at,
})).refine(data => !!data.remindAt, { message: 'remind_at or remindAt is required' });

const PatchReminderSchema = z.object({
  title: z.string().max(500).optional().nullable(),
  remindAt: z.string().datetime().optional(),
  remind_at: z.string().datetime().optional(),
  done: z.boolean().optional(),
}).transform(data => ({
  title: data.title,
  remindAt: data.remindAt || data.remind_at,
  done: data.done,
}));

async function ensureEntityAccess(
  db: CoreDeps['db'], organizationId: string, entityType: 'contact' | 'deal', entityId: string,
): Promise<void> {
  const table = entityType === 'contact' ? 'contacts' : 'deals';
  const result = await db.read.query(
    `SELECT 1 FROM ${table} WHERE id = $1 AND organization_id = $2`,
    [entityId, organizationId],
  );
  if (!result.rows.length) {
    throw new AppError(404, `${entityType === 'contact' ? 'Contact' : 'Deal'} not found`, ErrorCodes.NOT_FOUND);
  }
}

export function registerReminderRoutes(app: FastifyInstance, deps: CoreDeps): void {
  const { db } = deps;

  app.get('/api/crm/reminders/due', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { limit = 50 } = request.query as { limit?: number };
    const result = await db.read.query(
      'SELECT * FROM reminders WHERE organization_id = $1 AND remind_at <= NOW() AND done = false ORDER BY remind_at DESC LIMIT $2',
      [user.organizationId, Math.min(Number(limit) || 50, 200)],
    );
    return result.rows;
  });

  app.get('/api/crm/reminders/upcoming', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { hours = 72, limit = 50 } = request.query as { hours?: number; limit?: number };
    const result = await db.read.query(
      `SELECT * FROM reminders WHERE organization_id = $1 AND remind_at > NOW() AND remind_at <= NOW() + ($2 || ' hours')::interval AND done = false ORDER BY remind_at LIMIT $3`,
      [user.organizationId, String(hours), Math.min(Number(limit) || 50, 200)],
    );
    return result.rows;
  });

  app.get('/api/crm/contacts/:contactId/reminders', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { contactId } = request.params as { contactId: string };
    await ensureEntityAccess(db, user.organizationId, 'contact', contactId);
    const result = await db.read.query(
      "SELECT * FROM reminders WHERE entity_type = 'contact' AND entity_id = $1 AND organization_id = $2 ORDER BY remind_at",
      [contactId, user.organizationId],
    );
    return result.rows;
  });

  app.post('/api/crm/contacts/:contactId/reminders', { preHandler: [requireUser] }, async (request, reply) => {
    const { contactId } = request.params as { contactId: string };
    const body = CreateReminderSchema.parse(request.body);
    const user = request.user!;
    await ensureEntityAccess(db, user.organizationId, 'contact', contactId);
    const result = await db.write.query(
      "INSERT INTO reminders (organization_id, entity_type, entity_id, title, remind_at, user_id) VALUES ($1, 'contact', $2, $3, $4, $5) RETURNING *",
      [user.organizationId, contactId, body.title ?? null, body.remindAt, user.id],
    );
    reply.code(201);
    return result.rows[0];
  });

  app.patch('/api/crm/reminders/:id', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const body = PatchReminderSchema.parse(request.body);
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (body.title !== undefined) { sets.push(`title = $${i}`); vals.push(body.title); i++; }
    if (body.remindAt !== undefined) { sets.push(`remind_at = $${i}`); vals.push(body.remindAt); i++; }
    if (body.done !== undefined) { sets.push(`done = $${i}`); vals.push(body.done); i++; }
    if (!sets.length) throw new AppError(400, 'Nothing to update', ErrorCodes.BAD_REQUEST);
    vals.push(id, user.organizationId);
    const result = await db.write.query(
      `UPDATE reminders SET ${sets.join(', ')} WHERE id = $${i} AND organization_id = $${i + 1} RETURNING *`, vals,
    );
    if (!result.rows.length) throw new AppError(404, 'Reminder not found', ErrorCodes.NOT_FOUND);
    return result.rows[0];
  });

  app.delete('/api/crm/reminders/:id', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    await db.write.query('DELETE FROM reminders WHERE id = $1 AND organization_id = $2', [id, user.organizationId]);
    reply.code(204).send();
  });

  app.get('/api/crm/deals/:dealId/reminders', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { dealId } = request.params as { dealId: string };
    await ensureEntityAccess(db, user.organizationId, 'deal', dealId);
    const result = await db.read.query(
      "SELECT * FROM reminders WHERE entity_type = 'deal' AND entity_id = $1 AND organization_id = $2 ORDER BY remind_at",
      [dealId, user.organizationId],
    );
    return result.rows;
  });

  app.post('/api/crm/deals/:dealId/reminders', { preHandler: [requireUser] }, async (request, reply) => {
    const { dealId } = request.params as { dealId: string };
    const body = CreateReminderSchema.parse(request.body);
    const user = request.user!;
    await ensureEntityAccess(db, user.organizationId, 'deal', dealId);
    const result = await db.write.query(
      "INSERT INTO reminders (organization_id, entity_type, entity_id, title, remind_at, user_id) VALUES ($1, 'deal', $2, $3, $4, $5) RETURNING *",
      [user.organizationId, dealId, body.title ?? null, body.remindAt, user.id],
    );
    reply.code(201);
    return result.rows[0];
  });
}
