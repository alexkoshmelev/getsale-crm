import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { EventType, type Event } from '@getsale/events';
import { AppError, ErrorCodes, requireUser } from '@getsale/service-framework';
import type { CoreDeps } from '../types';

const CreateContactSchema = z.object({
  firstName: z.string().min(1).max(200).optional(),
  lastName: z.string().max(200).optional(),
  email: z.string().email().max(254).optional(),
  phone: z.string().max(50).optional(),
  telegramId: z.string().max(100).optional(),
  username: z.string().max(255).optional(),
  displayName: z.string().max(255).optional(),
  companyId: z.string().uuid().optional(),
});

const UpdateContactSchema = CreateContactSchema.partial();

const ListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().max(200).optional(),
  companyId: z.string().uuid().optional(),
});

const ImportCsvSchema = z.object({
  content: z.string().min(1),
  hasHeader: z.boolean().default(false),
  mapping: z.record(z.string(), z.number()),
});

const ImportTelegramGroupSchema = z.object({
  bdAccountId: z.string().uuid(),
  telegramChatId: z.string().min(1),
  telegramChatTitle: z.string().optional(),
  searchKeyword: z.string().optional(),
  excludeAdmins: z.boolean().optional(),
  leaveAfter: z.boolean().optional(),
});

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { result.push(current.trim()); current = ''; }
      else { current += ch; }
    }
  }
  result.push(current.trim());
  return result;
}

export function registerContactRoutes(app: FastifyInstance, deps: CoreDeps): void {
  const { db, rabbitmq, log, contactsCache } = deps;

  app.get('/api/crm/contacts', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const query = ListQuerySchema.parse(request.query);
    const page = query.page;
    const limit = query.limit;
    const offset = (page - 1) * limit;
    const cacheKey = `${user.organizationId}:list:${page}:${limit}:${query.search || ''}:${query.companyId || ''}`;

    const cached = await contactsCache.get(cacheKey);
    if (cached) return cached;

    const conditions = ['c.organization_id = $1', 'c.deleted_at IS NULL'];
    const params: unknown[] = [user.organizationId];
    let idx = 2;

    if (query.search) {
      conditions.push(
        `(c.first_name ILIKE $${idx} OR c.last_name ILIKE $${idx} OR c.email ILIKE $${idx} OR c.phone ILIKE $${idx} OR c.username ILIKE $${idx} OR COALESCE(c.display_name, '') ILIKE $${idx})`,
      );
      params.push(`%${query.search}%`);
      idx++;
    }
    if (query.companyId) {
      conditions.push(`c.company_id = $${idx}`);
      params.push(query.companyId);
      idx++;
    }

    const where = conditions.join(' AND ');
    const [dataResult, countResult] = await Promise.all([
      db.read.query(
        `SELECT c.*, comp.name as company_name FROM contacts c LEFT JOIN companies comp ON c.company_id = comp.id WHERE ${where} ORDER BY c.updated_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
        [...params, limit, offset],
      ),
      db.read.query(`SELECT COUNT(*) FROM contacts c WHERE ${where}`, params),
    ]);

    const total = parseInt(countResult.rows[0].count, 10);
    const items = dataResult.rows.map((r: Record<string, unknown>) => ({ ...r, companyName: (r.company_name as string) ?? null }));
    const result = { items, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
    await contactsCache.set(cacheKey, result);
    return result;
  });

  app.get('/api/crm/contacts/:id', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const result = await db.read.query(
      'SELECT c.*, comp.name as company_name FROM contacts c LEFT JOIN companies comp ON c.company_id = comp.id WHERE c.id = $1 AND c.organization_id = $2 AND c.deleted_at IS NULL',
      [id, user.organizationId],
    );
    if (!result.rows.length) throw new AppError(404, 'Contact not found', ErrorCodes.NOT_FOUND);
    const row = result.rows[0] as Record<string, unknown>;

    const sourcesResult = await db.read.query(
      'SELECT telegram_chat_id, telegram_chat_title FROM contact_telegram_sources WHERE contact_id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    const telegramGroups = (sourcesResult.rows as { telegram_chat_id: string; telegram_chat_title: string | null }[]).map((r) => ({
      telegram_chat_id: r.telegram_chat_id,
      telegram_chat_title: r.telegram_chat_title ?? undefined,
    }));

    return { ...row, companyName: (row.company_name as string) ?? null, telegramGroups };
  });

  app.post('/api/crm/contacts', { preHandler: [requireUser] }, async (request, reply) => {
    const body = CreateContactSchema.parse(request.body);
    const user = request.user!;

    if (body.companyId) {
      const companyCheck = await db.read.query(
        'SELECT 1 FROM companies WHERE id = $1 AND organization_id = $2',
        [body.companyId, user.organizationId],
      );
      if (!companyCheck.rows.length) throw new AppError(400, 'Company not found', ErrorCodes.BAD_REQUEST);
    }

    const result = await db.write.query(
      `INSERT INTO contacts (organization_id, first_name, last_name, email, phone, telegram_id, username, display_name, company_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
      [user.organizationId, body.firstName || '', body.lastName, body.email, body.phone, body.telegramId, body.username, body.displayName, body.companyId],
    );

    await contactsCache.invalidatePattern(`${user.organizationId}:list:*`);
    rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.CONTACT_CREATED, timestamp: new Date(),
      organizationId: user.organizationId, userId: user.id,
      correlationId: (request as any).correlationId || randomUUID(),
      data: { contactId: result.rows[0].id, entityType: 'contact', entityId: result.rows[0].id },
    } as unknown as Event).catch(() => {});

    reply.code(201);
    return result.rows[0];
  });

  app.put('/api/crm/contacts/:id', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = UpdateContactSchema.parse(request.body);
    const user = request.user!;

    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    for (const [key, val] of Object.entries(body)) {
      if (val !== undefined) {
        const col = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
        fields.push(`${col} = $${idx}`);
        values.push(val);
        idx++;
      }
    }
    if (!fields.length) throw new AppError(400, 'No fields to update', ErrorCodes.BAD_REQUEST);

    fields.push(`updated_at = NOW()`);
    values.push(id, user.organizationId);
    const result = await db.write.query(
      `UPDATE contacts SET ${fields.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1} AND deleted_at IS NULL RETURNING *`,
      values,
    );
    if (!result.rows.length) throw new AppError(404, 'Contact not found', ErrorCodes.NOT_FOUND);

    await contactsCache.invalidatePattern(`${user.organizationId}:*`);
    rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.CONTACT_UPDATED, timestamp: new Date(),
      organizationId: user.organizationId, userId: user.id,
      correlationId: (request as any).correlationId || randomUUID(),
      data: { contactId: id, entityType: 'contact', entityId: id },
    } as unknown as Event).catch(() => {});

    return result.rows[0];
  });

  app.patch('/api/crm/contacts/:id', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const body = UpdateContactSchema.parse(request.body);
    const user = request.user!;

    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    for (const [key, val] of Object.entries(body)) {
      if (val !== undefined) {
        const col = key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
        fields.push(`${col} = $${idx}`);
        values.push(val);
        idx++;
      }
    }
    if (!fields.length) throw new AppError(400, 'No fields to update', ErrorCodes.BAD_REQUEST);

    fields.push(`updated_at = NOW()`);
    values.push(id, user.organizationId);
    const result = await db.write.query(
      `UPDATE contacts SET ${fields.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1} AND deleted_at IS NULL RETURNING *`,
      values,
    );
    if (!result.rows.length) throw new AppError(404, 'Contact not found', ErrorCodes.NOT_FOUND);

    await contactsCache.invalidatePattern(`${user.organizationId}:*`);
    rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.CONTACT_UPDATED, timestamp: new Date(),
      organizationId: user.organizationId, userId: user.id,
      correlationId: (request as any).correlationId || randomUUID(),
      data: { contactId: id, entityType: 'contact', entityId: id },
    } as unknown as Event).catch(() => {});

    return result.rows[0];
  });

  app.delete('/api/crm/contacts/:id', { preHandler: [requireUser] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const client = await db.write.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE deals SET contact_id = NULL, updated_at = NOW() WHERE contact_id = $1 AND organization_id = $2',
        [id, user.organizationId],
      );
      await client.query(
        'UPDATE contacts SET deleted_at = NOW() WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
        [id, user.organizationId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    await contactsCache.invalidatePattern(`${user.organizationId}:*`);
    reply.code(204).send();
  });

  app.post('/api/crm/contacts/import', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { content, hasHeader, mapping } = ImportCsvSchema.parse(request.body);

    const lines = content.split('\n').filter((l: string) => l.trim());
    const rows = lines.map(parseCsvLine);
    const dataRows = hasHeader && rows.length > 1 ? rows.slice(1) : rows;

    let created = 0;
    let updated = 0;
    const errors: { row: number; message: string }[] = [];

    interface ImportRow { firstName: string | null; lastName: string | null; email: string | null; phone: string | null; telegramId: string | null }
    const validRows: ImportRow[] = [];
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
      validRows.push({ firstName, lastName, email, phone, telegramId });
    }

    const BATCH_SIZE = 100;
    for (let b = 0; b < validRows.length; b += BATCH_SIZE) {
      const batch = validRows.slice(b, b + BATCH_SIZE);
      const telegramIds = batch.map(r => r.telegramId).filter(Boolean) as string[];
      const emails = batch.map(r => r.email).filter(Boolean) as string[];

      const existingByTg = new Map<string, string>();
      const existingByEmail = new Map<string, string>();

      if (telegramIds.length > 0) {
        const r = await db.read.query(
          'SELECT id, telegram_id FROM contacts WHERE organization_id = $1 AND telegram_id = ANY($2::text[])',
          [user.organizationId, telegramIds],
        );
        for (const row of r.rows as { id: string; telegram_id: string }[]) existingByTg.set(row.telegram_id, row.id);
      }
      if (emails.length > 0) {
        const r = await db.read.query(
          'SELECT id, email FROM contacts WHERE organization_id = $1 AND email = ANY($2::text[])',
          [user.organizationId, emails],
        );
        for (const row of r.rows as { id: string; email: string }[]) existingByEmail.set(row.email, row.id);
      }

      const toUpdate: { id: string; row: ImportRow }[] = [];
      const toInsert: ImportRow[] = [];
      for (const row of batch) {
        const existingId = (row.telegramId && existingByTg.get(row.telegramId))
          || (row.email && existingByEmail.get(row.email))
          || null;
        if (existingId) {
          toUpdate.push({ id: existingId, row });
        } else {
          toInsert.push(row);
        }
      }

      if (toUpdate.length > 0) {
        await db.write.query(
          `UPDATE contacts SET
            first_name = COALESCE(d.first_name, contacts.first_name),
            last_name = COALESCE(d.last_name, contacts.last_name),
            email = COALESCE(d.email, contacts.email),
            phone = COALESCE(d.phone, contacts.phone),
            telegram_id = COALESCE(d.telegram_id, contacts.telegram_id),
            updated_at = NOW()
          FROM (SELECT unnest($1::uuid[]) AS id, unnest($2::text[]) AS first_name,
                       unnest($3::text[]) AS last_name, unnest($4::text[]) AS email,
                       unnest($5::text[]) AS phone, unnest($6::text[]) AS telegram_id) AS d
          WHERE contacts.id = d.id AND contacts.organization_id = $7`,
          [
            toUpdate.map(u => u.id),
            toUpdate.map(u => u.row.firstName),
            toUpdate.map(u => u.row.lastName),
            toUpdate.map(u => u.row.email),
            toUpdate.map(u => u.row.phone),
            toUpdate.map(u => u.row.telegramId),
            user.organizationId,
          ],
        );
        updated += toUpdate.length;
      }

      if (toInsert.length > 0) {
        const defaultConsent = JSON.stringify({ email: false, sms: false, telegram: false, marketing: false });
        const values: unknown[] = [];
        const placeholders = toInsert.map((c, idx) => {
          const off = idx * 7 + 1;
          values.push(user.organizationId, c.firstName, c.lastName, c.email, c.phone, c.telegramId, defaultConsent);
          return `($${off}, $${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}, $${off + 5}, $${off + 6})`;
        });
        await db.write.query(
          `INSERT INTO contacts (organization_id, first_name, last_name, email, phone, telegram_id, consent_flags)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (organization_id, telegram_id) WHERE telegram_id IS NOT NULL AND trim(telegram_id) <> ''
           DO UPDATE SET
             first_name = COALESCE(NULLIF(trim(EXCLUDED.first_name), ''), contacts.first_name),
             last_name = COALESCE(EXCLUDED.last_name, contacts.last_name),
             email = COALESCE(EXCLUDED.email, contacts.email),
             phone = COALESCE(EXCLUDED.phone, contacts.phone),
             telegram_id = COALESCE(EXCLUDED.telegram_id, contacts.telegram_id),
             consent_flags = COALESCE(EXCLUDED.consent_flags, contacts.consent_flags),
             updated_at = NOW()`,
          values,
        );
        created += toInsert.length;
      }
    }

    await contactsCache.invalidatePattern(`${user.organizationId}:list:*`);
    return { created, updated, errors, total: dataRows.length };
  });

  app.post('/api/crm/contacts/import-from-telegram-group', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const body = ImportTelegramGroupSchema.parse(request.body);

    const accountRow = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [body.bdAccountId, user.organizationId],
    );
    if (accountRow.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    const taskId = randomUUID();
    await rabbitmq.publishCommand(`telegram:commands:${body.bdAccountId}`, {
      type: 'GET_PARTICIPANTS',
      id: taskId,
      priority: 5,
      payload: {
        chatId: body.telegramChatId,
        organizationId: user.organizationId,
        limit: 200,
        offset: 0,
      },
    });

    return { taskId, status: 'queued', message: 'Import task submitted. Participants will be fetched from Telegram.' };
  });
}
