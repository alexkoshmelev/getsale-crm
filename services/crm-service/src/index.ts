import express from 'express';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { register, Counter } from 'prom-client';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, Event } from '@getsale/events';
import { createLogger } from '@getsale/logger';
import {
  AppError,
  isAppError,
  ErrorCodes,
} from './errors';
import {
  CompanyCreateSchema,
  CompanyUpdateSchema,
  ContactCreateSchema,
  ContactUpdateSchema,
  DealCreateSchema,
  DealUpdateSchema,
  DealStageUpdateSchema,
} from './validation';

const app = express();
const PORT = process.env.PORT || 3002;
const log = createLogger('crm-service');

const dealCreatedTotal = new Counter({ name: 'deal_created_total', help: 'Deals created', registers: [register] });
const dealStageChangedTotal = new Counter({ name: 'deal_stage_changed_total', help: 'Deal stage transitions', registers: [register] });

const pool = new Pool({
  connectionString:
    process.env.DATABASE_URL ||
    `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'postgres_dev'}@localhost:5432/postgres`,
});

const rabbitmq = new RabbitMQClient(
  process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672'
);

(async () => {
  try {
    await rabbitmq.connect();
  } catch (error) {
    console.error(
      'Failed to connect to RabbitMQ, service will continue without event publishing:',
      error
    );
  }
})();

function getUser(req: express.Request) {
  return {
    id: req.headers['x-user-id'] as string,
    organizationId: req.headers['x-organization-id'] as string,
  };
}

/** Get first stage (by order_index) of a pipeline for "add to pipeline" flow */
async function getFirstStageId(
  pipelineId: string,
  organizationId: string
): Promise<string | null> {
  const r = await pool.query(
    `SELECT id FROM stages
     WHERE pipeline_id = $1 AND organization_id = $2
     ORDER BY order_index ASC LIMIT 1`,
    [pipelineId, organizationId]
  );
  return r.rows[0]?.id ?? null;
}

/** Ensure stage belongs to pipeline and organization */
async function ensureStageInPipeline(
  stageId: string,
  pipelineId: string,
  organizationId: string
): Promise<void> {
  const r = await pool.query(
    `SELECT 1 FROM stages
     WHERE id = $1 AND pipeline_id = $2 AND organization_id = $3`,
    [stageId, pipelineId, organizationId]
  );
  if (r.rows.length === 0) {
    throw new AppError(
      400,
      'Stage does not belong to the specified pipeline',
      ErrorCodes.VALIDATION
    );
  }
}

app.use(express.json());

// ---------- Health ----------
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'crm-service' });
});

app.get('/ready', async (_req, res) => {
  let postgres = false;
  try {
    await pool.query('SELECT 1');
    postgres = true;
  } catch {
    // ignore
  }
  const ok = postgres;
  res.status(ok ? 200 : 503).json({ status: ok ? 'ready' : 'not ready', checks: { postgres: ok } });
});

app.get('/metrics', async (_req, res) => {
  res.setHeader('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ---------- Companies ----------
app.get('/api/crm/companies', async (req, res, next) => {
  try {
    const user = getUser(req);
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const industry = typeof req.query.industry === 'string' ? req.query.industry.trim() : '';

    let where = 'WHERE organization_id = $1';
    const params: unknown[] = [user.organizationId];

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

    const offset = (page - 1) * limit;
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT * FROM companies ${where}
       ORDER BY updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      items: result.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (e) {
    next(e);
  }
});

app.get('/api/crm/companies/:id', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const result = await pool.query(
      'SELECT * FROM companies WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'Company not found', ErrorCodes.NOT_FOUND);
    }
    res.json(result.rows[0]);
  } catch (e) {
    next(e);
  }
});

app.post('/api/crm/companies', async (req, res, next) => {
  try {
    const user = getUser(req);
    const parsed = CompanyCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.errors.map((e) => e.message).join('; '),
        ErrorCodes.VALIDATION
      );
    }
    const { name, industry, size, description, goals, policies } = parsed.data;
    const result = await pool.query(
      `INSERT INTO companies (organization_id, name, industry, size, description, goals, policies)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [
        user.organizationId,
        name,
        industry ?? null,
        size ?? null,
        description ?? null,
        JSON.stringify(goals ?? []),
        JSON.stringify(policies ?? {}),
      ]
    );
    await rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.COMPANY_CREATED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { companyId: result.rows[0].id },
    } as Event);
    res.status(201).json(result.rows[0]);
  } catch (e) {
    next(e);
  }
});

app.put('/api/crm/companies/:id', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const parsed = CompanyUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.errors.map((e) => e.message).join('; '),
        ErrorCodes.VALIDATION
      );
    }
    const existing = await pool.query(
      'SELECT * FROM companies WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (existing.rows.length === 0) {
      throw new AppError(404, 'Company not found', ErrorCodes.NOT_FOUND);
    }
    const { name, industry, size, description, goals, policies } = parsed.data;
    const row = existing.rows[0];
    const result = await pool.query(
      `UPDATE companies SET
        name = COALESCE($2, name),
        industry = $3,
        size = $4,
        description = $5,
        goals = COALESCE($6, goals),
        policies = COALESCE($7, policies),
        updated_at = NOW()
       WHERE id = $1 AND organization_id = $8
       RETURNING *`,
      [
        id,
        name ?? row.name,
        industry !== undefined ? industry : row.industry,
        size !== undefined ? size : row.size,
        description !== undefined ? description : row.description,
        goals !== undefined ? JSON.stringify(goals) : row.goals,
        policies !== undefined ? JSON.stringify(policies) : row.policies,
        user.organizationId,
      ]
    );
    await rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.COMPANY_UPDATED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { companyId: id },
    } as Event);
    res.json(result.rows[0]);
  } catch (e) {
    next(e);
  }
});

app.delete('/api/crm/companies/:id', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const existing = await pool.query(
      'SELECT * FROM companies WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (existing.rows.length === 0) {
      throw new AppError(404, 'Company not found', ErrorCodes.NOT_FOUND);
    }
    const dealsCount = await pool.query(
      'SELECT COUNT(*)::int AS c FROM deals WHERE company_id = $1',
      [id]
    );
    if (dealsCount.rows[0].c > 0) {
      throw new AppError(
        409,
        'Cannot delete company that has deals. Move or delete deals first.',
        ErrorCodes.CONFLICT
      );
    }
    await pool.query(
      'UPDATE contacts SET company_id = NULL, updated_at = NOW() WHERE company_id = $1',
      [id]
    );
    await pool.query('DELETE FROM companies WHERE id = $1 AND organization_id = $2', [
      id,
      user.organizationId,
    ]);
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

// ---------- Contacts ----------
app.get('/api/crm/contacts', async (req, res, next) => {
  try {
    const user = getUser(req);
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;

    let where = 'WHERE c.organization_id = $1';
    const params: unknown[] = [user.organizationId];

    if (companyId) {
      params.push(companyId);
      where += ` AND c.company_id = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND (
        c.first_name ILIKE $${params.length}
        OR c.last_name ILIKE $${params.length}
        OR c.email ILIKE $${params.length}
        OR c.phone ILIKE $${params.length}
        OR COALESCE(c.display_name, '') ILIKE $${params.length}
      )`;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM contacts c ${where}`,
      params
    );
    const total = countResult.rows[0].total;

    const offset = (page - 1) * limit;
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT c.*, co.name AS company_name
       FROM contacts c
       LEFT JOIN companies co ON c.company_id = co.id
       ${where}
       ORDER BY c.updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const items = result.rows.map((r: any) => {
      const { company_name, ...rest } = r;
      return { ...rest, companyName: company_name ?? null };
    });

    res.json({
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (e) {
    next(e);
  }
});

app.get('/api/crm/contacts/:id', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const result = await pool.query(
      `SELECT c.*, co.name AS company_name
       FROM contacts c
       LEFT JOIN companies co ON c.company_id = co.id
       WHERE c.id = $1 AND c.organization_id = $2`,
      [id, user.organizationId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'Contact not found', ErrorCodes.NOT_FOUND);
    }
    const row = result.rows[0];
    const { company_name, ...contact } = row;
    res.json({ ...contact, companyName: company_name ?? null });
  } catch (e) {
    next(e);
  }
});

/** Parse a single CSV line (handles quoted fields). */
function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      inQuotes = !inQuotes;
    } else if ((c === ',' && !inQuotes) || c === '\r') {
      out.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  out.push(cur.trim());
  return out;
}

/** Mass import contacts from CSV. Body: { content: string, hasHeader?: boolean, mapping?: Record<string, number> } where mapping keys are firstName|lastName|email|phone|telegramId and values are 0-based column index. */
app.post('/api/crm/contacts/import', async (req, res, next) => {
  try {
    const user = getUser(req);
    const body = req.body as { content?: string; hasHeader?: boolean; mapping?: Record<string, number> };
    if (!body || typeof body.content !== 'string') {
      throw new AppError(400, 'Missing or invalid body: content (CSV string) is required', ErrorCodes.VALIDATION);
    }
    const hasHeader = body.hasHeader !== false;
    const mapping = body.mapping ?? {
      firstName: 0,
      lastName: 1,
      email: 2,
      phone: 3,
      telegramId: 4,
    };
    const lines = body.content.split('\n').filter((l) => l.trim());
    const rows = lines.map((l) => parseCsvLine(l));
    const dataRows = hasHeader && rows.length > 1 ? rows.slice(1) : rows;
    let created = 0;
    let updated = 0;
    const errors: { row: number; message: string }[] = [];
    const consentFlagsJson = JSON.stringify({ email: false, sms: false, telegram: false, marketing: false });

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
        `SELECT id FROM contacts WHERE organization_id = $1 AND (($2::text IS NOT NULL AND telegram_id = $2) OR ($3::text IS NOT NULL AND email = $3)) LIMIT 1`,
        [user.organizationId, telegramId || null, email || null]
      );
      if (existing.rows.length > 0) {
        await pool.query(
          `UPDATE contacts SET first_name = COALESCE($2, first_name), last_name = COALESCE($3, last_name), email = COALESCE($4, email), phone = COALESCE($5, phone), telegram_id = COALESCE($6, telegram_id), updated_at = NOW() WHERE id = $1 AND organization_id = $7`,
          [
            existing.rows[0].id,
            firstName ?? null,
            lastName ?? null,
            email ?? null,
            phone ?? null,
            telegramId ?? null,
            user.organizationId,
          ]
        );
        updated++;
      } else {
        await pool.query(
          `INSERT INTO contacts (organization_id, first_name, last_name, email, phone, telegram_id, consent_flags) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [user.organizationId, firstName ?? null, lastName ?? null, email ?? null, phone ?? null, telegramId ?? null, consentFlagsJson]
        );
        created++;
      }
    }

    res.json({ created, updated, errors, total: dataRows.length });
  } catch (e) {
    next(e);
  }
});

app.post('/api/crm/contacts', async (req, res, next) => {
  try {
    const user = getUser(req);
    const parsed = ContactCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.errors.map((e) => e.message).join('; '),
        ErrorCodes.VALIDATION
      );
    }
    const {
      firstName,
      lastName,
      displayName,
      username,
      email,
      phone,
      telegramId,
      companyId,
      consentFlags,
    } = parsed.data;
    if (companyId) {
      const companyCheck = await pool.query(
        'SELECT 1 FROM companies WHERE id = $1 AND organization_id = $2',
        [companyId, user.organizationId]
      );
      if (companyCheck.rows.length === 0) {
        throw new AppError(400, 'Company not found or access denied', ErrorCodes.VALIDATION);
      }
    }
    const result = await pool.query(
      `INSERT INTO contacts (organization_id, company_id, first_name, last_name, display_name, username, email, phone, telegram_id, consent_flags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        user.organizationId,
        companyId ?? null,
        (firstName ?? '').trim() || null,
        (lastName ?? '').trim() || null,
        (displayName ?? '').trim() || null,
        (username ?? '').trim() || null,
        email || null,
        phone ?? null,
        telegramId ?? null,
        JSON.stringify(consentFlags ?? { email: false, sms: false, telegram: false, marketing: false }),
      ]
    );
    await rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.CONTACT_CREATED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { contactId: result.rows[0].id },
    } as Event);
    res.status(201).json(result.rows[0]);
  } catch (e) {
    next(e);
  }
});

async function updateContactHandler(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const parsed = ContactUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.errors.map((e) => e.message).join('; '),
        ErrorCodes.VALIDATION
      );
    }
    const existing = await pool.query(
      'SELECT * FROM contacts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (existing.rows.length === 0) {
      throw new AppError(404, 'Contact not found', ErrorCodes.NOT_FOUND);
    }
    if (parsed.data.companyId !== undefined) {
      const companyCheck = await pool.query(
        'SELECT 1 FROM companies WHERE id = $1 AND organization_id = $2',
        [parsed.data.companyId, user.organizationId]
      );
      if (companyCheck.rows.length === 0) {
        throw new AppError(400, 'Company not found or access denied', ErrorCodes.VALIDATION);
      }
    }
    const d = parsed.data;
    const result = await pool.query(
      `UPDATE contacts SET
        first_name = COALESCE($2, first_name),
        last_name = $3,
        email = $4,
        phone = $5,
        telegram_id = $6,
        company_id = $7,
        display_name = $8,
        username = $9,
        consent_flags = COALESCE($10, consent_flags),
        updated_at = NOW()
       WHERE id = $1 AND organization_id = $11
       RETURNING *`,
      [
        id,
        d.firstName,
        d.lastName ?? null,
        d.email ?? null,
        d.phone ?? null,
        d.telegramId ?? null,
        d.companyId ?? null,
        d.displayName ?? null,
        d.username ?? null,
        d.consentFlags ? JSON.stringify(d.consentFlags) : null,
        user.organizationId,
      ]
    );
    await rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.CONTACT_UPDATED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { contactId: id },
    } as Event);
    res.json(result.rows[0]);
  } catch (e) {
    next(e);
  }
}

app.put('/api/crm/contacts/:id', updateContactHandler);
app.patch('/api/crm/contacts/:id', updateContactHandler);

app.delete('/api/crm/contacts/:id', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const existing = await pool.query(
      'SELECT * FROM contacts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (existing.rows.length === 0) {
      throw new AppError(404, 'Contact not found', ErrorCodes.NOT_FOUND);
    }
    await pool.query(
      'UPDATE deals SET contact_id = NULL, updated_at = NOW() WHERE contact_id = $1',
      [id]
    );
    await pool.query('DELETE FROM contacts WHERE id = $1 AND organization_id = $2', [
      id,
      user.organizationId,
    ]);
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

// ---------- Notes (contact or deal) ----------
async function ensureEntityAccess(
  organizationId: string,
  entityType: 'contact' | 'deal',
  entityId: string
): Promise<void> {
  const table = entityType === 'contact' ? 'contacts' : 'deals';
  const r = await pool.query(
    `SELECT 1 FROM ${table} WHERE id = $1 AND organization_id = $2`,
    [entityId, organizationId]
  );
  if (r.rows.length === 0) {
    throw new AppError(404, `${entityType === 'contact' ? 'Contact' : 'Deal'} not found`, ErrorCodes.NOT_FOUND);
  }
}

app.get('/api/crm/contacts/:contactId/notes', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { contactId } = req.params;
    await ensureEntityAccess(user.organizationId, 'contact', contactId);
    const result = await pool.query(
      `SELECT id, entity_type, entity_id, content, user_id, created_at, updated_at
       FROM notes WHERE organization_id = $1 AND entity_type = 'contact' AND entity_id = $2
       ORDER BY created_at DESC`,
      [user.organizationId, contactId]
    );
    res.json(result.rows);
  } catch (e) {
    next(e);
  }
});

app.post('/api/crm/contacts/:contactId/notes', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { contactId } = req.params;
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) throw new AppError(400, 'content is required', ErrorCodes.VALIDATION);
    await ensureEntityAccess(user.organizationId, 'contact', contactId);
    const result = await pool.query(
      `INSERT INTO notes (organization_id, entity_type, entity_id, content, user_id)
       VALUES ($1, 'contact', $2, $3, $4) RETURNING *`,
      [user.organizationId, contactId, content, user.id || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    next(e);
  }
});

app.get('/api/crm/deals/:dealId/notes', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { dealId } = req.params;
    await ensureEntityAccess(user.organizationId, 'deal', dealId);
    const result = await pool.query(
      `SELECT id, entity_type, entity_id, content, user_id, created_at, updated_at
       FROM notes WHERE organization_id = $1 AND entity_type = 'deal' AND entity_id = $2
       ORDER BY created_at DESC`,
      [user.organizationId, dealId]
    );
    res.json(result.rows);
  } catch (e) {
    next(e);
  }
});

app.post('/api/crm/deals/:dealId/notes', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { dealId } = req.params;
    const content = typeof req.body?.content === 'string' ? req.body.content.trim() : '';
    if (!content) throw new AppError(400, 'content is required', ErrorCodes.VALIDATION);
    await ensureEntityAccess(user.organizationId, 'deal', dealId);
    const result = await pool.query(
      `INSERT INTO notes (organization_id, entity_type, entity_id, content, user_id)
       VALUES ($1, 'deal', $2, $3, $4) RETURNING *`,
      [user.organizationId, dealId, content, user.id || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    next(e);
  }
});

app.delete('/api/crm/notes/:id', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM notes WHERE id = $1 AND organization_id = $2 RETURNING id',
      [id, user.organizationId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'Note not found', ErrorCodes.NOT_FOUND);
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

// ---------- Reminders (contact or deal) ----------
app.get('/api/crm/contacts/:contactId/reminders', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { contactId } = req.params;
    await ensureEntityAccess(user.organizationId, 'contact', contactId);
    const result = await pool.query(
      `SELECT id, entity_type, entity_id, remind_at, title, done, user_id, created_at
       FROM reminders WHERE organization_id = $1 AND entity_type = 'contact' AND entity_id = $2
       ORDER BY remind_at ASC`,
      [user.organizationId, contactId]
    );
    res.json(result.rows);
  } catch (e) {
    next(e);
  }
});

app.post('/api/crm/contacts/:contactId/reminders', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { contactId } = req.params;
    const remindAt = req.body?.remind_at; // ISO string
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 500) : null;
    if (!remindAt) throw new AppError(400, 'remind_at is required', ErrorCodes.VALIDATION);
    const at = new Date(remindAt);
    if (Number.isNaN(at.getTime())) throw new AppError(400, 'remind_at must be a valid date', ErrorCodes.VALIDATION);
    await ensureEntityAccess(user.organizationId, 'contact', contactId);
    const result = await pool.query(
      `INSERT INTO reminders (organization_id, entity_type, entity_id, remind_at, title, user_id)
       VALUES ($1, 'contact', $2, $3, $4, $5) RETURNING *`,
      [user.organizationId, contactId, at, title, user.id || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    next(e);
  }
});

app.get('/api/crm/deals/:dealId/reminders', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { dealId } = req.params;
    await ensureEntityAccess(user.organizationId, 'deal', dealId);
    const result = await pool.query(
      `SELECT id, entity_type, entity_id, remind_at, title, done, user_id, created_at
       FROM reminders WHERE organization_id = $1 AND entity_type = 'deal' AND entity_id = $2
       ORDER BY remind_at ASC`,
      [user.organizationId, dealId]
    );
    res.json(result.rows);
  } catch (e) {
    next(e);
  }
});

app.post('/api/crm/deals/:dealId/reminders', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { dealId } = req.params;
    const remindAt = req.body?.remind_at;
    const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 500) : null;
    if (!remindAt) throw new AppError(400, 'remind_at is required', ErrorCodes.VALIDATION);
    const at = new Date(remindAt);
    if (Number.isNaN(at.getTime())) throw new AppError(400, 'remind_at must be a valid date', ErrorCodes.VALIDATION);
    await ensureEntityAccess(user.organizationId, 'deal', dealId);
    const result = await pool.query(
      `INSERT INTO reminders (organization_id, entity_type, entity_id, remind_at, title, user_id)
       VALUES ($1, 'deal', $2, $3, $4, $5) RETURNING *`,
      [user.organizationId, dealId, at, title, user.id || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    next(e);
  }
});

app.patch('/api/crm/reminders/:id', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { done, remind_at, title } = req.body || {};
    const existing = await pool.query(
      'SELECT * FROM reminders WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (existing.rows.length === 0) throw new AppError(404, 'Reminder not found', ErrorCodes.NOT_FOUND);
    const updates: string[] = [];
    const params: unknown[] = [];
    let idx = 1;
    if (typeof done === 'boolean') {
      params.push(done);
      updates.push(`done = $${idx++}`);
    }
    if (remind_at != null) {
      const at = new Date(remind_at);
      if (!Number.isNaN(at.getTime())) {
        params.push(at);
        updates.push(`remind_at = $${idx++}`);
      }
    }
    if (typeof title === 'string') {
      params.push(title.slice(0, 500));
      updates.push(`title = $${idx++}`);
    }
    if (params.length === 0) return res.json(existing.rows[0]);
    params.push(id, user.organizationId);
    const result = await pool.query(
      `UPDATE reminders SET ${updates.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1} RETURNING *`,
      params
    );
    res.json(result.rows[0]);
  } catch (e) {
    next(e);
  }
});

app.delete('/api/crm/reminders/:id', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const result = await pool.query(
      'DELETE FROM reminders WHERE id = $1 AND organization_id = $2 RETURNING id',
      [id, user.organizationId]
    );
    if (result.rows.length === 0) throw new AppError(404, 'Reminder not found', ErrorCodes.NOT_FOUND);
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

/** Upcoming reminders for the organization (done = false, remind_at from now to +horizon). For widget "Предстоящие напоминания". */
app.get('/api/crm/reminders/upcoming', async (req, res, next) => {
  try {
    const user = getUser(req);
    const horizonHours = Math.min(168, Math.max(24, parseInt(String(req.query.hours), 10) || 72)); // default 72h
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit), 10) || 20));
    const from = new Date();
    const to = new Date(from.getTime() + horizonHours * 60 * 60 * 1000);
    const result = await pool.query(
      `SELECT r.id, r.entity_type, r.entity_id, r.remind_at, r.title, r.done, r.user_id, r.created_at
       FROM reminders r
       WHERE r.organization_id = $1 AND r.done = false AND r.remind_at >= $2 AND r.remind_at <= $3
       ORDER BY r.remind_at ASC
       LIMIT $4`,
      [user.organizationId, from, to, limit]
    );
    res.json(result.rows);
  } catch (e) {
    next(e);
  }
});

// ---------- Deals ----------
app.get('/api/crm/deals', async (req, res, next) => {
  try {
    const user = getUser(req);
    const page = Math.max(1, parseInt(String(req.query.page), 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit), 10) || 20));
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;
    const contactId = typeof req.query.contactId === 'string' ? req.query.contactId : undefined;
    const pipelineId = typeof req.query.pipelineId === 'string' ? req.query.pipelineId : undefined;
    const stageId = typeof req.query.stageId === 'string' ? req.query.stageId : undefined;
    const ownerId = typeof req.query.ownerId === 'string' ? req.query.ownerId : undefined;
    const createdBy = typeof req.query.createdBy === 'string' ? req.query.createdBy : undefined;

    let where = 'WHERE d.organization_id = $1';
    const params: unknown[] = [user.organizationId];

    if (companyId) {
      params.push(companyId);
      where += ` AND d.company_id = $${params.length}`;
    }
    if (contactId) {
      params.push(contactId);
      where += ` AND d.contact_id = $${params.length}`;
    }
    if (pipelineId) {
      params.push(pipelineId);
      where += ` AND d.pipeline_id = $${params.length}`;
    }
    if (stageId) {
      params.push(stageId);
      where += ` AND d.stage_id = $${params.length}`;
    }
    if (ownerId) {
      params.push(ownerId);
      where += ` AND d.owner_id = $${params.length}`;
    }
    if (createdBy) {
      params.push(createdBy);
      where += ` AND d.created_by_id = $${params.length}`;
    }
    if (search) {
      params.push(`%${search}%`);
      where += ` AND d.title ILIKE $${params.length}`;
    }

    const countResult = await pool.query(
      `SELECT COUNT(*)::int AS total FROM deals d ${where}`,
      params
    );
    const total = countResult.rows[0].total;

    const offset = (page - 1) * limit;
    params.push(limit, offset);
    const result = await pool.query(
      `SELECT d.*,
        c.name AS company_name,
        p.name AS pipeline_name,
        s.name AS stage_name,
        s.order_index AS stage_order,
        cont.display_name AS contact_display_name,
        cont.first_name AS contact_first_name,
        cont.last_name AS contact_last_name,
        cont.email AS contact_email,
        u.email AS owner_email,
        creator.email AS creator_email
       FROM deals d
       LEFT JOIN companies c ON d.company_id = c.id
       LEFT JOIN pipelines p ON d.pipeline_id = p.id
       LEFT JOIN stages s ON d.stage_id = s.id
       LEFT JOIN contacts cont ON d.contact_id = cont.id
       LEFT JOIN users u ON d.owner_id = u.id
       LEFT JOIN users creator ON d.created_by_id = creator.id
       ${where}
       ORDER BY d.updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const items = result.rows.map((r: any) => {
      const { company_name, pipeline_name, stage_name, stage_order, contact_display_name, contact_first_name, contact_last_name, contact_email, owner_email, creator_email, ...deal } = r;
      const contactName =
        contact_display_name?.trim() ||
        [contact_first_name?.trim(), contact_last_name?.trim()].filter(Boolean).join(' ') ||
        contact_email?.trim() ||
        null;
      return {
        ...deal,
        leadId: deal.lead_id ?? undefined,
        companyName: company_name,
        pipelineName: pipeline_name,
        stageName: stage_name,
        stageOrder: stage_order,
        contactName: contactName || undefined,
        ownerEmail: owner_email || undefined,
        creatorEmail: creator_email || undefined,
      };
    });

    res.json({
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (e) {
    next(e);
  }
});

app.get('/api/crm/deals/:id', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const result = await pool.query(
      `SELECT d.*,
        c.name AS company_name,
        p.name AS pipeline_name,
        s.name AS stage_name,
        s.order_index AS stage_order,
        cont.display_name AS contact_display_name,
        cont.first_name AS contact_first_name,
        cont.last_name AS contact_last_name,
        cont.email AS contact_email,
        u.email AS owner_email,
        creator.email AS creator_email
       FROM deals d
       LEFT JOIN companies c ON d.company_id = c.id
       LEFT JOIN pipelines p ON d.pipeline_id = p.id
       LEFT JOIN stages s ON d.stage_id = s.id
       LEFT JOIN contacts cont ON d.contact_id = cont.id
       LEFT JOIN users u ON d.owner_id = u.id
       LEFT JOIN users creator ON d.created_by_id = creator.id
       WHERE d.id = $1 AND d.organization_id = $2`,
      [id, user.organizationId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'Deal not found', ErrorCodes.NOT_FOUND);
    }
    const row = result.rows[0];
    const { company_name, pipeline_name, stage_name, stage_order, contact_display_name, contact_first_name, contact_last_name, contact_email, owner_email, creator_email, ...deal } = row;
    const contactName =
      contact_display_name?.trim() ||
      [contact_first_name?.trim(), contact_last_name?.trim()].filter(Boolean).join(' ') ||
      contact_email?.trim() ||
      null;
    res.json({
      ...deal,
      leadId: deal.lead_id ?? undefined,
      companyName: company_name,
      pipelineName: pipeline_name,
      stageName: stage_name,
      stageOrder: stage_order,
      contactName: contactName || undefined,
      ownerEmail: owner_email || undefined,
      creatorEmail: creator_email || undefined,
    });
  } catch (e) {
    next(e);
  }
});

app.post('/api/crm/deals', async (req, res, next) => {
  try {
    const user = getUser(req);
    const parsed = DealCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.errors.map((e) => e.message).join('; '),
        ErrorCodes.VALIDATION
      );
    }
    const {
      companyId,
      contactId,
      pipelineId,
      stageId: bodyStageId,
      leadId,
      title,
      value,
      currency,
      probability,
      expectedCloseDate,
      comments,
      bdAccountId,
      channel,
      channelId,
    } = parsed.data;

    const fromChat = bdAccountId != null && channel != null && channelId != null;
    const fromContactOnly = contactId != null && !fromChat && (companyId == null || companyId === '');
    if (!fromChat && !fromContactOnly && (companyId == null || companyId === '') && !leadId) {
      throw new AppError(
        400,
        'Either companyId, (bdAccountId + channel + channelId), contactId, or leadId is required',
        ErrorCodes.VALIDATION
      );
    }

    // --- ЭТАП 3: создание сделки из лида (leadId) — одна транзакция, перевод лида в Converted, lead.converted ---
    if (leadId) {
      const leadRow = await pool.query(
        'SELECT id, contact_id, pipeline_id, stage_id, organization_id FROM leads WHERE id = $1 AND organization_id = $2',
        [leadId, user.organizationId]
      );
      if (leadRow.rows.length === 0) {
        throw new AppError(404, 'Lead not found or access denied', ErrorCodes.NOT_FOUND);
      }
      const lead = leadRow.rows[0] as { id: string; contact_id: string; pipeline_id: string; stage_id: string; organization_id: string };
      const existingDeal = await pool.query('SELECT 1 FROM deals WHERE lead_id = $1', [leadId]);
      if (existingDeal.rows.length > 0) {
        throw new AppError(409, 'This lead is already linked to a deal', ErrorCodes.CONFLICT);
      }
      if (pipelineId != null && pipelineId !== lead.pipeline_id) {
        throw new AppError(400, "pipelineId must match lead's pipeline", ErrorCodes.VALIDATION);
      }
      if (contactId != null && contactId !== lead.contact_id) {
        throw new AppError(400, "contactId must match lead's contact", ErrorCodes.VALIDATION);
      }
      const convertedStage = await pool.query(
        "SELECT id FROM stages WHERE pipeline_id = $1 AND organization_id = $2 AND name = 'Converted' LIMIT 1",
        [lead.pipeline_id, user.organizationId]
      );
      if (convertedStage.rows.length === 0) {
        throw new AppError(400, 'Pipeline must have a Converted stage', ErrorCodes.VALIDATION);
      }
      const convertedStageId = convertedStage.rows[0].id as string;
      const correlationId = (req.headers['x-correlation-id'] as string) ?? null;
      let resolvedCompanyId = companyId ?? null;
      if (companyId) {
        const companyCheck = await pool.query(
          'SELECT 1 FROM companies WHERE id = $1 AND organization_id = $2',
          [companyId, user.organizationId]
        );
        if (companyCheck.rows.length === 0) {
          throw new AppError(400, 'Company not found or access denied', ErrorCodes.VALIDATION);
        }
      } else {
        const contactRow = await pool.query(
          'SELECT company_id FROM contacts WHERE id = $1 AND organization_id = $2',
          [lead.contact_id, user.organizationId]
        );
        if (contactRow.rows.length > 0 && contactRow.rows[0].company_id) {
          resolvedCompanyId = contactRow.rows[0].company_id;
        }
      }
      let stageId = bodyStageId ?? null;
      if (!stageId) {
        stageId = await getFirstStageId(lead.pipeline_id, user.organizationId);
        if (!stageId) {
          throw new AppError(400, 'Pipeline has no stages', ErrorCodes.VALIDATION);
        }
      } else {
        await ensureStageInPipeline(stageId, lead.pipeline_id, user.organizationId);
      }

      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const insertResult = await client.query(
          `INSERT INTO deals (organization_id, company_id, contact_id, pipeline_id, stage_id, owner_id, created_by_id, lead_id, title, value, currency, probability, expected_close_date, comments, history, bd_account_id, channel, channel_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING *`,
          [
            user.organizationId,
            resolvedCompanyId,
            lead.contact_id,
            lead.pipeline_id,
            stageId,
            user.id,
            user.id,
            leadId,
            title,
            value ?? null,
            currency ?? null,
            probability ?? null,
            expectedCloseDate ?? null,
            comments ?? null,
            JSON.stringify([
              { id: randomUUID(), action: 'created', toStageId: stageId, performedBy: user.id, timestamp: new Date() },
            ]),
            bdAccountId ?? null,
            channel ?? null,
            channelId ?? null,
          ]
        );
        const deal = insertResult.rows[0];
        await client.query(
          'UPDATE leads SET stage_id = $1, updated_at = NOW() WHERE id = $2',
          [convertedStageId, leadId]
        );
        await client.query(
          `INSERT INTO stage_history (organization_id, entity_type, entity_id, pipeline_id, from_stage_id, to_stage_id, changed_by, reason, source, correlation_id)
           VALUES ($1, 'lead', $2, $3, $4, $5, $6, $7, 'manual', $8)`,
          [user.organizationId, leadId, lead.pipeline_id, lead.stage_id, convertedStageId, user.id, 'Converted to deal', correlationId]
        );
        await client.query('COMMIT');

        dealCreatedTotal.inc();
        log.info({
          message: 'deal created',
          correlation_id: correlationId ?? undefined,
          entity_type: 'deal',
          entity_id: deal.id,
          lead_id: leadId,
        });

        try {
          await rabbitmq.publishEvent({
            id: randomUUID(),
            type: EventType.DEAL_CREATED,
            timestamp: new Date(),
            organizationId: user.organizationId,
            userId: user.id,
            data: { dealId: deal.id, pipelineId: lead.pipeline_id, stageId, leadId },
          } as Event);
          await rabbitmq.publishEvent({
            id: randomUUID(),
            type: EventType.LEAD_CONVERTED,
            timestamp: new Date(),
            organizationId: user.organizationId,
            userId: user.id,
            data: {
              leadId,
              dealId: deal.id,
              pipelineId: lead.pipeline_id,
              convertedAt: new Date().toISOString(),
            },
          } as Event);
        } catch (pubErr) {
          console.error('Failed to publish deal.created/lead.converted:', pubErr);
        }
        const { lead_id, ...rest } = deal;
        res.status(201).json({ ...rest, leadId: lead_id ?? undefined });
      } catch (txErr) {
        await client.query('ROLLBACK').catch(() => {});
        throw txErr;
      } finally {
        client.release();
      }
      return;
    }

    // --- Без leadId: обычный флоу ---
    if (!fromChat && !fromContactOnly && (pipelineId == null || pipelineId === '')) {
      throw new AppError(400, 'pipelineId is required when leadId is not provided', ErrorCodes.VALIDATION);
    }
    let resolvedCompanyId = companyId ?? null;
    if (!fromChat && !fromContactOnly && companyId) {
      const companyCheck = await pool.query(
        'SELECT 1 FROM companies WHERE id = $1 AND organization_id = $2',
        [companyId, user.organizationId]
      );
      if (companyCheck.rows.length === 0) {
        throw new AppError(400, 'Company not found or access denied', ErrorCodes.VALIDATION);
      }
    }
    if (fromContactOnly && contactId) {
      const contactRow = await pool.query(
        'SELECT company_id FROM contacts WHERE id = $1 AND organization_id = $2',
        [contactId, user.organizationId]
      );
      if (contactRow.rows.length > 0 && contactRow.rows[0].company_id) {
        resolvedCompanyId = contactRow.rows[0].company_id;
      }
    }
    const pipelineCheck = await pool.query(
      'SELECT 1 FROM pipelines WHERE id = $1 AND organization_id = $2',
      [pipelineId, user.organizationId]
    );
    if (pipelineCheck.rows.length === 0) {
      throw new AppError(400, 'Pipeline not found or access denied', ErrorCodes.VALIDATION);
    }

    const resolvedPipelineId = pipelineId!;
    let stageId = bodyStageId ?? null;
    if (!stageId) {
      stageId = await getFirstStageId(resolvedPipelineId, user.organizationId);
      if (!stageId) {
        throw new AppError(
          400,
          'Pipeline has no stages. Create at least one stage first.',
          ErrorCodes.VALIDATION
        );
      }
    } else {
      await ensureStageInPipeline(stageId, resolvedPipelineId, user.organizationId);
    }

    if (contactId) {
      const contactCheck = await pool.query(
        'SELECT 1 FROM contacts WHERE id = $1 AND organization_id = $2',
        [contactId, user.organizationId]
      );
      if (contactCheck.rows.length === 0) {
        throw new AppError(400, 'Contact not found or access denied', ErrorCodes.VALIDATION);
      }
    }

    const result = await pool.query(
      `INSERT INTO deals (organization_id, company_id, contact_id, pipeline_id, stage_id, owner_id, created_by_id, title, value, currency, probability, expected_close_date, comments, history, bd_account_id, channel, channel_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) RETURNING *`,
      [
        user.organizationId,
        resolvedCompanyId,
        contactId ?? null,
        pipelineId,
        stageId,
        user.id,
        user.id,
        title,
        value ?? null,
        currency ?? null,
        probability ?? null,
        expectedCloseDate ?? null,
        comments ?? null,
        JSON.stringify([
          {
            id: randomUUID(),
            action: 'created',
            toStageId: stageId,
            performedBy: user.id,
            timestamp: new Date(),
          },
        ]),
        bdAccountId ?? null,
        channel ?? null,
        channelId ?? null,
      ]
    );
    dealCreatedTotal.inc();
    await rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.DEAL_CREATED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { dealId: result.rows[0].id, pipelineId, stageId },
    } as Event);
    res.status(201).json(result.rows[0]);
  } catch (e) {
    next(e);
  }
});

app.put('/api/crm/deals/:id', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const parsed = DealUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.errors.map((e) => e.message).join('; '),
        ErrorCodes.VALIDATION
      );
    }
    const existing = await pool.query(
      'SELECT * FROM deals WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (existing.rows.length === 0) {
      throw new AppError(404, 'Deal not found', ErrorCodes.NOT_FOUND);
    }
    const d = parsed.data;
    const row = existing.rows[0];
    const result = await pool.query(
      `UPDATE deals SET
        title = COALESCE($2, title),
        value = $3,
        currency = $4,
        contact_id = $5,
        owner_id = COALESCE($6, owner_id),
        probability = $7,
        expected_close_date = $8,
        comments = $9,
        updated_at = NOW()
       WHERE id = $1 AND organization_id = $10
       RETURNING *`,
      [
        id,
        d.title ?? row.title,
        d.value !== undefined ? d.value : row.value,
        d.currency !== undefined ? d.currency : row.currency,
        d.contactId !== undefined ? d.contactId : row.contact_id,
        d.ownerId ?? row.owner_id,
        d.probability !== undefined ? d.probability : row.probability,
        d.expectedCloseDate !== undefined ? d.expectedCloseDate : row.expected_close_date,
        d.comments !== undefined ? d.comments : row.comments,
        user.organizationId,
      ]
    );
    await rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.DEAL_UPDATED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { dealId: id },
    } as Event);
    res.json(result.rows[0]);
  } catch (e) {
    next(e);
  }
});

// SINGLE SOURCE OF TRUTH FOR DEAL STAGE TRANSITIONS: only this handler updates deals.stage_id,
// writes to deals.history and stage_history, and publishes deal.stage.changed.
app.patch('/api/crm/deals/:id/stage', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const parsed = DealStageUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(
        400,
        parsed.error.errors.map((e) => e.message).join('; '),
        ErrorCodes.VALIDATION
      );
    }
    const { stageId, reason, autoMoved = false } = parsed.data;
    const correlationId = (req.headers['x-correlation-id'] as string) ?? null;
    const dealResult = await pool.query(
      'SELECT * FROM deals WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (dealResult.rows.length === 0) {
      throw new AppError(404, 'Deal not found', ErrorCodes.NOT_FOUND);
    }
    const deal = dealResult.rows[0];
    await ensureStageInPipeline(stageId, deal.pipeline_id, user.organizationId);

    const history = Array.isArray(deal.history) ? [...deal.history] : [];
    history.push({
      id: randomUUID(),
      action: 'stage_changed',
      fromStageId: deal.stage_id,
      toStageId: stageId,
      performedBy: user.id,
      timestamp: new Date(),
      reason: reason ?? undefined,
    });

    await pool.query(
      'UPDATE deals SET stage_id = $1, history = $2, updated_at = NOW() WHERE id = $3',
      [stageId, JSON.stringify(history), id]
    );

    dealStageChangedTotal.inc();
    // Audit log for analytics (ЭТАП 2: entity_type/entity_id/source; ЭТАП 5: correlation_id).
    await pool.query(
      `INSERT INTO stage_history (organization_id, entity_type, entity_id, pipeline_id, from_stage_id, to_stage_id, changed_by, reason, source, correlation_id)
       VALUES ($1, 'deal', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        user.organizationId,
        id,
        deal.pipeline_id,
        deal.stage_id,
        stageId,
        user.id,
        reason ?? null,
        autoMoved ? 'automation' : 'manual',
        correlationId,
      ]
    );

    await rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.DEAL_STAGE_CHANGED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { dealId: id, fromStageId: deal.stage_id, toStageId: stageId, reason, autoMoved },
    } as Event);
    res.json({ success: true });
  } catch (e) {
    next(e);
  }
});

app.delete('/api/crm/deals/:id', async (req, res, next) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const existing = await pool.query(
      'SELECT * FROM deals WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (existing.rows.length === 0) {
      throw new AppError(404, 'Deal not found', ErrorCodes.NOT_FOUND);
    }
    await pool.query("DELETE FROM stage_history WHERE entity_type = 'deal' AND entity_id = $1", [id]);
    await pool.query('DELETE FROM deals WHERE id = $1 AND organization_id = $2', [
      id,
      user.organizationId,
    ]);
    res.status(204).send();
  } catch (e) {
    next(e);
  }
});

// ---------- Analytics: conversion (Lead → Deal baseline) ----------
// GET /api/crm/analytics/conversion?pipelineId=...
// Returns totalLeads, convertedLeads, conversionRate. Optional pipelineId scopes to one pipeline.
app.get('/api/crm/analytics/conversion', async (req, res, next) => {
  try {
    const user = getUser(req);
    const pipelineId = typeof req.query.pipelineId === 'string' ? req.query.pipelineId : undefined;

    let leadsWhere = 'WHERE l.organization_id = $1';
    let dealsWhere = 'WHERE d.organization_id = $1 AND d.lead_id IS NOT NULL';
    const params: unknown[] = [user.organizationId];

    if (pipelineId) {
      params.push(pipelineId);
      leadsWhere += ` AND l.pipeline_id = $${params.length}`;
      dealsWhere += ` AND d.pipeline_id = $${params.length}`;
    }

    const [leadsResult, dealsResult] = await Promise.all([
      pool.query(
        `SELECT COUNT(*)::int AS total FROM leads l ${leadsWhere}`,
        params
      ),
      pool.query(
        `SELECT COUNT(*)::int AS total FROM deals d ${dealsWhere}`,
        params
      ),
    ]);

    const totalLeads = leadsResult.rows[0].total;
    const convertedLeads = dealsResult.rows[0].total;
    const conversionRate =
      totalLeads > 0 ? Math.round((convertedLeads / totalLeads) * 10000) / 10000 : 0;

    res.json({
      totalLeads,
      convertedLeads,
      conversionRate,
    });
  } catch (e) {
    next(e);
  }
});

// ---------- Error handler (must be last) ----------
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (isAppError(err)) {
    return res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
    });
  }
  console.error('Unhandled error:', err);
  res.status(500).json({
    error: 'Internal server error',
    code: 'INTERNAL_ERROR',
  });
});

app.listen(PORT, () => {
  console.log(`CRM service running on port ${PORT}`);
});
