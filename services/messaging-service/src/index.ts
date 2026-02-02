import express from 'express';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, MessageSentEvent } from '@getsale/events';
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
  };
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
            NULLIF(TRIM(COALESCE(s.title, '')), ''),
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
          NULLIF(TRIM(COALESCE(s.title, '')), ''),
          c.telegram_id::text,
          m.channel_id
        ) AS name,
        COUNT(*) FILTER (WHERE m.unread = true) as unread_count,
        (SELECT COALESCE(m2.telegram_date, m2.created_at) FROM messages m2 WHERE m2.organization_id = m.organization_id AND m2.channel = m.channel AND m2.channel_id = m.channel_id AND (m2.bd_account_id IS NOT DISTINCT FROM m.bd_account_id) ORDER BY COALESCE(m2.telegram_date, m2.created_at) DESC LIMIT 1) as last_message_at,
        (SELECT content FROM messages m2 WHERE m2.organization_id = m.organization_id AND m2.channel = m.channel AND m2.channel_id = m.channel_id AND (m2.bd_account_id IS NOT DISTINCT FROM m.bd_account_id) ORDER BY COALESCE(m2.telegram_date, m2.created_at) DESC LIMIT 1) as last_message
      FROM messages m
      LEFT JOIN contacts c ON m.contact_id = c.id
      LEFT JOIN bd_account_sync_chats s ON s.bd_account_id = m.bd_account_id AND s.telegram_chat_id = m.channel_id
      WHERE m.organization_id = $1
    `;

    if (channel) {
      query += ` AND m.channel = $${params.length + 1}`;
      params.push(channel);
    }

    query += `
      GROUP BY m.organization_id, m.channel, m.channel_id, m.bd_account_id, m.contact_id, s.peer_type, c.first_name, c.last_name, c.email, c.telegram_id, c.display_name, c.username, s.title
      ORDER BY last_message_at DESC NULLS LAST
    `;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching chats:', error);
    res.status(500).json({ error: 'Internal server error' });
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

// Send message
app.post('/api/messaging/send', async (req, res) => {
  try {
    const user = getUser(req);
    const { contactId, channel, channelId, content, bdAccountId } = req.body;

    if (!contactId || !channel || !channelId || !content) {
      return res.status(400).json({ error: 'Missing required fields: contactId, channel, channelId, content' });
    }

    // Get contact info to determine organization
    const contactResult = await pool.query(
      'SELECT id, organization_id, telegram_id FROM contacts WHERE id = $1 AND organization_id = $2',
      [contactId, user.organizationId]
    );

    if (contactResult.rows.length === 0) {
      return res.status(404).json({ error: 'Contact not found' });
    }

    const contact = contactResult.rows[0];

    // Save message
    const result = await pool.query(
      `INSERT INTO messages (organization_id, bd_account_id, channel, channel_id, contact_id, direction, content, status, unread, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
      [
        user.organizationId,
        bdAccountId || null,
        channel,
        channelId,
        contactId,
        MessageDirection.OUTBOUND,
        content,
        MessageStatus.PENDING,
        false,
        JSON.stringify({ sentBy: user.id }),
      ]
    );

    const message = result.rows[0];

    // Send via appropriate channel
    let sent = false;
    if (channel === MessageChannel.TELEGRAM) {
      if (!bdAccountId) {
        return res.status(400).json({ error: 'bdAccountId is required for Telegram messages' });
      }

      try {
        // Call BD Accounts Service to send message via Telegram
        const response = await fetch(`${BD_ACCOUNTS_SERVICE_URL}/api/bd-accounts/${bdAccountId}/send`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-User-Id': user.id,
            'X-Organization-Id': user.organizationId,
          },
          body: JSON.stringify({
            chatId: channelId,
            text: content,
          }),
        });

        if (response.ok) {
          await pool.query('UPDATE messages SET status = $1 WHERE id = $2', [
            MessageStatus.DELIVERED,
            message.id,
          ]);
          sent = true;
        } else {
          const errorBody = (await response.json()) as { message?: string };
          throw new Error(errorBody.message || 'Failed to send message');
        }
      } catch (error: any) {
        console.error('Error sending Telegram message:', error);
        await pool.query('UPDATE messages SET status = $1, metadata = $2 WHERE id = $3', [
          MessageStatus.FAILED,
          JSON.stringify({ error: error.message }),
          message.id,
        ]);
        throw error;
      }
    }
    // TODO: Email sending
    // TODO: LinkedIn sending
    // TODO: Twitter sending

    if (!sent) {
      return res.status(400).json({ error: 'Unsupported channel or sending failed' });
    }

    // Publish event
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
      },
    };
    await rabbitmq.publishEvent(event);

    // Get updated message
    const updatedResult = await pool.query('SELECT * FROM messages WHERE id = $1', [message.id]);
    res.json(updatedResult.rows[0]);
  } catch (error: any) {
    console.error('Error sending message:', error);
    res.status(500).json({ 
      error: 'Internal server error',
      message: error.message || 'Failed to send message'
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

app.listen(PORT, () => {
  console.log(`Messaging service running on port ${PORT}`);
});

