import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { EventType, type Event } from '@getsale/events';
import { AppError, ErrorCodes, requireUser } from '@getsale/service-framework';
import type { CoreDeps } from '../types';

// ─── Validation Schemas ────────────────────────────────────────────────────

const ListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

const DiscoverySearchParamsSchema = z
  .object({
    bdAccountId: z.string().uuid().optional(),
    accountIds: z.array(z.string().uuid()).min(1).max(10).optional(),
    queries: z.array(z.string().min(1).max(512)).min(1).max(100),
    searchType: z.enum(['groups', 'channels', 'all']).optional(),
    limitPerQuery: z.number().int().min(1).max(100).optional(),
  })
  .superRefine((p, ctx) => {
    if (!p.bdAccountId && !(Array.isArray(p.accountIds) && p.accountIds.length > 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide bdAccountId and/or accountIds', path: ['bdAccountId'] });
    }
  });

const DiscoveryParseChatItemSchema = z.object({
  chatId: z.string().min(1).max(512),
  title: z.string().max(512).optional(),
  peerType: z.string().max(64).optional(),
});

const DiscoveryParseSourceItemSchema = z.object({
  chatId: z.string().max(128).optional(),
  linkedChatId: z.union([z.number(), z.string().transform((s) => Number(s))]).optional(),
  title: z.string().max(512).optional(),
  type: z.string().max(32).optional(),
  canGetMembers: z.boolean().optional(),
});

const DiscoveryParseParamsSchema = z
  .object({
    bdAccountId: z.string().uuid().optional(),
    accountIds: z.array(z.string().uuid()).min(1).max(10).optional(),
    chats: z.array(DiscoveryParseChatItemSchema).max(200).optional(),
    sources: z.array(DiscoveryParseSourceItemSchema).max(200).optional(),
    parseMode: z.string().max(32).optional(),
    postDepth: z.number().int().min(1).max(2000).optional(),
    excludeAdmins: z.boolean().optional(),
    leaveAfter: z.boolean().optional(),
    campaignId: z.string().uuid().optional(),
    campaignName: z.string().max(255).optional(),
    channelEngagement: z.enum(['default', 'reactions']).optional(),
  })
  .superRefine((p, ctx) => {
    if (!p.bdAccountId && !(Array.isArray(p.accountIds) && p.accountIds.length > 0)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide bdAccountId and/or accountIds', path: ['bdAccountId'] });
    }
    if (!(p.chats?.length) && !(p.sources?.length)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide non-empty chats or sources', path: ['chats'] });
    }
  });

const DiscoveryTaskCreateSchema = z.discriminatedUnion('type', [
  z.object({
    name: z.string().min(1).max(255).trim(),
    type: z.literal('search'),
    params: DiscoverySearchParamsSchema,
  }),
  z.object({
    name: z.string().min(1).max(255).trim(),
    type: z.literal('parse'),
    params: DiscoveryParseParamsSchema,
  }),
]);

const DiscoveryTaskActionSchema = z.object({
  action: z.enum(['start', 'pause', 'stop']),
});

const ParseResolveSchema = z.object({
  sources: z.array(z.string().min(1)).min(1).max(20),
  bdAccountId: z.string().uuid(),
});

const ResolvedSourceSchema = z.object({
  input: z.string(),
  type: z.enum(['channel', 'public_group', 'private_group', 'comment_group', 'unknown']),
  title: z.string(),
  username: z.string().optional(),
  chatId: z.string(),
  membersCount: z.number().optional(),
  linkedChatId: z.union([z.number(), z.string().transform((s) => Number(s))]).optional(),
  canGetMembers: z.boolean(),
  canGetMessages: z.boolean(),
});

const ParseSettingsSchema = z.object({
  depth: z.enum(['fast', 'standard', 'deep']).default('standard'),
  excludeAdmins: z.boolean().default(true),
  maxMessages: z.number().optional(),
  maxMembers: z.number().optional(),
});

const ParseStartSchema = z.object({
  sources: z.array(ResolvedSourceSchema).min(1).max(50),
  settings: ParseSettingsSchema.optional(),
  accountIds: z.array(z.string().uuid()).min(1).max(10),
  listName: z.string().max(255).optional(),
  campaignId: z.string().uuid().optional(),
  campaignName: z.string().max(255).optional(),
  channelEngagement: z.enum(['default', 'reactions']).optional(),
});

// ─── Helpers ───────────────────────────────────────────────────────────────

const TASK_COLUMNS = 'id, name, type, status, progress, total, params, results, created_at, updated_at';

function computeTotal(type: string, params: Record<string, unknown>): number {
  if (type === 'search' && Array.isArray(params.queries)) return params.queries.length;
  if (type === 'parse') {
    if (Array.isArray(params.chats) && params.chats.length > 0) return params.chats.length;
    if (Array.isArray(params.sources) && params.sources.length > 0) return params.sources.length;
  }
  return 0;
}

// ─── Route Registration ────────────────────────────────────────────────────

export function registerDiscoveryRoutes(app: FastifyInstance, deps: CoreDeps): void {
  const { db, rabbitmq, log, redis } = deps;

  // ── Discovery Tasks CRUD ───────────────────────────────────────────────

  app.get('/api/crm/discovery-tasks', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { limit, offset } = ListQuerySchema.parse(request.query);

    const [dataResult, countResult] = await Promise.all([
      db.read.query(
        `SELECT ${TASK_COLUMNS} FROM contact_discovery_tasks
         WHERE organization_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
        [user.organizationId, limit, offset],
      ),
      db.read.query(
        'SELECT COUNT(*) FROM contact_discovery_tasks WHERE organization_id = $1',
        [user.organizationId],
      ),
    ]);

    return {
      tasks: dataResult.rows,
      total: parseInt(countResult.rows[0].count, 10),
      limit,
      offset,
    };
  });

  app.get('/api/crm/discovery-tasks/:id', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const result = await db.read.query(
      `SELECT ${TASK_COLUMNS} FROM contact_discovery_tasks WHERE id = $1 AND organization_id = $2`,
      [id, user.organizationId],
    );
    if (!result.rows.length) throw new AppError(404, 'Task not found', ErrorCodes.NOT_FOUND);
    return result.rows[0];
  });

  app.post('/api/crm/discovery-tasks', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const body = DiscoveryTaskCreateSchema.parse(request.body);
    const { name, type, params } = body;

    let finalParams: Record<string, unknown> = { ...params };

    if (type === 'parse' && params.campaignName && !params.campaignId) {
      try {
        const campResult = await db.write.query(
          `INSERT INTO campaigns (organization_id, name, status, created_by_user_id) VALUES ($1, $2, 'draft', $3) RETURNING id`,
          [user.organizationId, params.campaignName, user.id],
        );
        finalParams.campaignId = campResult.rows[0].id;
        delete finalParams.campaignName;
      } catch (err) {
        log.warn({ message: 'Failed to create campaign for discovery task', error: String(err) });
        throw new AppError(500, 'Failed to create campaign for export', ErrorCodes.INTERNAL_ERROR);
      }
    }

    const total = computeTotal(type, finalParams);
    const taskId = randomUUID();

    const result = await db.write.query(
      `INSERT INTO contact_discovery_tasks (id, organization_id, created_by_user_id, name, type, status, progress, total, params, results)
       VALUES ($1, $2, $3, $4, $5, 'pending', 0, $6, $7, '{}'::jsonb)
       RETURNING ${TASK_COLUMNS}`,
      [taskId, user.organizationId, user.id, name, type, total, JSON.stringify(finalParams)],
    );

    reply.code(201);
    return result.rows[0];
  });

  app.post('/api/crm/discovery-tasks/:id/action', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const { action } = DiscoveryTaskActionSchema.parse(request.body);

    const task = await db.read.query(
      'SELECT id, name, status FROM contact_discovery_tasks WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!task.rows.length) throw new AppError(404, 'Task not found', ErrorCodes.NOT_FOUND);

    const currentStatus: string = task.rows[0].status;
    let newStatus: string;

    if (action === 'start') {
      if (currentStatus === 'pending' || currentStatus === 'paused' || currentStatus === 'failed') {
        newStatus = 'running';
      } else {
        throw new AppError(400, `Cannot start task in status ${currentStatus}`, ErrorCodes.BAD_REQUEST);
      }
    } else if (action === 'pause') {
      if (currentStatus === 'running') {
        newStatus = 'paused';
      } else if (currentStatus === 'completed' || currentStatus === 'stopped' || currentStatus === 'failed') {
        return { id, status: currentStatus, updated_at: new Date() };
      } else {
        throw new AppError(400, `Cannot pause task in status ${currentStatus}`, ErrorCodes.BAD_REQUEST);
      }
    } else {
      if (currentStatus === 'running' || currentStatus === 'paused' || currentStatus === 'pending') {
        newStatus = 'stopped';
      } else if (currentStatus === 'completed' || currentStatus === 'stopped' || currentStatus === 'failed') {
        return { id, status: currentStatus, updated_at: new Date() };
      } else {
        throw new AppError(400, `Cannot stop task in status ${currentStatus}`, ErrorCodes.BAD_REQUEST);
      }
    }

    const updated = await db.write.query(
      `UPDATE contact_discovery_tasks
       SET status = $1, created_by_user_id = COALESCE(created_by_user_id, $3), updated_at = NOW()
       WHERE id = $2
       RETURNING id, status, updated_at`,
      [newStatus, id, user.id],
    );

    if (action === 'start') {
      rabbitmq.publishEvent({
        id: randomUUID(),
        type: EventType.DISCOVERY_TASK_STARTED,
        timestamp: new Date(),
        organizationId: user.organizationId,
        userId: user.id,
        data: { taskId: id, name: task.rows[0].name },
      } as unknown as Event).catch((err) => {
        log.warn({ message: 'Failed to publish DISCOVERY_TASK_STARTED', taskId: id, error: String(err) });
      });
    }

    return updated.rows[0];
  });

  // ── Parse Routes ───────────────────────────────────────────────────────

  app.post('/api/crm/parse/resolve', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { sources, bdAccountId } = ParseResolveSchema.parse(request.body);

    const TSM_BASE = process.env.TELEGRAM_SERVICE_URL || 'http://telegram-sm:4005';
    const INTERNAL_AUTH = process.env.INTERNAL_AUTH_SECRET || '';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'x-organization-id': user.organizationId,
      'x-user-id': user.id,
      'x-user-role': user.role ?? 'member',
    };
    if (INTERNAL_AUTH) headers['x-internal-auth'] = INTERNAL_AUTH;

    const tsmResp = await fetch(
      `${TSM_BASE}/api/bd-accounts/${bdAccountId}/resolve-chats`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({ inputs: sources }),
        signal: AbortSignal.timeout(30_000),
      },
    );

    if (!tsmResp.ok) {
      const text = await tsmResp.text().catch(() => '');
      log.warn({ message: `parse/resolve: TSM call failed (${tsmResp.status})`, error: text });
      throw new AppError(502, 'Failed to resolve sources via Telegram', ErrorCodes.INTERNAL_ERROR);
    }

    const tsmData = (await tsmResp.json()) as {
      results: Array<{
        input: string;
        resolved: boolean;
        id?: string;
        type?: string;
        username?: string | null;
        title?: string | null;
        error?: string;
      }>;
    };

    type SourceType = 'channel' | 'public_group' | 'private_group' | 'comment_group' | 'unknown';
    const mapType = (t?: string, entity?: any): SourceType => {
      if (t === 'channel') return 'channel';
      if (t === 'group') return 'public_group';
      return 'unknown';
    };

    const results = tsmData.results.map((r) => ({
      input: r.input,
      type: mapType(r.type),
      title: r.title || r.input,
      username: r.username || undefined,
      chatId: r.id || '',
      membersCount: undefined as number | undefined,
      linkedChatId: undefined as number | undefined,
      canGetMembers: r.type === 'group',
      canGetMessages: r.resolved && r.type !== 'user',
      error: r.resolved ? undefined : (r.error || 'Could not resolve'),
    }));

    return { results };
  });

  app.post('/api/crm/parse/start', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const body = ParseStartSchema.parse(request.body);
    const {
      sources, settings, accountIds,
      listName, campaignId: reqCampaignId, campaignName,
      channelEngagement,
    } = body;

    let campaignId: string | undefined = reqCampaignId;
    if (!campaignId && campaignName?.trim()) {
      try {
        const campResult = await db.write.query(
          `INSERT INTO campaigns (organization_id, name, status, created_by_user_id) VALUES ($1, $2, 'draft', $3) RETURNING id`,
          [user.organizationId, campaignName.trim(), user.id],
        );
        campaignId = campResult.rows[0].id;
      } catch (err) {
        log.warn({ message: 'Failed to create campaign for parse task', error: String(err) });
        throw new AppError(500, 'Failed to create campaign for export', ErrorCodes.INTERNAL_ERROR);
      }
    }

    const name = (listName && String(listName).trim()) || `Parse ${randomUUID().slice(0, 8)}`;
    const settingsFinal = settings ?? { depth: 'standard', excludeAdmins: true };

    const sourcesForParams = sources.map((s) => ({
      ...s,
      type: String(s.type ?? 'unknown'),
      canGetMembers: Boolean(s.canGetMembers),
      chatId: String(s.chatId ?? ''),
      title: String(s.title ?? ''),
      linkedChatId: s.linkedChatId != null ? Number(s.linkedChatId) : undefined,
    }));

    const params: Record<string, unknown> = {
      sources: sourcesForParams,
      settings: settingsFinal,
      accountIds,
      listName: listName?.trim() || name,
      chats: sourcesForParams.map((s) => ({
        chatId: s.chatId,
        title: s.title,
        peerType: s.type,
        username: (s as any).username || undefined,
      })),
      bdAccountId: accountIds[0],
      excludeAdmins: settingsFinal.excludeAdmins,
      parseMode: 'all',
      postDepth: 100,
      ...(campaignId ? { campaignId } : {}),
      ...(channelEngagement ? { channelEngagement } : {}),
    };

    const total = sources.length;
    const taskId = randomUUID();

    await db.write.query(
      `INSERT INTO contact_discovery_tasks (id, organization_id, created_by_user_id, name, type, status, progress, total, params, results)
       VALUES ($1, $2, $3, $4, 'parse', 'running', 0, $5, $6, '{}'::jsonb)`,
      [taskId, user.organizationId, user.id, name, total, JSON.stringify(params)],
    );

    rabbitmq.publishEvent({
      id: randomUUID(),
      type: EventType.DISCOVERY_TASK_STARTED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { taskId, name },
    } as unknown as Event).catch((err) => {
      log.warn({ message: 'Failed to publish DISCOVERY_TASK_STARTED for parse', taskId, error: String(err) });
    });

    reply.code(201);
    return { taskId, campaignId: campaignId ?? null };
  });

  app.post('/api/crm/parse/pause/:taskId', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { taskId } = request.params as { taskId: string };

    const task = await db.read.query(
      'SELECT id, status FROM contact_discovery_tasks WHERE id = $1 AND organization_id = $2',
      [taskId, user.organizationId],
    );
    if (!task.rows.length) throw new AppError(404, 'Task not found', ErrorCodes.NOT_FOUND);
    const currentStatus: string = task.rows[0].status;
    if (currentStatus === 'completed' || currentStatus === 'stopped' || currentStatus === 'failed') {
      return { taskId, status: currentStatus };
    }
    if (currentStatus !== 'running') {
      throw new AppError(400, `Cannot pause task in status ${currentStatus}`, ErrorCodes.BAD_REQUEST);
    }

    await db.write.query(
      'UPDATE contact_discovery_tasks SET status = $1, updated_at = NOW() WHERE id = $2',
      ['paused', taskId],
    );

    return { taskId, status: 'paused' };
  });

  app.post('/api/crm/parse/stop/:taskId', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { taskId } = request.params as { taskId: string };

    const task = await db.read.query(
      'SELECT id, status FROM contact_discovery_tasks WHERE id = $1 AND organization_id = $2',
      [taskId, user.organizationId],
    );
    if (!task.rows.length) throw new AppError(404, 'Task not found', ErrorCodes.NOT_FOUND);

    const status: string = task.rows[0].status;
    if (status === 'completed' || status === 'stopped' || status === 'failed') {
      return { taskId, status };
    }
    if (status !== 'running' && status !== 'paused' && status !== 'pending') {
      throw new AppError(400, `Cannot stop task in status ${status}`, ErrorCodes.BAD_REQUEST);
    }

    await db.write.query(
      'UPDATE contact_discovery_tasks SET status = $1, updated_at = NOW() WHERE id = $2',
      ['stopped', taskId],
    );

    return { taskId, status: 'stopped' };
  });

  // GET /api/crm/parse/progress/:taskId — SSE with Redis pub/sub + DB poll fallback
  app.get('/api/crm/parse/progress/:taskId', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const { taskId } = request.params as { taskId: string };

    const row = await db.read.query(
      'SELECT id, progress, total, status, results FROM contact_discovery_tasks WHERE id = $1 AND organization_id = $2',
      [taskId, user.organizationId],
    );
    if (!row.rows.length) throw new AppError(404, 'Task not found', ErrorCodes.NOT_FOUND);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const send = (event: Record<string, unknown>) => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const stageByStatus: Record<string, string> = {
      running: 'fetching_members',
      paused: 'paused',
      completed: 'done',
      failed: 'error',
      stopped: 'done',
      pending: 'resolving',
    };

    const computeEta = (args: { parseStartedAtMs?: number; chatsCompleted: number; totalChats: number; found: number }) => {
      const { parseStartedAtMs, chatsCompleted, totalChats, found } = args;
      if (!parseStartedAtMs || chatsCompleted <= 0) return {};
      const elapsedMs = Date.now() - parseStartedAtMs;
      const avgMsPerChat = elapsedMs / chatsCompleted;
      const remaining = totalChats - chatsCompleted;
      const etaMs = Math.round(remaining * avgMsPerChat);
      const avgPerChat = Math.round(found / chatsCompleted);
      const estimatedTotal = avgPerChat * totalChats;
      return { etaMs, estimatedTotal, avgMsPerChat: Math.round(avgMsPerChat) };
    };

    const poll = async () => {
      try {
        const r = await db.read.query(
          'SELECT progress, total, status, results FROM contact_discovery_tasks WHERE id = $1 AND organization_id = $2',
          [taskId, user.organizationId],
        );
        if (!r.rows.length) return;
        const t = r.rows[0];
        const total = Number(t.total) || 1;
        const progress = Number(t.progress) || 0;
        const percent = Math.min(100, Math.round((progress / total) * 100));
        const results = (t.results as Record<string, unknown>) || {};
        const parsed = Number(results.parsed) || 0;
        const parseStartedAtMs = typeof results.parseStartedAtMs === 'number' ? results.parseStartedAtMs : undefined;

        send({
          taskId,
          stage: stageByStatus[t.status] || 'fetching_members',
          stageLabel: t.status === 'running' ? 'Сбор участников...' : t.status === 'completed' ? 'Завершено' : t.status,
          percent,
          found: parsed,
          estimated: total,
          progress,
          total,
          status: t.status,
          ...computeEta({ parseStartedAtMs, chatsCompleted: progress, totalChats: total, found: parsed }),
        });
      } catch (err: unknown) {
        log.warn({ message: 'Parse progress poll error', taskId, error: String(err) });
      }
    };

    const POLL_MS = 2000;
    const KEEPALIVE_MS = 30000;
    const progressChannel = `parse:progress:${taskId}`;
    let sub: ReturnType<typeof redis.duplicateSubscriber> | null = null;

    try {
      sub = redis.duplicateSubscriber();
      await sub.subscribe(progressChannel);
      sub.on('message', (_channel: string, message: string) => {
        try {
          send(JSON.parse(message));
        } catch {
          // ignore malformed
        }
      });
    } catch (e) {
      log.warn({ message: 'Parse SSE: Redis subscribe failed, using DB poll only', taskId, error: String(e) });
      try { sub?.disconnect(); } catch { /* noop */ }
      sub = null;
    }

    await poll();
    const interval = setInterval(poll, POLL_MS);
    const keepalive = setInterval(() => {
      try { reply.raw.write(': keepalive\n\n'); } catch { /* noop */ }
    }, KEEPALIVE_MS);

    request.raw.on('close', () => {
      clearInterval(interval);
      clearInterval(keepalive);
      if (sub) {
        sub.unsubscribe(progressChannel).catch(() => {});
        sub.disconnect();
        sub = null;
      }
      try { if (!reply.raw.writableEnded) reply.raw.end(); } catch { /* noop */ }
    });
  });

  app.get('/api/crm/parse/result/:taskId', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { taskId } = request.params as { taskId: string };

    const row = await db.read.query(
      `SELECT ${TASK_COLUMNS} FROM contact_discovery_tasks WHERE id = $1 AND organization_id = $2`,
      [taskId, user.organizationId],
    );
    if (!row.rows.length) throw new AppError(404, 'Task not found', ErrorCodes.NOT_FOUND);

    const task = row.rows[0];
    const results = (task.results as Record<string, unknown>) || {};

    return {
      taskId: task.id,
      name: task.name,
      status: task.status,
      progress: task.progress,
      total: task.total,
      parsed: results.parsed ?? 0,
      results: task.results,
      params: task.params,
      created_at: task.created_at,
      updated_at: task.updated_at,
    };
  });
}
