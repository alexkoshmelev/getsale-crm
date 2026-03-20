import { Router } from 'express';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, validate, ServiceHttpClient } from '@getsale/service-core';
import { randomUUID } from 'crypto';
import type { RedisClient } from '@getsale/utils';

type RedisSubscriber = ReturnType<RedisClient['duplicateSubscriber']>;
import { ParseResolveSchema, ParseStartSchema } from '../validation';
import { computeParseEtaFields } from '../parse-progress-utils';

interface Deps {
  pool: Pool;
  log: Logger;
  bdAccountsClient: ServiceHttpClient;
  campaignServiceClient: ServiceHttpClient;
  redis: RedisClient | null;
}

const PARSE_PROGRESS_POLL_MS = 2000;
const PARSE_SSE_KEEPALIVE_MS = 30000;

export function parseRouter({ pool, log, bdAccountsClient, campaignServiceClient, redis }: Deps): Router {
  const router = Router();

  // POST /api/crm/parse/resolve
  router.post('/resolve', validate(ParseResolveSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { sources, bdAccountId } = req.body;

    const data = await bdAccountsClient.post<{ results: unknown[] }>(
      `/api/bd-accounts/${bdAccountId}/parse/resolve`,
      { sources },
      undefined,
      { organizationId, userId: req.user?.id }
    );
    res.json(data);
  }));

  // POST /api/crm/parse/start
  router.post('/start', validate(ParseStartSchema), asyncHandler(async (req, res) => {
    const { organizationId, id: userId } = req.user as { organizationId: string; id: string };
    const {
      sources,
      settings,
      accountIds,
      listName,
      campaignId: reqCampaignId,
      campaignName,
      channelEngagement,
    } = req.body;

    let campaignId: string | undefined = reqCampaignId;
    if (!campaignId && campaignName?.trim()) {
      try {
        const createRes = await campaignServiceClient.post<{ id: string }>('/api/campaigns', {
          name: campaignName.trim(),
        }, undefined, { organizationId, userId });
        campaignId = createRes.id;
      } catch (err: any) {
        log.warn({ message: 'Failed to create campaign for parse task', error: err?.message });
        throw new AppError(500, 'Failed to create campaign for export', ErrorCodes.INTERNAL_ERROR);
      }
    }

    const name = (listName && String(listName).trim()) || `Parse ${randomUUID().slice(0, 8)}`;
    const settingsFinal = settings ?? { depth: 'standard', excludeAdmins: true };
    // Preserve type and canGetMembers explicitly so getParseWorkList sees correct types after DB roundtrip
    const sourcesForParams = sources.map((s: { chatId: string; title: string; type: string; canGetMembers: boolean; linkedChatId?: number; [k: string]: unknown }) => ({
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
      chats: sourcesForParams.map((s: { chatId: string; title: string; type: string }) => ({
        chatId: s.chatId,
        title: s.title,
        peerType: s.type,
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

    await pool.query(
      `INSERT INTO contact_discovery_tasks (id, organization_id, created_by_user_id, name, type, status, progress, total, params, results)
       VALUES ($1, $2, $3, $4, 'parse', 'running', 0, $5, $6, '{}'::jsonb)`,
      [taskId, organizationId, userId || null, name, total, JSON.stringify(params)]
    );

    res.status(201).json({ taskId, campaignId: campaignId ?? null });
  }));

  // GET /api/crm/parse/progress/:taskId — SSE: Redis parse:progress:{taskId} + DB poll fallback
  router.get('/progress/:taskId', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { taskId } = req.params;

    const row = await pool.query(
      'SELECT id, progress, total, status, results FROM contact_discovery_tasks WHERE id = $1 AND organization_id = $2',
      [taskId, organizationId]
    );
    if (row.rows.length === 0) {
      throw new AppError(404, 'Task not found', ErrorCodes.NOT_FOUND);
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();

    const send = (event: Record<string, unknown>) => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };

    const stageByStatus: Record<string, string> = {
      running: 'fetching_members',
      paused: 'paused',
      completed: 'done',
      failed: 'error',
      stopped: 'done',
      pending: 'resolving',
    };

    const poll = async () => {
      try {
        const r = await pool.query(
          'SELECT progress, total, status, results FROM contact_discovery_tasks WHERE id = $1 AND organization_id = $2',
          [taskId, organizationId]
        );
        if (r.rows.length === 0) return;
        const t = r.rows[0];
        const total = Number(t.total) || 1;
        const progress = Number(t.progress) || 0;
        const percent = Math.min(100, Math.round((progress / total) * 100));
        const results = (t.results as Record<string, unknown>) || {};
        const parsed = Number(results.parsed) || 0;
        const parseStartedAtMs =
          typeof results.parseStartedAtMs === 'number' ? results.parseStartedAtMs : undefined;

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
          ...computeParseEtaFields({
            parseStartedAtMs,
            chatsCompleted: progress,
            totalChats: total,
            found: parsed,
          }),
        });
      } catch (err: unknown) {
        log.warn({ message: 'Parse progress poll error', taskId, error: String(err) });
      }
    };

    const progressChannel = `parse:progress:${taskId}`;
    let sub: RedisSubscriber | null = null;
    if (redis) {
      try {
        sub = redis.duplicateSubscriber();
        await sub.subscribe(progressChannel);
        sub.on('message', (_channel: string, message: string) => {
          try {
            const ev = JSON.parse(message) as Record<string, unknown>;
            send(ev);
          } catch {
            // ignore malformed payloads
          }
        });
      } catch (e) {
        log.warn({
          message: 'Parse SSE: Redis subscribe failed, using DB poll only',
          taskId,
          error: String(e),
        });
        try {
          sub?.disconnect();
        } catch {
          /* noop */
        }
        sub = null;
      }
    }

    await poll();
    const interval = setInterval(poll, PARSE_PROGRESS_POLL_MS);
    const keepalive = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch (e) {
        if (!res.writableEnded) log.warn({ message: 'Parse SSE keepalive write failed', taskId, error: String(e) });
      }
    }, PARSE_SSE_KEEPALIVE_MS);

    req.on('close', () => {
      clearInterval(interval);
      clearInterval(keepalive);
      if (sub) {
        sub.unsubscribe(progressChannel).catch(() => {});
        sub.disconnect();
        sub = null;
      }
      try {
        if (!res.writableEnded) res.end();
      } catch (e) {
        log.warn({ message: 'Parse SSE end failed on close', taskId, error: String(e) });
      }
    });
  }));

  // POST /api/crm/parse/pause/:taskId
  router.post('/pause/:taskId', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { taskId } = req.params;

    const task = await pool.query(
      'SELECT id, status FROM contact_discovery_tasks WHERE id = $1 AND organization_id = $2',
      [taskId, organizationId]
    );
    if (task.rows.length === 0) {
      throw new AppError(404, 'Task not found', ErrorCodes.NOT_FOUND);
    }
    if (task.rows[0].status !== 'running') {
      throw new AppError(400, `Cannot pause task in status ${task.rows[0].status}`, ErrorCodes.BAD_REQUEST);
    }

    await pool.query(
      'UPDATE contact_discovery_tasks SET status = $1, updated_at = NOW() WHERE id = $2',
      ['paused', taskId]
    );
    res.json({ taskId, status: 'paused' });
  }));

  // POST /api/crm/parse/stop/:taskId
  router.post('/stop/:taskId', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { taskId } = req.params;

    const task = await pool.query(
      'SELECT id, status FROM contact_discovery_tasks WHERE id = $1 AND organization_id = $2',
      [taskId, organizationId]
    );
    if (task.rows.length === 0) {
      throw new AppError(404, 'Task not found', ErrorCodes.NOT_FOUND);
    }
    const status = task.rows[0].status;
    if (status !== 'running' && status !== 'paused' && status !== 'pending') {
      throw new AppError(400, `Cannot stop task in status ${status}`, ErrorCodes.BAD_REQUEST);
    }

    await pool.query(
      'UPDATE contact_discovery_tasks SET status = $1, updated_at = NOW() WHERE id = $2',
      ['stopped', taskId]
    );
    res.json({ taskId, status: 'stopped' });
  }));

  // GET /api/crm/parse/result/:taskId
  router.get('/result/:taskId', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { taskId } = req.params;

    const row = await pool.query(
      `SELECT id, name, type, status, progress, total, params, results, created_at, updated_at
       FROM contact_discovery_tasks WHERE id = $1 AND organization_id = $2`,
      [taskId, organizationId]
    );
    if (row.rows.length === 0) {
      throw new AppError(404, 'Task not found', ErrorCodes.NOT_FOUND);
    }

    const task = row.rows[0];
    const results = (task.results as Record<string, unknown>) || {};
    res.json({
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
    });
  }));

  return router;
}
