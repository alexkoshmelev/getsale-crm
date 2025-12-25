import express from 'express';
import { Pool } from 'pg';
import { Telegraf } from 'telegraf';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, MessageReceivedEvent } from '@getsale/events';
import { MessageChannel, MessageDirection, MessageStatus } from '@getsale/types';

const app = express();
const PORT = process.env.PORT || 3003;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://getsale:getsale_dev@localhost:5432/getsale_crm',
});

const rabbitmq = new RabbitMQClient(
  process.env.RABBITMQ_URL || 'amqp://getsale:getsale_dev@localhost:5672'
);

// Telegram bot (if configured)
let telegramBot: Telegraf | null = null;
if (process.env.TELEGRAM_BOT_TOKEN) {
  telegramBot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN);
}

(async () => {
  try {
    await rabbitmq.connect();
  } catch (error) {
    console.error('Failed to connect to RabbitMQ, service will continue without event publishing:', error);
  }
  await initDatabase();
  if (telegramBot) {
    await initTelegramBot();
  }
})();

async function initDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      organization_id UUID NOT NULL,
      channel VARCHAR(50) NOT NULL,
      channel_id VARCHAR(255) NOT NULL,
      contact_id UUID,
      direction VARCHAR(20) NOT NULL,
      content TEXT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'sent',
      unread BOOLEAN DEFAULT true,
      owner_id UUID,
      metadata JSONB,
      created_at TIMESTAMP DEFAULT NOW(),
      updated_at TIMESTAMP DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_messages_org ON messages(organization_id);
    CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id);
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel, channel_id);
    CREATE INDEX IF NOT EXISTS idx_messages_unread ON messages(organization_id, unread) WHERE unread = true;
  `);
}

async function initTelegramBot() {
  if (!telegramBot) return;

  telegramBot.on('message', async (ctx) => {
    try {
      const message = ctx.message;
      const chatId = String(ctx.chat.id);
      const userId = String(ctx.from?.id);

      // Find contact by telegram_id
      const contactResult = await pool.query(
        'SELECT id, organization_id FROM contacts WHERE telegram_id = $1',
        [userId]
      );

      if (contactResult.rows.length === 0) {
        // Unknown contact - could create or ignore
        return;
      }

      const contact = contactResult.rows[0];
      const text = 'text' in message ? message.text : '';

      // Save message
      const msgResult = await pool.query(
        `INSERT INTO messages (organization_id, channel, channel_id, contact_id, direction, content, status, unread)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
        [
          contact.organization_id,
          MessageChannel.TELEGRAM,
          chatId,
          contact.id,
          MessageDirection.INBOUND,
          text,
          MessageStatus.DELIVERED,
          true,
        ]
      );

      const savedMessage = msgResult.rows[0];

      // Publish event
      const event: MessageReceivedEvent = {
        id: crypto.randomUUID(),
        type: EventType.MESSAGE_RECEIVED,
        timestamp: new Date(),
        organizationId: contact.organization_id,
        data: {
          messageId: savedMessage.id,
          channel: MessageChannel.TELEGRAM,
          contactId: contact.id,
          content: text,
        },
      };
      await rabbitmq.publishEvent(event);
    } catch (error) {
      console.error('Error processing Telegram message:', error);
    }
  });

  await telegramBot.launch();
  console.log('Telegram bot started');
}

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

// Get messages for a contact/channel
app.get('/api/messaging/messages', async (req, res) => {
  try {
    const user = getUser(req);
    const { contactId, channel, channelId } = req.query;

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

    query += ' ORDER BY created_at ASC';

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Send message
app.post('/api/messaging/send', async (req, res) => {
  try {
    const user = getUser(req);
    const { contactId, channel, channelId, content } = req.body;

    // Save message
    const result = await pool.query(
      `INSERT INTO messages (organization_id, channel, channel_id, contact_id, direction, content, status, owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [
        user.organizationId,
        channel,
        channelId,
        contactId,
        MessageDirection.OUTBOUND,
        content,
        MessageStatus.SENT,
        user.id,
      ]
    );

    const message = result.rows[0];

    // Send via appropriate channel
    if (channel === MessageChannel.TELEGRAM && telegramBot) {
      await telegramBot.telegram.sendMessage(channelId, content);
      await pool.query('UPDATE messages SET status = $1 WHERE id = $2', [MessageStatus.DELIVERED, message.id]);
    }
    // TODO: Email sending

    // Publish event
    await rabbitmq.publishEvent({
      id: crypto.randomUUID(),
      type: EventType.MESSAGE_SENT,
      timestamp: new Date(),
      organizationId: user.organizationId,
      userId: user.id,
      data: { messageId: message.id, channel, contactId },
    });

    res.json(message);
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: 'Internal server error' });
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

