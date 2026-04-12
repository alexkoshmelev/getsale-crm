// @ts-nocheck
import type { Pool, PoolClient } from 'pg';
import type { Logger } from '@getsale/logger';
import type { RedisClient } from '@getsale/cache';
import type { DatabasePools } from '@getsale/service-framework';

const POLL_INTERVAL_MS = 5_000;
const TSM_BASE_URL = process.env.TELEGRAM_SERVICE_URL || 'http://telegram-sm:4005';
const INTERNAL_AUTH = process.env.INTERNAL_AUTH_SECRET || '';

interface DiscoveryTaskRow {
  id: string;
  type: string;
  organization_id: string;
  created_by_user_id: string | null;
  params: Record<string, unknown> | null;
  progress: number;
  total: number;
  results: Record<string, unknown> | null;
  status?: string;
}

interface DiscoveryLoopDeps {
  db: DatabasePools;
  log: Logger;
  redis: RedisClient;
}

function pushProgress(redis: RedisClient, taskId: string, payload: Record<string, unknown>): void {
  redis.raw
    .publish(`parse:progress:${taskId}`, JSON.stringify({ ...payload, taskId }))
    .catch(() => {});
}

async function tsmGet<T>(path: string, orgId: string, userId?: string): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-organization-id': orgId,
  };
  if (userId) {
    headers['x-user-id'] = userId;
    headers['x-user-role'] = 'owner';
  }
  if (INTERNAL_AUTH) headers['x-internal-auth'] = INTERNAL_AUTH;

  const resp = await fetch(`${TSM_BASE_URL}${path}`, { headers, signal: AbortSignal.timeout(60_000) });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`TSM ${path} returned ${resp.status}: ${text}`);
  }
  return resp.json() as Promise<T>;
}

export function startDiscoveryLoop(deps: DiscoveryLoopDeps): void {
  const { log } = deps;
  log.info({ message: 'Discovery loop started' });

  setInterval(() => {
    processNextTasks(deps).catch((err) => {
      log.error({ message: 'Discovery loop iteration error', error: String(err) });
    });
  }, POLL_INTERVAL_MS);
}

async function resolveUserId(db: DatabasePools, task: DiscoveryTaskRow): Promise<string> {
  if (task.created_by_user_id) return task.created_by_user_id;
  const r = await db.read.query(
    `SELECT u.id FROM users u
     JOIN organization_members om ON om.user_id = u.id
     WHERE om.organization_id = $1
     ORDER BY om.role = 'owner' DESC, om.created_at ASC
     LIMIT 1`,
    [task.organization_id],
  );
  return r.rows.length > 0 ? (r.rows[0] as { id: string }).id : 'system';
}

async function processNextTasks(deps: DiscoveryLoopDeps): Promise<void> {
  const { db, log, redis } = deps;
  const client = await db.write.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query<DiscoveryTaskRow>(
      `SELECT * FROM contact_discovery_tasks WHERE status = 'running' FOR UPDATE SKIP LOCKED LIMIT 2`,
    );
    const tasks = result.rows;

    if (tasks.length === 0) {
      await client.query('COMMIT');
      return;
    }

    for (const task of tasks) {
      try {
        const userId = await resolveUserId(db, task);
        if (task.type === 'search') {
          await processSearchTask(client, task, deps, userId);
        } else if (task.type === 'parse') {
          await processParseTask(client, task, deps, userId);
        } else {
          await client.query(
            `UPDATE contact_discovery_tasks SET status = 'failed', updated_at = NOW() WHERE id = $1`,
            [task.id],
          );
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error({ message: 'Discovery task failed', taskId: task.id, error: errMsg });
        await client.query(
          `UPDATE contact_discovery_tasks
           SET status = 'failed',
               results = jsonb_set(COALESCE(results, '{}'::jsonb), '{error}', to_jsonb($2::text)),
               updated_at = NOW()
           WHERE id = $1`,
          [task.id, errMsg],
        );
        pushProgress(redis, task.id, {
          stage: 'error',
          stageLabel: 'Ошибка',
          percent: 0,
          found: 0,
          status: 'failed',
          error: errMsg,
        });
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function processSearchTask(
  client: PoolClient,
  task: DiscoveryTaskRow,
  deps: DiscoveryLoopDeps,
  userId: string,
): Promise<void> {
  const { log, redis } = deps;
  const params = task.params || {};
  const queries = (params.queries ?? []) as string[];
  const searchType = (params.searchType as string) || 'all';
  const limitPerQuery = (params.limitPerQuery as number) || 50;
  const accountIds: string[] =
    Array.isArray(params.accountIds) && params.accountIds.length > 0
      ? params.accountIds as string[]
      : params.bdAccountId
        ? [params.bdAccountId as string]
        : [];

  if (accountIds.length === 0 || queries.length === 0) {
    await client.query(
      `UPDATE contact_discovery_tasks SET status = 'failed', updated_at = NOW() WHERE id = $1`,
      [task.id],
    );
    return;
  }

  const progress = task.progress || 0;
  if (progress >= queries.length) {
    await client.query(
      `UPDATE contact_discovery_tasks SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [task.id],
    );
    return;
  }

  const keyword = queries[progress];
  const results: Record<string, unknown> = task.results ? { ...task.results } : {};
  let currentGroups = (results.groups ?? []) as Array<Record<string, unknown>>;

  let lastErr: unknown;
  for (const bdId of accountIds) {
    try {
      const qp = new URLSearchParams({ q: keyword, type: searchType, limit: String(limitPerQuery) });
      const res = await tsmGet<Array<Record<string, unknown>>>(
        `/api/bd-accounts/${bdId}/search-groups?${qp.toString()}`,
        task.organization_id,
        userId,
      );

      const newGroups = res || [];
      const existingIds = new Set(currentGroups.map((g) => g.chatId));

      for (const g of newGroups) {
        if (!existingIds.has(String(g.chatId))) {
          currentGroups.push({
            chatId: String(g.chatId),
            title: g.title,
            peerType: g.peerType,
            membersCount: g.membersCount,
            username: g.username || undefined,
          });
        }
      }

      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      log.warn({ message: 'Search task: TSM call failed, trying next account', bdAccountId: bdId, error: String(e) });
    }
  }

  if (lastErr) throw lastErr;

  results.groups = currentGroups;
  const newProgress = progress + 1;
  const isComplete = newProgress >= queries.length;

  await client.query(
    `UPDATE contact_discovery_tasks
     SET progress = $1,
         results = $2::jsonb,
         status = $3,
         updated_at = NOW()
     WHERE id = $4`,
    [newProgress, JSON.stringify(results), isComplete ? 'completed' : 'running', task.id],
  );

  pushProgress(redis, task.id, {
    stage: isComplete ? 'done' : 'fetching_members',
    stageLabel: isComplete ? 'Завершено' : `Поиск: ${newProgress}/${queries.length}`,
    percent: Math.round((newProgress / queries.length) * 100),
    found: currentGroups.length,
    progress: newProgress,
    total: queries.length,
    status: isComplete ? 'completed' : 'running',
  });

  log.info({
    message: `Search task progress`,
    taskId: task.id,
    keyword,
    progress: newProgress,
    total: queries.length,
    groupsFound: currentGroups.length,
  });
}

// ── Parse Work Item (mirrors v1 getParseWorkList) ────────────────────────

interface ParseWorkItem {
  chatId: string;
  title: string;
  username: string;
  useMembersList: boolean;
  depth: number;
  strategy?: 'comment_replies' | 'reaction_users';
  linkedChatId?: string;
}

function getParseWorkList(params: Record<string, unknown>): ParseWorkItem[] {
  const sources = (params.sources ?? []) as Array<Record<string, unknown>>;
  const chats = (params.chats ?? []) as Array<Record<string, unknown>>;
  const settings = (params.settings || {}) as Record<string, unknown>;
  const channelEngagement = (params.channelEngagement ?? 'default') as string;

  const depthPreset = settings.depth === 'deep' ? 500 : settings.depth === 'fast' ? 100 : 200;
  const maxMessages = (typeof settings.maxMessages === 'number' ? settings.maxMessages : depthPreset) as number;

  if (Array.isArray(sources) && sources.length > 0) {
    return sources.map((s) => {
      const srcType = String(s.type ?? '');
      const linked = s.linkedChatId != null && String(s.linkedChatId).trim() !== ''
        ? String(s.linkedChatId)
        : undefined;
      const username = String(s.username || '').replace(/^@/, '').trim();

      if (srcType === 'channel' && !linked && channelEngagement === 'reactions') {
        return {
          chatId: String(s.chatId ?? ''),
          title: `${String(s.title || s.chatId || '')} (реакции)`.trim(),
          username,
          useMembersList: false,
          depth: maxMessages,
          strategy: 'reaction_users' as const,
        };
      }
      if (srcType === 'channel' && linked) {
        return {
          chatId: String(s.chatId ?? ''),
          title: `${String(s.title || s.chatId || '')} (комментарии к постам)`.trim(),
          username,
          useMembersList: false,
          depth: maxMessages,
          strategy: 'comment_replies' as const,
          linkedChatId: linked,
        };
      }

      const useDiscussionGroup = s.linkedChatId != null && s.canGetMembers === false;
      const chatId = useDiscussionGroup ? String(s.linkedChatId) : String(s.chatId ?? '');
      const title = useDiscussionGroup
        ? `${String(s.title || s.chatId)} (обсуждения)`
        : String(s.title || s.chatId || '');
      const useMembersList = useDiscussionGroup || (srcType === 'public_group' && s.canGetMembers === true);
      return { chatId, title, username, useMembersList, depth: maxMessages };
    });
  }

  if (Array.isArray(chats) && chats.length > 0) {
    return chats.map((c) => ({
      chatId: String(c.chatId),
      title: String(c.title || c.chatId),
      username: String(c.username || '').replace(/^@/, '').trim(),
      useMembersList: true,
      depth: (params.postDepth as number) ?? 100,
    }));
  }

  return [];
}

// ── TSM POST helper ──────────────────────────────────────────────────────

async function tsmPost(path: string, orgId: string, userId?: string, body?: unknown): Promise<void> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'x-organization-id': orgId,
  };
  if (userId) {
    headers['x-user-id'] = userId;
    headers['x-user-role'] = 'owner';
  }
  if (INTERNAL_AUTH) headers['x-internal-auth'] = INTERNAL_AUTH;

  const resp = await fetch(`${TSM_BASE_URL}${path}`, {
    method: 'POST',
    headers,
    body: body != null ? JSON.stringify(body) : '{}',
    signal: AbortSignal.timeout(30_000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`TSM POST ${path} returned ${resp.status}: ${text}`);
  }
}

// ── Fetch participants with strategy ─────────────────────────────────────

type ParticipantRow = Record<string, unknown>;

async function fetchParticipantsForItem(
  item: ParseWorkItem,
  bdId: string,
  orgId: string,
  userId: string,
  settings: Record<string, unknown>,
  log: Logger,
): Promise<ParticipantRow[]> {
  const excludeAdmins = Boolean(settings.excludeAdmins ?? true);
  const maxMembers = (typeof settings.maxMembers === 'number' ? settings.maxMembers : 2000) as number;
  const baseQp = new URLSearchParams();
  if (item.username) baseQp.set('username', item.username);
  if (excludeAdmins) baseQp.set('excludeAdmins', 'true');

  const chatSeg = encodeURIComponent(item.chatId);

  if (item.strategy === 'comment_replies' && item.linkedChatId) {
    const postLimit = Math.min(100, Math.max(10, Math.floor(item.depth / 5) || 30));
    const maxRepliesPerPost = Math.min(300, Math.max(50, item.depth * 2));
    baseQp.set('linkedChatId', item.linkedChatId);
    baseQp.set('postLimit', String(postLimit));
    baseQp.set('maxRepliesPerPost', String(maxRepliesPerPost));
    const res = await tsmGet<{ participants?: ParticipantRow[] }>(
      `/api/bd-accounts/${bdId}/chats/${chatSeg}/comment-participants?${baseQp.toString()}`,
      orgId, userId,
    );
    return res?.participants ?? [];
  }

  if (item.strategy === 'reaction_users') {
    const depth = Math.min(200, Math.max(20, item.depth));
    baseQp.set('depth', String(depth));
    const res = await tsmGet<{ participants?: ParticipantRow[] }>(
      `/api/bd-accounts/${bdId}/chats/${chatSeg}/reaction-participants?${baseQp.toString()}`,
      orgId, userId,
    );
    return res?.participants ?? [];
  }

  if (item.useMembersList) {
    const allParticipants: ParticipantRow[] = [];
    let offset = 0;
    const limit = 200;

    while (allParticipants.length < maxMembers) {
      const qp = new URLSearchParams(baseQp);
      qp.set('offset', String(offset));
      qp.set('limit', String(limit));
      const res = await tsmGet<{ participants?: ParticipantRow[]; nextOffset?: number | null }>(
        `/api/bd-accounts/${bdId}/chats/${chatSeg}/participants?${qp.toString()}`,
        orgId, userId,
      );
      const users = res?.participants ?? [];
      if (users.length === 0) break;
      allParticipants.push(...users);
      if (res?.nextOffset == null) break;
      offset = typeof res.nextOffset === 'number' ? res.nextOffset : offset + limit;
    }

    if (allParticipants.length === 0) {
      log.info({ message: 'Members list empty, falling back to active-participants', chatId: item.chatId });
      const depth = Math.min(2000, Math.max(1, item.depth));
      baseQp.set('depth', String(depth));
      const res = await tsmGet<{ participants?: ParticipantRow[] }>(
        `/api/bd-accounts/${bdId}/chats/${chatSeg}/active-participants?${baseQp.toString()}`,
        orgId, userId,
      );
      return res?.participants ?? [];
    }

    return allParticipants.slice(0, maxMembers);
  }

  const depth = Math.min(2000, Math.max(1, item.depth));
  baseQp.set('depth', String(depth));
  const res = await tsmGet<{ participants?: ParticipantRow[] }>(
    `/api/bd-accounts/${bdId}/chats/${chatSeg}/active-participants?${baseQp.toString()}`,
    orgId, userId,
  );
  return res?.participants ?? [];
}

// ── processParseTask (v1 parity) ─────────────────────────────────────────

async function processParseTask(
  client: PoolClient,
  task: DiscoveryTaskRow,
  deps: DiscoveryLoopDeps,
  userId: string,
): Promise<void> {
  const { db, log, redis } = deps;
  const pool = db.write;
  const params = task.params || {};
  const workList = getParseWorkList(params);
  const accountIds: string[] =
    Array.isArray(params.accountIds) && params.accountIds.length > 0
      ? params.accountIds as string[]
      : params.bdAccountId
        ? [params.bdAccountId as string]
        : [];

  const settings = (params.settings || {}) as Record<string, unknown>;
  const leaveAfter = Boolean(params.leaveAfter ?? settings.leaveAfter ?? false);
  const campaignId = params.campaignId as string | undefined;

  if (accountIds.length === 0 || workList.length === 0) {
    await client.query(
      `UPDATE contact_discovery_tasks SET status = 'failed', updated_at = NOW() WHERE id = $1`,
      [task.id],
    );
    return;
  }

  const progress = task.progress || 0;
  if (progress >= workList.length) {
    await client.query(
      `UPDATE contact_discovery_tasks SET status = 'completed', updated_at = NOW() WHERE id = $1`,
      [task.id],
    );
    return;
  }

  const item = workList[progress];
  if (!item.chatId) {
    await client.query(
      `UPDATE contact_discovery_tasks SET progress = $1, updated_at = NOW() WHERE id = $2`,
      [progress + 1, task.id],
    );
    return;
  }

  const results: Record<string, unknown> = task.results ? { ...task.results } : {};
  let parsedTotal = Number(results.parsed) || 0;
  if (!results.parseStartedAtMs) results.parseStartedAtMs = Date.now();

  let lastErr: unknown;
  let bdUsed: string | null = null;
  const contactIds: string[] = [];

  for (const bdId of accountIds) {
    try {
      const participants = await fetchParticipantsForItem(
        item, bdId, task.organization_id, userId, settings, log,
      );

      for (const p of participants) {
        const telegramId = p.userId ? String(p.userId) : p.telegram_id ? String(p.telegram_id) : p.id ? String(p.id) : null;
        if (!telegramId) continue;

        const firstName = String(p.firstName || p.first_name || '').trim() || 'Contact';
        const lastName = String(p.lastName || p.last_name || '').trim() || null;
        const username = String(p.username || '').trim() || null;
        const phone = p.phone ? String(p.phone).trim() : null;

        try {
          const existing = await pool.query(
            'SELECT id FROM contacts WHERE organization_id = $1 AND telegram_id = $2',
            [task.organization_id, telegramId],
          );
          if (existing.rows.length > 0) {
            await pool.query(
              `UPDATE contacts SET
                 first_name = COALESCE(NULLIF($1, ''), first_name),
                 last_name  = COALESCE($2, last_name),
                 username   = COALESCE($3, username),
                 phone      = COALESCE($4, phone),
                 updated_at = NOW()
               WHERE organization_id = $5 AND telegram_id = $6`,
              [firstName, lastName, username, phone, task.organization_id, telegramId],
            );
            contactIds.push(existing.rows[0].id);
          } else {
            const ins = await pool.query(
              `INSERT INTO contacts (organization_id, telegram_id, first_name, last_name, username, phone, created_at, updated_at)
               VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
               ON CONFLICT (organization_id, telegram_id) WHERE telegram_id IS NOT NULL AND trim(telegram_id) <> ''
               DO UPDATE SET
                 first_name = COALESCE(NULLIF(EXCLUDED.first_name, ''), contacts.first_name),
                 last_name  = COALESCE(EXCLUDED.last_name, contacts.last_name),
                 username   = COALESCE(EXCLUDED.username, contacts.username),
                 phone      = COALESCE(EXCLUDED.phone, contacts.phone),
                 updated_at = NOW()
               RETURNING id`,
              [task.organization_id, telegramId, firstName, lastName, username, phone],
            );
            if (ins.rows.length > 0) contactIds.push(ins.rows[0].id);
          }
          parsedTotal++;
        } catch (insertErr) {
          log.warn({ message: 'Parse: contact upsert failed', telegramId, error: String(insertErr) });
        }
      }

      bdUsed = bdId;
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      log.warn({ message: 'Parse task: TSM call failed, trying next account', bdAccountId: bdId, chatId: item.chatId, error: String(e) });
    }
  }

  if (leaveAfter && bdUsed) {
    try {
      await tsmPost(
        `/api/bd-accounts/${bdUsed}/chats/${encodeURIComponent(item.chatId)}/leave`,
        task.organization_id,
        userId,
      );
    } catch (leaveErr) {
      log.warn({ message: 'leaveAfter failed', chatId: item.chatId, error: String(leaveErr) });
    }
  }

  if (campaignId && contactIds.length > 0) {
    try {
      const CAMPAIGN_BASE = process.env.CAMPAIGN_SERVICE_URL || 'http://campaign-orchestrator:4003';
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'x-organization-id': task.organization_id,
      };
      if (userId) {
        headers['x-user-id'] = userId;
        headers['x-user-role'] = 'owner';
      }
      if (INTERNAL_AUTH) headers['x-internal-auth'] = INTERNAL_AUTH;
      await fetch(`${CAMPAIGN_BASE}/api/campaigns/${campaignId}/participants-bulk`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ contactIds, bdAccountId: bdUsed }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (campErr) {
      log.warn({ message: 'Campaign participant export failed', campaignId, error: String(campErr) });
    }
  }

  if (lastErr) {
    const errors = (results.errors ?? []) as Array<Record<string, unknown>>;
    errors.push({ chatId: item.chatId, error: String(lastErr) });
    results.errors = errors;
  }

  results.parsed = parsedTotal;
  const newProgress = progress + 1;
  const isComplete = newProgress >= workList.length;

  await client.query(
    `UPDATE contact_discovery_tasks
     SET progress = $1,
         results = $2::jsonb,
         status = $3,
         updated_at = NOW()
     WHERE id = $4`,
    [newProgress, JSON.stringify(results), isComplete ? 'completed' : 'running', task.id],
  );

  const percent = Math.round((newProgress / workList.length) * 100);
  pushProgress(redis, task.id, {
    stage: isComplete ? 'done' : 'fetching_members',
    stageLabel: isComplete ? 'Завершено' : `Сбор участников: ${newProgress}/${workList.length}`,
    percent,
    found: parsedTotal,
    progress: newProgress,
    total: workList.length,
    status: isComplete ? 'completed' : 'running',
  });

  log.info({
    message: 'Parse task progress',
    taskId: task.id,
    chatId: item.chatId,
    strategy: item.strategy ?? (item.useMembersList ? 'members' : 'active'),
    progress: newProgress,
    total: workList.length,
    parsed: parsedTotal,
  });
}
