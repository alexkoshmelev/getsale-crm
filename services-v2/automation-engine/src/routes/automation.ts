import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { AppError, ErrorCodes, requireUser, DatabasePools } from '@getsale/service-framework';
import { RabbitMQClient } from '@getsale/queue';
import { EventType, Event } from '@getsale/events';
import { Logger } from '@getsale/logger';

interface Deps {
  db: DatabasePools;
  rabbitmq: RabbitMQClient;
  log: Logger;
}

const CreateRuleSchema = z.object({
  name: z.string().min(1).max(500),
  triggerType: z.string().min(1),
  triggerConditions: z.record(z.unknown()).optional(),
  actions: z.array(z.record(z.unknown())),
  isActive: z.boolean().default(true),
});

export function registerAutomationRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, rabbitmq, log } = deps;

  app.get('/api/automation/rules', { preHandler: [requireUser] }, async (request) => {
    const result = await db.read.query(
      'SELECT * FROM automation_rules WHERE organization_id = $1 ORDER BY created_at DESC',
      [request.user!.organizationId],
    );
    return result.rows;
  });

  app.get('/api/automation/rules/:id', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const result = await db.read.query(
      'SELECT * FROM automation_rules WHERE id = $1 AND organization_id = $2',
      [id, request.user!.organizationId],
    );
    if (!result.rows.length) throw new AppError(404, 'Rule not found', ErrorCodes.NOT_FOUND);
    return result.rows[0];
  });

  app.post('/api/automation/rules', { preHandler: [requireUser] }, async (request, reply) => {
    const body = CreateRuleSchema.parse(request.body);
    const user = request.user!;
    const result = await db.write.query(
      `INSERT INTO automation_rules (organization_id, name, trigger_type, trigger_conditions, actions, is_active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        user.organizationId,
        body.name,
        body.triggerType,
        JSON.stringify(body.triggerConditions || {}),
        JSON.stringify(body.actions),
        body.isActive,
      ],
    );

    const row = result.rows[0];

    try {
      await rabbitmq.publishEvent({
        id: randomUUID(),
        type: EventType.AUTOMATION_RULE_CREATED,
        timestamp: new Date(),
        organizationId: user.organizationId,
        userId: user.id,
        correlationId: request.correlationId,
        data: { ruleId: row.id, name: row.name },
      } as unknown as Event);
    } catch (pubErr) {
      log.warn({ message: 'Failed to publish AUTOMATION_RULE_CREATED', error: String(pubErr) });
    }

    reply.code(201);
    return row;
  });

  app.put('/api/automation/rules/:id', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = CreateRuleSchema.partial().parse(request.body);
    const sets: string[] = [];
    const vals: unknown[] = [];
    let i = 1;
    if (body.name !== undefined) { sets.push(`name = $${i}`); vals.push(body.name); i++; }
    if (body.triggerType !== undefined) { sets.push(`trigger_type = $${i}`); vals.push(body.triggerType); i++; }
    if (body.triggerConditions !== undefined) { sets.push(`trigger_conditions = $${i}`); vals.push(JSON.stringify(body.triggerConditions)); i++; }
    if (body.actions !== undefined) { sets.push(`actions = $${i}`); vals.push(JSON.stringify(body.actions)); i++; }
    if (body.isActive !== undefined) { sets.push(`is_active = $${i}`); vals.push(body.isActive); i++; }
    if (!sets.length) throw new AppError(400, 'Nothing to update', ErrorCodes.BAD_REQUEST);
    sets.push('updated_at = NOW()');
    vals.push(id, request.user!.organizationId);
    const result = await db.write.query(
      `UPDATE automation_rules SET ${sets.join(', ')} WHERE id = $${i} AND organization_id = $${i + 1} RETURNING *`, vals,
    );
    if (!result.rows.length) throw new AppError(404, 'Rule not found', ErrorCodes.NOT_FOUND);
    return result.rows[0];
  });

  app.delete('/api/automation/rules/:id', { preHandler: [requireUser] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    await db.write.query('DELETE FROM automation_rules WHERE id = $1 AND organization_id = $2', [id, request.user!.organizationId]);
    reply.code(204).send();
  });
}
