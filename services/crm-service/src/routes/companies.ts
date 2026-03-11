import { Router } from 'express';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, Event } from '@getsale/events';
import { Logger } from '@getsale/logger';
import { asyncHandler, validate, AppError, ErrorCodes } from '@getsale/service-core';
import { parsePageLimit, buildPagedResponse } from '../helpers';
import { CompanyCreateSchema, CompanyUpdateSchema } from '../validation';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
}

export function companiesRouter({ pool, rabbitmq, log }: Deps): Router {
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { page, limit, offset } = parsePageLimit(req.query);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const industry = typeof req.query.industry === 'string' ? req.query.industry.trim() : '';

    let where = 'WHERE organization_id = $1';
    const params: unknown[] = [organizationId];

    if (search) {
      params.push(`%${search}%`);
      where += ` AND (name ILIKE $${params.length} OR industry ILIKE $${params.length})`;
    }
    if (industry) {
      params.push(industry);
      where += ` AND industry = $${params.length}`;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM companies ${where}`,
      params
    );
    const total = countResult.rows[0].total;

    params.push(limit, offset);
    const result = await pool.query(
      `SELECT * FROM companies ${where}
       ORDER BY updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json(buildPagedResponse(result.rows, total, page, limit));
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const result = await pool.query(
      'SELECT * FROM companies WHERE id = $1 AND organization_id = $2',
      [req.params.id, organizationId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'Company not found', ErrorCodes.NOT_FOUND);
    }
    res.json(result.rows[0]);
  }));

  router.post('/', validate(CompanyCreateSchema), asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { name, industry, size, description, goals, policies } = req.body;

    const result = await pool.query(
      `INSERT INTO companies (organization_id, name, industry, size, description, goals, policies)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [organizationId, name, industry ?? null, size ?? null, description ?? null,
       JSON.stringify(goals ?? []), JSON.stringify(policies ?? {})]
    );

    await rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.COMPANY_CREATED, timestamp: new Date(),
      organizationId, userId, data: { companyId: result.rows[0].id },
    } as Event);

    res.status(201).json(result.rows[0]);
  }));

  router.put('/:id', validate(CompanyUpdateSchema), asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { id } = req.params;

    const existing = await pool.query(
      'SELECT * FROM companies WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (existing.rows.length === 0) {
      throw new AppError(404, 'Company not found', ErrorCodes.NOT_FOUND);
    }

    const { name, industry, size, description, goals, policies } = req.body;
    const row = existing.rows[0];
    const result = await pool.query(
      `UPDATE companies SET
        name = COALESCE($2, name), industry = $3, size = $4, description = $5,
        goals = COALESCE($6, goals), policies = COALESCE($7, policies), updated_at = NOW()
       WHERE id = $1 AND organization_id = $8 RETURNING *`,
      [id, name ?? row.name,
       industry !== undefined ? industry : row.industry,
       size !== undefined ? size : row.size,
       description !== undefined ? description : row.description,
       goals !== undefined ? JSON.stringify(goals) : row.goals,
       policies !== undefined ? JSON.stringify(policies) : row.policies,
       organizationId]
    );

    await rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.COMPANY_UPDATED, timestamp: new Date(),
      organizationId, userId, data: { companyId: id },
    } as Event);

    res.json(result.rows[0]);
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;

    const existing = await pool.query(
      'SELECT 1 FROM companies WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (existing.rows.length === 0) {
      throw new AppError(404, 'Company not found', ErrorCodes.NOT_FOUND);
    }

    const dealsCount = await pool.query(
      'SELECT COUNT(*)::int AS c FROM deals WHERE company_id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (dealsCount.rows[0].c > 0) {
      throw new AppError(409, 'Cannot delete company that has deals. Move or delete deals first.', ErrorCodes.CONFLICT);
    }

    await pool.query(
      'UPDATE contacts SET company_id = NULL, updated_at = NOW() WHERE company_id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    await pool.query('DELETE FROM companies WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    res.status(204).send();
  }));

  return router;
}
