import { Router } from 'express';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, Event } from '@getsale/events';
import { Logger } from '@getsale/logger';
import { asyncHandler, validate, AppError, ErrorCodes } from '@getsale/service-core';
import { ContactCreateSchema, ContactUpdateSchema } from '../validation';
import { parseCsvLine } from '../helpers';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
}

export function contactsRouter({ pool, rabbitmq, log }: Deps): Router {
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;

    let where = 'WHERE c.organization_id = $1';
    const params: unknown[] = [organizationId];

    if (companyId) {
      params.push(companyId);
      where += ` AND c.company_id = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (c.first_name ILIKE $${params.length} OR c.last_name ILIKE $${params.length}
        OR c.email ILIKE $${params.length} OR c.phone ILIKE $${params.length}
        OR COALESCE(c.display_name, '') ILIKE $${params.length})`;
    }

    const countResult = await pool.query(`SELECT COUNT(*)::int AS total FROM contacts c ${where}`, params);
    const total = countResult.rows[0].total;

    const offset = (page - 1) * limit;
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT c.*, co.name AS company_name FROM contacts c
       LEFT JOIN companies co ON c.company_id = co.id
       ${where} ORDER BY c.updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    const items = result.rows.map((r: Record<string, unknown>) => {
      const { company_name, ...rest } = r;
      return { ...rest, companyName: company_name ?? null };
    });

    res.json({
      items,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const result = await pool.query(
      `SELECT c.*, co.name AS company_name FROM contacts c
       LEFT JOIN companies co ON c.company_id = co.id
       WHERE c.id = $1 AND c.organization_id = $2`,
      [req.params.id, organizationId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'Contact not found', ErrorCodes.NOT_FOUND);
    }
    const { company_name, ...contact } = result.rows[0];
    res.json({ ...contact, companyName: company_name ?? null });
  }));

  router.post('/import', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const body = req.body as { content?: string; hasHeader?: boolean; mapping?: Record<string, number> };
    if (!body || typeof body.content !== 'string') {
      throw new AppError(400, 'Missing or invalid body: content (CSV string) is required', ErrorCodes.VALIDATION);
    }

    const hasHeader = body.hasHeader !== false;
    const mapping = body.mapping ?? { firstName: 0, lastName: 1, email: 2, phone: 3, telegramId: 4 };
    const lines = body.content.split('\n').filter((l) => l.trim());
    const rows = lines.map(parseCsvLine);
    const dataRows = hasHeader && rows.length > 1 ? rows.slice(1) : rows;

    let created = 0;
    let updated = 0;
    const errors: { row: number; message: string }[] = [];
    const defaultConsent = JSON.stringify({ email: false, sms: false, telegram: false, marketing: false });

    for (let i = 0; i < dataRows.length; i++) {
      const row = dataRows[i];
      const get = (key: string) => {
        const idx = mapping[key];
        return idx != null && row[idx] !== undefined ? String(row[idx]).trim() || null : null;
      };
      const firstName = get('firstName');
      const lastName = get('lastName');
      const email = get('email');
      const phone = get('phone');
      const telegramId = get('telegramId');

      if (!email && !telegramId) {
        errors.push({ row: i + (hasHeader ? 2 : 1), message: 'Each row must have email or telegram_id' });
        continue;
      }

      const existing = await pool.query(
        `SELECT id FROM contacts WHERE organization_id = $1
         AND (($2::text IS NOT NULL AND telegram_id = $2) OR ($3::text IS NOT NULL AND email = $3)) LIMIT 1`,
        [organizationId, telegramId || null, email || null]
      );

      if (existing.rows.length > 0) {
        await pool.query(
          `UPDATE contacts SET first_name = COALESCE($2, first_name), last_name = COALESCE($3, last_name),
           email = COALESCE($4, email), phone = COALESCE($5, phone), telegram_id = COALESCE($6, telegram_id),
           updated_at = NOW() WHERE id = $1 AND organization_id = $7`,
          [existing.rows[0].id, firstName, lastName, email, phone, telegramId, organizationId]
        );
        updated++;
      } else {
        await pool.query(
          `INSERT INTO contacts (organization_id, first_name, last_name, email, phone, telegram_id, consent_flags)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [organizationId, firstName, lastName, email, phone, telegramId, defaultConsent]
        );
        created++;
      }
    }

    res.json({ created, updated, errors, total: dataRows.length });
  }));

  router.post('/', validate(ContactCreateSchema), asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { firstName, lastName, displayName, username, email, phone, telegramId, companyId, consentFlags } = req.body;

    if (companyId) {
      const check = await pool.query('SELECT 1 FROM companies WHERE id = $1 AND organization_id = $2', [companyId, organizationId]);
      if (check.rows.length === 0) {
        throw new AppError(400, 'Company not found or access denied', ErrorCodes.VALIDATION);
      }
    }

    const result = await pool.query(
      `INSERT INTO contacts (organization_id, company_id, first_name, last_name, display_name, username, email, phone, telegram_id, consent_flags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [organizationId, companyId ?? null,
       (firstName ?? '').trim() || null, (lastName ?? '').trim() || null,
       (displayName ?? '').trim() || null, (username ?? '').trim() || null,
       email || null, phone ?? null, telegramId ?? null,
       JSON.stringify(consentFlags ?? { email: false, sms: false, telegram: false, marketing: false })]
    );

    await rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.CONTACT_CREATED, timestamp: new Date(),
      organizationId, userId, data: { contactId: result.rows[0].id },
    } as Event);

    res.status(201).json(result.rows[0]);
  }));

  const updateHandler = asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { id } = req.params;
    const parsed = ContactUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, parsed.error.errors.map((e) => e.message).join('; '), ErrorCodes.VALIDATION);
    }

    const existing = await pool.query('SELECT * FROM contacts WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    if (existing.rows.length === 0) {
      throw new AppError(404, 'Contact not found', ErrorCodes.NOT_FOUND);
    }

    const d = parsed.data;
    if (d.companyId !== undefined) {
      const check = await pool.query('SELECT 1 FROM companies WHERE id = $1 AND organization_id = $2', [d.companyId, organizationId]);
      if (check.rows.length === 0) {
        throw new AppError(400, 'Company not found or access denied', ErrorCodes.VALIDATION);
      }
    }

    const result = await pool.query(
      `UPDATE contacts SET
        first_name = COALESCE($2, first_name), last_name = $3, email = $4, phone = $5,
        telegram_id = $6, company_id = $7, display_name = $8, username = $9,
        consent_flags = COALESCE($10, consent_flags), updated_at = NOW()
       WHERE id = $1 AND organization_id = $11 RETURNING *`,
      [id, d.firstName, d.lastName ?? null, d.email ?? null, d.phone ?? null,
       d.telegramId ?? null, d.companyId ?? null, d.displayName ?? null, d.username ?? null,
       d.consentFlags ? JSON.stringify(d.consentFlags) : null, organizationId]
    );

    await rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.CONTACT_UPDATED, timestamp: new Date(),
      organizationId, userId, data: { contactId: id },
    } as Event);

    res.json(result.rows[0]);
  });

  router.put('/:id', updateHandler);
  router.patch('/:id', updateHandler);

  router.delete('/:id', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;

    const existing = await pool.query('SELECT 1 FROM contacts WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    if (existing.rows.length === 0) {
      throw new AppError(404, 'Contact not found', ErrorCodes.NOT_FOUND);
    }

    await pool.query(
      'UPDATE deals SET contact_id = NULL, updated_at = NOW() WHERE contact_id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    await pool.query('DELETE FROM contacts WHERE id = $1 AND organization_id = $2', [id, organizationId]);
    res.status(204).send();
  }));

  return router;
}
