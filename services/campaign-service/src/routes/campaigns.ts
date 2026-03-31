import { Router } from 'express';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, Event } from '@getsale/events';
import { CampaignStatus } from '@getsale/types';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, validate, withOrgContext, parsePageLimit, parseLimit } from '@getsale/service-core';
import { parseCsv, getBdAccountDisplayName, getSentTodayByAccount } from '../helpers';
import {
  CampaignCreateSchema,
  CampaignPatchSchema,
  FromCsvBodySchema,
  FromUsernameListBodySchema,
  ParticipantsBulkSchema,
  PresetCreateSchema,
} from '../validation';
import { matchOrCreateContactsFromRows, parseUsernameListToRows, type CsvContactRow } from '../audience-contact-import';
import type { QueryParam, CampaignRow, CampaignCountRow, CampaignRevenueRow, BdAccountRow } from '../types';

function getBdAccountIdsFromTargetAudience(aud: unknown): string[] {
  if (!aud || typeof aud !== 'object') return [];
  const a = aud as { bdAccountIds?: unknown; bdAccountId?: unknown };
  if (Array.isArray(a.bdAccountIds) && a.bdAccountIds.length > 0) {
    return a.bdAccountIds.filter((id): id is string => typeof id === 'string');
  }
  if (typeof a.bdAccountId === 'string' && a.bdAccountId) return [a.bdAccountId];
  return [];
}

function serializeBdAccountRow(row: BdAccountRow) {
  return {
    id: row.id,
    displayName: getBdAccountDisplayName(row),
    floodWaitUntil: row.flood_wait_until != null ? new Date(row.flood_wait_until).toISOString() : null,
    floodWaitSeconds: row.flood_wait_seconds,
    floodReason: row.flood_reason,
    floodLastAt: row.flood_last_at != null ? new Date(row.flood_last_at).toISOString() : null,
    photoFileId: row.photo_file_id,
    isActive: row.is_active,
    connectionState: row.connection_state,
    firstName: row.first_name,
    lastName: row.last_name,
    username: row.username,
    phoneNumber: row.phone_number,
    telegramId: row.telegram_id,
  };
}

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
}

export function campaignsRouter({ pool, rabbitmq, log }: Deps): Router {
  const router = Router();

  router.get('/', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { status, page: pageRaw, limit: limitRaw } = req.query;

    const { page, limit, offset } = parsePageLimit(
      { page: pageRaw, limit: limitRaw } as Record<string, unknown>,
      20,
      100
    );

    let whereClause = 'WHERE c.organization_id = $1 AND c.deleted_at IS NULL';
    const paramsBase: QueryParam[] = [organizationId];
    if (status && typeof status === 'string') {
      paramsBase.push(status);
      whereClause += ` AND c.status = $${paramsBase.length}`;
    }

    const countRes = await pool.query(
      `SELECT COUNT(*)::int AS total FROM campaigns c ${whereClause}`,
      paramsBase
    );
    const totalCount = (countRes.rows[0] as { total: number }).total;

    const [summarySentRes, summaryRepliedRes, summaryWonRes] = await Promise.all([
      pool.query(
        `SELECT COALESCE(SUM(cnt), 0)::int AS total FROM (
           SELECT cp.campaign_id, COUNT(DISTINCT cp.id)::int AS cnt
           FROM campaign_sends cs
           JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
           JOIN campaigns c ON c.id = cp.campaign_id
           ${whereClause}
           GROUP BY cp.campaign_id
         ) t`,
        paramsBase
      ),
      pool.query(
        `SELECT COALESCE(SUM(cnt), 0)::int AS total FROM (
           SELECT cp.campaign_id, COUNT(*)::int AS cnt
           FROM campaign_participants cp
           JOIN campaigns c ON c.id = cp.campaign_id
           ${whereClause} AND cp.status = 'replied'
           GROUP BY cp.campaign_id
         ) t`,
        paramsBase
      ),
      pool.query(
        `SELECT COALESCE(SUM(cnt), 0)::int AS total FROM (
           SELECT conv.campaign_id, COUNT(*)::int AS cnt
           FROM conversations conv
           JOIN campaigns c ON c.id = conv.campaign_id
           ${whereClause} AND conv.won_at IS NOT NULL
           GROUP BY conv.campaign_id
         ) t`,
        paramsBase
      ),
    ]);

    const summaryTotals = {
      total_sent: (summarySentRes.rows[0] as { total: number } | undefined)?.total ?? 0,
      total_replied: (summaryRepliedRes.rows[0] as { total: number } | undefined)?.total ?? 0,
      total_won: (summaryWonRes.rows[0] as { total: number } | undefined)?.total ?? 0,
    };

    const params = [...paramsBase, limit, offset];
    const result = await pool.query(
      `SELECT c.*,
              u.email AS owner_email,
              COALESCE(NULLIF(TRIM(CONCAT_WS(' ', up.first_name, up.last_name)), ''), u.email) AS owner_name,
              (SELECT COUNT(*)::int FROM campaign_participants cp2 WHERE cp2.campaign_id = c.id) AS total_participants
       FROM campaigns c
       LEFT JOIN users u ON u.id = c.created_by_user_id
       LEFT JOIN user_profiles up ON up.user_id = u.id
       ${whereClause}
       ORDER BY c.created_at DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const campaigns = result.rows as { id: string; target_audience?: { bdAccountId?: string; bdAccountIds?: string[] } }[];

    if (campaigns.length === 0) {
      return res.json({ data: [], total: totalCount, page, limit, summary: summaryTotals });
    }

    const ids = campaigns.map((c) => c.id);
    const bdAccountIds = [...new Set(campaigns.flatMap((c) => {
      const aud = c.target_audience;
      if (aud?.bdAccountIds?.length) return aud.bdAccountIds;
      return aud?.bdAccountId ? [aud.bdAccountId] : [];
    }))] as string[];

    const [sentRes, repliedRes, sharedRes, readRes, wonRes, revenueRes, bdAccountsRes] = await Promise.all([
      pool.query(
        `SELECT cp.campaign_id, COUNT(DISTINCT cp.id)::int AS cnt
         FROM campaign_sends cs JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
         WHERE cp.campaign_id = ANY($1::uuid[]) GROUP BY cp.campaign_id`,
        [ids]
      ),
      pool.query(
        `SELECT campaign_id, COUNT(*)::int AS cnt FROM campaign_participants WHERE campaign_id = ANY($1::uuid[]) AND status = 'replied' GROUP BY campaign_id`,
        [ids]
      ),
      pool.query(
        `SELECT campaign_id, COUNT(*)::int AS cnt FROM conversations WHERE campaign_id = ANY($1::uuid[]) AND shared_chat_created_at IS NOT NULL GROUP BY campaign_id`,
        [ids]
      ),
      pool.query(
        `SELECT first_sends.campaign_id, COUNT(*)::int AS cnt FROM (
           SELECT DISTINCT ON (cp.id) cp.campaign_id, cs.message_id AS mid
           FROM campaign_sends cs JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
           WHERE cp.campaign_id = ANY($1::uuid[])
           ORDER BY cp.id, cs.sent_at
         ) first_sends
         JOIN messages m ON m.id = first_sends.mid AND m.status = 'read'
         GROUP BY first_sends.campaign_id`,
        [ids]
      ),
      pool.query(`SELECT campaign_id, COUNT(*)::int AS cnt FROM conversations WHERE campaign_id = ANY($1::uuid[]) AND won_at IS NOT NULL GROUP BY campaign_id`, [ids]),
      pool.query(`SELECT campaign_id, COALESCE(SUM(revenue_amount), 0)::numeric AS total FROM conversations WHERE campaign_id = ANY($1::uuid[]) AND won_at IS NOT NULL GROUP BY campaign_id`, [ids]),
      bdAccountIds.length > 0
        ? pool.query(
            `SELECT id, display_name, first_name, last_name, username, phone_number, telegram_id,
                    flood_wait_until, flood_wait_seconds, flood_reason, flood_last_at, photo_file_id, is_active, connection_state
             FROM bd_accounts WHERE id = ANY($1::uuid[])`,
            [bdAccountIds]
          )
        : Promise.resolve({ rows: [] }),
    ]);

    const sentMap = new Map((sentRes.rows as CampaignCountRow[]).map((r) => [r.campaign_id, r.cnt]));
    const repliedMap = new Map((repliedRes.rows as CampaignCountRow[]).map((r) => [r.campaign_id, r.cnt]));
    const sharedMap = new Map((sharedRes.rows as CampaignCountRow[]).map((r) => [r.campaign_id, r.cnt]));
    const readMap = new Map((readRes.rows as CampaignCountRow[]).map((r) => [r.campaign_id, r.cnt]));
    const wonMap = new Map((wonRes.rows as CampaignCountRow[]).map((r) => [r.campaign_id, r.cnt]));
    const revenueMap = new Map((revenueRes.rows as CampaignRevenueRow[]).map((r) => [r.campaign_id, Number(r.total)]));
    const bdAccountMap = new Map((bdAccountsRes.rows as BdAccountRow[]).map((a) => [a.id, a]));

    const withKpi = campaigns.map((c) => {
      const sent = sentMap.get(c.id) ?? 0;
      const replied = repliedMap.get(c.id) ?? 0;
      const won = wonMap.get(c.id) ?? 0;
      const aud = c.target_audience;
      const bdIdsOrdered = getBdAccountIdsFromTargetAudience(aud);
      const bd_accounts = bdIdsOrdered
        .map((bid) => bdAccountMap.get(bid))
        .filter((r): r is BdAccountRow => r != null)
        .map(serializeBdAccountRow);
      const firstId = aud?.bdAccountIds?.[0] ?? aud?.bdAccountId;
      const firstRow = firstId ? bdAccountMap.get(firstId) : undefined;

      return {
        ...c,
        total_sent: sent,
        total_read: readMap.get(c.id) ?? 0,
        total_replied: replied,
        total_converted_to_shared_chat: sharedMap.get(c.id) ?? 0,
        total_won: won,
        total_revenue: revenueMap.get(c.id) ?? 0,
        bd_account_name: firstRow ? getBdAccountDisplayName(firstRow) : null,
        bd_accounts,
      };
    });

    res.json({
      data: withKpi,
      total: totalCount,
      page,
      limit,
      summary: summaryTotals,
    });
  }));

  router.get('/agents', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const accounts = await pool.query(
      `SELECT a.id, a.display_name, a.first_name, a.last_name, a.username, a.phone_number, a.telegram_id,
              a.flood_wait_until, a.flood_wait_seconds, a.flood_reason, a.flood_last_at, a.photo_file_id, a.is_active, a.connection_state
       FROM bd_accounts a
       WHERE a.organization_id = $1 AND a.is_active = true
       ORDER BY a.display_name NULLS LAST, a.phone_number`,
      [organizationId]
    );
    const sentMap = await getSentTodayByAccount(pool, organizationId);
    const result = (accounts.rows as BdAccountRow[]).map((a) => ({
      ...serializeBdAccountRow(a),
      sentToday: sentMap.get(a.id) ?? 0,
    }));
    res.json(result);
  }));

  router.get('/presets', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const result = await pool.query(
      `SELECT id, name, channel, content, created_at
       FROM campaign_templates
       WHERE organization_id = $1 AND campaign_id IS NULL
       ORDER BY name`,
      [organizationId]
    );
    res.json(result.rows);
  }));

  router.post('/presets', validate(PresetCreateSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { name, channel, content } = req.body;
    const id = randomUUID();
    const row = await withOrgContext(pool, organizationId, async (client) => {
      await client.query(
        `INSERT INTO campaign_templates (id, organization_id, campaign_id, name, channel, content)
         VALUES ($1, $2, NULL, $3, $4, $5)`,
        [id, organizationId, name.trim(), channel || 'telegram', content]
      );
      const r = await client.query('SELECT id, name, channel, content, created_at FROM campaign_templates WHERE id = $1', [id]);
      return r.rows[0];
    });
    res.status(201).json(row);
  }));

  router.get('/group-sources', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const result = await pool.query(
      `SELECT s.id, s.bd_account_id, s.telegram_chat_id, s.title, s.peer_type, a.display_name as account_name
       FROM bd_account_sync_chats s
       JOIN bd_accounts a ON a.id = s.bd_account_id
       WHERE a.organization_id = $1 AND a.is_active = true AND s.peer_type IN ('chat', 'channel')
       ORDER BY s.title`,
      [organizationId]
    );
    res.json(result.rows);
  }));

  router.get('/group-sources/contacts', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { bdAccountId, telegramChatId } = req.query;
    if (!bdAccountId || !telegramChatId) {
      throw new AppError(400, 'bdAccountId and telegramChatId are required', ErrorCodes.VALIDATION);
    }
    const accountCheck = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [bdAccountId, organizationId]
    );
    if (accountCheck.rows.length === 0) {
      throw new AppError(404, 'Account not found', ErrorCodes.NOT_FOUND);
    }
    const contacts = await pool.query(
      `SELECT DISTINCT m.contact_id
       FROM messages m
       WHERE m.bd_account_id = $1 AND m.channel_id = $2 AND m.contact_id IS NOT NULL
         AND m.organization_id = $3`,
      [bdAccountId, telegramChatId, organizationId]
    );
    const contactIds = contacts.rows.map((r: { contact_id: string }) => r.contact_id);
    res.json({ contactIds });
  }));

  router.get('/telegram-source-keywords', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const r = await pool.query(
      `SELECT DISTINCT search_keyword AS keyword FROM contact_telegram_sources
       WHERE organization_id = $1 AND search_keyword IS NOT NULL AND search_keyword != ''
       ORDER BY search_keyword`,
      [organizationId]
    );
    res.json((r.rows as { keyword: string }[]).map((x) => x.keyword));
  }));

  router.get('/telegram-source-groups', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const r = await pool.query(
      `SELECT DISTINCT bd_account_id, telegram_chat_id, telegram_chat_title FROM contact_telegram_sources
       WHERE organization_id = $1 ORDER BY telegram_chat_title NULLS LAST, telegram_chat_id`,
      [organizationId]
    );
    res.json(r.rows.map((row: { bd_account_id: string; telegram_chat_id: string; telegram_chat_title: string | null }) => ({
      bdAccountId: row.bd_account_id,
      telegramChatId: row.telegram_chat_id,
      telegramChatTitle: row.telegram_chat_title ?? undefined,
    })));
  }));

  router.get('/contacts-for-picker', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { limit: limitQ, outreachStatus, search, sourceKeyword, sourceTelegramChatId, sourceBdAccountId } = req.query;
    const limitNum = parseLimit({ limit: limitQ } as Record<string, unknown>, 500, 1000);
    let query = `
      SELECT c.id, c.first_name, c.last_name, c.display_name, c.username, c.telegram_id, c.email, c.phone,
        CASE WHEN EXISTS (
          SELECT 1 FROM campaign_participants cp
          JOIN campaigns c2 ON c2.id = cp.campaign_id
          WHERE cp.contact_id = c.id AND c2.organization_id = c.organization_id
        ) THEN 'in_outreach' ELSE 'new' END AS outreach_status
      FROM contacts c
      WHERE c.organization_id = $1 AND c.telegram_id IS NOT NULL AND c.telegram_id != ''
    `;
    const params: QueryParam[] = [organizationId];
    let idx = 2;
    if (sourceKeyword && typeof sourceKeyword === 'string' && sourceKeyword.trim()) {
      query += ` AND EXISTS (SELECT 1 FROM contact_telegram_sources cts WHERE cts.contact_id = c.id AND cts.organization_id = c.organization_id AND cts.search_keyword = $${idx})`;
      params.push(sourceKeyword.trim());
      idx++;
    }
    if (sourceTelegramChatId && typeof sourceTelegramChatId === 'string' && sourceTelegramChatId.trim()) {
      query += ` AND EXISTS (SELECT 1 FROM contact_telegram_sources cts WHERE cts.contact_id = c.id AND cts.organization_id = c.organization_id AND cts.telegram_chat_id = $${idx}`;
      params.push(sourceTelegramChatId.trim());
      idx++;
      if (sourceBdAccountId && typeof sourceBdAccountId === 'string' && sourceBdAccountId.trim()) {
        query += ` AND cts.bd_account_id = $${idx}`;
        params.push(sourceBdAccountId.trim());
        idx++;
      }
      query += ')';
    }
    if (outreachStatus === 'new') {
      query += ` AND NOT EXISTS (SELECT 1 FROM campaign_participants cp JOIN campaigns c2 ON c2.id = cp.campaign_id WHERE cp.contact_id = c.id AND c2.organization_id = c.organization_id)`;
    } else if (outreachStatus === 'in_outreach') {
      query += ` AND EXISTS (SELECT 1 FROM campaign_participants cp JOIN campaigns c2 ON c2.id = cp.campaign_id WHERE cp.contact_id = c.id AND c2.organization_id = c.organization_id)`;
    }
    if (search && typeof search === 'string' && search.trim()) {
      const term = `%${search.trim().replace(/%/g, '\\%')}%`;
      query += ` AND (c.first_name ILIKE $${idx} OR c.last_name ILIKE $${idx} OR c.display_name ILIKE $${idx} OR c.username ILIKE $${idx} OR c.telegram_id ILIKE $${idx} OR c.email ILIKE $${idx} OR c.phone ILIKE $${idx})`;
      params.push(term);
      idx++;
    }
    query += ` ORDER BY c.first_name, c.last_name LIMIT $${idx}`;
    params.push(limitNum);
    const result = await pool.query(query, params);
    res.json(result.rows);
  }));

  router.get('/:id', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const campaignRes = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, organizationId]
    );
    if (campaignRes.rows.length === 0) {
      throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);
    }
    const campaign = campaignRes.rows[0];
    const aud = (campaign.target_audience || {}) as { contactIds?: string[] };
    const contactIds = Array.isArray(aud.contactIds) ? aud.contactIds : [];
    const isDraftOrPaused = campaign.status === 'draft' || campaign.status === 'paused';
    const [templatesRes, sequencesRes, selectedContactsRes] = await Promise.all([
      pool.query(
        'SELECT * FROM campaign_templates WHERE campaign_id = $1 ORDER BY created_at',
        [id]
      ),
      pool.query(
        'SELECT cs.*, ct.name as template_name, ct.channel, ct.content FROM campaign_sequences cs JOIN campaign_templates ct ON ct.id = cs.template_id WHERE cs.campaign_id = $1 ORDER BY cs.order_index',
        [id]
      ),
      isDraftOrPaused && contactIds.length > 0
        ? pool.query(
            'SELECT id, first_name, last_name, display_name, username, telegram_id, email, phone FROM contacts WHERE id = ANY($1) AND organization_id = $2',
            [contactIds, organizationId]
          )
        : Promise.resolve({ rows: [] }),
    ]);
    const selected_contacts = selectedContactsRes?.rows ?? [];
    const bdIds = getBdAccountIdsFromTargetAudience(campaign.target_audience);
    let bd_accounts: ReturnType<typeof serializeBdAccountRow>[] = [];
    if (bdIds.length > 0) {
      const r = await pool.query(
        `SELECT id, display_name, first_name, last_name, username, phone_number, telegram_id,
                flood_wait_until, flood_wait_seconds, flood_reason, flood_last_at, photo_file_id, is_active, connection_state
         FROM bd_accounts WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
        [bdIds, organizationId]
      );
      const map = new Map((r.rows as BdAccountRow[]).map((row) => [row.id, row]));
      bd_accounts = bdIds
        .map((id) => map.get(id))
        .filter((row): row is BdAccountRow => row != null)
        .map(serializeBdAccountRow);
    }
    res.json({
      ...campaign,
      templates: templatesRes.rows,
      sequences: sequencesRes.rows,
      ...(selected_contacts.length > 0 ? { selected_contacts } : {}),
      bd_accounts,
    });
  }));

  router.post('/', validate(CampaignCreateSchema), asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { name, companyId, pipelineId, targetAudience, schedule } = req.body;
    const id = randomUUID();
    const campaign = await withOrgContext(pool, organizationId, async (client) => {
      await client.query(
        `INSERT INTO campaigns (id, organization_id, company_id, pipeline_id, name, status, target_audience, schedule, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          organizationId,
          companyId || null,
          pipelineId || null,
          name.trim(),
          CampaignStatus.DRAFT,
          JSON.stringify(targetAudience || {}),
          schedule ? JSON.stringify(schedule) : null,
          userId || null,
        ]
      );
      const row = await client.query('SELECT * FROM campaigns WHERE id = $1', [id]);
      return row.rows[0];
    });
    try {
      await rabbitmq.publishEvent({
        id: randomUUID(),
        type: EventType.CAMPAIGN_CREATED,
        timestamp: new Date(),
        organizationId,
        userId,
        correlationId: req.correlationId,
        data: { campaignId: id },
      } as unknown as Event);
    } catch (err) {
      log.warn({ message: 'CAMPAIGN_CREATED publish failed', campaignId: id, error: err instanceof Error ? err.message : String(err) });
    }
    res.status(201).json(campaign);
  }));

  router.patch('/:id', validate(CampaignPatchSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { name, companyId, pipelineId, targetAudience, schedule, status, leadCreationSettings } = req.body;

    const existing = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, organizationId]
    );
    if (existing.rows.length === 0) {
      throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);
    }
    const cur = existing.rows[0];
    const onlyStop = status === CampaignStatus.COMPLETED && cur.status === CampaignStatus.ACTIVE;
    if (!onlyStop && cur.status !== CampaignStatus.DRAFT && cur.status !== CampaignStatus.PAUSED) {
      throw new AppError(400, 'Only draft or paused campaigns can be updated', ErrorCodes.BAD_REQUEST);
    }

    if (onlyStop) {
      const updated = await withOrgContext(pool, organizationId, async (client) => {
        await client.query(
          "UPDATE campaigns SET status = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3",
          [CampaignStatus.COMPLETED, id, organizationId]
        );
        const row = await client.query('SELECT * FROM campaigns WHERE id = $1', [id]);
        return row.rows[0];
      });
      return res.json(updated);
    }

    const updates: string[] = ['updated_at = NOW()'];
    const params: QueryParam[] = [];
    let idx = 1;
    if (name !== undefined) {
      params.push(typeof name === 'string' ? name.trim() : name);
      updates.push(`name = $${idx++}`);
    }
    if (companyId !== undefined) {
      params.push(companyId || null);
      updates.push(`company_id = $${idx++}`);
    }
    if (pipelineId !== undefined) {
      params.push(pipelineId || null);
      updates.push(`pipeline_id = $${idx++}`);
    }
    if (targetAudience !== undefined) {
      params.push(JSON.stringify(targetAudience || {}));
      updates.push(`target_audience = $${idx++}`);
    }
    if (schedule !== undefined) {
      params.push(schedule ? JSON.stringify(schedule) : null);
      updates.push(`schedule = $${idx++}`);
    }
    if (leadCreationSettings !== undefined) {
      params.push(leadCreationSettings ? JSON.stringify(leadCreationSettings) : null);
      updates.push(`lead_creation_settings = $${idx++}`);
    }
    if (status !== undefined && [CampaignStatus.DRAFT, CampaignStatus.PAUSED].includes(status)) {
      params.push(status);
      updates.push(`status = $${idx++}`);
    }
    if (params.length === 0) {
      return res.json(existing.rows[0]);
    }
    params.push(id, organizationId);
    const result = await withOrgContext(pool, organizationId, (client) =>
      client.query(
        `UPDATE campaigns SET ${updates.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1} RETURNING *`,
        params
      )
    );
    res.json(result.rows[0]);
  }));

  router.delete('/:id', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const existing = await pool.query(
      'SELECT status FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, organizationId]
    );
    if (existing.rows.length === 0) {
      throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);
    }
    const status = existing.rows[0].status;
    if (status === CampaignStatus.ACTIVE) {
      throw new AppError(400, 'Cannot delete active campaign; pause it first', ErrorCodes.BAD_REQUEST);
    }
    await withOrgContext(pool, organizationId, (client) =>
      client.query(
        'UPDATE campaigns SET deleted_at = NOW() WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
        [id, organizationId]
      )
    );
    res.status(204).send();
  }));

  router.post('/:id/audience/from-csv', validate(FromCsvBodySchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { content, hasHeader } = req.body;
    const campaign = await pool.query(
      'SELECT id, organization_id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (campaign.rows.length === 0) {
      throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);
    }
    const orgId = campaign.rows[0].organization_id;

    const rows = parseCsv(content);
    if (rows.length === 0) return res.json({ contactIds: [], created: 0, matched: 0 });
    const header = hasHeader ? rows[0] : [];
    const dataRows = hasHeader ? rows.slice(1) : rows;
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

    const validRows: CsvContactRow[] = [];
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

    const { contactIds, created, matched } = await matchOrCreateContactsFromRows(pool, orgId, validRows);
    res.json({ contactIds, created, matched });
  }));

  router.post('/:id/audience/from-usernames', validate(FromUsernameListBodySchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { text } = req.body as { text: string };
    const campaign = await pool.query(
      'SELECT id, organization_id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (campaign.rows.length === 0) {
      throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);
    }
    const orgId = campaign.rows[0].organization_id;

    const { rows, skipped, invalidSamples } = parseUsernameListToRows(text);
    if (rows.length === 0) {
      return res.json({ contactIds: [], created: 0, matched: 0, skipped, invalidSamples });
    }
    const { contactIds, created, matched } = await matchOrCreateContactsFromRows(pool, orgId, rows);
    res.json({ contactIds, created, matched, skipped, invalidSamples });
  }));

  router.post('/:id/participants-bulk', validate(ParticipantsBulkSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const { contactIds, bdAccountId } = req.body as { contactIds: string[], bdAccountId?: string };

    const campaign = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (campaign.rows.length === 0) {
      throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);
    }

    const assignedBdAccountId = bdAccountId;

    if (contactIds.length === 0) {
      return res.json({ added: 0 });
    }

    let added = 0;
    const batchSize = 1000;
    for (let i = 0; i < contactIds.length; i += batchSize) {
      const batch = contactIds.slice(i, i + batchSize);
      
      const values: string[] = [];
      const params: QueryParam[] = [id];
      let pIdx = 2;

      for (const cid of batch) {
         values.push(`($1, $${pIdx}, $${pIdx + 1}, 'pending', NOW(), NOW())`);
         params.push(cid, assignedBdAccountId || null);
         pIdx += 2;
      }
      
      const insertQuery = `
        INSERT INTO campaign_participants (campaign_id, contact_id, bd_account_id, status, created_at, updated_at)
        VALUES ${values.join(', ')}
        ON CONFLICT (campaign_id, contact_id) DO NOTHING
      `;
      
      const result = await pool.query(insertQuery, params);
      added += result.rowCount || 0;
    }

    res.json({ added });
  }));

  return router;
}
