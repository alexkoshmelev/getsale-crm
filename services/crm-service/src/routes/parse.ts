import { Router } from 'express';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, validate, ServiceHttpClient } from '@getsale/service-core';
import { randomUUID } from 'crypto';
import { RedisClient } from '@getsale/utils';
import { ParseResolveSchema, ParseStartSchema } from '../validation';

interface Deps {
  pool: Pool;
  log: Logger;
  bdAccountsClient: ServiceHttpClient;
  redis: RedisClient | null;
}

const PARSE_PROGRESS_POLL_MS = 2000;
const PARSE_SSE_KEEPALIVE_MS = 30000;

export function parseRouter({ pool, log, bdAccountsClient, redis }: Deps): Router {
  const router = Router();

  // POST /api/crm/parse/resolve
  router.post('/resolve', validate(ParseResolveSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { sources, bdAccountId } = req.body;

    const data = await bdAccountsClient.post<{ results: unknown[] }>(
      `/api/bd-accounts/${bdAccountId}/parse/resolve`,
      { sources },
      { 'x-organization-id': organizationId }
    );
    res.json(data);
  }));

  // POST /api/crm/parse/start
  router.post('/start', validate(ParseStartSchema), asyncHandler(async (req, res) => {
    const { organizationId, id: userId } = req.user as { organizationId: string; id: string };
    const { sources, settings, accountIds, listName } = req.body;

    const name = (listName && String(listName).trim()) || `Parse ${randomUUID().slice(0, 8)}`;
    const settingsFinal = settings ?? { depth: 'standard', excludeAdmins: true };
    const params = {
      sources,
      settings: settingsFinal,
      accountIds,
      listName: listName?.trim() || name,
      // backward compatibility for discovery-loop until it uses sources/strategy
      chats: sources.map((s: { chatId: string; title: string; type: string }) => ({
        chatId: s.chatId,
        title: s.title,
        peerType: s.type,
      })),
      bdAccountId: accountIds[0],
      excludeAdmins: settingsFinal.excludeAdmins,
      parseMode: 'all',
      postDepth: 100,
    };
    const total = sources.length;
    const taskId = randomUUID();

    await pool.query(
      `INSERT INTO contact_discovery_tasks (id, organization_id, created_by_user_id, name, type, status, progress, total, params, results)
       VALUES ($1, $2, $3, $4, 'parse', 'running', 0, $5, $6, '{}'::jsonb)`,
      [taskId, organizationId, userId || null, name, total, JSON.stringify(params)]
    );

    res.status(201).json({ taskId });
  }));

  // GET /api/crm/parse/progress/:taskId — SSE stream (polls DB)
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
        });
      } catch (err: unknown) {
        log.warn({ message: 'Parse progress poll error', taskId, error: String(err) });
      }
    };

    await poll();
    const interval = setInterval(poll, PARSE_PROGRESS_POLL_MS);
    const keepalive = setInterval(() => {
      try {
        res.write(': keepalive\n\n');
      } catch (_) {}
    }, PARSE_SSE_KEEPALIVE_MS);

    req.on('close', () => {
      clearInterval(interval);
      clearInterval(keepalive);
      try {
        res.end();
      } catch (_) {}
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
