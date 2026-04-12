import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { AppError, ErrorCodes, requireUser, DatabasePools } from '@getsale/service-framework';
import { Logger } from '@getsale/logger';

interface Deps {
  db: DatabasePools;
  log: Logger;
}

const PresetCreateSchema = z.object({
  name: z.string().min(1).max(500).trim(),
  channel: z.string().max(64).optional().default('telegram'),
  content: z.string().min(1).max(50_000),
});

const AudienceConflictsBodySchema = z.object({
  contactIds: z.array(z.string().uuid()).min(1).max(5000),
});

const FromCsvBodySchema = z.object({
  content: z.string().min(1).max(5_000_000),
  hasHeader: z.boolean().optional().default(true),
});

const FromUsernameListBodySchema = z.object({
  text: z.string().min(1).max(500_000),
});

function parseCsv(content: string): string[][] {
  return content.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
    const cells: string[] = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQuotes) {
        if (ch === '"' && line[i + 1] === '"') {
          current += '"';
          i++;
        } else if (ch === '"') {
          inQuotes = false;
        } else {
          current += ch;
        }
      } else if (ch === '"') {
        inQuotes = true;
      } else if (ch === ',' || ch === ';' || ch === '\t') {
        cells.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
    cells.push(current.trim());
    return cells;
  });
}

function parseUsernameList(text: string): { rows: { telegramId: string | null; username: string | null; firstName: string }[]; skipped: number; invalidSamples: string[] } {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const rows: { telegramId: string | null; username: string | null; firstName: string }[] = [];
  let skipped = 0;
  const invalidSamples: string[] = [];

  for (const line of lines) {
    const clean = line.replace(/^@/, '').trim();
    if (!clean) { skipped++; continue; }
    if (/^\d+$/.test(clean)) {
      rows.push({ telegramId: clean, username: null, firstName: 'Contact' });
    } else if (/^[\w.]+$/.test(clean)) {
      rows.push({ telegramId: null, username: clean, firstName: clean });
    } else {
      skipped++;
      if (invalidSamples.length < 5) invalidSamples.push(line.slice(0, 80));
    }
  }

  return { rows, skipped, invalidSamples };
}

type BdAccountsListScope = 'all' | 'own_only' | 'none';

function bdAccountsListScope(role: string | undefined | null): BdAccountsListScope {
  const r = (role || '').toLowerCase();
  if (r === 'viewer') return 'none';
  if (r === 'bidi') return 'own_only';
  return 'all';
}

function getBdAccountDisplayName(row: Record<string, unknown>): string {
  const dn = row.display_name as string | null;
  if (dn && dn.trim()) return dn.trim();
  const fn = (row.first_name as string | null) ?? '';
  const ln = (row.last_name as string | null) ?? '';
  const full = `${fn} ${ln}`.trim();
  if (full) return full;
  return (row.username as string) || (row.phone_number as string) || String(row.telegram_id ?? row.id ?? '');
}

export function registerStaticDataRoutes(app: FastifyInstance, deps: Deps): void {
  const { db } = deps;

  app.get('/api/campaigns/agents', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const scope = bdAccountsListScope(user.role);
    if (scope === 'none') return [];

    const params: unknown[] = [user.organizationId];
    let ownerClause = '';
    if (scope === 'own_only') {
      params.push(user.id);
      ownerClause = ` AND a.created_by_user_id = $${params.length}`;
    }

    const accounts = await db.read.query(
      `SELECT a.id, a.created_by_user_id, a.display_name, a.first_name, a.last_name, a.username, a.phone_number, a.telegram_id,
              a.flood_wait_until, a.flood_wait_seconds, a.flood_reason, a.flood_last_at,
              a.spam_restricted_at, a.spam_restriction_source, a.peer_flood_count_1h,
              a.photo_file_id, a.is_active, a.connection_state
       FROM bd_accounts a
       WHERE a.organization_id = $1 AND a.is_active = true${ownerClause}
       ORDER BY a.display_name NULLS LAST, a.phone_number`,
      params,
    );

    const today = new Date().toISOString().slice(0, 10);
    const sentTodayRes = await db.read.query(
      `SELECT cp.bd_account_id, COUNT(*)::int AS cnt
       FROM campaign_sends cs
       JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
       JOIN campaigns c ON c.id = cp.campaign_id
       WHERE c.organization_id = $1 AND cs.sent_at::date = $2::date AND cs.status = 'sent'
       GROUP BY cp.bd_account_id`,
      [user.organizationId, today],
    );
    const sentMap = new Map((sentTodayRes.rows as { bd_account_id: string; cnt: number }[]).map((r) => [r.bd_account_id, r.cnt]));

    const result = (accounts.rows as Record<string, unknown>[]).map((a) => ({
      id: a.id,
      displayName: getBdAccountDisplayName(a),
      floodWaitUntil: a.flood_wait_until != null ? new Date(a.flood_wait_until as string).toISOString() : null,
      floodWaitSeconds: a.flood_wait_seconds,
      floodReason: a.flood_reason,
      floodLastAt: a.flood_last_at != null ? new Date(a.flood_last_at as string).toISOString() : null,
      spamRestrictedAt: a.spam_restricted_at != null ? new Date(a.spam_restricted_at as string).toISOString() : null,
      spamRestrictionSource: a.spam_restriction_source ?? null,
      peerFloodCount1h: a.peer_flood_count_1h != null ? Number(a.peer_flood_count_1h) : null,
      photoFileId: a.photo_file_id,
      isActive: a.is_active,
      connectionState: a.connection_state,
      firstName: a.first_name,
      lastName: a.last_name,
      username: a.username,
      phoneNumber: a.phone_number,
      telegramId: a.telegram_id,
      sentToday: sentMap.get(a.id as string) ?? 0,
    }));

    return result;
  });

  app.get('/api/campaigns/presets', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const result = await db.read.query(
      `SELECT id, name, channel, content, created_at
       FROM campaign_templates
       WHERE organization_id = $1 AND campaign_id IS NULL
       ORDER BY name`,
      [user.organizationId],
    );
    return result.rows;
  });

  app.post('/api/campaigns/presets', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const body = PresetCreateSchema.parse(request.body);

    const id = randomUUID();
    await db.write.query(
      `INSERT INTO campaign_templates (id, organization_id, campaign_id, name, channel, content)
       VALUES ($1, $2, NULL, $3, $4, $5)`,
      [id, user.organizationId, body.name, body.channel || 'telegram', body.content],
    );
    const result = await db.read.query(
      'SELECT id, name, channel, content, created_at FROM campaign_templates WHERE id = $1',
      [id],
    );
    reply.code(201);
    return result.rows[0];
  });

  app.get('/api/campaigns/contacts-for-picker', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const query = request.query as Record<string, string | undefined>;

    const limitNum = Math.min(1000, Math.max(1, parseInt(query.limit ?? '500', 10) || 500));
    let sql = `
      SELECT c.id, c.first_name, c.last_name, c.display_name, c.username, c.telegram_id, c.email, c.phone,
        CASE WHEN EXISTS (
          SELECT 1 FROM campaign_participants cp
          JOIN campaigns c2 ON c2.id = cp.campaign_id
          WHERE cp.contact_id = c.id AND c2.organization_id = c.organization_id
        ) THEN 'in_outreach' ELSE 'new' END AS outreach_status
      FROM contacts c
      WHERE c.organization_id = $1 AND c.telegram_id IS NOT NULL AND c.telegram_id != ''
    `;
    const params: unknown[] = [user.organizationId];
    let idx = 2;

    if (query.sourceKeyword?.trim()) {
      sql += ` AND EXISTS (SELECT 1 FROM contact_telegram_sources cts WHERE cts.contact_id = c.id AND cts.organization_id = c.organization_id AND cts.search_keyword = $${idx})`;
      params.push(query.sourceKeyword.trim());
      idx++;
    }
    if (query.sourceTelegramChatId?.trim()) {
      sql += ` AND EXISTS (SELECT 1 FROM contact_telegram_sources cts WHERE cts.contact_id = c.id AND cts.organization_id = c.organization_id AND cts.telegram_chat_id = $${idx}`;
      params.push(query.sourceTelegramChatId.trim());
      idx++;
      if (query.sourceBdAccountId?.trim()) {
        sql += ` AND cts.bd_account_id = $${idx}`;
        params.push(query.sourceBdAccountId.trim());
        idx++;
      }
      sql += ')';
    }
    if (query.outreachStatus === 'new') {
      sql += ' AND NOT EXISTS (SELECT 1 FROM campaign_participants cp JOIN campaigns c2 ON c2.id = cp.campaign_id WHERE cp.contact_id = c.id AND c2.organization_id = c.organization_id)';
    } else if (query.outreachStatus === 'in_outreach') {
      sql += ' AND EXISTS (SELECT 1 FROM campaign_participants cp JOIN campaigns c2 ON c2.id = cp.campaign_id WHERE cp.contact_id = c.id AND c2.organization_id = c.organization_id)';
    }
    if (query.search?.trim()) {
      const term = `%${query.search.trim().replace(/%/g, '\\%')}%`;
      sql += ` AND (c.first_name ILIKE $${idx} OR c.last_name ILIKE $${idx} OR c.display_name ILIKE $${idx} OR c.username ILIKE $${idx} OR c.telegram_id ILIKE $${idx} OR c.email ILIKE $${idx} OR c.phone ILIKE $${idx})`;
      params.push(term);
      idx++;
    }
    sql += ` ORDER BY c.first_name, c.last_name LIMIT $${idx}`;
    params.push(limitNum);

    const result = await db.read.query(sql, params);
    return result.rows;
  });

  app.get('/api/campaigns/telegram-source-keywords', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const r = await db.read.query(
      `SELECT DISTINCT search_keyword AS keyword FROM contact_telegram_sources
       WHERE organization_id = $1 AND search_keyword IS NOT NULL AND search_keyword != ''
       ORDER BY search_keyword`,
      [user.organizationId],
    );
    return (r.rows as { keyword: string }[]).map((x) => x.keyword);
  });

  app.get('/api/campaigns/telegram-source-groups', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const r = await db.read.query(
      `SELECT DISTINCT bd_account_id, telegram_chat_id, telegram_chat_title FROM contact_telegram_sources
       WHERE organization_id = $1 ORDER BY telegram_chat_title NULLS LAST, telegram_chat_id`,
      [user.organizationId],
    );
    return (r.rows as { bd_account_id: string; telegram_chat_id: string; telegram_chat_title: string | null }[]).map((row) => ({
      bdAccountId: row.bd_account_id,
      telegramChatId: row.telegram_chat_id,
      telegramChatTitle: row.telegram_chat_title ?? undefined,
    }));
  });

  app.get('/api/campaigns/group-sources', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const result = await db.read.query(
      `SELECT s.id, s.bd_account_id, s.telegram_chat_id, s.title, s.peer_type, a.display_name as account_name
       FROM bd_account_sync_chats s
       JOIN bd_accounts a ON a.id = s.bd_account_id
       WHERE a.organization_id = $1 AND a.is_active = true AND s.peer_type IN ('chat', 'channel')
       ORDER BY s.title`,
      [user.organizationId],
    );
    return result.rows;
  });

  app.get('/api/campaigns/group-sources/contacts', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { bdAccountId, telegramChatId } = request.query as { bdAccountId?: string; telegramChatId?: string };

    if (!bdAccountId || !telegramChatId) {
      throw new AppError(400, 'bdAccountId and telegramChatId are required', ErrorCodes.BAD_REQUEST);
    }

    const accountCheck = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [bdAccountId, user.organizationId],
    );
    if (!accountCheck.rows.length) throw new AppError(404, 'Account not found', ErrorCodes.NOT_FOUND);

    const contacts = await db.read.query(
      `SELECT DISTINCT m.contact_id
       FROM messages m
       WHERE m.bd_account_id = $1 AND m.channel_id = $2 AND m.contact_id IS NOT NULL
         AND m.organization_id = $3`,
      [bdAccountId, telegramChatId, user.organizationId],
    );

    return { contactIds: (contacts.rows as { contact_id: string }[]).map((r) => r.contact_id) };
  });

  app.post('/api/campaigns/:id/audience/conflicts', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const { contactIds } = AudienceConflictsBodySchema.parse(request.body);

    const camp = await db.read.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, user.organizationId],
    );
    if (!camp.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const result = await db.read.query(
      `SELECT cp.contact_id::text AS contact_id,
              COALESCE(NULLIF(TRIM(ct.display_name), ''), NULLIF(TRIM(CONCAT(COALESCE(ct.first_name,''), ' ', COALESCE(ct.last_name,''))), ''), ct.username, ct.telegram_id::text) AS contact_name,
              ct.username AS contact_username,
              c.id::text AS campaign_id,
              c.name AS campaign_name,
              cp.status AS participant_status,
              (SELECT MAX(cs.sent_at) FROM campaign_sends cs WHERE cs.campaign_participant_id = cp.id AND cs.status IN ('sent', 'queued')) AS last_sent_at,
              (c.id = $3::uuid) AS is_current_campaign
       FROM campaign_participants cp
       JOIN campaigns c ON c.id = cp.campaign_id
       JOIN contacts ct ON ct.id = cp.contact_id
       WHERE cp.contact_id = ANY($1::uuid[])
         AND c.organization_id = $2
         AND c.deleted_at IS NULL
       ORDER BY cp.contact_id, c.name`,
      [contactIds, user.organizationId, id],
    );

    return { conflicts: result.rows };
  });

  app.post('/api/campaigns/:id/audience/from-csv', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const body = FromCsvBodySchema.parse(request.body);

    const campaign = await db.read.query(
      'SELECT id, organization_id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!campaign.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const orgId = user.organizationId;
    const rows = parseCsv(body.content);
    if (rows.length === 0) return { contactIds: [], created: 0, matched: 0 };

    const header = body.hasHeader ? rows[0] : [];
    const dataRows = body.hasHeader ? rows.slice(1) : rows;

    const col = (name: string) => {
      const n = name.toLowerCase().replace(/\s/g, '_');
      const i = header.map((h) => (h || '').toLowerCase().replace(/\s/g, '_')).indexOf(n);
      return i >= 0 ? i : -1;
    };
    const idxTelegram = col('telegram_id') >= 0 ? col('telegram_id') : col('telegram') >= 0 ? col('telegram') : -1;
    const idxFirst = col('first_name') >= 0 ? col('first_name') : col('name') >= 0 ? col('name') : 0;
    const idxLast = col('last_name') >= 0 ? col('last_name') : 1;
    const idxEmail = col('email') >= 0 ? col('email') : -1;
    const idxUsername = col('username') >= 0 ? col('username') : -1;
    const idxPhone = col('phone') >= 0 ? col('phone') : -1;

    const validRows: { telegramId: string | null; email: string | null; username: string | null; firstName: string; lastName: string | null; phone: string | null }[] = [];
    for (const row of dataRows) {
      const telegramId = idxTelegram >= 0 ? (row[idxTelegram] || '').trim().replace(/^@/, '') || null : null;
      const email = idxEmail >= 0 ? (row[idxEmail] || '').trim() || null : null;
      const username = idxUsername >= 0 ? (row[idxUsername] || '').trim().replace(/^@/, '') || null : null;
      const firstName = (idxFirst >= 0 ? (row[idxFirst] || '').trim() : '') || 'Contact';
      const lastName = idxLast >= 0 ? (row[idxLast] || '').trim() || null : null;
      const phone = idxPhone >= 0 ? (row[idxPhone] || '').trim() || null : null;
      if (!telegramId && !email && !username) continue;
      validRows.push({ telegramId, email, username, firstName, lastName, phone });
    }

    let created = 0;
    let matched = 0;
    const contactIds: string[] = [];

    for (const vr of validRows) {
      let contactId: string | null = null;
      if (vr.telegramId) {
        const r = await db.read.query(
          'SELECT id FROM contacts WHERE organization_id = $1 AND telegram_id = $2 LIMIT 1',
          [orgId, vr.telegramId],
        );
        if (r.rows.length) { contactId = (r.rows[0] as { id: string }).id; matched++; }
      }
      if (!contactId && vr.username) {
        const r = await db.read.query(
          'SELECT id FROM contacts WHERE organization_id = $1 AND username = $2 LIMIT 1',
          [orgId, vr.username],
        );
        if (r.rows.length) { contactId = (r.rows[0] as { id: string }).id; matched++; }
      }
      if (!contactId) {
        const cid = randomUUID();
        await db.write.query(
          `INSERT INTO contacts (id, organization_id, first_name, last_name, telegram_id, username, email, phone, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())`,
          [cid, orgId, vr.firstName, vr.lastName, vr.telegramId, vr.username, vr.email, vr.phone],
        );
        contactId = cid;
        created++;
      }
      contactIds.push(contactId);
    }

    return { contactIds, created, matched };
  });

  app.post('/api/campaigns/:id/audience/from-usernames', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const body = FromUsernameListBodySchema.parse(request.body);

    const campaign = await db.read.query(
      'SELECT id, organization_id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!campaign.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const orgId = user.organizationId;
    const { rows, skipped, invalidSamples } = parseUsernameList(body.text);
    if (rows.length === 0) return { contactIds: [], created: 0, matched: 0, skipped, invalidSamples };

    let created = 0;
    let matched = 0;
    const contactIds: string[] = [];

    for (const vr of rows) {
      let contactId: string | null = null;
      if (vr.telegramId) {
        const r = await db.read.query(
          'SELECT id FROM contacts WHERE organization_id = $1 AND telegram_id = $2 LIMIT 1',
          [orgId, vr.telegramId],
        );
        if (r.rows.length) { contactId = (r.rows[0] as { id: string }).id; matched++; }
      }
      if (!contactId && vr.username) {
        const r = await db.read.query(
          'SELECT id FROM contacts WHERE organization_id = $1 AND username = $2 LIMIT 1',
          [orgId, vr.username],
        );
        if (r.rows.length) { contactId = (r.rows[0] as { id: string }).id; matched++; }
      }
      if (!contactId) {
        const cid = randomUUID();
        await db.write.query(
          `INSERT INTO contacts (id, organization_id, first_name, telegram_id, username, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, NOW(), NOW())`,
          [cid, orgId, vr.firstName, vr.telegramId, vr.username],
        );
        contactId = cid;
        created++;
      }
      contactIds.push(contactId);
    }

    return { contactIds, created, matched, skipped, invalidSamples };
  });
}
