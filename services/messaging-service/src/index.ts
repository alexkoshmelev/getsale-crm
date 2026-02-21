import express from 'express';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, MessageSentEvent, MessageDeletedEvent } from '@getsale/events';
import { MessageChannel, MessageDirection, MessageStatus } from '@getsale/types';

const app = express();
const PORT = process.env.PORT || 3003;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || `postgresql://postgres:${process.env.POSTGRES_PASSWORD || 'postgres_dev'}@localhost:5432/postgres`,
});

const rabbitmq = new RabbitMQClient(
  process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672'
);

const BD_ACCOUNTS_SERVICE_URL = process.env.BD_ACCOUNTS_SERVICE_URL || 'http://bd-accounts-service:3007';

(async () => {
  try {
    await rabbitmq.connect();
  } catch (error) {
    console.error('Failed to connect to RabbitMQ, service will continue without event publishing:', error);
  }
})();

function getUser(req: express.Request) {
  return {
    id: req.headers['x-user-id'] as string,
    organizationId: req.headers['x-organization-id'] as string,
    role: (req.headers['x-user-role'] as string) || '',
  };
}

/** Проверка права по role_permissions (owner всегда true). */
async function canPermission(pool: Pool, role: string, resource: string, action: string): Promise<boolean> {
  const roleLower = (role || '').toLowerCase();
  try {
    const r = await pool.query(
      `SELECT 1 FROM role_permissions WHERE role = $1 AND resource = $2 AND (action = $3 OR action = '*') LIMIT 1`,
      [roleLower, resource, action]
    );
    if (r.rows.length > 0) return true;
    if (roleLower === 'owner') return true;
    return false;
  } catch {
    if (roleLower === 'owner') return true;
    return false;
  }
}

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'messaging-service' });
});

// Get inbox (unread messages)
app.get('/api/messaging/inbox', async (req, res) => {
  try {
    const user = getUser(req);
    const result = await pool.query(
      `SELECT m.*, c.first_name, c.last_name, c.email
       FROM messages m
       LEFT JOIN contacts c ON m.contact_id = c.id
       WHERE m.organization_id = $1 AND m.unread = true
       ORDER BY m.created_at DESC`,
      [user.organizationId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching inbox:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get messages for a contact/channel (optionally scoped to a BD account)
// При bdAccountId + channelId: если запрошена страница, которой ещё нет в БД, догружаем из Telegram (load-older-history)
app.get('/api/messaging/messages', async (req, res) => {
  try {
    const user = getUser(req);
    const { contactId, channel, channelId, bdAccountId, page = 1, limit = 50 } = req.query;

    const pageNum = Math.max(1, parseInt(String(page), 10));
    const limitNum = Math.min(100, Math.max(1, parseInt(String(limit), 10)));
    const bdId = bdAccountId && String(bdAccountId).trim() ? String(bdAccountId).trim() : null;
    const chId = channelId && String(channelId).trim() ? String(channelId).trim() : null;

    // Если чат Telegram и в БД 0 сообщений — один раз подгрузить первую страницу из Telegram (load-older-history при 0 сообщений)
    if (bdId && chId && channel === 'telegram' && pageNum === 1) {
      const countRes = await pool.query(
        'SELECT COUNT(*) FROM messages WHERE organization_id = $1 AND channel = $2 AND channel_id = $3 AND bd_account_id = $4',
        [user.organizationId, channel || 'telegram', chId, bdId]
      );
      const totalForChat = parseInt(countRes.rows[0].count);
      if (totalForChat === 0) {
        const exhaustedRow = await pool.query(
          'SELECT history_exhausted FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
          [bdId, chId]
        );
        const exhausted = exhaustedRow.rows.length > 0 && (exhaustedRow.rows[0] as any).history_exhausted === true;
        if (!exhausted) {
          try {
            const loadRes = await fetch(
              `${BD_ACCOUNTS_SERVICE_URL}/api/bd-accounts/${bdId}/chats/${chId}/load-older-history`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-user-id': user.id || '',
                  'x-organization-id': user.organizationId || '',
                },
              }
            );
            if (loadRes.ok) {
              await loadRes.json(); // дождаться полного ответа (сохранение в БД на стороне bd-accounts уже завершено)
            }
          } catch (err) {
            console.warn('Load initial history (0 messages) request failed:', err);
          }
        }
      }
    }

    // Если нужна более старая страница и чат из Telegram — попробовать догрузить из Telegram
    if (bdId && chId && channel === 'telegram' && pageNum > 1) {
      let countResult = await pool.query(
        'SELECT COUNT(*) FROM messages WHERE organization_id = $1 AND channel = $2 AND channel_id = $3 AND bd_account_id = $4',
        [user.organizationId, channel || 'telegram', chId, bdId]
      );
      let total = parseInt(countResult.rows[0].count);
      const needOffset = (pageNum - 1) * limitNum;
      if (needOffset >= total) {
        const exhaustedRow = await pool.query(
          'SELECT history_exhausted FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
          [bdId, chId]
        );
        const exhausted = exhaustedRow.rows.length > 0 && (exhaustedRow.rows[0] as any).history_exhausted === true;
        if (!exhausted) {
          try {
            const loadRes = await fetch(
              `${BD_ACCOUNTS_SERVICE_URL}/api/bd-accounts/${bdId}/chats/${chId}/load-older-history`,
              {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-user-id': user.id || '',
                  'x-organization-id': user.organizationId || '',
                },
              }
            );
            if (loadRes.ok) {
              const data = (await loadRes.json()) as { added?: number };
              if ((data.added ?? 0) > 0) {
                countResult = await pool.query(
                  'SELECT COUNT(*) FROM messages WHERE organization_id = $1 AND channel = $2 AND channel_id = $3 AND bd_account_id = $4',
                  [user.organizationId, channel || 'telegram', chId, bdId]
                );
                total = parseInt(countResult.rows[0].count);
              }
            }
          } catch (err) {
            console.warn('Load older history request failed:', err);
          }
        }
      }
    }

    let query = 'SELECT * FROM messages WHERE organization_id = $1';
    const params: any[] = [user.organizationId];

    if (contactId) {
      query += ` AND contact_id = $${params.length + 1}`;
      params.push(contactId);
    }

    if (channel && channelId) {
      query += ` AND channel = $${params.length + 1} AND channel_id = $${params.length + 2}`;
      params.push(channel, channelId);
    }

    if (bdId) {
      query += ` AND bd_account_id = $${params.length + 1}`;
      params.push(bdId);
    }

    const offset = (pageNum - 1) * limitNum;
    query += ` ORDER BY COALESCE(telegram_date, created_at) DESC NULLS LAST LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limitNum, offset);

    const result = await pool.query(query, params);
    const rows = (result.rows as any[]).slice().reverse();

    let countQuery = 'SELECT COUNT(*) FROM messages WHERE organization_id = $1';
    const countParams: any[] = [user.organizationId];
    if (contactId) {
      countQuery += ` AND contact_id = $${countParams.length + 1}`;
      countParams.push(contactId);
    }
    if (channel && channelId) {
      countQuery += ` AND channel = $${countParams.length + 1} AND channel_id = $${countParams.length + 2}`;
      countParams.push(channel, channelId);
    }
    if (bdId) {
      countQuery += ` AND bd_account_id = $${countParams.length + 1}`;
      countParams.push(bdId);
    }
    const countResult2 = await pool.query(countQuery, countParams);
    const total = parseInt(countResult2.rows[0].count);

    let historyExhausted: boolean | undefined;
    if (bdId && chId) {
      const exRow = await pool.query(
        'SELECT history_exhausted FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
        [bdId, chId]
      );
      historyExhausted = exRow.rows.length > 0 ? (exRow.rows[0] as any).history_exhausted === true : undefined;
    }

    const payload: {
      messages: any[];
      pagination: { page: number; limit: number; total: number; totalPages: number };
      historyExhausted?: boolean;
    } = {
      messages: rows,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total,
        totalPages: Math.ceil(total / limitNum),
      },
    };
    if (historyExhausted !== undefined) payload.historyExhausted = historyExhausted;
    res.json(payload);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get message by ID
app.get('/api/messaging/messages/:id', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;

    const result = await pool.query(
      'SELECT * FROM messages WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Error fetching message:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get all chats (from DB only; optionally filtered by bd_account_id so only allowed sync chats appear)
// При bdAccountId: показываем все чаты из bd_account_sync_chats (в т.ч. без сообщений), а не только те, у кого есть сообщения в messages
app.get('/api/messaging/chats', async (req, res) => {
  try {
    const user = getUser(req);
    const { channel, bdAccountId } = req.query;

    const orgId = user.organizationId;
    const params: any[] = [orgId];

    // Если выбран аккаунт — список строим из sync_chats, чтобы показывать все выбранные чаты (даже без сообщений)
    if (bdAccountId && String(bdAccountId).trim()) {
      if (channel && String(channel) !== 'telegram') {
        return res.json([]);
      }
      params.push(String(bdAccountId).trim());

      const query = `
        SELECT
          'telegram' AS channel,
          s.telegram_chat_id::text AS channel_id,
          s.bd_account_id,
          s.folder_id,
          (SELECT COALESCE(array_agg(j.folder_id ORDER BY j.folder_id), ARRAY[]::integer[]) FROM bd_account_sync_chat_folders j WHERE j.bd_account_id = s.bd_account_id AND j.telegram_chat_id = s.telegram_chat_id) AS folder_ids,
          msg.contact_id,
          s.peer_type,
          c.first_name,
          c.last_name,
          c.email,
          c.telegram_id,
          c.display_name,
          c.username,
          COALESCE(
            c.display_name,
            CASE WHEN NULLIF(TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))), '') IS NOT NULL
                 AND TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))) NOT LIKE 'Telegram %'
                 THEN TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))) ELSE NULL END,
            c.username,
            CASE WHEN NULLIF(TRIM(COALESCE(s.title, '')), '') IS NOT NULL
                 AND (TRIM(COALESCE(s.title, '')) = NULLIF(TRIM(COALESCE(a.display_name, '')), '')
                      OR TRIM(COALESCE(s.title, '')) = COALESCE(a.username, '')
                      OR TRIM(COALESCE(s.title, '')) = NULLIF(TRIM(COALESCE(a.first_name, '')), ''))
                 THEN NULL ELSE NULLIF(TRIM(COALESCE(s.title, '')), '') END,
            c.telegram_id::text,
            s.telegram_chat_id::text
          ) AS name,
          COALESCE(msg.unread_count, 0)::int AS unread_count,
          msg.last_message_at,
          msg.last_message
        FROM bd_account_sync_chats s
        JOIN bd_accounts a ON a.id = s.bd_account_id AND a.organization_id = $1
        LEFT JOIN LATERAL (
          SELECT
            (SELECT m0.contact_id FROM messages m0 WHERE m0.organization_id = a.organization_id AND m0.channel = 'telegram' AND m0.channel_id = s.telegram_chat_id::text AND m0.bd_account_id = s.bd_account_id LIMIT 1) AS contact_id,
            (SELECT COUNT(*)::int FROM messages m WHERE m.organization_id = a.organization_id AND m.channel = 'telegram' AND m.channel_id = s.telegram_chat_id::text AND m.bd_account_id = s.bd_account_id AND m.unread = true) AS unread_count,
            (SELECT MAX(COALESCE(m.telegram_date, m.created_at)) FROM messages m WHERE m.organization_id = a.organization_id AND m.channel = 'telegram' AND m.channel_id = s.telegram_chat_id::text AND m.bd_account_id = s.bd_account_id) AS last_message_at,
            (SELECT m2.content FROM messages m2 WHERE m2.organization_id = a.organization_id AND m2.channel = 'telegram' AND m2.channel_id = s.telegram_chat_id::text AND m2.bd_account_id = s.bd_account_id ORDER BY COALESCE(m2.telegram_date, m2.created_at) DESC LIMIT 1) AS last_message
        ) msg ON true
        LEFT JOIN contacts c ON c.id = msg.contact_id
        WHERE s.bd_account_id = $2 AND s.peer_type IN ('user', 'chat')
        ORDER BY msg.last_message_at DESC NULLS LAST, s.telegram_chat_id
      `;
      const result = await pool.query(query, params);
      return res.json(result.rows);
    }

    // Без bdAccountId — как раньше: чаты из messages (только те, у кого есть сообщения)
    let query = `
      SELECT 
        m.channel,
        m.channel_id,
        m.bd_account_id,
        m.contact_id,
        s.peer_type,
        c.first_name,
        c.last_name,
        c.email,
        c.telegram_id,
        c.display_name,
        c.username,
        COALESCE(
          c.display_name,
          CASE WHEN NULLIF(TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))), '') IS NOT NULL
               AND TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))) NOT LIKE 'Telegram %'
               THEN TRIM(CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,''))) ELSE NULL END,
          c.username,
          CASE WHEN NULLIF(TRIM(COALESCE(s.title, '')), '') IS NOT NULL
               AND (TRIM(COALESCE(s.title, '')) = NULLIF(TRIM(COALESCE(ba.display_name, '')), '')
                    OR TRIM(COALESCE(s.title, '')) = COALESCE(ba.username, '')
                    OR TRIM(COALESCE(s.title, '')) = NULLIF(TRIM(COALESCE(ba.first_name, '')), ''))
               THEN NULL ELSE NULLIF(TRIM(COALESCE(s.title, '')), '') END,
          c.telegram_id::text,
          m.channel_id
        ) AS name,
        COUNT(*) FILTER (WHERE m.unread = true) as unread_count,
        (SELECT COALESCE(m2.telegram_date, m2.created_at) FROM messages m2 WHERE m2.organization_id = m.organization_id AND m2.channel = m.channel AND m2.channel_id = m.channel_id AND (m2.bd_account_id IS NOT DISTINCT FROM m.bd_account_id) ORDER BY COALESCE(m2.telegram_date, m2.created_at) DESC LIMIT 1) as last_message_at,
        (SELECT content FROM messages m2 WHERE m2.organization_id = m.organization_id AND m2.channel = m.channel AND m2.channel_id = m.channel_id AND (m2.bd_account_id IS NOT DISTINCT FROM m.bd_account_id) ORDER BY COALESCE(m2.telegram_date, m2.created_at) DESC LIMIT 1) as last_message
      FROM messages m
      LEFT JOIN contacts c ON m.contact_id = c.id
      LEFT JOIN bd_account_sync_chats s ON s.bd_account_id = m.bd_account_id AND s.telegram_chat_id = m.channel_id
      LEFT JOIN bd_accounts ba ON ba.id = m.bd_account_id
      WHERE m.organization_id = $1
    `;

    if (channel) {
      query += ` AND m.channel = $${params.length + 1}`;
      params.push(channel);
    }

    query += `
      GROUP BY m.organization_id, m.channel, m.channel_id, m.bd_account_id, m.contact_id, s.peer_type, c.first_name, c.last_name, c.email, c.telegram_id, c.display_name, c.username, s.title, ba.display_name, ba.username, ba.first_name
      ORDER BY last_message_at DESC NULLS LAST
    `;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Search chats by name (for command palette). Scopes to org and sync chats only.
app.get('/api/messaging/search', async (req, res) => {
  try {
    const user = getUser(req);
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
      [user.organizationId, searchPattern, limit]
    );
    res.json({ items: result.rows });
  } catch (error) {
    console.error('Error searching chats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Unfurl link preview (Open Graph). Requires auth to avoid abuse.
const UNFURL_TIMEOUT_MS = 4000;
const UNFURL_MAX_BODY = 300000; // 300kb
const URL_REGEX = /^https?:\/\/[^\s<>"']+$/i;

app.get('/api/messaging/unfurl', async (req, res) => {
  try {
    getUser(req); // require auth
    const rawUrl = typeof req.query.url === 'string' ? req.query.url.trim() : '';
    if (!rawUrl || !URL_REGEX.test(rawUrl)) {
      return res.status(400).json({ error: 'Valid url query parameter is required' });
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), UNFURL_TIMEOUT_MS);
    const response = await fetch(rawUrl, {
      signal: controller.signal,
      headers: { 'User-Agent': 'GetSale-CRM-Bot/1.0 (link preview)' },
      redirect: 'follow',
    });
    clearTimeout(timeout);
    if (!response.ok || !response.body) {
      return res.json({ title: null, description: null, image: null });
    }
    const contentLength = response.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > UNFURL_MAX_BODY) {
      return res.json({ title: null, description: null, image: null });
    }
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = (response.body as any).getReader();
    try {
      while (total < UNFURL_MAX_BODY) {
        const { done, value } = await reader.read();
        if (done) break;
        const buf = Buffer.from(value);
        total += buf.length;
        chunks.push(total <= UNFURL_MAX_BODY ? buf : buf.subarray(0, UNFURL_MAX_BODY - (total - buf.length)));
        if (total >= UNFURL_MAX_BODY) break;
      }
    } finally {
      reader.releaseLock?.();
    }
    const html = Buffer.concat(chunks).toString('utf8', 0, Math.min(total, UNFURL_MAX_BODY));
    const ogTitle = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i)?.[1];
    const ogDesc = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i)?.[1];
    const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1]
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
    const title = ogTitle ? ogTitle.replace(/&amp;/g, '&').replace(/&#39;/g, "'").slice(0, 200) : null;
    const description = ogDesc ? ogDesc.replace(/&amp;/g, '&').replace(/&#39;/g, "'").slice(0, 300) : null;
    let image: string | null = ogImage ? ogImage.replace(/&amp;/g, '&').trim() : null;
    if (image && !/^https?:\/\//i.test(image)) image = new URL(image, rawUrl).href;
    res.json({ title, description, image });
  } catch (err: any) {
    if (err.name === 'AbortError') {
      return res.json({ title: null, description: null, image: null });
    }
    res.json({ title: null, description: null, image: null });
  }
});

// Mark all messages as read for a chat
app.post('/api/messaging/chats/:chatId/mark-all-read', async (req, res) => {
  try {
    const user = getUser(req);
    const { chatId } = req.params;
    const { channel } = req.query;

    if (!channel) {
      return res.status(400).json({ error: 'channel query parameter is required' });
    }

    await pool.query(
      `UPDATE messages 
       SET unread = false, updated_at = NOW() 
       WHERE organization_id = $1 AND channel = $2 AND channel_id = $3`,
      [user.organizationId, channel, chatId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error marking messages as read:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Alternative endpoint for marking messages as read (for compatibility)
app.post('/api/messaging/mark-read', async (req, res) => {
  try {
    const user = getUser(req);
    const { channel, channelId } = req.body;

    if (!channel || !channelId) {
      return res.status(400).json({ error: 'channel and channelId are required' });
    }

    await pool.query(
      `UPDATE messages 
       SET unread = false, updated_at = NOW() 
       WHERE organization_id = $1 AND channel = $2 AND channel_id = $3`,
      [user.organizationId, channel, channelId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error marking messages as read:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Pinned chats (user-specific, per bd_account)
app.get('/api/messaging/pinned-chats', async (req, res) => {
  try {
    const user = getUser(req);
    const { bdAccountId } = req.query;
    if (!bdAccountId || String(bdAccountId).trim() === '') {
      return res.status(400).json({ error: 'bdAccountId is required' });
    }
    const result = await pool.query(
      `SELECT channel_id, order_index FROM user_chat_pins
       WHERE user_id = $1 AND organization_id = $2 AND bd_account_id = $3
       ORDER BY order_index ASC, created_at ASC`,
      [user.id, user.organizationId, String(bdAccountId).trim()]
    );
    res.json(result.rows.map((r: any) => ({ channel_id: r.channel_id, order_index: r.order_index })));
  } catch (error) {
    console.error('Error fetching pinned chats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.post('/api/messaging/pinned-chats', async (req, res) => {
  try {
    const user = getUser(req);
    const { bdAccountId, channelId } = req.body;
    if (!bdAccountId || !channelId) {
      return res.status(400).json({ error: 'bdAccountId and channelId are required' });
    }
    const bdId = String(bdAccountId).trim();
    const chId = String(channelId).trim();
    const maxResult = await pool.query(
      `SELECT COALESCE(MAX(order_index), -1) + 1 AS next_index FROM user_chat_pins
       WHERE user_id = $1 AND organization_id = $2 AND bd_account_id = $3`,
      [user.id, user.organizationId, bdId]
    );
    const nextIndex = maxResult.rows[0]?.next_index ?? 0;
    await pool.query(
      `INSERT INTO user_chat_pins (user_id, organization_id, bd_account_id, channel_id, order_index)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id, organization_id, bd_account_id, channel_id) DO UPDATE SET order_index = EXCLUDED.order_index`,
      [user.id, user.organizationId, bdId, chId, nextIndex]
    );
    res.json({ success: true, channel_id: chId, order_index: nextIndex });
  } catch (error) {
    console.error('Error pinning chat:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.delete('/api/messaging/pinned-chats/:channelId', async (req, res) => {
  try {
    const user = getUser(req);
    const allowed = await canPermission(pool, user.role, 'messaging', 'chat.delete');
    if (!allowed) {
      return res.status(403).json({ error: 'Forbidden: no permission to unpin chats' });
    }
    const { channelId } = req.params;
    const { bdAccountId } = req.query;
    if (!bdAccountId || String(bdAccountId).trim() === '') {
      return res.status(400).json({ error: 'bdAccountId query is required' });
    }
    await pool.query(
      `DELETE FROM user_chat_pins
       WHERE user_id = $1 AND organization_id = $2 AND bd_account_id = $3 AND channel_id = $4`,
      [user.id, user.organizationId, String(bdAccountId).trim(), String(channelId)]
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Error unpinning chat:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Sync pinned chats from Telegram: replace current user's pins for this bd_account with the ordered list from Telegram.
app.post('/api/messaging/pinned-chats/sync', async (req, res) => {
  try {
    const user = getUser(req);
    const { bdAccountId, pinned_chat_ids: pinnedChatIds } = req.body;
    if (!bdAccountId || String(bdAccountId).trim() === '') {
      return res.status(400).json({ error: 'bdAccountId is required' });
    }
    const bdId = String(bdAccountId).trim();
    const ids = Array.isArray(pinnedChatIds) ? pinnedChatIds.map((x: any) => String(x)).filter(Boolean) : [];
    await pool.query(
      `DELETE FROM user_chat_pins
       WHERE user_id = $1 AND organization_id = $2 AND bd_account_id = $3`,
      [user.id, user.organizationId, bdId]
    );
    for (let i = 0; i < ids.length; i++) {
      await pool.query(
        `INSERT INTO user_chat_pins (user_id, organization_id, bd_account_id, channel_id, order_index)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id, organization_id, bd_account_id, channel_id) DO UPDATE SET order_index = EXCLUDED.order_index`,
        [user.id, user.organizationId, bdId, ids[i], i]
      );
    }
    res.json({ success: true, count: ids.length });
  } catch (error) {
    console.error('Error syncing pinned chats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Get messaging statistics
app.get('/api/messaging/stats', async (req, res) => {
  try {
    const user = getUser(req);
    const { startDate, endDate } = req.query;

    let query = `
      SELECT 
        channel,
        direction,
        status,
        COUNT(*) as count
      FROM messages
      WHERE organization_id = $1
    `;
    const params: any[] = [user.organizationId];

    if (startDate) {
      query += ` AND created_at >= $${params.length + 1}`;
      params.push(startDate);
    }
    if (endDate) {
      query += ` AND created_at <= $${params.length + 1}`;
      params.push(endDate);
    }

    query += ` GROUP BY channel, direction, status`;

    const result = await pool.query(query, params);

    // Get unread count
    const unreadResult = await pool.query(
      'SELECT COUNT(*) as count FROM messages WHERE organization_id = $1 AND unread = true',
      [user.organizationId]
    );

    res.json({
      stats: result.rows,
      unreadCount: parseInt(unreadResult.rows[0].count),
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

// Send message (optionally with file as base64)
app.post('/api/messaging/send', async (req, res) => {
  try {
    const user = getUser(req);
    const { contactId, channel, channelId, content, bdAccountId, fileBase64, fileName, replyToMessageId } = req.body;

    if (!contactId || !channel || !channelId) {
      return res.status(400).json({ error: 'Missing required fields: contactId, channel, channelId' });
    }
    if (!content && !fileBase64) {
      return res.status(400).json({ error: 'Missing required field: content or fileBase64' });
    }

    if (fileBase64 && typeof fileBase64 === 'string') {
      const estimatedBytes = (fileBase64.length * 3) / 4;
      if (estimatedBytes > MAX_FILE_SIZE_BYTES) {
        return res.status(413).json({
          error: 'File too large',
          message: 'Maximum file size is 2 GB. Use a smaller file.',
        });
      }
    }

    const contactResult = await pool.query(
      'SELECT id, organization_id, telegram_id FROM contacts WHERE id = $1 AND organization_id = $2',
      [contactId, user.organizationId]
    );
    if (contactResult.rows.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const captionOrContent = typeof content === 'string' ? content : '';
    const contentForDb = captionOrContent || (fileName ? `[Файл: ${fileName}]` : '[Медиа]');
    const replyToTgId = replyToMessageId != null && String(replyToMessageId).trim() ? String(replyToMessageId).trim() : null;

    const result = await pool.query(
      `INSERT INTO messages (organization_id, bd_account_id, channel, channel_id, contact_id, direction, content, status, unread, metadata, reply_to_telegram_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
      [
        user.organizationId,
        bdAccountId || null,
        channel,
        channelId,
        contactId,
        MessageDirection.OUTBOUND,
        contentForDb,
        MessageStatus.PENDING,
        false,
        JSON.stringify({ sentBy: user.id }),
        replyToTgId,
      ]
    );
    const message = result.rows[0];

    let sent = false;
    if (channel === MessageChannel.TELEGRAM) {
      if (!bdAccountId) {
        return res.status(400).json({ error: 'bdAccountId is required for Telegram messages' });
      }
      try {
        const body: Record<string, string> = {
          chatId: channelId,
          text: captionOrContent,
        };
        if (fileBase64 && typeof fileBase64 === 'string') {
          body.fileBase64 = fileBase64;
          body.fileName = typeof fileName === 'string' ? fileName : 'file';
        }
        if (replyToTgId) {
          body.replyToMessageId = replyToTgId;
        }
        const response = await fetch(`${BD_ACCOUNTS_SERVICE_URL}/api/bd-accounts/${bdAccountId}/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-User-Id': user.id,
            'X-Organization-Id': user.organizationId,
          },
          body: JSON.stringify(body),
        });

        if (response.ok) {
          const resJson = (await response.json().catch(() => ({}))) as {
            messageId?: string;
            date?: number;
            telegram_media?: Record<string, unknown> | null;
            telegram_entities?: Record<string, unknown>[] | null;
          };
          const tgMessageId = resJson.messageId != null ? String(resJson.messageId).trim() : null;
          const tgDate = resJson.date != null ? new Date(resJson.date * 1000) : null;
          const hasMedia = resJson.telegram_media != null && typeof resJson.telegram_media === 'object';
          const hasEntities = Array.isArray(resJson.telegram_entities);
          if (hasMedia || hasEntities) {
            await pool.query(
              `UPDATE messages SET status = $1, telegram_message_id = $2, telegram_date = $3, telegram_media = $4, telegram_entities = $5 WHERE id = $6`,
              [
                MessageStatus.DELIVERED,
                tgMessageId,
                tgDate,
                hasMedia ? JSON.stringify(resJson.telegram_media) : null,
                hasEntities ? JSON.stringify(resJson.telegram_entities) : null,
                message.id,
              ]
            );
          } else {
            await pool.query(
              `UPDATE messages SET status = $1, telegram_message_id = $2, telegram_date = $3 WHERE id = $4`,
              [MessageStatus.DELIVERED, tgMessageId, tgDate, message.id]
            );
          }
          sent = true;
        } else {
          const errJson = await response.json().catch(() => ({})) as { message?: string; error?: string };
          const errMsg = response.status === 413 ? (errJson.message || errJson.error || 'File too large') : (errJson.message || errJson.error || 'Failed to send message');
          throw new Error(errMsg);
        }
      } catch (error: any) {
        console.error('Error sending Telegram message:', error);
        await pool.query('UPDATE messages SET status = $1, metadata = $2 WHERE id = $3', [
          MessageStatus.FAILED,
          JSON.stringify({ error: error.message }),
          message.id,
        ]);
        const status = error.message && (error.message.toLowerCase().includes('too large') || error.message.includes('2 GB')) ? 413 : 500;
        return res.status(status).json({
          error: status === 413 ? 'File too large' : 'Internal server error',
          message: error.message || 'Failed to send message',
        });
      }
    }
    // TODO: Email sending
    // TODO: LinkedIn sending
    // TODO: Twitter sending

    if (!sent) {
      return res.status(400).json({ error: 'Unsupported channel or sending failed' });
    }

    // Get updated message first so we can include full payload in event (for real-time UI)
    const updatedResult = await pool.query('SELECT * FROM messages WHERE id = $1', [message.id]);
    const updatedRow = updatedResult.rows[0] as Record<string, unknown> | undefined;

    // Publish event with channelId/content so frontend can show sent message without refresh
    const event: MessageSentEvent = {
      id: randomUUID(),
      type: EventType.MESSAGE_SENT,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: {
        messageId: message.id,
        channel,
        contactId,
        bdAccountId,
        channelId: updatedRow ? String(updatedRow.channel_id ?? '') : undefined,
        content: updatedRow && typeof updatedRow.content === 'string' ? updatedRow.content : undefined,
        direction: 'outbound',
        telegramMessageId: (() => {
          const v = updatedRow?.telegram_message_id;
          return v != null && (typeof v === 'string' || typeof v === 'number') ? v : undefined;
        })(),
        createdAt: updatedRow && updatedRow.created_at != null ? String(updatedRow.created_at) : undefined,
      },
    };
    await rabbitmq.publishEvent(event);

    res.json(updatedRow);
  } catch (error: any) {
    console.error('Error sending message:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message || 'Failed to send message'
    });
  }
});

// Delete message (and in Telegram if applicable)
app.delete('/api/messaging/messages/:id', async (req, res) => {
  try {
    const user = getUser(req);
    const allowed = await canPermission(pool, user.role, 'messaging', 'message.delete');
    if (!allowed) {
      return res.status(403).json({ error: 'Forbidden: no permission to delete messages' });
    }
    const { id } = req.params;

    const msgResult = await pool.query(
      'SELECT id, organization_id, bd_account_id, channel_id, telegram_message_id FROM messages WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (msgResult.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    const msg = msgResult.rows[0] as { id: string; organization_id: string; bd_account_id: string | null; channel_id: string; telegram_message_id: number | string | null };

    if (msg.bd_account_id && msg.telegram_message_id != null) {
      try {
        const telegramMessageId = typeof msg.telegram_message_id === 'string' ? parseInt(msg.telegram_message_id, 10) : msg.telegram_message_id;
        const delRes = await fetch(
          `${BD_ACCOUNTS_SERVICE_URL}/api/bd-accounts/${msg.bd_account_id}/delete-message`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-User-Id': user.id,
              'X-Organization-Id': user.organizationId,
            },
            body: JSON.stringify({
              channelId: String(msg.channel_id),
              telegramMessageId: Number.isNaN(telegramMessageId) ? Number(msg.telegram_message_id) : telegramMessageId,
            }),
          }
        );
        if (!delRes.ok) {
          const errBody = (await delRes.json()) as { message?: string };
          throw new Error(errBody.message || 'Failed to delete message in Telegram');
        }
      } catch (err: any) {
        console.error('Error deleting message in Telegram:', err);
        return res.status(502).json({
          error: 'Failed to delete in Telegram',
          message: err.message || 'BD accounts service error',
        });
      }
    }

    await pool.query('DELETE FROM messages WHERE id = $1 AND organization_id = $2', [id, user.organizationId]);

    const ev: MessageDeletedEvent = {
      id: randomUUID(),
      type: EventType.MESSAGE_DELETED,
      timestamp: new Date(),
      organizationId: user.organizationId,
      data: {
        messageId: msg.id,
        bdAccountId: msg.bd_account_id || '',
        channelId: msg.channel_id,
        telegramMessageId:
          msg.telegram_message_id != null
            ? typeof msg.telegram_message_id === 'string'
              ? (Number.isNaN(parseInt(msg.telegram_message_id, 10)) ? undefined : parseInt(msg.telegram_message_id, 10))
              : msg.telegram_message_id
            : undefined,
      },
    };
    await rabbitmq.publishEvent(ev);

    res.json({ success: true });
  } catch (error: any) {
    console.error('Error deleting message:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message || 'Failed to delete message',
    });
  }
});

// Mark as read
app.patch('/api/messaging/messages/:id/read', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;

    await pool.query(
      'UPDATE messages SET unread = false, updated_at = NOW() WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );

    res.json({ success: true });
  } catch (error) {
    console.error('Error marking message as read:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Реакция на сообщение (лайк и т.д.). reactions в БД: JSONB { "👍": 2, "❤️": 1 }.
const ALLOWED_EMOJI = ['👍', '👎', '❤️', '🔥', '👏', '😄', '😮', '😢', '🙏'];
app.patch('/api/messaging/messages/:id/reaction', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const { emoji } = req.body as { emoji?: string };

    if (!emoji || typeof emoji !== 'string' || emoji.length > 10) {
      return res.status(400).json({ error: 'Invalid emoji' });
    }
    const trimmed = emoji.trim();
    if (!ALLOWED_EMOJI.includes(trimmed)) {
      return res.status(400).json({ error: 'Emoji not allowed', allowed: ALLOWED_EMOJI });
    }

    const msgResult = await pool.query(
      'SELECT id, reactions, our_reactions, bd_account_id, channel_id, telegram_message_id FROM messages WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId]
    );
    if (msgResult.rows.length === 0) {
      return res.status(404).json({ error: 'Message not found' });
    }
    const row = msgResult.rows[0];
    const current = (row.reactions as Record<string, number>) || {};
    const prevCount = current[trimmed] || 0;
    const next: Record<string, number> = { ...current };
    const currentOurs: string[] = Array.isArray(row.our_reactions) ? row.our_reactions : [];
    let newOurs: string[];
    if (prevCount > 0) {
      if (prevCount === 1) delete next[trimmed];
      else next[trimmed] = prevCount - 1;
      newOurs = currentOurs.filter((e) => e !== trimmed);
    } else {
      next[trimmed] = prevCount + 1;
      newOurs = [...currentOurs.filter((e) => e !== trimmed), trimmed].slice(0, 3);
    }

    await pool.query(
      'UPDATE messages SET reactions = $1, our_reactions = $2, updated_at = NOW() WHERE id = $3 AND organization_id = $4',
      [JSON.stringify(next), JSON.stringify(newOurs), id, user.organizationId]
    );

    const bdAccountId = row.bd_account_id;
    const channelId = row.channel_id;
    const telegramMessageId = row.telegram_message_id;
    if (bdAccountId && channelId && telegramMessageId) {
      try {
        await fetch(
          `${BD_ACCOUNTS_SERVICE_URL}/api/bd-accounts/${bdAccountId}/messages/${telegramMessageId}/reaction`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-User-Id': user.id,
              'X-Organization-Id': user.organizationId,
            },
            body: JSON.stringify({ chatId: channelId, reaction: newOurs }),
          }
        );
      } catch (err) {
        console.warn('Failed to sync reaction to Telegram:', err);
      }
    }

    const updated = await pool.query('SELECT * FROM messages WHERE id = $1', [id]);
    res.json(updated.rows[0]);
  } catch (error: any) {
    console.error('Error adding reaction:', error);
    res.status(500).json({ error: 'Internal server error', message: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`Messaging service running on port ${PORT}`);
});

