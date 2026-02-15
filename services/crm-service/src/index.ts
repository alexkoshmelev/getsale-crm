import express from 'express';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, Event } from '@getsale/events';
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
        u.email AS owner_email
       FROM deals d
       LEFT JOIN companies c ON d.company_id = c.id
       LEFT JOIN pipelines p ON d.pipeline_id = p.id
       LEFT JOIN stages s ON d.stage_id = s.id
       LEFT JOIN contacts cont ON d.contact_id = cont.id
       LEFT JOIN users u ON d.owner_id = u.id
       ${where}
       ORDER BY d.updated_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const items = result.rows.map((r: any) => {
      const { company_name, pipeline_name, stage_name, stage_order, contact_display_name, contact_first_name, contact_last_name, contact_email, owner_email, ...deal } = r;
      const contactName =
        contact_display_name?.trim() ||
        [contact_first_name?.trim(), contact_last_name?.trim()].filter(Boolean).join(' ') ||
        contact_email?.trim() ||
        null;
      return {
        ...deal,
        companyName: company_name,
        pipelineName: pipeline_name,
        stageName: stage_name,
        stageOrder: stage_order,
        contactName: contactName || undefined,
        ownerEmail: owner_email || undefined,
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
        u.email AS owner_email
       FROM deals d
       LEFT JOIN companies c ON d.company_id = c.id
       LEFT JOIN pipelines p ON d.pipeline_id = p.id
       LEFT JOIN stages s ON d.stage_id = s.id
       LEFT JOIN contacts cont ON d.contact_id = cont.id
       LEFT JOIN users u ON d.owner_id = u.id
       WHERE d.id = $1 AND d.organization_id = $2`,
      [id, user.organizationId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'Deal not found', ErrorCodes.NOT_FOUND);
    }
    const row = result.rows[0];
    const { company_name, pipeline_name, stage_name, stage_order, contact_display_name, contact_first_name, contact_last_name, contact_email, owner_email, ...deal } = row;
    const contactName =
      contact_display_name?.trim() ||
      [contact_first_name?.trim(), contact_last_name?.trim()].filter(Boolean).join(' ') ||
      contact_email?.trim() ||
      null;
    res.json({
      ...deal,
      companyName: company_name,
      pipelineName: pipeline_name,
      stageName: stage_name,
      stageOrder: stage_order,
      contactName: contactName || undefined,
      ownerEmail: owner_email || undefined,
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
    if (!fromChat && !fromContactOnly && (companyId == null || companyId === '')) {
      throw new AppError(
        400,
        'Either companyId, (bdAccountId + channel + channelId), or contactId is required',
        ErrorCodes.VALIDATION
      );
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

    let stageId = bodyStageId ?? null;
    if (!stageId) {
      stageId = await getFirstStageId(pipelineId, user.organizationId);
      if (!stageId) {
        throw new AppError(
          400,
          'Pipeline has no stages. Create at least one stage first.',
          ErrorCodes.VALIDATION
        );
      }
    } else {
      await ensureStageInPipeline(stageId, pipelineId, user.organizationId);
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
      `INSERT INTO deals (organization_id, company_id, contact_id, pipeline_id, stage_id, owner_id, title, value, currency, probability, expected_close_date, comments, history, bd_account_id, channel, channel_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16) RETURNING *`,
      [
        user.organizationId,
        resolvedCompanyId,
        contactId ?? null,
        pipelineId,
        stageId,
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
    const { stageId, reason } = parsed.data;
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

    await rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.DEAL_STAGE_CHANGED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { dealId: id, fromStageId: deal.stage_id, toStageId: stageId, reason },
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
    await pool.query('DELETE FROM stage_history WHERE deal_id = $1', [id]);
    await pool.query('DELETE FROM deals WHERE id = $1 AND organization_id = $2', [
      id,
      user.organizationId,
    ]);
    res.status(204).send();
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
