import { Router } from 'express';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, Event } from '@getsale/events';
import { Logger } from '@getsale/logger';
import { asyncHandler, validate, requireUser, requireRole, AppError, ErrorCodes } from '@getsale/service-core';
import { RuleCreateSchema, RunSlaCronBodySchema } from '../validation';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  runSlaCronOnce: (filterOrgId?: string, filterLeadId?: string) => Promise<void>;
}

export function rulesRouter({ pool, rabbitmq, log, runSlaCronOnce }: Deps): Router {
  const router = Router();

  router.get('/rules', requireUser(), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const result = await pool.query(
      'SELECT * FROM automation_rules WHERE organization_id = $1 ORDER BY created_at DESC',
      [organizationId]
    );
    res.json(result.rows);
  }));

  router.post('/rules', requireUser(), validate(RuleCreateSchema), asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { name, triggerType, triggerConfig, conditions, actions, is_active } = req.body;

    const result = await pool.query(
      `INSERT INTO automation_rules (organization_id, name, trigger_type, trigger_conditions, actions, is_active)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [
        organizationId,
        name,
        triggerType,
        JSON.stringify(triggerConfig || {}),
        JSON.stringify(actions ?? []),
        is_active !== false,
      ]
    );

    try {
      const createdEvent = {
        id: randomUUID(),
        type: EventType.AUTOMATION_RULE_CREATED,
        timestamp: new Date(),
        organizationId,
        userId,
        data: { ruleId: result.rows[0].id },
      };
      await rabbitmq.publishEvent(createdEvent as Event);
    } catch (pubErr) {
      log.warn({ message: 'Failed to publish AUTOMATION_RULE_CREATED', error: String(pubErr) });
    }

    res.status(201).json(result.rows[0]);
  }));

  // Internal endpoint for e2e: single SLA cron run (admin/owner only)
  router.post(
    '/internal/run-sla-cron-once',
    requireUser(),
    requireRole('owner', 'admin'),
    validate(RunSlaCronBodySchema, 'body'),
    asyncHandler(async (req, res) => {
      const fromBody = req.body?.organizationId;
      const fromHeader = typeof req.headers['x-organization-id'] === 'string' ? req.headers['x-organization-id'] : undefined;
      const filterOrgId = fromBody ?? fromHeader ?? req.user?.organizationId;
      const filterLeadId = req.body?.leadId;
      await runSlaCronOnce(filterOrgId || undefined, filterLeadId);
      res.json({ ok: true });
    })
  );

  return router;
}
