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

/** ЭТАП 7 — единственная точка создания conversation. Вызывать перед сохранением любого сообщения. */
async function ensureConversation(
  db: Pool,
  params: { organizationId: string; bdAccountId: string | null; channel: string; channelId: string; contactId: string | null }
): Promise<void> {
  await db.query(
    `INSERT INTO conversations (id, organization_id, bd_account_id, channel, channel_id, contact_id, created_at, updated_at)
     VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(), NOW())
     ON CONFLICT (organization_id, bd_account_id, channel, channel_id)
     DO UPDATE SET contact_id = COALESCE(EXCLUDED.contact_id, conversations.contact_id), updated_at = NOW()`,
    [params.organizationId, params.bdAccountId, params.channel, params.channelId, params.contactId]
  );
  if (params.contactId) {
    await db.query(
      `UPDATE conversations c SET lead_id = sub.id, became_lead_at = COALESCE(c.became_lead_at, sub.created_at), updated_at = NOW()
       FROM (SELECT id, created_at FROM leads WHERE organization_id = $1 AND contact_id = $5 ORDER BY created_at DESC LIMIT 1) sub
       WHERE c.organization_id = $1 AND c.bd_account_id IS NOT DISTINCT FROM $2 AND c.channel = $3 AND c.channel_id = $4 AND c.lead_id IS NULL`,
      [params.organizationId, params.bdAccountId, params.channel, params.channelId, params.contactId]
    );
  }
}

/** ЭТАП 7 — привязать лид к conversation (idempotent). По событию LEAD_CREATED_FROM_CAMPAIGN. */
async function attachLead(db: Pool, params: { conversationId: string; leadId: string; campaignId: string }): Promise<void> {
  await db.query(
    `UPDATE conversations SET lead_id = $1, campaign_id = $2, became_lead_at = COALESCE(became_lead_at, NOW()), updated_at = NOW()
     WHERE id = $3 AND (lead_id IS NULL OR lead_id = $1)`,
    [params.leadId, params.campaignId, params.conversationId]
  );
}

(async () => {
  try {
    await rabbitmq.connect();
    await rabbitmq.subscribeToEvents(
      [EventType.LEAD_CREATED_FROM_CAMPAIGN],
      async (event: any) => {
        if (event.type !== EventType.LEAD_CREATED_FROM_CAMPAIGN) return;
        const { conversationId, leadId, campaignId } = event.data || {};
        if (!conversationId || !leadId || !campaignId) return;
        try {
          await attachLead(pool, { conversationId, leadId, campaignId });
        } catch (err) {
          console.error('attachLead error:', err);
        }
      },
      'events',
      'messaging-service'
    );
  } catch (e) {
    console.error('Failed to connect to RabbitMQ, service will continue without event subscription:', e);
  }
})();

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
          msg.last_message,
          conv.id AS conversation_id,
          conv.lead_id,
          conv.campaign_id,
          conv.became_lead_at,
          conv.last_viewed_at,
          st.name AS lead_stage_name,
          p.name AS lead_pipeline_name
        FROM bd_account_sync_chats s
        JOIN bd_accounts a ON a.id = s.bd_account_id AND a.organization_id = $1
        LEFT JOIN LATERAL (
          SELECT
            (SELECT m0.contact_id FROM messages m0 WHERE m0.organization_id = a.organization_id AND m0.channel = 'telegram' AND m0.channel_id = s.telegram_chat_id::text AND m0.bd_account_id = s.bd_account_id LIMIT 1) AS contact_id,
            (SELECT COUNT(*)::int FROM messages m WHERE m.organization_id = a.organization_id AND m.channel = 'telegram' AND m.channel_id = s.telegram_chat_id::text AND m.bd_account_id = s.bd_account_id AND m.unread = true) AS unread_count,
            (SELECT MAX(COALESCE(m.telegram_date, m.created_at)) FROM messages m WHERE m.organization_id = a.organization_id AND m.channel = 'telegram' AND m.channel_id = s.telegram_chat_id::text AND m.bd_account_id = s.bd_account_id) AS last_message_at,
            (SELECT COALESCE(NULLIF(TRIM(m2.content), ''), '[Media]') FROM messages m2 WHERE m2.organization_id = a.organization_id AND m2.channel = 'telegram' AND m2.channel_id = s.telegram_chat_id::text AND m2.bd_account_id = s.bd_account_id ORDER BY COALESCE(m2.telegram_date, m2.created_at) DESC LIMIT 1) AS last_message
        ) msg ON true
        LEFT JOIN contacts c ON c.id = msg.contact_id
        LEFT JOIN conversations conv ON conv.organization_id = a.organization_id AND conv.bd_account_id = s.bd_account_id AND conv.channel = 'telegram' AND conv.channel_id = s.telegram_chat_id::text
        LEFT JOIN leads l ON l.id = conv.lead_id
        LEFT JOIN stages st ON st.id = l.stage_id
        LEFT JOIN pipelines p ON p.id = l.pipeline_id
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
        (SELECT COALESCE(NULLIF(TRIM(m2.content), ''), '[Media]') FROM messages m2 WHERE m2.organization_id = m.organization_id AND m2.channel = m.channel AND m2.channel_id = m.channel_id AND (m2.bd_account_id IS NOT DISTINCT FROM m.bd_account_id) ORDER BY COALESCE(m2.telegram_date, m2.created_at) DESC LIMIT 1) as last_message,
        conv.id AS conversation_id,
        conv.lead_id,
        conv.campaign_id,
        conv.became_lead_at,
        conv.last_viewed_at,
        st.name AS lead_stage_name,
        p.name AS lead_pipeline_name
      FROM messages m
      LEFT JOIN contacts c ON m.contact_id = c.id
      LEFT JOIN bd_account_sync_chats s ON s.bd_account_id = m.bd_account_id AND s.telegram_chat_id = m.channel_id
      LEFT JOIN bd_accounts ba ON ba.id = m.bd_account_id
      LEFT JOIN conversations conv ON conv.organization_id = m.organization_id AND conv.bd_account_id IS NOT DISTINCT FROM m.bd_account_id AND conv.channel = m.channel AND conv.channel_id = m.channel_id
      LEFT JOIN leads l ON l.id = conv.lead_id
      LEFT JOIN stages st ON st.id = l.stage_id
      LEFT JOIN pipelines p ON p.id = l.pipeline_id
      WHERE m.organization_id = $1
    `;

    if (channel) {
      query += ` AND m.channel = $${params.length + 1}`;
      params.push(channel);
    }

    query += `
      GROUP BY m.organization_id, m.channel, m.channel_id, m.bd_account_id, m.contact_id, s.peer_type, c.first_name, c.last_name, c.email, c.telegram_id, c.display_name, c.username, s.title, ba.display_name, ba.username, ba.first_name, conv.id, conv.lead_id, conv.campaign_id, conv.became_lead_at, conv.last_viewed_at, st.name, p.name
      ORDER BY last_message_at DESC NULLS LAST
    `;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PHASE 2.3 §11в — папка «Новые лиды»: lead_id != null AND first_manager_reply_at IS NULL. Сортировка became_lead_at DESC.
app.get('/api/messaging/new-leads', async (req, res) => {
  try {
    const user = getUser(req);
    const result = await pool.query(
      `SELECT conv.id AS conversation_id, conv.organization_id, conv.bd_account_id, conv.channel, conv.channel_id,
              conv.contact_id, conv.lead_id, conv.campaign_id, conv.became_lead_at, conv.last_viewed_at,
              st.name AS lead_stage_name, p.name AS lead_pipeline_name, l.stage_id,
              c.first_name, c.last_name, c.display_name, c.username, c.telegram_id,
              (SELECT COUNT(*)::int FROM messages m WHERE m.organization_id = conv.organization_id AND m.channel = conv.channel AND m.channel_id = conv.channel_id AND m.bd_account_id IS NOT DISTINCT FROM conv.bd_account_id AND m.unread = true) AS unread_count,
              (SELECT MAX(COALESCE(m.telegram_date, m.created_at)) FROM messages m WHERE m.organization_id = conv.organization_id AND m.channel = conv.channel AND m.channel_id = conv.channel_id AND m.bd_account_id IS NOT DISTINCT FROM conv.bd_account_id) AS last_message_at,
              (SELECT COALESCE(NULLIF(TRIM(m2.content), ''), '[Media]') FROM messages m2 WHERE m2.organization_id = conv.organization_id AND m2.channel = conv.channel AND m2.channel_id = conv.channel_id AND m2.bd_account_id IS NOT DISTINCT FROM conv.bd_account_id ORDER BY COALESCE(m2.telegram_date, m2.created_at) DESC LIMIT 1) AS last_message
       FROM conversations conv
       JOIN leads l ON l.id = conv.lead_id
       JOIN stages st ON st.id = l.stage_id
       JOIN pipelines p ON p.id = l.pipeline_id
       LEFT JOIN contacts c ON c.id = conv.contact_id
       WHERE conv.organization_id = $1 AND conv.lead_id IS NOT NULL AND conv.first_manager_reply_at IS NULL
       ORDER BY conv.became_lead_at DESC NULLS LAST`,
      [user.organizationId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching new leads:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PATCH conversation: установить last_viewed_at (при открытии чата — убрать из «Новые лиды»).
app.patch('/api/messaging/conversations/:id/view', async (req, res) => {
  try {
    const user = getUser(req);
    const { id } = req.params;
    const r = await pool.query(
      `UPDATE conversations SET last_viewed_at = NOW(), updated_at = NOW() WHERE id = $1 AND organization_id = $2 RETURNING id`,
      [id, user.organizationId]
    );
    if (r.rows.length === 0) return res.status(404).json({ error: 'Conversation not found' });
    res.json({ ok: true });
  } catch (error) {
    console.error('Error updating conversation view:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PHASE 2.2 — единый контракт для Lead Panel. Всё в одном ответе. Без лишних полей.
app.get('/api/messaging/conversations/:id/lead-context', async (req, res) => {
  try {
    const user = getUser(req);
    const { id: conversationId } = req.params;

    const conv = await pool.query(
      `SELECT c.id AS conversation_id, c.lead_id, c.campaign_id, c.became_lead_at, c.contact_id,
              c.bd_account_id, c.channel_id,
              c.shared_chat_created_at, c.shared_chat_channel_id,
              c.won_at, c.revenue_amount, c.lost_at, c.loss_reason,
              l.pipeline_id, l.stage_id,
              p.name AS pipeline_name,
              st.name AS stage_name,
              COALESCE(
                NULLIF(TRIM(c2.display_name), ''),
                NULLIF(TRIM(CONCAT(COALESCE(c2.first_name,''), ' ', COALESCE(c2.last_name,''))), ''),
                c2.username,
                c2.telegram_id::text
              ) AS contact_name,
              c2.telegram_id AS contact_telegram_id,
              c2.username AS contact_username,
              camp.name AS campaign_name
       FROM conversations c
       LEFT JOIN leads l ON l.id = c.lead_id
       LEFT JOIN pipelines p ON p.id = l.pipeline_id
       LEFT JOIN stages st ON st.id = l.stage_id
       LEFT JOIN contacts c2 ON c2.id = c.contact_id
       LEFT JOIN campaigns camp ON camp.id = c.campaign_id
       WHERE c.id = $1 AND c.organization_id = $2`,
      [conversationId, user.organizationId]
    );
    if (conv.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found' });
    }
    const row = conv.rows[0] as any;
    if (row.lead_id == null) {
      return res.status(404).json({ error: 'No lead for this conversation' });
    }

    const pipelineId = row.pipeline_id;
    const leadId = row.lead_id;

    let sharedChatSettings: { titleTemplate: string; extraUsernames: string[] } = {
      titleTemplate: 'Чат: {{contact_name}}',
      extraUsernames: [],
    };
    const settingsRow = await pool.query(
      `SELECT value FROM organization_settings WHERE organization_id = $1 AND key = 'shared_chat'`,
      [user.organizationId]
    );
    if (settingsRow.rows.length > 0 && settingsRow.rows[0].value) {
      const v = settingsRow.rows[0].value as Record<string, unknown>;
      if (typeof v?.titleTemplate === 'string') sharedChatSettings.titleTemplate = v.titleTemplate;
      if (Array.isArray(v?.extraUsernames)) sharedChatSettings.extraUsernames = v.extraUsernames.filter((u): u is string => typeof u === 'string');
    }

    const [stagesResult, timelineResult] = await Promise.all([
      pool.query<{ id: string; name: string }>(
        `SELECT id, name FROM stages WHERE pipeline_id = $1 AND organization_id = $2 ORDER BY order_index`,
        [pipelineId, user.organizationId]
      ),
      pool.query(
        `SELECT lal.type, lal.created_at, lal.metadata, s.name AS to_stage_name
         FROM lead_activity_log lal
         LEFT JOIN stages s ON s.id = (lal.metadata->>'to_stage_id')::uuid
         WHERE lal.lead_id = $1 AND lal.type IN ('lead_created', 'stage_changed', 'deal_created')
         ORDER BY lal.created_at DESC
         LIMIT 10`,
        [leadId]
      ),
    ]);

    const timeline = timelineResult.rows.map((t: any) => {
      const item: { type: string; created_at: string; stage_name?: string } = {
        type: t.type,
        created_at: t.created_at instanceof Date ? t.created_at.toISOString() : String(t.created_at),
      };
      if (t.type === 'stage_changed' && t.to_stage_name != null) {
        item.stage_name = t.to_stage_name;
      }
      return item;
    });

    const payload = {
      conversation_id: row.conversation_id,
      lead_id: row.lead_id,
      contact_name: row.contact_name ?? '',
      contact_telegram_id: row.contact_telegram_id != null ? String(row.contact_telegram_id) : null,
      contact_username: typeof row.contact_username === 'string' ? row.contact_username : null,
      bd_account_id: row.bd_account_id ?? null,
      channel_id: row.channel_id ?? null,
      pipeline: { id: row.pipeline_id, name: row.pipeline_name ?? '' },
      stage: { id: row.stage_id, name: row.stage_name ?? '' },
      stages: stagesResult.rows.map((s) => ({ id: s.id, name: s.name })),
      campaign: row.campaign_id != null ? { id: row.campaign_id, name: row.campaign_name ?? '' } : null,
      became_lead_at: row.became_lead_at instanceof Date ? row.became_lead_at.toISOString() : row.became_lead_at,
      shared_chat_created_at: row.shared_chat_created_at != null && row.shared_chat_created_at instanceof Date ? row.shared_chat_created_at.toISOString() : row.shared_chat_created_at,
      shared_chat_channel_id: row.shared_chat_channel_id != null ? String(row.shared_chat_channel_id) : null,
      won_at: row.won_at != null && row.won_at instanceof Date ? row.won_at.toISOString() : row.won_at,
      revenue_amount: row.revenue_amount != null ? Number(row.revenue_amount) : null,
      lost_at: row.lost_at != null && row.lost_at instanceof Date ? row.lost_at.toISOString() : row.lost_at,
      loss_reason: row.loss_reason != null ? String(row.loss_reason) : null,
      shared_chat_settings: sharedChatSettings,
      timeline,
    };
    res.json(payload);
  } catch (error) {
    console.error('Error fetching lead-context:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET/PATCH настройки создания общего чата (шаблон названия, доп. участники по @username).
app.get('/api/messaging/settings/shared-chat', async (req, res) => {
  try {
    const user = getUser(req);
    const row = await pool.query(
      `SELECT value FROM organization_settings WHERE organization_id = $1 AND key = 'shared_chat'`,
      [user.organizationId]
    );
    const value = row.rows[0]?.value as Record<string, unknown> | undefined;
    const titleTemplate = typeof value?.titleTemplate === 'string' ? value.titleTemplate : 'Чат: {{contact_name}}';
    const extraUsernames = Array.isArray(value?.extraUsernames) ? value.extraUsernames.filter((u: unknown) => typeof u === 'string') : [];
    res.json({ titleTemplate, extraUsernames });
  } catch (error) {
    console.error('Error fetching shared-chat settings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.patch('/api/messaging/settings/shared-chat', async (req, res) => {
  try {
    const user = getUser(req);
    const { titleTemplate, extraUsernames } = req.body ?? {};
    const title = typeof titleTemplate === 'string' ? titleTemplate.trim() || 'Чат: {{contact_name}}' : undefined;
    const usernames = Array.isArray(extraUsernames) ? extraUsernames.filter((u: unknown) => typeof u === 'string').map((u: string) => String(u).trim().replace(/^@/, '')) : undefined;
    if (title === undefined && usernames === undefined) {
      return res.status(400).json({ error: 'Provide titleTemplate and/or extraUsernames' });
    }

    const existing = await pool.query(
      `SELECT value FROM organization_settings WHERE organization_id = $1 AND key = 'shared_chat'`,
      [user.organizationId]
    );
    const prev = (existing.rows[0]?.value as Record<string, unknown>) ?? {};
    const value = {
      titleTemplate: title !== undefined ? title : (typeof prev.titleTemplate === 'string' ? prev.titleTemplate : 'Чат: {{contact_name}}'),
      extraUsernames: usernames !== undefined ? usernames : (Array.isArray(prev.extraUsernames) ? prev.extraUsernames : []),
    };
    await pool.query(
      `INSERT INTO organization_settings (organization_id, key, value, updated_at)
       VALUES ($1, 'shared_chat', $2::jsonb, NOW())
       ON CONFLICT (organization_id, key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
      [user.organizationId, JSON.stringify(value)]
    );
    res.json({ titleTemplate: value.titleTemplate, extraUsernames: value.extraUsernames });
  } catch (error) {
    console.error('Error updating shared-chat settings:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Создать реальный групповой чат в Telegram (BD-аккаунт + лид + доп. участники), затем проставить shared_chat_created_at.
app.post('/api/messaging/create-shared-chat', async (req, res) => {
  try {
    const user = getUser(req);
    const { conversation_id: conversationId, title: titleOverride, participant_usernames: participantUsernamesOverride } = req.body ?? {};
    if (!conversationId || typeof conversationId !== 'string') {
      return res.status(400).json({ error: 'conversation_id required' });
    }

    const convRow = await pool.query(
      `SELECT c.id, c.bd_account_id, c.channel_id, c.contact_id, c.shared_chat_created_at,
              COALESCE(NULLIF(TRIM(c2.display_name), ''), NULLIF(TRIM(CONCAT(COALESCE(c2.first_name,''), ' ', COALESCE(c2.last_name,''))), ''), c2.username, c2.telegram_id::text) AS contact_name
       FROM conversations c
       LEFT JOIN contacts c2 ON c2.id = c.contact_id
       WHERE c.id = $1 AND c.organization_id = $2 AND c.lead_id IS NOT NULL`,
      [conversationId, user.organizationId]
    );
    if (convRow.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found or not a lead' });
    }
    const conv = convRow.rows[0] as { id: string; bd_account_id: string; channel_id: string; contact_id: string | null; shared_chat_created_at: unknown; contact_name: string | null };
    if (conv.shared_chat_created_at != null) {
      return res.status(409).json({ error: 'Shared chat already created for this conversation' });
    }
    if (!conv.bd_account_id) {
      return res.status(400).json({ error: 'Conversation has no BD account' });
    }

    let title: string;
    if (titleOverride && typeof titleOverride === 'string' && titleOverride.trim()) {
      title = titleOverride.trim().slice(0, 255);
    } else {
      const settingsRow = await pool.query(
        `SELECT value FROM organization_settings WHERE organization_id = $1 AND key = 'shared_chat'`,
        [user.organizationId]
      );
      const v = settingsRow.rows[0]?.value as Record<string, unknown> | undefined;
      const template = typeof v?.titleTemplate === 'string' ? v.titleTemplate : 'Чат: {{contact_name}}';
      title = template.replace(/\{\{\s*contact_name\s*\}\}/gi, (conv.contact_name ?? 'Контакт').trim()).trim().slice(0, 255) || 'Общий чат';
    }

    let extraUsernames: string[];
    if (Array.isArray(participantUsernamesOverride)) {
      extraUsernames = participantUsernamesOverride.filter((u: unknown) => typeof u === 'string').map((u: string) => String(u).trim().replace(/^@/, ''));
    } else {
      const settingsRow = await pool.query(
        `SELECT value FROM organization_settings WHERE organization_id = $1 AND key = 'shared_chat'`,
        [user.organizationId]
      );
      const v = settingsRow.rows[0]?.value as Record<string, unknown> | undefined;
      extraUsernames = Array.isArray(v?.extraUsernames) ? v.extraUsernames.filter((u: unknown) => typeof u === 'string').map((u: string) => String(u).trim().replace(/^@/, '')) : [];
    }

    const leadTelegramUserId = conv.channel_id ? parseInt(conv.channel_id, 10) : undefined;
    if (!leadTelegramUserId || !Number.isInteger(leadTelegramUserId)) {
      return res.status(400).json({ error: 'Lead Telegram user id (channel_id) is missing or invalid' });
    }

    const createRes = await fetch(
      `${BD_ACCOUNTS_SERVICE_URL}/api/bd-accounts/${conv.bd_account_id}/create-shared-chat`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-user-id': user.id || '',
          'x-organization-id': user.organizationId || '',
        },
        body: JSON.stringify({
          title,
          lead_telegram_user_id: leadTelegramUserId,
          extra_usernames: extraUsernames,
        }),
      }
    );
    if (!createRes.ok) {
      const errBody = await createRes.text();
      let errData: { error?: string; message?: string } = {};
      try {
        errData = JSON.parse(errBody);
      } catch (_) {}
      return res.status(createRes.status >= 400 && createRes.status < 500 ? createRes.status : 500).json({
        error: errData.error || 'Failed to create shared chat',
        message: errData.message || errBody,
      });
    }

    const created = (await createRes.json()) as { channelId?: string; title?: string };
    const channelIdRaw = created.channelId;
    const sharedChatChannelId = channelIdRaw != null ? (typeof channelIdRaw === 'string' ? parseInt(channelIdRaw, 10) : Number(channelIdRaw)) : null;
    const sharedChatChannelIdDb = sharedChatChannelId != null && !Number.isNaN(sharedChatChannelId) ? sharedChatChannelId : null;

    await pool.query(
      `UPDATE conversations SET shared_chat_created_at = NOW(), shared_chat_channel_id = $3, updated_at = NOW()
       WHERE id = $1 AND organization_id = $2
       RETURNING id, shared_chat_created_at, shared_chat_channel_id`,
      [conversationId, user.organizationId, sharedChatChannelIdDb]
    );

    const systemContent = `[System] Общий чат создан: ${(created.title ?? title).slice(0, 500)}`;
    await pool.query(
      `INSERT INTO messages (organization_id, bd_account_id, channel, channel_id, contact_id, direction, content, status, unread, metadata)
       VALUES ($1, $2, 'telegram', $3, $4, $5, $6, $7, false, $8)`,
      [
        user.organizationId,
        conv.bd_account_id,
        conv.channel_id,
        conv.contact_id,
        MessageDirection.OUTBOUND,
        systemContent,
        MessageStatus.DELIVERED,
        JSON.stringify({ system: true, event: 'shared_chat_created', title: created.title ?? title }),
      ]
    );

    res.json({
      conversation_id: conversationId,
      shared_chat_created_at: new Date().toISOString(),
      shared_chat_channel_id: sharedChatChannelIdDb != null ? String(sharedChatChannelIdDb) : null,
      channel_id: created.channelId,
      title: created.title ?? title,
    });
  } catch (error) {
    console.error('Error creating shared chat:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PHASE 2.5 §11г — legacy: только метка без создания чата. PHASE 2.6: 409 если уже создан.
app.post('/api/messaging/mark-shared-chat', async (req, res) => {
  try {
    const user = getUser(req);
    const { conversation_id: conversationId } = req.body ?? {};
    if (!conversationId || typeof conversationId !== 'string') {
      return res.status(400).json({ error: 'conversation_id required' });
    }
    const check = await pool.query(
      `SELECT id, shared_chat_created_at FROM conversations WHERE id = $1 AND organization_id = $2 AND lead_id IS NOT NULL`,
      [conversationId, user.organizationId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found or not a lead' });
    }
    const existing = check.rows[0] as { id: string; shared_chat_created_at: Date | null };
    if (existing.shared_chat_created_at != null) {
      return res.status(409).json({ error: 'Shared chat already created for this conversation' });
    }
    const r = await pool.query(
      `UPDATE conversations SET shared_chat_created_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND organization_id = $2 AND lead_id IS NOT NULL
       RETURNING id, shared_chat_created_at`,
      [conversationId, user.organizationId]
    );
    const row = r.rows[0] as { id: string; shared_chat_created_at: Date };
    res.json({
      conversation_id: row.id,
      shared_chat_created_at: row.shared_chat_created_at instanceof Date ? row.shared_chat_created_at.toISOString() : row.shared_chat_created_at,
    });
  } catch (error) {
    console.error('Error marking shared chat:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PHASE 2.7 — Закрыть сделку (Won). Необратимо, с системным сообщением в диалоге.
app.post('/api/messaging/mark-won', async (req, res) => {
  try {
    const user = getUser(req);
    const { conversation_id: conversationId, revenue_amount: revenueAmountRaw } = req.body ?? {};
    if (!conversationId || typeof conversationId !== 'string') {
      return res.status(400).json({ error: 'conversation_id required' });
    }
    const revenueAmount = revenueAmountRaw != null ? parseFloat(String(revenueAmountRaw)) : null;
    if (revenueAmount != null && (Number.isNaN(revenueAmount) || revenueAmount < 0)) {
      return res.status(400).json({ error: 'revenue_amount must be a non-negative number' });
    }

    const check = await pool.query(
      `SELECT id, bd_account_id, channel_id, contact_id, shared_chat_created_at, won_at, lost_at
       FROM conversations WHERE id = $1 AND organization_id = $2 AND lead_id IS NOT NULL`,
      [conversationId, user.organizationId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found or not a lead' });
    }
    const c = check.rows[0] as { id: string; bd_account_id: string; channel_id: string; contact_id: string | null; shared_chat_created_at: Date | null; won_at: Date | null; lost_at: Date | null };
    if (c.won_at != null) {
      return res.status(409).json({ error: 'Deal already marked as won' });
    }
    if (c.lost_at != null) {
      return res.status(409).json({ error: 'Deal already marked as lost' });
    }
    if (c.shared_chat_created_at == null) {
      return res.status(400).json({ error: 'Shared chat must be created before marking as won' });
    }

    const amount = revenueAmount != null ? Math.round(revenueAmount * 100) / 100 : null;
    await pool.query(
      `UPDATE conversations SET won_at = NOW(), revenue_amount = $3, updated_at = NOW()
       WHERE id = $1 AND organization_id = $2`,
      [conversationId, user.organizationId, amount]
    );

    const systemContent = amount != null
      ? `[System] Сделка закрыта. Сумма: ${amount} €`
      : '[System] Сделка закрыта.';
    await pool.query(
      `INSERT INTO messages (organization_id, bd_account_id, channel, channel_id, contact_id, direction, content, status, unread, metadata)
       VALUES ($1, $2, 'telegram', $3, $4, $5, $6, $7, false, $8)`,
      [
        user.organizationId,
        c.bd_account_id,
        c.channel_id,
        c.contact_id,
        MessageDirection.OUTBOUND,
        systemContent,
        MessageStatus.DELIVERED,
        JSON.stringify({ system: true, event: 'deal_won', revenue_amount: amount }),
      ]
    );

    res.json({
      conversation_id: conversationId,
      won_at: new Date().toISOString(),
      revenue_amount: amount,
    });
  } catch (error) {
    console.error('Error marking won:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// PHASE 2.7 — Отметить как потеряно (Lost). Необратимо, с системным сообщением.
app.post('/api/messaging/mark-lost', async (req, res) => {
  try {
    const user = getUser(req);
    const { conversation_id: conversationId, reason } = req.body ?? {};
    if (!conversationId || typeof conversationId !== 'string') {
      return res.status(400).json({ error: 'conversation_id required' });
    }

    const check = await pool.query(
      `SELECT id, bd_account_id, channel_id, contact_id, won_at, lost_at
       FROM conversations WHERE id = $1 AND organization_id = $2 AND lead_id IS NOT NULL`,
      [conversationId, user.organizationId]
    );
    if (check.rows.length === 0) {
      return res.status(404).json({ error: 'Conversation not found or not a lead' });
    }
    const c = check.rows[0] as { id: string; bd_account_id: string; channel_id: string; contact_id: string | null; won_at: Date | null; lost_at: Date | null };
    if (c.won_at != null) {
      return res.status(409).json({ error: 'Deal already marked as won' });
    }
    if (c.lost_at != null) {
      return res.status(409).json({ error: 'Deal already marked as lost' });
    }

    const lossReason = reason != null && typeof reason === 'string' ? reason.trim().slice(0, 2000) : null;
    await pool.query(
      `UPDATE conversations SET lost_at = NOW(), loss_reason = $3, updated_at = NOW()
       WHERE id = $1 AND organization_id = $2`,
      [conversationId, user.organizationId, lossReason]
    );

    const systemContent = lossReason
      ? `[System] Сделка потеряна. Причина: ${lossReason.slice(0, 500)}`
      : '[System] Сделка потеряна.';
    await pool.query(
      `INSERT INTO messages (organization_id, bd_account_id, channel, channel_id, contact_id, direction, content, status, unread, metadata)
       VALUES ($1, $2, 'telegram', $3, $4, $5, $6, $7, false, $8)`,
      [
        user.organizationId,
        c.bd_account_id,
        c.channel_id,
        c.contact_id,
        MessageDirection.OUTBOUND,
        systemContent,
        MessageStatus.DELIVERED,
        JSON.stringify({ system: true, event: 'deal_lost', reason: lossReason }),
      ]
    );

    res.json({
      conversation_id: conversationId,
      lost_at: new Date().toISOString(),
      loss_reason: lossReason,
    });
  } catch (error) {
    console.error('Error marking lost:', error);
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

    await ensureConversation(pool, {
      organizationId: user.organizationId,
      bdAccountId: bdAccountId || null,
      channel,
      channelId,
      contactId,
    });

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

    await pool.query(
      `UPDATE conversations SET first_manager_reply_at = COALESCE(first_manager_reply_at, NOW()), updated_at = NOW()
       WHERE organization_id = $1 AND bd_account_id IS NOT DISTINCT FROM $2 AND channel = $3 AND channel_id = $4`,
      [user.organizationId, bdAccountId || null, channel, channelId]
    );

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

