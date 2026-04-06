import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser } from '@getsale/service-framework';
import type { CoreDeps } from '../types';

const ActivityQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  entityType: z.string().max(50).optional(),
  entityId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
});

export function registerActivityRoutes(app: FastifyInstance, deps: CoreDeps): void {
  const { db } = deps;

  app.get('/api/activity', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const query = ActivityQuerySchema.parse(request.query);
    const conditions = ['oa.organization_id = $1'];
    const params: unknown[] = [user.organizationId];
    let idx = 2;

    if (query.entityType) { conditions.push(`oa.entity_type = $${idx}`); params.push(query.entityType); idx++; }
    if (query.entityId) { conditions.push(`oa.entity_id = $${idx}`); params.push(query.entityId); idx++; }
    if (query.userId) { conditions.push(`oa.user_id = $${idx}`); params.push(query.userId); idx++; }

    const where = conditions.join(' AND ');
    const result = await db.read.query(
      `SELECT oa.id, oa.user_id, oa.action_type, oa.entity_type, oa.entity_id, oa.metadata, oa.created_at,
              u.email AS user_email, up.first_name, up.last_name
       FROM organization_activity oa
       JOIN users u ON u.id = oa.user_id
       LEFT JOIN user_profiles up ON up.user_id = u.id AND up.organization_id = oa.organization_id
       WHERE ${where}
       ORDER BY oa.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, query.limit, query.offset],
    );
    const rows = result.rows.map((row: Record<string, unknown>) => {
      const firstName = row.first_name as string | null;
      const lastName = row.last_name as string | null;
      const email = row.user_email as string;
      const displayName = [firstName, lastName].filter(Boolean).join(' ').trim() || email || String(row.user_id);
      return {
        id: row.id, user_id: row.user_id, user_email: email, user_display_name: displayName,
        action_type: row.action_type, entity_type: row.entity_type, entity_id: row.entity_id,
        metadata: row.metadata, created_at: row.created_at,
      };
    });
    return rows;
  });
}
