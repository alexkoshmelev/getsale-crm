import { Router } from 'express';
import { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes } from '@getsale/service-core';

/** Internal API for other services (e.g. messaging). Requires X-Organization-Id and internal auth. */

export interface InternalSyncChatRow {
  telegram_chat_id: string;
  title: string | null;
  peer_type: string;
  history_exhausted: boolean;
  folder_id: number | null;
  folder_ids: number[];
}

export function internalBdAccountsRouter({ pool, log }: { pool: Pool; log: Logger }): Router {
  const router = Router();

  // GET /sync-chats?bdAccountId= — list sync chats for an account (tenant check via X-Organization-Id)
  router.get('/sync-chats', asyncHandler(async (req, res) => {
    const organizationId = req.headers['x-organization-id'] as string | undefined;
    if (!organizationId?.trim()) {
      throw new AppError(400, 'X-Organization-Id required', ErrorCodes.VALIDATION);
    }
    const bdAccountId = req.query.bdAccountId as string | undefined;
    if (!bdAccountId?.trim()) {
      throw new AppError(400, 'bdAccountId query required', ErrorCodes.VALIDATION);
    }

    const accountCheck = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [bdAccountId.trim(), organizationId.trim()]
    );
    if (accountCheck.rows.length === 0) {
      throw new AppError(404, 'Account not found', ErrorCodes.NOT_FOUND);
    }

    const chatsRows = await pool.query(
      `SELECT s.telegram_chat_id::text AS telegram_chat_id, s.title, s.peer_type,
              COALESCE(s.history_exhausted, false) AS history_exhausted, s.folder_id
       FROM bd_account_sync_chats s
       WHERE s.bd_account_id = $1 AND s.peer_type IN ('user', 'chat', 'channel')
       ORDER BY s.telegram_chat_id`,
      [bdAccountId.trim()]
    );
    const junctionRows = await pool.query(
      'SELECT telegram_chat_id::text, folder_id FROM bd_account_sync_chat_folders WHERE bd_account_id = $1',
      [bdAccountId.trim()]
    );
    const folderIdsByChat = new Map<string, number[]>();
    for (const r of junctionRows.rows as { telegram_chat_id: string; folder_id: number }[]) {
      const tid = String(r.telegram_chat_id);
      if (!folderIdsByChat.has(tid)) folderIdsByChat.set(tid, []);
      folderIdsByChat.get(tid)!.push(Number(r.folder_id));
    }

    const chats: InternalSyncChatRow[] = (chatsRows.rows as Array<{
      telegram_chat_id: string;
      title: string | null;
      peer_type: string;
      history_exhausted: boolean;
      folder_id: number | null;
    }>).map((row) => ({
      telegram_chat_id: row.telegram_chat_id,
      title: row.title,
      peer_type: row.peer_type,
      history_exhausted: Boolean(row.history_exhausted),
      folder_id: row.folder_id,
      folder_ids: folderIdsByChat.get(row.telegram_chat_id) ?? [],
    }));

    res.json({ chats });
  }));

  // GET /search-sync-chats?q=&limit= — search synced chats for org (messaging global search; no direct sync table read from messaging)
  router.get('/search-sync-chats', asyncHandler(async (req, res) => {
    const organizationId = req.headers['x-organization-id'] as string | undefined;
    if (!organizationId?.trim()) {
      throw new AppError(400, 'X-Organization-Id required', ErrorCodes.VALIDATION);
    }
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const limit = Math.min(Math.max(parseInt(String(req.query.limit || '5'), 10) || 5, 1), 20);
    if (!q || q.length < 2) {
      return res.json({ items: [] });
    }
    const searchPattern = `%${q.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;
    const result = await pool.query(
      `SELECT
        'telegram' AS channel,
        s.telegram_chat_id::text AS channel_id,
        s.bd_account_id,
        COALESCE(
          c.display_name,
          CASE WHEN NULLIF(TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))), '') IS NOT NULL
               AND TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))) NOT LIKE 'Telegram %%'
               THEN TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))) ELSE NULL END,
          c.username,
          NULLIF(TRIM(COALESCE(s.title, '')), ''),
          c.telegram_id::text,
          s.telegram_chat_id::text
        ) AS name
       FROM bd_account_sync_chats s
       JOIN bd_accounts a ON a.id = s.bd_account_id AND a.organization_id = $1
       LEFT JOIN LATERAL (
         SELECT m0.contact_id FROM messages m0
         WHERE m0.organization_id = a.organization_id AND m0.channel = 'telegram'
           AND m0.channel_id = s.telegram_chat_id::text AND m0.bd_account_id = s.bd_account_id
         LIMIT 1
       ) mid ON true
       LEFT JOIN contacts c ON c.id = mid.contact_id
       WHERE s.peer_type IN ('user', 'chat')
         AND (
           s.title ILIKE $2
           OR c.display_name ILIKE $2
           OR CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,'')) ILIKE $2
           OR c.username ILIKE $2
           OR c.telegram_id::text ILIKE $2
         )
       ORDER BY s.title, c.display_name NULLS LAST
       LIMIT $3`,
      [organizationId.trim(), searchPattern, limit]
    );
    res.json({ items: result.rows });
  }));

  return router;
}
