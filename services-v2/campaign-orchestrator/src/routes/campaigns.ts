import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { EventType, type Event } from '@getsale/events';
import { AppError, ErrorCodes, requireUser, validate, type DatabasePools } from '@getsale/service-framework';
import { type RabbitMQClient } from '@getsale/queue';
import { type Logger } from '@getsale/logger';
import { CampaignScheduler } from '../scheduler';

/* ------------------------------------------------------------------ */
/*  Deps                                                               */
/* ------------------------------------------------------------------ */

interface Deps {
  db: DatabasePools;
  rabbitmq: RabbitMQClient;
  log: Logger;
  scheduler: CampaignScheduler;
}

/* ------------------------------------------------------------------ */
/*  Zod schemas                                                        */
/* ------------------------------------------------------------------ */

const targetAudienceSchema = z
  .object({
    contactIds: z.array(z.string().uuid()).optional(),
    limit: z.number().int().min(0).optional(),
    sendDelaySeconds: z.number().min(0).optional(),
    sendDelayMinSeconds: z.number().int().min(0).max(3600).optional(),
    sendDelayMaxSeconds: z.number().int().min(0).max(3600).optional(),
    dynamicPipelineId: z.string().uuid().optional(),
    dynamicStageIds: z.array(z.string().uuid()).optional(),
    bdAccountId: z.string().uuid().optional(),
    bdAccountIds: z.array(z.string().uuid()).optional(),
    randomizeWithAI: z.boolean().optional(),
    dailySendTarget: z.number().int().min(1).max(500).optional(),
  })
  .passthrough()
  .superRefine((val, ctx) => {
    const min = val.sendDelayMinSeconds;
    const max = val.sendDelayMaxSeconds;
    if (min != null && max != null && min > max) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'sendDelayMinSeconds must be <= sendDelayMaxSeconds',
        path: ['sendDelayMinSeconds'],
      });
    }
  })
  .optional()
  .nullable();

const scheduleSchema = z
  .object({
    timezone: z.string().max(64).optional(),
    workingHours: z.object({ start: z.string().max(16).optional(), end: z.string().max(16).optional() }).optional(),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).optional(),
  })
  .passthrough()
  .optional()
  .nullable();

const leadCreationSettingsSchema = z
  .object({
    trigger: z.string().max(64).optional(),
    default_stage_id: z.string().uuid().optional(),
    default_responsible_id: z.string().uuid().optional(),
  })
  .passthrough()
  .optional()
  .nullable();

const campaignStatusSchema = z.enum(['draft', 'active', 'paused', 'completed']);

const CampaignCreateSchema = z.object({
  name: z.string().min(1, 'Name is required').max(500).trim(),
  companyId: z.string().uuid().optional().nullable(),
  pipelineId: z.string().uuid().optional().nullable(),
  targetAudience: targetAudienceSchema,
  schedule: scheduleSchema,
});

const CampaignPatchSchema = z.object({
  name: z.string().min(1).max(500).trim().optional(),
  companyId: z.string().uuid().optional().nullable(),
  pipelineId: z.string().uuid().optional().nullable(),
  targetAudience: targetAudienceSchema,
  schedule: scheduleSchema,
  status: campaignStatusSchema.optional(),
  leadCreationSettings: leadCreationSettingsSchema,
});

const ParticipantsBulkSchema = z.object({
  contactIds: z.array(z.string().uuid()).min(1).max(5000),
  bdAccountId: z.string().uuid().optional(),
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function getBdAccountIdsFromTargetAudience(aud: unknown): string[] {
  if (!aud || typeof aud !== 'object') return [];
  const a = aud as { bdAccountIds?: unknown; bdAccountId?: unknown };
  if (Array.isArray(a.bdAccountIds) && a.bdAccountIds.length > 0) {
    return a.bdAccountIds.filter((id): id is string => typeof id === 'string');
  }
  if (typeof a.bdAccountId === 'string' && a.bdAccountId) return [a.bdAccountId];
  return [];
}

function canManageCampaignLifecycle(
  role: string | undefined,
  userId: string | undefined,
  createdByUserId: string | null,
): boolean {
  const r = (role || '').toLowerCase();
  if (r === 'owner' || r === 'admin') return true;
  return createdByUserId != null && userId != null && createdByUserId === userId;
}

interface BdAccountRow {
  id: string;
  created_by_user_id: string | null;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  phone_number: string | null;
  telegram_id: string | null;
  flood_wait_until: Date | string | null;
  flood_wait_seconds: number | null;
  flood_reason: string | null;
  flood_last_at: Date | string | null;
  spam_restricted_at?: Date | string | null;
  spam_restriction_source?: string | null;
  peer_flood_count_1h?: number | null;
  photo_file_id: string | null;
  is_active: boolean;
  connection_state: string | null;
}

function getBdAccountDisplayName(row: BdAccountRow): string {
  if (row.display_name?.trim()) return row.display_name.trim();
  const full = `${row.first_name ?? ''} ${row.last_name ?? ''}`.trim();
  if (full) return full;
  return row.username || row.phone_number || String(row.telegram_id ?? row.id ?? '');
}

function serializeBdAccountRow(row: BdAccountRow) {
  return {
    id: row.id,
    displayName: getBdAccountDisplayName(row),
    floodWaitUntil: row.flood_wait_until != null ? new Date(row.flood_wait_until as string).toISOString() : null,
    floodWaitSeconds: row.flood_wait_seconds,
    floodReason: row.flood_reason,
    floodLastAt: row.flood_last_at != null ? new Date(row.flood_last_at as string).toISOString() : null,
    spamRestrictedAt: row.spam_restricted_at != null ? new Date(row.spam_restricted_at as string).toISOString() : null,
    spamRestrictionSource: row.spam_restriction_source ?? null,
    peerFloodCount1h: row.peer_flood_count_1h != null ? Number(row.peer_flood_count_1h) : null,
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

/* ------------------------------------------------------------------ */
/*  Route registration                                                 */
/* ------------------------------------------------------------------ */

export function registerCampaignRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, rabbitmq, log, scheduler } = deps;

  /* ===================== GET /api/campaigns (list) ================== */

  app.get('/api/campaigns', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { status, page: pageRaw, limit: limitRaw } = request.query as {
      status?: string;
      page?: string | number;
      limit?: string | number;
    };

    const page = Math.max(1, Number(pageRaw) || 1);
    const limit = Math.min(100, Math.max(1, Number(limitRaw) || 20));
    const offset = (page - 1) * limit;

    let whereClause = 'WHERE c.organization_id = $1 AND c.deleted_at IS NULL';
    const paramsBase: unknown[] = [user.organizationId];
    if (status && typeof status === 'string') {
      paramsBase.push(status);
      whereClause += ` AND c.status = $${paramsBase.length}`;
    }

    const countRes = await db.read.query(
      `SELECT COUNT(*)::int AS total FROM campaigns c ${whereClause}`,
      paramsBase,
    );
    const totalCount = Number((countRes.rows[0] as { total: number }).total);

    const [summarySentRes, summaryRepliedRes, summaryWonRes] = await Promise.all([
      db.read.query(
        `SELECT COALESCE(SUM(cnt), 0)::int AS total FROM (
           SELECT cp.campaign_id, COUNT(DISTINCT cp.id)::int AS cnt
           FROM campaign_sends cs
           JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
           JOIN campaigns c ON c.id = cp.campaign_id
           ${whereClause}
           AND cs.status = 'sent'
           GROUP BY cp.campaign_id
         ) t`,
        paramsBase,
      ),
      db.read.query(
        `SELECT COALESCE(SUM(cnt), 0)::int AS total FROM (
           SELECT cp.campaign_id, COUNT(*)::int AS cnt
           FROM campaign_participants cp
           JOIN campaigns c ON c.id = cp.campaign_id
           ${whereClause} AND cp.status = 'replied'
           GROUP BY cp.campaign_id
         ) t`,
        paramsBase,
      ),
      db.read.query(
        `SELECT COALESCE(SUM(cnt), 0)::int AS total FROM (
           SELECT conv.campaign_id, COUNT(*)::int AS cnt
           FROM conversations conv
           JOIN campaigns c ON c.id = conv.campaign_id
           ${whereClause} AND conv.won_at IS NOT NULL
           GROUP BY conv.campaign_id
         ) t`,
        paramsBase,
      ),
    ]);

    const summaryTotals = {
      total_sent: ((summarySentRes.rows[0] as { total: number } | undefined)?.total) ?? 0,
      total_replied: ((summaryRepliedRes.rows[0] as { total: number } | undefined)?.total) ?? 0,
      total_won: ((summaryWonRes.rows[0] as { total: number } | undefined)?.total) ?? 0,
    };

    const dataParams = [...paramsBase, limit, offset];
    const result = await db.read.query(
      `SELECT c.*,
              u.email AS owner_email,
              COALESCE(NULLIF(TRIM(CONCAT_WS(' ', up.first_name, up.last_name)), ''), u.email) AS owner_name,
              (SELECT COUNT(*)::int FROM campaign_participants cp2 WHERE cp2.campaign_id = c.id) AS total_participants
       FROM campaigns c
       LEFT JOIN users u ON u.id = c.created_by_user_id
       LEFT JOIN user_profiles up ON up.user_id = u.id
       ${whereClause}
       ORDER BY c.created_at DESC
       LIMIT $${dataParams.length - 1} OFFSET $${dataParams.length}`,
      dataParams,
    );

    type CampaignListRow = { id: string; target_audience?: { bdAccountId?: string; bdAccountIds?: string[] } };
    const campaigns = result.rows as CampaignListRow[];

    if (campaigns.length === 0) {
      return { data: [], total: totalCount, page, limit, summary: summaryTotals };
    }

    const ids = campaigns.map((c) => c.id);
    const bdAccountIds = [...new Set(campaigns.flatMap((c) => getBdAccountIdsFromTargetAudience(c.target_audience)))];

    const [sentRes, repliedRes, sharedRes, readRes, wonRes, revenueRes, bdAccountsRes] = await Promise.all([
      db.read.query(
        `SELECT cp.campaign_id, COUNT(DISTINCT cp.id)::int AS cnt
         FROM campaign_sends cs JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
         WHERE cp.campaign_id = ANY($1::uuid[]) AND cs.status = 'sent' GROUP BY cp.campaign_id`,
        [ids],
      ),
      db.read.query(
        `SELECT campaign_id, COUNT(*)::int AS cnt FROM campaign_participants
         WHERE campaign_id = ANY($1::uuid[]) AND status = 'replied' GROUP BY campaign_id`,
        [ids],
      ),
      db.read.query(
        `SELECT campaign_id, COUNT(*)::int AS cnt FROM conversations
         WHERE campaign_id = ANY($1::uuid[]) AND shared_chat_created_at IS NOT NULL GROUP BY campaign_id`,
        [ids],
      ),
      db.read.query(
        `SELECT cp.campaign_id, COUNT(DISTINCT cp.id)::int AS cnt
         FROM campaign_sends cs
         JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
         JOIN messages m ON m.id = cs.message_id AND m.status = 'read'
         WHERE cp.campaign_id = ANY($1::uuid[]) AND cs.status = 'sent'
         GROUP BY cp.campaign_id`,
        [ids],
      ),
      db.read.query(
        `SELECT campaign_id, COUNT(*)::int AS cnt FROM conversations
         WHERE campaign_id = ANY($1::uuid[]) AND won_at IS NOT NULL GROUP BY campaign_id`,
        [ids],
      ),
      db.read.query(
        `SELECT campaign_id, COALESCE(SUM(revenue_amount), 0)::numeric AS total FROM conversations
         WHERE campaign_id = ANY($1::uuid[]) AND won_at IS NOT NULL GROUP BY campaign_id`,
        [ids],
      ),
      bdAccountIds.length > 0
        ? db.read.query(
            `SELECT id, created_by_user_id, display_name, first_name, last_name, username, phone_number, telegram_id,
                    flood_wait_until, flood_wait_seconds, flood_reason, flood_last_at,
                    spam_restricted_at, spam_restriction_source, peer_flood_count_1h,
                    photo_file_id, is_active, connection_state
             FROM bd_accounts WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
            [bdAccountIds, user.organizationId],
          )
        : Promise.resolve({ rows: [] as BdAccountRow[] }),
    ]);

    type CountRow = { campaign_id: string; cnt: number };
    type RevenueRow = { campaign_id: string; total: string };

    const sentMap = new Map((sentRes.rows as CountRow[]).map((r) => [r.campaign_id, r.cnt]));
    const repliedMap = new Map((repliedRes.rows as CountRow[]).map((r) => [r.campaign_id, r.cnt]));
    const sharedMap = new Map((sharedRes.rows as CountRow[]).map((r) => [r.campaign_id, r.cnt]));
    const readMap = new Map((readRes.rows as CountRow[]).map((r) => [r.campaign_id, r.cnt]));
    const wonMap = new Map((wonRes.rows as CountRow[]).map((r) => [r.campaign_id, r.cnt]));
    const revenueMap = new Map((revenueRes.rows as RevenueRow[]).map((r) => [r.campaign_id, Number(r.total)]));
    const bdAccountMap = new Map((bdAccountsRes.rows as BdAccountRow[]).map((a) => [a.id, a]));

    const data = campaigns.map((c) => {
      const bdIdsOrdered = getBdAccountIdsFromTargetAudience(c.target_audience);
      const bd_accounts = bdIdsOrdered
        .map((bid) => bdAccountMap.get(bid))
        .filter((r): r is BdAccountRow => r != null)
        .map(serializeBdAccountRow);
      const firstId = c.target_audience?.bdAccountIds?.[0] ?? c.target_audience?.bdAccountId;
      const firstRow = firstId ? bdAccountMap.get(firstId) : undefined;

      return {
        ...c,
        total_sent: sentMap.get(c.id) ?? 0,
        total_read: readMap.get(c.id) ?? 0,
        total_replied: repliedMap.get(c.id) ?? 0,
        total_converted_to_shared_chat: sharedMap.get(c.id) ?? 0,
        total_won: wonMap.get(c.id) ?? 0,
        total_revenue: revenueMap.get(c.id) ?? 0,
        bd_account_name: firstRow ? getBdAccountDisplayName(firstRow) : null,
        bd_accounts,
      };
    });

    return { data, total: totalCount, page, limit, summary: summaryTotals };
  });

  /* =================== GET /api/campaigns/:id (detail) ============= */

  app.get('/api/campaigns/:id', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;

    const campaignRes = await db.read.query(
      'SELECT * FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, user.organizationId],
    );
    if (!campaignRes.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const campaign = campaignRes.rows[0] as Record<string, unknown>;
    const aud = (campaign.target_audience || {}) as { contactIds?: string[] };
    const contactIds = Array.isArray(aud.contactIds) ? aud.contactIds : [];
    const isDraftOrPaused = campaign.status === 'draft' || campaign.status === 'paused';

    const [templatesRes, sequencesRes, selectedContactsRes] = await Promise.all([
      db.read.query(
        'SELECT * FROM campaign_templates WHERE campaign_id = $1 ORDER BY created_at',
        [id],
      ),
      db.read.query(
        `SELECT cs.*, ct.name as template_name, ct.channel, ct.content
         FROM campaign_sequences cs
         JOIN campaign_templates ct ON ct.id = cs.template_id
         WHERE cs.campaign_id = $1
         ORDER BY cs.order_index`,
        [id],
      ),
      isDraftOrPaused && contactIds.length > 0
        ? db.read.query(
            `SELECT id, first_name, last_name, display_name, username, telegram_id, email, phone
             FROM contacts WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
            [contactIds, user.organizationId],
          )
        : Promise.resolve({ rows: [] }),
    ]);

    const selected_contacts = selectedContactsRes?.rows ?? [];

    const bdIds = getBdAccountIdsFromTargetAudience(campaign.target_audience);
    let bd_accounts: ReturnType<typeof serializeBdAccountRow>[] = [];
    if (bdIds.length > 0) {
      const r = await db.read.query(
        `SELECT id, created_by_user_id, display_name, first_name, last_name, username, phone_number, telegram_id,
                flood_wait_until, flood_wait_seconds, flood_reason, flood_last_at,
                spam_restricted_at, spam_restriction_source, peer_flood_count_1h,
                photo_file_id, is_active, connection_state
         FROM bd_accounts WHERE id = ANY($1::uuid[]) AND organization_id = $2`,
        [bdIds, user.organizationId],
      );
      const map = new Map((r.rows as BdAccountRow[]).map((row) => [row.id, row]));
      bd_accounts = bdIds
        .map((bid) => map.get(bid))
        .filter((row): row is BdAccountRow => row != null)
        .map(serializeBdAccountRow);
    }

    return {
      ...campaign,
      templates: templatesRes.rows,
      sequences: sequencesRes.rows,
      ...(selected_contacts.length > 0 ? { selected_contacts } : {}),
      bd_accounts,
    };
  });

  /* =================== GET /api/campaigns/:id/stats ================ */

  app.get('/api/campaigns/:id/stats', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    return scheduler.getCampaignStats(id);
  });

  /* =================== POST /api/campaigns (create) ================ */

  app.post('/api/campaigns', { preHandler: [requireUser, validate(CampaignCreateSchema)] }, async (request, reply) => {
    const user = request.user!;
    const { name, companyId, pipelineId, targetAudience, schedule } = request.body as z.infer<typeof CampaignCreateSchema>;
    const id = randomUUID();

    const campaign = await db.withOrgContext('write', user.organizationId, async (client) => {
      await client.query(
        `INSERT INTO campaigns (id, organization_id, company_id, pipeline_id, name, status, target_audience, schedule, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          id,
          user.organizationId,
          companyId || null,
          pipelineId || null,
          name.trim(),
          'draft',
          JSON.stringify(targetAudience || {}),
          schedule ? JSON.stringify(schedule) : null,
          user.id || null,
        ],
      );
      const row = await client.query('SELECT * FROM campaigns WHERE id = $1', [id]);
      return row.rows[0];
    });

    try {
      await rabbitmq.publishEvent({
        id: randomUUID(),
        type: EventType.CAMPAIGN_CREATED,
        timestamp: new Date(),
        organizationId: user.organizationId,
        userId: user.id,
        correlationId: request.correlationId,
        data: { campaignId: id },
      } as unknown as Event);
    } catch (err) {
      log.warn({ message: 'CAMPAIGN_CREATED publish failed', campaignId: id, error: err instanceof Error ? err.message : String(err) });
    }

    reply.code(201);
    return campaign;
  });

  /* =================== PATCH /api/campaigns/:id ==================== */

  app.patch('/api/campaigns/:id', { preHandler: [requireUser, validate(CampaignPatchSchema)] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const { name, companyId, pipelineId, targetAudience, schedule, status, leadCreationSettings } =
      request.body as z.infer<typeof CampaignPatchSchema>;

    const existing = await db.read.query(
      'SELECT * FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, user.organizationId],
    );
    if (!existing.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const cur = existing.rows[0] as { status: string; created_by_user_id: string | null };

    const bodyKeys = Object.keys((request.body || {}) as Record<string, unknown>).filter(
      (k) => ((request.body as Record<string, unknown>)[k]) !== undefined,
    );
    const nameOnlyRename = bodyKeys.length === 1 && bodyKeys[0] === 'name' && typeof name === 'string';

    if (nameOnlyRename) {
      const nm = name!.trim();
      if (!nm) throw new AppError(400, 'Name is required', ErrorCodes.BAD_REQUEST);
      if (!canManageCampaignLifecycle(user.role, user.id, cur.created_by_user_id)) {
        throw new AppError(403, 'Insufficient permissions', ErrorCodes.FORBIDDEN);
      }
      const renamed = await db.write.query(
        'UPDATE campaigns SET name = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3 RETURNING *',
        [nm, id, user.organizationId],
      );
      return renamed.rows[0];
    }

    const onlyStop = status === 'completed' && cur.status === 'active';
    if (!onlyStop && cur.status !== 'draft' && cur.status !== 'paused') {
      throw new AppError(400, 'Only draft or paused campaigns can be updated', ErrorCodes.BAD_REQUEST);
    }

    if (onlyStop) {
      return db.withOrgContext('write', user.organizationId, async (client) => {
        await client.query(
          "UPDATE campaigns SET status = 'completed', updated_at = NOW() WHERE id = $1 AND organization_id = $2",
          [id, user.organizationId],
        );
        const row = await client.query('SELECT * FROM campaigns WHERE id = $1', [id]);
        return row.rows[0];
      });
    }

    const updates: string[] = ['updated_at = NOW()'];
    const params: unknown[] = [];
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
    if (status !== undefined && (status === 'draft' || status === 'paused')) {
      params.push(status);
      updates.push(`status = $${idx++}`);
    }

    if (params.length === 0) {
      return existing.rows[0];
    }

    params.push(id, user.organizationId);
    const result = await db.withOrgContext('write', user.organizationId, (client) =>
      client.query(
        `UPDATE campaigns SET ${updates.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1} RETURNING *`,
        params,
      ),
    );
    return result.rows[0];
  });

  /* =================== DELETE /api/campaigns/:id =================== */

  app.delete('/api/campaigns/:id', { preHandler: [requireUser] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;

    const existing = await db.read.query(
      'SELECT status, created_by_user_id FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, user.organizationId],
    );
    if (!existing.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const row = existing.rows[0] as { status: string; created_by_user_id: string | null };
    if (!canManageCampaignLifecycle(user.role, user.id, row.created_by_user_id)) {
      throw new AppError(403, 'Insufficient permissions', ErrorCodes.FORBIDDEN);
    }
    if (row.status === 'active') {
      throw new AppError(400, 'Cannot delete active campaign; pause it first', ErrorCodes.BAD_REQUEST);
    }

    await db.withOrgContext('write', user.organizationId, (client) =>
      client.query(
        'UPDATE campaigns SET deleted_at = NOW() WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
        [id, user.organizationId],
      ),
    );

    reply.code(204).send();
  });

  /* =================== POST /api/campaigns/:id/start =============== */

  app.post('/api/campaigns/:id/start', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;

    const campaign = await db.read.query(
      'SELECT * FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, user.organizationId],
    );
    if (!campaign.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);
    const camp = campaign.rows[0] as Record<string, unknown>;
    if (camp.status === 'active') throw new AppError(400, 'Campaign already active', ErrorCodes.BAD_REQUEST);

    const seqRes = await db.read.query('SELECT 1 FROM campaign_sequences WHERE campaign_id = $1 LIMIT 1', [id]);
    if (!seqRes.rows.length) throw new AppError(400, 'Add at least one sequence step before starting', ErrorCodes.BAD_REQUEST);

    const existingParticipantsRes = await db.read.query(
      'SELECT COUNT(*)::int AS c FROM campaign_participants WHERE campaign_id = $1',
      [id],
    );
    const existingParticipantCount = Number((existingParticipantsRes.rows[0] as { c?: number })?.c ?? 0);

    const audience = (camp.target_audience || {}) as {
      contactIds?: string[];
      filters?: Record<string, unknown>;
      limit?: number;
      onlyNew?: boolean;
      bdAccountId?: string;
      bdAccountIds?: string[];
      sendDelaySeconds?: number;
      sendDelayMinSeconds?: number;
      sendDelayMaxSeconds?: number;
      dailySendTarget?: number;
    };

    let insertedCount = 0;

    if (existingParticipantCount === 0) {
      const audienceLimit = Math.min(audience.limit ?? 5000, 10000);

      let contactsQuery: string;
      const queryParams: unknown[] = [user.organizationId];
      let paramIdx = 2;

      if (audience.contactIds && Array.isArray(audience.contactIds) && audience.contactIds.length > 0) {
        const ids = audience.contactIds.slice(0, audienceLimit).filter((x) => typeof x === 'string');
        if (ids.length === 0) throw new AppError(400, 'No valid contact IDs in audience', ErrorCodes.BAD_REQUEST);
        contactsQuery = `
          SELECT c.id AS contact_id, c.telegram_id, c.username
          FROM contacts c
          WHERE c.organization_id = $1
          AND (
            (c.telegram_id IS NOT NULL AND TRIM(c.telegram_id) != '')
            OR (c.username IS NOT NULL AND TRIM(c.username) != '')
          )
          AND c.id = ANY($${paramIdx}::uuid[])
        `;
        queryParams.push(ids);
        paramIdx++;
      } else {
        contactsQuery = `
          SELECT c.id AS contact_id, c.telegram_id, c.username
          FROM contacts c
          WHERE c.organization_id = $1
          AND (
            (c.telegram_id IS NOT NULL AND TRIM(c.telegram_id) != '')
            OR (c.username IS NOT NULL AND TRIM(c.username) != '')
          )
        `;
        if (audience.filters?.companyId) {
          contactsQuery += ` AND c.company_id = $${paramIdx++}`;
          queryParams.push(audience.filters.companyId);
        }
        if (audience.filters?.pipelineId) {
          contactsQuery += ` AND EXISTS (SELECT 1 FROM leads l WHERE l.contact_id = c.id AND l.pipeline_id = $${paramIdx})`;
          queryParams.push(audience.filters.pipelineId);
          paramIdx++;
        }
        if (audience.onlyNew) {
          contactsQuery += ` AND NOT EXISTS (
            SELECT 1 FROM campaign_participants cp2
            JOIN campaigns c2 ON c2.id = cp2.campaign_id
            WHERE cp2.contact_id = c.id AND c2.organization_id = c.organization_id
          )`;
        }
        contactsQuery += ` LIMIT ${audienceLimit}`;
      }

      const contactsResult = await db.read.query(contactsQuery, queryParams);
      const contacts = contactsResult.rows as { contact_id: string; telegram_id: string | null; username: string | null }[];

      const hadExplicitIds = Array.isArray(audience.contactIds) && audience.contactIds.length > 0;
      if (hadExplicitIds && contacts.length === 0) {
        throw new AppError(400, 'None of the selected contacts have a Telegram ID or username.', ErrorCodes.BAD_REQUEST);
      }

      const bdAccountIdsRaw = audience.bdAccountIds ?? (audience.bdAccountId ? [audience.bdAccountId] : []);
      const bdAccountIdsFiltered = bdAccountIdsRaw.filter((x): x is string => typeof x === 'string');
      let accountIds: string[] = [];
      if (bdAccountIdsFiltered.length > 0) {
        const check = await db.read.query(
          'SELECT id FROM bd_accounts WHERE id = ANY($1::uuid[]) AND organization_id = $2 AND is_active = true',
          [bdAccountIdsFiltered, user.organizationId],
        );
        const order = new Map(bdAccountIdsFiltered.map((x, i) => [x, i]));
        accountIds = (check.rows as { id: string }[])
          .map((r) => r.id)
          .sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
      }
      if (accountIds.length === 0) {
        const fallback = await db.read.query(
          'SELECT id FROM bd_accounts WHERE organization_id = $1 AND is_active = true LIMIT 1',
          [user.organizationId],
        );
        accountIds = fallback.rows.length > 0 ? [(fallback.rows[0] as { id: string }).id] : [];
      }

      const ordRow = await db.read.query(
        'SELECT COALESCE(MAX(enqueue_order), -1) + 1 AS n FROM campaign_participants WHERE campaign_id = $1',
        [id],
      );
      let enqueueOrder = Number((ordRow.rows[0] as { n?: number })?.n ?? 0);
      const dailyCap = audience.dailySendTarget ?? 50;

      for (const row of contacts) {
        const bdAccountId = accountIds.length > 0 ? accountIds[insertedCount % accountIds.length]! : null;
        const telegramIdNorm = row.telegram_id != null && String(row.telegram_id).trim() !== '' ? String(row.telegram_id).trim() : null;
        const usernameNorm = row.username != null && row.username.trim().replace(/^@/, '') !== '' ? row.username.trim().replace(/^@/, '') : null;
        let channelId: string | null = telegramIdNorm ?? usernameNorm;

        if (channelId && bdAccountId) {
          const chatRes = await db.read.query(
            'SELECT bd_account_id, telegram_chat_id FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
            [bdAccountId, channelId],
          );
          if (chatRes.rows.length > 0) {
            channelId = String((chatRes.rows[0] as { telegram_chat_id: string }).telegram_chat_id);
          }
        }
        if (!channelId || !bdAccountId) continue;

        const slotIndex = enqueueOrder + insertedCount;
        const baseIntervalSec = dailyCap > 0 ? Math.max(60, Math.floor(((18 - 9) * 3600) / dailyCap)) : 60;
        const offsetSec = slotIndex * baseIntervalSec + (slotIndex === 0 ? 0 : Math.floor(Math.random() * Math.max(10, Math.floor(baseIntervalSec * 0.1)) * 2) - Math.max(10, Math.floor(baseIntervalSec * 0.1)));
        const nextSendAt = new Date(Date.now() + Math.max(0, offsetSec) * 1000);

        const ins = await db.write.query(
          `INSERT INTO campaign_participants (id, campaign_id, contact_id, bd_account_id, channel_id, status, current_step, next_send_at, enqueue_order, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6, $7, NOW(), NOW())
           ON CONFLICT (campaign_id, contact_id) DO NOTHING
           RETURNING id`,
          [randomUUID(), id, row.contact_id, bdAccountId, channelId, nextSendAt, slotIndex],
        );
        if (ins.rowCount && ins.rows.length > 0) insertedCount++;
      }

      if (contacts.length > 0 && insertedCount === 0) {
        throw new AppError(400, 'No participants could be added. Ensure contacts have Telegram data and an active BD account is selected.', ErrorCodes.BAD_REQUEST);
      }
    } else {
      log.info({ message: `Campaign ${id} already has ${existingParticipantCount} participants, enriching missing data` });

      const bdAccountIdsRaw = audience.bdAccountIds ?? (audience.bdAccountId ? [audience.bdAccountId] : []);
      const bdAccountIdsFiltered = bdAccountIdsRaw.filter((x): x is string => typeof x === 'string');
      let accountIds: string[] = [];
      if (bdAccountIdsFiltered.length > 0) {
        const check = await db.read.query(
          'SELECT id FROM bd_accounts WHERE id = ANY($1::uuid[]) AND organization_id = $2 AND is_active = true',
          [bdAccountIdsFiltered, user.organizationId],
        );
        const order = new Map(bdAccountIdsFiltered.map((x, i) => [x, i]));
        accountIds = (check.rows as { id: string }[])
          .map((r) => r.id)
          .sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
      }
      if (accountIds.length === 0) {
        const fallback = await db.read.query(
          'SELECT id FROM bd_accounts WHERE organization_id = $1 AND is_active = true LIMIT 1',
          [user.organizationId],
        );
        accountIds = fallback.rows.length > 0 ? [(fallback.rows[0] as { id: string }).id] : [];
      }

      const incomplete = await db.read.query(
        `SELECT cp.id, cp.contact_id, cp.bd_account_id, cp.channel_id
         FROM campaign_participants cp
         WHERE cp.campaign_id = $1
           AND cp.status = 'pending'
           AND (cp.channel_id IS NULL OR cp.bd_account_id IS NULL)`,
        [id],
      );

      let enrichedCount = 0;
      for (const row of incomplete.rows as { id: string; contact_id: string; bd_account_id: string | null; channel_id: string | null }[]) {
        let bdAccountId = row.bd_account_id;
        if (!bdAccountId && accountIds.length > 0) {
          bdAccountId = accountIds[enrichedCount % accountIds.length]!;
        }

        let channelId = row.channel_id;
        if (!channelId) {
          const contactRes = await db.read.query(
            'SELECT telegram_id, username FROM contacts WHERE id = $1',
            [row.contact_id],
          );
          const ct = contactRes.rows[0] as { telegram_id: string | null; username: string | null } | undefined;
          if (ct) {
            const telegramIdNorm = ct.telegram_id != null && String(ct.telegram_id).trim() !== '' ? String(ct.telegram_id).trim() : null;
            const usernameNorm = ct.username != null && ct.username.trim().replace(/^@/, '') !== '' ? ct.username.trim().replace(/^@/, '') : null;
            channelId = telegramIdNorm ?? usernameNorm;

            if (channelId && bdAccountId) {
              const chatRes = await db.read.query(
                'SELECT telegram_chat_id FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
                [bdAccountId, channelId],
              );
              if (chatRes.rows.length > 0) {
                channelId = String((chatRes.rows[0] as { telegram_chat_id: string }).telegram_chat_id);
              }
            }
          }
        }

        if (!channelId || !bdAccountId) {
          await db.write.query(
            "UPDATE campaign_participants SET status = 'skipped', last_error = 'No channel_id or bd_account_id could be resolved', updated_at = NOW() WHERE id = $1",
            [row.id],
          );
          continue;
        }

        await db.write.query(
          'UPDATE campaign_participants SET bd_account_id = $1, channel_id = $2, updated_at = NOW() WHERE id = $3',
          [bdAccountId, channelId, row.id],
        );
        enrichedCount++;
      }

      log.info({ message: `Enriched ${enrichedCount}/${incomplete.rows.length} participants for campaign ${id}` });
    }

    const totalReady = await db.read.query(
      "SELECT COUNT(*)::int AS c FROM campaign_participants WHERE campaign_id = $1 AND status = 'pending'",
      [id],
    );
    if (Number((totalReady.rows[0] as { c?: number })?.c ?? 0) === 0) {
      throw new AppError(400, 'No participants ready to send to. Ensure contacts have Telegram data and an active BD account is selected.', ErrorCodes.BAD_REQUEST);
    }

    log.info({ message: `Campaign ${id}: ready to schedule` });

    const scheduled = await scheduler.scheduleCampaign(id);

    await db.write.query(
      "UPDATE campaigns SET status = 'active', updated_at = NOW() WHERE id = $1 AND organization_id = $2",
      [id, user.organizationId],
    );

    rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.CAMPAIGN_STARTED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      correlationId: request.correlationId,
      data: { campaignId: id, scheduledCount: scheduled, insertedCount },
    } as unknown as Event).catch(() => {});

    const updated = await db.read.query('SELECT * FROM campaigns WHERE id = $1', [id]);
    return updated.rows[0];
  });

  /* =================== POST /api/campaigns/:id/pause =============== */

  app.post('/api/campaigns/:id/pause', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;

    const campaign = await db.read.query(
      'SELECT status FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, user.organizationId],
    );
    if (!campaign.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);
    if ((campaign.rows[0] as { status: string }).status !== 'active') {
      throw new AppError(400, 'Only active campaigns can be paused', ErrorCodes.BAD_REQUEST);
    }

    await scheduler.cancelCampaign(id);

    await db.write.query(
      "UPDATE campaigns SET status = 'paused', updated_at = NOW() WHERE id = $1 AND organization_id = $2",
      [id, user.organizationId],
    );

    rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.CAMPAIGN_PAUSED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      correlationId: request.correlationId,
      data: { campaignId: id },
    } as unknown as Event).catch(() => {});

    const updated = await db.read.query('SELECT * FROM campaigns WHERE id = $1', [id]);
    return updated.rows[0];
  });

  /* ============= GET /api/campaigns/:id/participants/export ========= */

  app.get('/api/campaigns/:id/participants/export', { preHandler: [requireUser] }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const user = request.user!;

    const campaign = await db.read.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, user.organizationId],
    );
    if (!campaign.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const result = await db.read.query(
      `SELECT
         c.first_name,
         c.last_name,
         c.username,
         c.phone,
         c.email,
         cp.status,
         cs_first.sent_at AS first_sent_at,
         cs_first.send_status AS first_send_status,
         ba.display_name AS sender_account,
         CASE WHEN cs_latest.read_at IS NOT NULL THEN true
              WHEN m_read.id IS NOT NULL THEN true
              ELSE false END AS is_read,
         cp.replied_at,
         m_reply.content AS first_reply_text
       FROM campaign_participants cp
       JOIN contacts c ON c.id = cp.contact_id
       LEFT JOIN bd_accounts ba ON ba.id = cp.bd_account_id
       LEFT JOIN LATERAL (
         SELECT sent_at, status AS send_status FROM campaign_sends
         WHERE campaign_participant_id = cp.id AND status IN ('sent', 'queued')
         ORDER BY sequence_step ASC LIMIT 1
       ) cs_first ON true
       LEFT JOIN LATERAL (
         SELECT read_at, message_id FROM campaign_sends
         WHERE campaign_participant_id = cp.id AND status = 'sent'
         ORDER BY sequence_step DESC LIMIT 1
       ) cs_latest ON true
       LEFT JOIN messages m_read ON m_read.id = cs_latest.message_id AND m_read.status = 'read'
       LEFT JOIN LATERAL (
         SELECT content FROM messages
         WHERE bd_account_id = cp.bd_account_id
           AND channel_id = cp.channel_id
           AND direction = 'inbound'
           AND created_at > COALESCE(cs_first.sent_at, cp.created_at)
         ORDER BY created_at ASC LIMIT 1
       ) m_reply ON cp.status = 'replied'
       WHERE cp.campaign_id = $1
       ORDER BY cp.created_at`,
      [id],
    );

    return (result.rows as Record<string, unknown>[]).map((r) => {
      const st = String(r.status ?? '');
      const isDelivered = r.first_sent_at != null && r.first_send_status === 'sent';
      const displayStatus = (() => {
        if (st === 'failed' || st === 'skipped' || st === 'completed') return 'failed';
        if (st === 'replied') return 'replied';
        if (isDelivered && r.is_read) return 'read';
        if (isDelivered) return 'sent';
        return 'waiting';
      })();
      return { ...r, display_status: displayStatus };
    });
  });

  /* ============= POST /api/campaigns/:id/participants-bulk ========= */

  app.post('/api/campaigns/:id/participants-bulk', { preHandler: [requireUser, validate(ParticipantsBulkSchema)] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const { contactIds, bdAccountId } = request.body as z.infer<typeof ParticipantsBulkSchema>;

    const campaign = await db.read.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!campaign.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    if (contactIds.length === 0) return { added: 0 };

    let added = 0;
    const batchSize = 1000;
    const maxRes = await db.read.query(
      'SELECT COALESCE(MAX(enqueue_order), -1)::int AS m FROM campaign_participants WHERE campaign_id = $1',
      [id],
    );
    let enqueueBase = Number((maxRes.rows[0] as { m?: number })?.m ?? -1);

    for (let i = 0; i < contactIds.length; i += batchSize) {
      const batch = contactIds.slice(i, i + batchSize);

      const values: string[] = [];
      const params: unknown[] = [id];
      let pIdx = 2;

      for (const cid of batch) {
        enqueueBase += 1;
        values.push(`($1, $${pIdx}, $${pIdx + 1}, 'pending', $${pIdx + 2}, NOW(), NOW())`);
        params.push(cid, bdAccountId || null, enqueueBase);
        pIdx += 3;
      }

      const insertQuery = `
        INSERT INTO campaign_participants (campaign_id, contact_id, bd_account_id, status, enqueue_order, created_at, updated_at)
        VALUES ${values.join(', ')}
        ON CONFLICT (campaign_id, contact_id) DO NOTHING
      `;

      const result = await db.write.query(insertQuery, params);
      added += result.rowCount || 0;
    }

    return { added };
  });
}
