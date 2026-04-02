import { Router } from 'express';
import { Pool } from 'pg';
import { randomUUID } from 'crypto';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, Event } from '@getsale/events';
import { Logger } from '@getsale/logger';
import { asyncHandler, validate, AppError, ErrorCodes, withOrgContext } from '@getsale/service-core';
import { ContactCreateSchema, ContactUpdateSchema, ContactImportSchema, ImportFromTelegramGroupSchema } from '../validation';
import { parseCsvLine, parsePageLimit, buildPagedResponse } from '../helpers';
import type { ServiceHttpClient } from '@getsale/service-core';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
  bdAccountsClient?: ServiceHttpClient;
}

const MAX_IMPORT_PARTICIPANTS = 10_000;

export function contactsRouter({ pool, rabbitmq, log, bdAccountsClient }: Deps): Router {
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { page, limit, offset } = parsePageLimit(req.query);
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const companyId = typeof req.query.companyId === 'string' ? req.query.companyId : undefined;

    let where = 'WHERE c.organization_id = $1 AND c.deleted_at IS NULL';
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

    res.json(buildPagedResponse(items, total, page, limit));
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const result = await pool.query(
      `SELECT c.*, co.name AS company_name FROM contacts c
       LEFT JOIN companies co ON c.company_id = co.id
       WHERE c.id = $1 AND c.organization_id = $2 AND c.deleted_at IS NULL`,
      [req.params.id, organizationId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'Contact not found', ErrorCodes.NOT_FOUND);
    }
    const { company_name, ...contact } = result.rows[0];
    const sourcesRows = await pool.query(
      `SELECT telegram_chat_id, telegram_chat_title FROM contact_telegram_sources
       WHERE contact_id = $1 AND organization_id = $2`,
      [req.params.id, organizationId]
    );
    const telegramGroups = (sourcesRows.rows as { telegram_chat_id: string; telegram_chat_title: string | null }[]).map((r) => ({
      telegram_chat_id: r.telegram_chat_id,
      telegram_chat_title: r.telegram_chat_title ?? undefined,
    }));
    res.json({ ...contact, companyName: company_name ?? null, telegramGroups });
  }));

  router.post('/import', validate(ContactImportSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { content, hasHeader, mapping } = req.body;

    const lines = content.split('\n').filter((l: string) => l.trim());
    const rows = lines.map(parseCsvLine);
    const dataRows = hasHeader && rows.length > 1 ? rows.slice(1) : rows;

    let created = 0;
    let updated = 0;
    const errors: { row: number; message: string }[] = [];
    const defaultConsent = JSON.stringify({ email: false, sms: false, telegram: false, marketing: false });

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
        const r = await pool.query(
          'SELECT id, telegram_id FROM contacts WHERE organization_id = $1 AND telegram_id = ANY($2::text[])',
          [organizationId, telegramIds]
        );
        for (const row of r.rows as { id: string; telegram_id: string }[]) existingByTg.set(row.telegram_id, row.id);
      }
      if (emails.length > 0) {
        const r = await pool.query(
          'SELECT id, email FROM contacts WHERE organization_id = $1 AND email = ANY($2::text[])',
          [organizationId, emails]
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
        await pool.query(
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
            organizationId,
          ]
        );
        updated += toUpdate.length;
      }

      if (toInsert.length > 0) {
        const values: unknown[] = [];
        const placeholders = toInsert.map((c, idx) => {
          const off = idx * 7 + 1;
          values.push(organizationId, c.firstName, c.lastName, c.email, c.phone, c.telegramId, defaultConsent);
          return `($${off}, $${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}, $${off + 5}, $${off + 6})`;
        });
        await pool.query(
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
          values
        );
        created += toInsert.length;
      }
    }

    res.json({ created, updated, errors, total: dataRows.length });
  }));

  router.post('/import-from-telegram-group', validate(ImportFromTelegramGroupSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { bdAccountId, telegramChatId, telegramChatTitle, searchKeyword, excludeAdmins, leaveAfter } = req.body;
    if (!bdAccountsClient) {
      throw new AppError(503, 'Contact discovery not configured', ErrorCodes.INTERNAL_ERROR);
    }
    const accountRow = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [bdAccountId, organizationId]
    );
    if (accountRow.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    const defaultConsent = JSON.stringify({ email: false, sms: false, telegram: false, marketing: false });
    const contactIds: string[] = [];
    let created = 0;
    let matched = 0;
    let offset = 0;
    const limit = 200;
    let totalFetched = 0;
    const excludeAdminsParam = excludeAdmins === true ? '&excludeAdmins=true' : '';
    while (totalFetched < MAX_IMPORT_PARTICIPANTS) {
      const result = await bdAccountsClient.request<{ users: Array<{ telegram_id: string; username?: string; first_name?: string; last_name?: string }>; nextOffset: number | null }>(
        `/api/bd-accounts/${bdAccountId}/chats/${encodeURIComponent(telegramChatId)}/participants?limit=${limit}&offset=${offset}${excludeAdminsParam}`,
        { method: 'GET', context: { organizationId, userId: req.user?.id } }
      );
      const users = result?.users ?? [];
      const validUsers = users
        .map(u => ({
          telegramId: (u.telegram_id || '').trim() || null,
          firstName: (u.first_name ?? '').trim() || 'Contact',
          lastName: (u.last_name ?? '').trim() || null,
          username: (u.username ?? '').trim() || null,
        }))
        .filter((u): u is { telegramId: string; firstName: string; lastName: string | null; username: string | null } => u.telegramId !== null);

      if (validUsers.length > 0) {
        const tgIds = validUsers.map(u => u.telegramId);
        const existingRes = await pool.query(
          'SELECT id, telegram_id FROM contacts WHERE organization_id = $1 AND telegram_id = ANY($2::text[])',
          [organizationId, tgIds]
        );
        const existingMap = new Map<string, string>();
        for (const r of existingRes.rows as { id: string; telegram_id: string }[]) {
          existingMap.set(r.telegram_id, r.id);
        }

        const newContacts: { id: string; telegramId: string; firstName: string; lastName: string | null; username: string | null }[] = [];
        for (const u of validUsers) {
          const existingId = existingMap.get(u.telegramId);
          if (existingId) {
            matched++;
          } else {
            newContacts.push({ id: randomUUID(), ...u });
            created++;
          }
        }

        if (newContacts.length > 0) {
          const values: unknown[] = [];
          const placeholders = newContacts.map((c, idx) => {
            const off = idx * 7 + 1;
            values.push(c.id, organizationId, c.firstName, c.lastName, c.username, c.telegramId, defaultConsent);
            return `($${off}, $${off + 1}, $${off + 2}, $${off + 3}, $${off + 4}, $${off + 5}, $${off + 6})`;
          });
          const insRes = await pool.query(
            `INSERT INTO contacts (id, organization_id, first_name, last_name, username, telegram_id, consent_flags)
             VALUES ${placeholders.join(', ')}
             ON CONFLICT (organization_id, telegram_id) WHERE telegram_id IS NOT NULL AND trim(telegram_id) <> ''
             DO UPDATE SET
               first_name = COALESCE(NULLIF(trim(EXCLUDED.first_name), ''), contacts.first_name),
               last_name = COALESCE(EXCLUDED.last_name, contacts.last_name),
               username = COALESCE(EXCLUDED.username, contacts.username),
               consent_flags = COALESCE(EXCLUDED.consent_flags, contacts.consent_flags),
               updated_at = NOW()
             RETURNING id, telegram_id`,
            values
          );
          for (const r of insRes.rows as { id: string; telegram_id: string }[]) {
            existingMap.set(r.telegram_id, r.id);
          }
        }

        const pageContactIds: string[] = [];
        for (const u of validUsers) {
          const id = existingMap.get(u.telegramId);
          if (id) pageContactIds.push(id);
        }

        contactIds.push(...pageContactIds);

        const srcValues: any[] = [organizationId, bdAccountId, telegramChatId, telegramChatTitle ?? null, searchKeyword ?? null];
        const srcPlaceholders = pageContactIds.map((cId, idx) => {
          srcValues.push(cId);
          return `($1, $${idx + 6}, $2, $3, $4, $5)`;
        });
        await pool.query(
          `INSERT INTO contact_telegram_sources (organization_id, contact_id, bd_account_id, telegram_chat_id, telegram_chat_title, search_keyword)
           VALUES ${srcPlaceholders.join(', ')}
           ON CONFLICT (organization_id, contact_id, bd_account_id, telegram_chat_id) DO NOTHING`,
          srcValues
        );
      }
      totalFetched += users.length;
      if (result?.nextOffset == null || users.length === 0) break;
      offset = result.nextOffset;
    }
    if (leaveAfter === true) {
      try {
        await bdAccountsClient.request(
          `/api/bd-accounts/${bdAccountId}/chats/${encodeURIComponent(telegramChatId)}/leave`,
          { method: 'POST', context: { organizationId, userId: req.user?.id } }
        );
      } catch (leaveErr: any) {
        log.warn({ message: 'Leave after import failed', bdAccountId, telegramChatId, error: leaveErr?.message || String(leaveErr) });
      }
    }
    res.json({ contactIds, created, matched });
  }));

  router.post('/', validate(ContactCreateSchema), asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { firstName, lastName, displayName, username, email, phone, telegramId, companyId, consentFlags } = req.body;

      const row = await withOrgContext(pool, organizationId, async (client) => {
      if (companyId) {
        const check = await client.query('SELECT 1 FROM companies WHERE id = $1 AND organization_id = $2', [companyId, organizationId]);
        if (check.rows.length === 0) {
          throw new AppError(400, 'Company not found or access denied', ErrorCodes.VALIDATION);
        }
      }
      const consentJson = JSON.stringify(consentFlags ?? { email: false, sms: false, telegram: false, marketing: false });
      const tg = telegramId != null && String(telegramId).trim() !== '' ? String(telegramId).trim() : null;
      const result = tg
        ? await client.query(
            `INSERT INTO contacts (organization_id, company_id, first_name, last_name, display_name, username, email, phone, telegram_id, consent_flags)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT (organization_id, telegram_id) WHERE telegram_id IS NOT NULL AND trim(telegram_id) <> ''
             DO UPDATE SET
               first_name = COALESCE(NULLIF(trim(EXCLUDED.first_name), ''), contacts.first_name),
               last_name = COALESCE(EXCLUDED.last_name, contacts.last_name),
               display_name = COALESCE(EXCLUDED.display_name, contacts.display_name),
               username = COALESCE(EXCLUDED.username, contacts.username),
               email = COALESCE(EXCLUDED.email, contacts.email),
               phone = COALESCE(EXCLUDED.phone, contacts.phone),
               company_id = COALESCE(EXCLUDED.company_id, contacts.company_id),
               consent_flags = COALESCE(EXCLUDED.consent_flags, contacts.consent_flags),
               updated_at = NOW()
             RETURNING *`,
            [organizationId, companyId ?? null,
             (firstName ?? '').trim() || null, (lastName ?? '').trim() || null,
             (displayName ?? '').trim() || null, (username ?? '').trim() || null,
             email || null, phone ?? null, tg, consentJson]
          )
        : await client.query(
            `INSERT INTO contacts (organization_id, company_id, first_name, last_name, display_name, username, email, phone, telegram_id, consent_flags)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
            [organizationId, companyId ?? null,
             (firstName ?? '').trim() || null, (lastName ?? '').trim() || null,
             (displayName ?? '').trim() || null, (username ?? '').trim() || null,
             email || null, phone ?? null, telegramId ?? null, consentJson]
          );
      return result.rows[0] as Record<string, unknown>;
    });

    await rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.CONTACT_CREATED, timestamp: new Date(),
      organizationId, userId, correlationId: req.correlationId, data: { contactId: row.id },
    } as Event);

    res.status(201).json(row);
  }));

  const updateHandler = asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { id } = req.params;
    const payload = req.body as Record<string, unknown>;

    const row = await withOrgContext(pool, organizationId, async (client) => {
      const existing = await client.query('SELECT * FROM contacts WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [id, organizationId]);
      if (existing.rows.length === 0) {
        throw new AppError(404, 'Contact not found', ErrorCodes.NOT_FOUND);
      }
      if (payload.companyId !== undefined) {
        const check = await client.query('SELECT 1 FROM companies WHERE id = $1 AND organization_id = $2', [payload.companyId, organizationId]);
        if (check.rows.length === 0) {
          throw new AppError(400, 'Company not found or access denied', ErrorCodes.VALIDATION);
        }
      }
      const result = await client.query(
        `UPDATE contacts SET
          first_name = COALESCE($2, first_name), last_name = $3, email = $4, phone = $5,
          telegram_id = $6, company_id = $7, display_name = $8, username = $9,
          consent_flags = COALESCE($10, consent_flags), updated_at = NOW()
         WHERE id = $1 AND organization_id = $11 RETURNING *`,
        [id, payload.firstName, payload.lastName ?? null, payload.email ?? null, payload.phone ?? null,
         payload.telegramId ?? null, payload.companyId ?? null, payload.displayName ?? null, payload.username ?? null,
         payload.consentFlags ? JSON.stringify(payload.consentFlags) : null, organizationId]
      );
      return result.rows[0];
    });

    await rabbitmq.publishEvent({
      id: randomUUID(), type: EventType.CONTACT_UPDATED, timestamp: new Date(),
      organizationId, userId, correlationId: req.correlationId, data: { contactId: id },
    } as Event);

    res.json(row);
  });

  router.put('/:id', validate(ContactUpdateSchema), updateHandler);
  router.patch('/:id', validate(ContactUpdateSchema), updateHandler);

  router.delete('/:id', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;

    const existing = await pool.query('SELECT 1 FROM contacts WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL', [id, organizationId]);
    if (existing.rows.length === 0) {
      throw new AppError(404, 'Contact not found', ErrorCodes.NOT_FOUND);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE deals SET contact_id = NULL, updated_at = NOW() WHERE contact_id = $1 AND organization_id = $2',
        [id, organizationId]
      );
      await client.query(
        'UPDATE contacts SET deleted_at = NOW() WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
        [id, organizationId]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
    res.status(204).send();
  }));

  return router;
}
