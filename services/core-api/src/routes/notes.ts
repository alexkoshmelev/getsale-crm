import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, ErrorCodes, requireUser } from '@getsale/service-framework';
import type { CoreDeps } from '../types';

const CreateNoteSchema = z.object({
  content: z.string().min(1).max(50_000),
});

export function registerNoteRoutes(app: FastifyInstance, deps: CoreDeps): void {
  const { db } = deps;

  app.get('/api/crm/contacts/:contactId/notes', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { contactId } = request.params as { contactId: string };
    const result = await db.read.query(
      'SELECT * FROM notes WHERE entity_type = $1 AND entity_id = $2 AND organization_id = $3 ORDER BY created_at DESC',
      ['contact', contactId, user.organizationId],
    );
    return result.rows;
  });

  app.post('/api/crm/contacts/:contactId/notes', { preHandler: [requireUser] }, async (request, reply) => {
    const { contactId } = request.params as { contactId: string };
    const body = CreateNoteSchema.parse(request.body);
    const user = request.user!;
    const result = await db.write.query(
      'INSERT INTO notes (organization_id, entity_type, entity_id, content, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [user.organizationId, 'contact', contactId, body.content, user.id],
    );
    reply.code(201);
    return result.rows[0];
  });

  app.get('/api/crm/deals/:dealId/notes', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { dealId } = request.params as { dealId: string };
    const result = await db.read.query(
      'SELECT * FROM notes WHERE entity_type = $1 AND entity_id = $2 AND organization_id = $3 ORDER BY created_at DESC',
      ['deal', dealId, user.organizationId],
    );
    return result.rows;
  });

  app.post('/api/crm/deals/:dealId/notes', { preHandler: [requireUser] }, async (request, reply) => {
    const { dealId } = request.params as { dealId: string };
    const body = CreateNoteSchema.parse(request.body);
    const user = request.user!;
    const result = await db.write.query(
      'INSERT INTO notes (organization_id, entity_type, entity_id, content, user_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
      [user.organizationId, 'deal', dealId, body.content, user.id],
    );
    reply.code(201);
    return result.rows[0];
  });

  app.delete('/api/crm/notes/:id', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const result = await db.write.query(
      'DELETE FROM notes WHERE id = $1 AND organization_id = $2 RETURNING id',
      [id, user.organizationId],
    );
    if (!result.rows.length) throw new AppError(404, 'Note not found', ErrorCodes.NOT_FOUND);
    reply.code(204).send();
  });
}
