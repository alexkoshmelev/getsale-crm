import { Pool, PoolClient } from 'pg';
import { Logger } from '@getsale/logger';
import { ServiceHttpClient } from '@getsale/service-core';
import { RedisClient } from '@getsale/utils';
import { randomUUID } from 'crypto';

/** Row from contact_discovery_tasks */
export interface DiscoveryTaskRow {
  id: string;
  type: string;
  organization_id: string;
  created_by_user_id: string | null;
  params: DiscoveryTaskParams | null;
  progress: number;
  results: DiscoveryTaskResults | null;
  status?: string;
}

export interface DiscoveryTaskParams {
  bdAccountId?: string;
  accountIds?: string[];
  queries?: string[];
  searchType?: string;
  limitPerQuery?: number;
  sources?: Array<{ chatId?: string; linkedChatId?: string; title?: string; type?: string; canGetMembers?: boolean }>;
  chats?: Array<{ chatId: string; title?: string }>;
  settings?: { depth?: string; maxMessages?: number; maxMembers?: number; excludeAdmins?: boolean };
  postDepth?: number;
  excludeAdmins?: boolean;
  leaveAfter?: boolean;
  campaignId?: string;
}

export interface DiscoveryTaskResults {
  groups?: Array<{ chatId: string; title?: string; peerType?: string; membersCount?: number }>;
  parsed?: number;
  error?: string;
  errors?: Array<{ chatId: string; error: string }>;
}

interface Deps {
  pool: Pool;
  log: Logger;
  bdAccountsClient: ServiceHttpClient;
  campaignServiceClient: ServiceHttpClient;
  redis: RedisClient | null;
}

const stageByStatus: Record<string, string> = {
  running: 'fetching_members',
  paused: 'paused',
  completed: 'done',
  failed: 'error',
  stopped: 'done',
  pending: 'resolving',
};

type RedisPublish = { publish(channel: string, message: string): Promise<void> };

function pushParseProgress(redis: RedisClient | null, userId: string | null, taskId: string, payload: Record<string, unknown>): void {
  if (!redis || !userId) return;
  const channel = `events:${userId}`;
  (redis as RedisPublish).publish(channel, JSON.stringify({ event: 'parse_progress', data: { ...payload, taskId } })).catch(() => {});
}

export function startDiscoveryLoop(deps: Deps) {
  const { log } = deps;
  log.info({ message: 'Starting discovery-loop worker' });

  // Run the loop every 5 seconds
  setInterval(() => {
    processNextTasks(deps).catch((err) => {
      log.error({ message: 'Error in discovery loop iteration', error: err?.message || String(err) });
    });
  }, 5000);
}

async function processNextTasks(deps: Deps) {
  const { pool, log, bdAccountsClient, campaignServiceClient, redis } = deps;

  // Lock up to 2 running tasks
  const client = await pool.connect();
  let tasks: DiscoveryTaskRow[] = [];
  try {
    await client.query('BEGIN');
    const result = await client.query<DiscoveryTaskRow>(`
      SELECT * FROM contact_discovery_tasks
      WHERE status = 'running'
      FOR UPDATE SKIP LOCKED
      LIMIT 2
    `);
    tasks = result.rows as DiscoveryTaskRow[];
    
    if (tasks.length === 0) {
      await client.query('COMMIT');
      return;
    }

    for (const task of tasks) {
      try {
        if (task.type === 'search') {
          await processSearchTask(client, task, deps);
        } else if (task.type === 'parse') {
          await processParseTask(client, task, deps);
        } else {
          // Unknown task type
          await client.query(`UPDATE contact_discovery_tasks SET status = 'failed' WHERE id = $1`, [task.id]);
        }
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error({ message: 'Task failed in loop', taskId: task.id, error: errMsg });
        await client.query(
          `UPDATE contact_discovery_tasks SET status = 'failed', results = jsonb_set(COALESCE(results, '{}'::jsonb), '{error}', to_jsonb($2::text)), updated_at = NOW() WHERE id = $1`,
          [task.id, errMsg]
        );
        try {
          const chats = task.params?.chats ?? [];
          pushParseProgress(redis, task.created_by_user_id, task.id, {
            stage: 'error',
            stageLabel: 'Ошибка',
            percent: 0,
            found: task.results?.parsed ?? 0,
            estimated: Array.isArray(chats) ? chats.length : 0,
            progress: task.progress ?? 0,
            total: Array.isArray(chats) ? chats.length : 0,
            status: 'failed',
            error: errMsg,
          });
        } catch (e) {
          log.warn({ message: 'Failed to push parse progress after task failure', taskId: task.id, error: String(e) });
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function processSearchTask(client: PoolClient, task: DiscoveryTaskRow, deps: Deps) {
  const { log, bdAccountsClient } = deps;
  const params = (task.params || {}) as DiscoveryTaskParams;
  const { bdAccountId, queries = [], searchType = 'all', limitPerQuery = 50 } = params;
  
  if (!bdAccountId || !Array.isArray(queries) || queries.length === 0) {
     await client.query(`UPDATE contact_discovery_tasks SET status = 'failed', updated_at = NOW() WHERE id = $1`, [task.id]);
     return;
  }

  const progress = task.progress || 0;
  if (progress >= queries.length) {
     await client.query(`UPDATE contact_discovery_tasks SET status = 'completed', updated_at = NOW() WHERE id = $1`, [task.id]);
     return;
  }

  const keyword = queries[progress];
  const results: DiscoveryTaskResults = task.results ? { ...task.results } : {};
  let currentGroups = results.groups || [];

  try {
    const queryParams = new URLSearchParams({ q: keyword, type: searchType, limit: String(limitPerQuery) });
    const res = await bdAccountsClient.get<Array<{ chatId?: string; title?: string; peerType?: string; membersCount?: number }>>(
      `/api/bd-accounts/${bdAccountId}/search-groups?${queryParams.toString()}`,
      undefined,
      { organizationId: task.organization_id, userId: task.created_by_user_id ?? undefined }
    );

    const newGroups = res || [];
    const currentIds = new Set(currentGroups.map((g) => g.chatId));
    
    for (const g of newGroups) {
       if (!currentIds.has(String(g.chatId))) {
          currentGroups.push({
             chatId: String(g.chatId),
             title: g.title,
             peerType: g.peerType,
             membersCount: g.membersCount
          });
       }
    }

    results.groups = currentGroups;
    const nextProgress = progress + 1;
    const newStatus = nextProgress >= queries.length ? 'completed' : 'running';

    await client.query(
      `UPDATE contact_discovery_tasks SET progress = $1, results = $2, status = $3, updated_at = NOW() WHERE id = $4`,
      [nextProgress, JSON.stringify(results), newStatus, task.id]
    );

  } catch (err: unknown) {
    log.warn({ message: 'Search task query failed', taskId: task.id, keyword, error: err instanceof Error ? err.message : String(err) });
    // Even if one query fails, continue to the next
    const nextProgress = progress + 1;
    const newStatus = nextProgress >= queries.length ? 'completed' : 'running';
    await client.query(
      `UPDATE contact_discovery_tasks SET progress = $1, status = $2, updated_at = NOW() WHERE id = $3`,
      [nextProgress, newStatus, task.id]
    );
  }
}

interface ParseWorkItem {
  chatId: string;
  title: string;
  useMembersList: boolean;
  depth: number;
}

/** Work item for parse: either from new sources (with type) or legacy chats */
function getParseWorkList(params: DiscoveryTaskParams): ParseWorkItem[] {
  const sources = params.sources;
  const chats = params.chats;
  const settings = params.settings || {};
  const depthPreset = settings.depth === 'deep' ? 500 : settings.depth === 'fast' ? 100 : 200;
  const maxMessages = settings.maxMessages ?? depthPreset;

  if (Array.isArray(sources) && sources.length > 0) {
    return sources.map((s) => {
      const useDiscussionGroup = s.linkedChatId != null && s.canGetMembers === false;
      const chatId = useDiscussionGroup ? String(s.linkedChatId) : String(s.chatId ?? '');
      const title = useDiscussionGroup
        ? `${String(s.title || s.chatId)} (обсуждения)`
        : String((s.title || s.chatId) ?? '');
      const useMembersList = useDiscussionGroup || (s.type === 'public_group' && s.canGetMembers === true);
      return { chatId, title, useMembersList, depth: maxMessages };
    });
  }
  if (Array.isArray(chats) && chats.length > 0) {
    return chats.map((c) => ({
      chatId: String(c.chatId),
      title: String(c.title || c.chatId),
      useMembersList: true,
      depth: params.postDepth ?? 100,
    }));
  }
  return [];
}

async function processParseTask(client: PoolClient, task: DiscoveryTaskRow, deps: Deps) {
  const { pool, log, bdAccountsClient, campaignServiceClient, redis } = deps;
  const params = (task.params || {}) as DiscoveryTaskParams;
  const workList = getParseWorkList(params);
  const accountIds = params.accountIds ?? (params.bdAccountId ? [params.bdAccountId] : []);
  const bdAccountId = accountIds[0] ?? params.bdAccountId;
  const { excludeAdmins = true, leaveAfter = false, campaignId } = params;
  const settings = params.settings || {};

  if (!bdAccountId || workList.length === 0) {
     await client.query(`UPDATE contact_discovery_tasks SET status = 'failed', updated_at = NOW() WHERE id = $1`, [task.id]);
     return;
  }

  const progress = task.progress || 0;
  if (progress >= workList.length) {
     await client.query(`UPDATE contact_discovery_tasks SET status = 'completed', updated_at = NOW() WHERE id = $1`, [task.id]);
     return;
  }

  const item = workList[progress];
  const targetChatId = item.chatId;
  const targetTitle = item.title;
  const results: DiscoveryTaskResults = task.results ? { ...task.results } : {};
  results.parsed = results.parsed || 0;

  const totalChats = workList.length;
  const pctStart = totalChats ? Math.min(100, Math.round((progress / totalChats) * 100)) : 0;
  pushParseProgress(redis, task.created_by_user_id, task.id, {
    stage: 'fetching_members',
    stageLabel: `Обработка чата ${progress + 1}/${totalChats}`,
    percent: pctStart,
    progress,
    total: totalChats,
    status: 'running',
    found: results.parsed ?? 0,
    estimated: totalChats,
  });

  interface ParticipantRow {
    telegram_id?: string;
    first_name?: string;
    last_name?: string;
    username?: string;
  }

  interface ParticipantsResponse {
    users?: ParticipantRow[];
    nextOffset?: number;
  }

  try {
    let participants: ParticipantRow[] = [];

    if (item.useMembersList) {
      let offset = 0;
      const limit = 200;
      const maxMembers = settings.maxMembers ?? 2000;
      while (participants.length < maxMembers) {
        const queryParams = new URLSearchParams({ offset: String(offset), limit: String(limit), excludeAdmins: String(excludeAdmins) });
        const res = await bdAccountsClient.get<ParticipantsResponse>(
          `/api/bd-accounts/${bdAccountId}/chats/${targetChatId}/participants?${queryParams.toString()}`,
          undefined,
          { organizationId: task.organization_id, userId: task.created_by_user_id ?? undefined }
        );
        const users = res?.users || [];
        if (users.length === 0) break;
        participants.push(...users);
        if (res?.nextOffset == null) break;
        offset = res.nextOffset;
      }
      // Fallback: if participants list returned 0 (e.g. broadcast channel), use active participants from history
      if (participants.length === 0) {
        const depth = Math.min(2000, Math.max(1, item.depth));
        const q = new URLSearchParams({ depth: String(depth), excludeAdmins: String(excludeAdmins) });
        const activeRes = await bdAccountsClient.get<ParticipantsResponse>(
          `/api/bd-accounts/${bdAccountId}/chats/${targetChatId}/active-participants?${q.toString()}`,
          undefined,
          { organizationId: task.organization_id, userId: task.created_by_user_id ?? undefined }
        );
        participants.push(...(activeRes?.users || []));
      }
    } else {
      const depth = Math.min(2000, Math.max(1, item.depth));
      const queryParams = new URLSearchParams({ depth: String(depth), excludeAdmins: String(excludeAdmins) });
      const res = await bdAccountsClient.get<ParticipantsResponse>(
        `/api/bd-accounts/${bdAccountId}/chats/${targetChatId}/active-participants?${queryParams.toString()}`,
        undefined,
        { organizationId: task.organization_id, userId: task.created_by_user_id ?? undefined }
      );
      participants = res?.users || [];
    }

    if (participants.length > 0) {
       const contactIds: string[] = [];
       let runningParsed = results.parsed || 0;
       const PROGRESS_UPDATE_BATCH = 50;

       for (const u of participants) {
          const telegramId = u.telegram_id;
          if (!telegramId) continue;

          let contactId: string;
          const existing = await client.query(
            'SELECT id FROM contacts WHERE organization_id = $1 AND telegram_id = $2',
            [task.organization_id, telegramId]
          );
          if (existing.rows.length > 0) {
             contactId = existing.rows[0].id;
          } else {
             contactId = randomUUID();
             await client.query(
               `INSERT INTO contacts (id, organization_id, first_name, last_name, username, telegram_id, created_at, updated_at)
                VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
               [contactId, task.organization_id, u.first_name || 'Contact', u.last_name || null, u.username || null, telegramId]
             );
          }
          contactIds.push(contactId);

          await client.query(
             `INSERT INTO contact_telegram_sources (organization_id, contact_id, bd_account_id, telegram_chat_id, telegram_chat_title)
              VALUES ($1, $2, $3, $4, $5)
              ON CONFLICT (organization_id, contact_id, bd_account_id, telegram_chat_id) DO NOTHING`,
             [task.organization_id, contactId, bdAccountId, targetChatId, targetTitle]
          );

          runningParsed++;
          if (runningParsed % PROGRESS_UPDATE_BATCH === 0) {
             await client.query('COMMIT');
             await client.query(
               'UPDATE contact_discovery_tasks SET results = jsonb_set(COALESCE(results, \'{}\'::jsonb), \'{parsed}\', to_jsonb($1::int)), updated_at = NOW() WHERE id = $2',
               [runningParsed, task.id]
             );
             await client.query('BEGIN');
             const totalChats = workList.length;
             const pct = totalChats ? Math.min(100, Math.round((progress / totalChats) * 100)) : 0;
             pushParseProgress(redis, task.created_by_user_id, task.id, {
               stage: stageByStatus.running,
               stageLabel: 'Сбор участников...',
               percent: pct,
               found: runningParsed,
               estimated: totalChats,
               progress,
               total: totalChats,
               status: 'running',
             });
          }
       }

       await client.query('COMMIT');
       await client.query('BEGIN');

       results.parsed = runningParsed;

       // Export to campaign if requested
       if (campaignId && contactIds.length > 0) {
          try {
             await campaignServiceClient.post(
               `/api/campaigns/${campaignId}/participants-bulk`,
               { contactIds, bdAccountId },
               undefined,
               { organizationId: task.organization_id, userId: task.created_by_user_id ?? undefined }
             );
          } catch (campErr: unknown) {
             log.warn({ message: 'Failed to add participants to campaign', taskId: task.id, campaignId, error: campErr instanceof Error ? campErr.message : String(campErr) });
          }
       }
    }

    // Leave chat if requested
    if (leaveAfter) {
       try {
         await bdAccountsClient.post(
           `/api/bd-accounts/${bdAccountId}/chats/${targetChatId}/leave`,
           {},
           undefined,
           { organizationId: task.organization_id, userId: task.created_by_user_id ?? undefined }
         );
       } catch (leaveErr: unknown) {
         log.warn({ message: 'Failed to leave chat', taskId: task.id, targetChatId, error: leaveErr instanceof Error ? leaveErr.message : String(leaveErr) });
       }
    }

    const nextProgress = progress + 1;
    const newStatus = nextProgress >= workList.length ? 'completed' : 'running';
    const totalChats = workList.length;
    const pct = totalChats ? Math.min(100, Math.round((nextProgress / totalChats) * 100)) : 100;

    await client.query(
      `UPDATE contact_discovery_tasks SET progress = $1, results = $2, status = $3, updated_at = NOW() WHERE id = $4`,
      [nextProgress, JSON.stringify(results), newStatus, task.id]
    );

    pushParseProgress(redis, task.created_by_user_id, task.id, {
      stage: stageByStatus[newStatus] || 'fetching_members',
      stageLabel: newStatus === 'completed' ? 'Завершено' : newStatus === 'running' ? 'Сбор участников...' : newStatus,
      percent: pct,
      found: results.parsed ?? 0,
      estimated: totalChats,
      progress: nextProgress,
      total: totalChats,
      status: newStatus,
    });
    if (newStatus === 'completed') {
      const channel = task.created_by_user_id ? `events:${task.created_by_user_id}` : null;
      if (redis && channel) {
        (redis as { publish(channel: string, message: string): Promise<void> }).publish(channel, JSON.stringify({
          event: 'notification',
          data: { type: 'parse_done', taskId: task.id, status: newStatus, parsed: results.parsed ?? 0 },
        })).catch(() => {});
      }
    }

  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error({ message: 'Parse task chat failed', taskId: task.id, chatId: targetChatId, error: errMsg });
    const nextProgress = progress + 1;
    const newStatus = nextProgress >= workList.length ? 'completed' : 'running';
    results.error = errMsg;
    if (!Array.isArray(results.errors)) results.errors = [];
    results.errors.push({ chatId: targetChatId, error: errMsg });
    try {
      await client.query(
        `UPDATE contact_discovery_tasks SET progress = $1, results = $2, status = $3, updated_at = NOW() WHERE id = $4`,
        [nextProgress, JSON.stringify(results), newStatus, task.id]
      );
      const totalChats = workList.length;
      const pct = totalChats ? Math.min(100, Math.round((nextProgress / totalChats) * 100)) : 100;
      pushParseProgress(redis, task.created_by_user_id, task.id, {
        stage: stageByStatus[newStatus] || 'error',
        stageLabel: newStatus,
        percent: pct,
        found: results.parsed ?? 0,
        estimated: totalChats,
        progress: nextProgress,
        total: totalChats,
        status: newStatus,
        error: errMsg,
      });
    } catch (e: unknown) {
      log.error({ message: 'Failed to update/push on parse chat error', taskId: task.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
}
