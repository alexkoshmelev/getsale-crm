import { EventType, type Event } from '@getsale/events';
import type { MessagingDeps } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(s: string): boolean {
  return UUID_RE.test(s.trim());
}

/**
 * Resolves CRM conversation + assignee for inbox updates when events only carry channel + BD account.
 */
async function resolveConversationForInbox(
  db: MessagingDeps['db'],
  organizationId: string,
  bdAccountId: string,
  channel: string,
  channelId: string,
): Promise<{
  conversationId: string;
  userId: string;
  contactName: string;
  contactId: string;
} | null> {
  const result = await db.read.query<{
    conversation_id: string;
    user_id: string | null;
    contact_first_name: string | null;
    contact_last_name: string | null;
    contact_id: string | null;
  }>(
    `SELECT c.id AS conversation_id,
            ba.created_by_user_id::text AS user_id,
            ct.first_name AS contact_first_name,
            ct.last_name AS contact_last_name,
            c.contact_id::text AS contact_id
     FROM conversations c
     JOIN bd_accounts ba ON ba.id = c.bd_account_id
     LEFT JOIN contacts ct ON ct.id = c.contact_id
     WHERE c.organization_id = $1 AND c.bd_account_id = $2 AND c.channel = $3 AND c.channel_id = $4`,
    [organizationId, bdAccountId, channel, channelId],
  );
  const row = result.rows[0];
  if (!row?.user_id) return null;
  const contactName = [row.contact_first_name, row.contact_last_name].filter(Boolean).join(' ').trim();
  return {
    conversationId: row.conversation_id,
    userId: row.user_id,
    contactName,
    contactId: row.contact_id || '',
  };
}

async function refreshInboxForChannel(
  deps: Pick<MessagingDeps, 'db' | 'inbox' | 'log'>,
  organizationId: string,
  bdAccountId: string,
  channel: string,
  channelId: string,
): Promise<void> {
  const { db, inbox, log } = deps;
  const ctx = await resolveConversationForInbox(db, organizationId, bdAccountId, channel, channelId);
  if (!ctx) return;

  const last = await db.read.query<{ content: string | null; created_at: Date; telegram_date: Date | null }>(
    `SELECT content, created_at, telegram_date FROM messages
     WHERE organization_id = $1 AND bd_account_id = $2 AND channel = $3 AND channel_id = $4
     ORDER BY COALESCE(telegram_date, created_at) DESC NULLS LAST LIMIT 1`,
    [organizationId, bdAccountId, channel, channelId],
  );

  if (!last.rows.length) {
    await inbox.removeFromInbox(organizationId, ctx.userId, ctx.conversationId);
    return;
  }

  const preview = (last.rows[0].content || '').slice(0, 200);
  const ts = new Date(last.rows[0].telegram_date || last.rows[0].created_at).getTime();

  try {
    await inbox.onMessage({
      orgId: organizationId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      messagePreview: preview,
      contactName: ctx.contactName,
      contactId: ctx.contactId,
      timestamp: ts,
      incrementUnread: false,
    });
  } catch (err) {
    log.error({ message: 'Inbox refresh failed after message change', error: String(err), channelId });
  }
}

export async function handleMessagingRabbitEvent(event: Event, deps: MessagingDeps): Promise<void> {
  const { db, inbox, log } = deps;
  const data = (event.data || {}) as Record<string, unknown>;
  const organizationId = event.organizationId;

  if (event.type === EventType.MESSAGE_RECEIVED || event.type === EventType.MESSAGE_SENT) {
    const channel = typeof data.channel === 'string' ? data.channel : 'telegram';
    const channelId = typeof data.channelId === 'string' ? data.channelId : '';
    const bdAccountId = typeof data.bdAccountId === 'string' ? data.bdAccountId : '';
    let conversationId = typeof data.conversationId === 'string' ? data.conversationId : '';
    const textRaw = data.text ?? data.content;
    const messagePreview = typeof textRaw === 'string' ? textRaw.slice(0, 200) : '';
    let userId =
      (typeof data.assignedUserId === 'string' && data.assignedUserId) ||
      (typeof event.userId === 'string' && event.userId) ||
      '';
    let contactName = typeof data.contactName === 'string' ? data.contactName : '';
    let contactId = typeof data.contactId === 'string' ? data.contactId : '';

    if ((!conversationId || !userId) && channelId && bdAccountId) {
      const resolved = await resolveConversationForInbox(db, organizationId, bdAccountId, channel, channelId);
      if (resolved) {
        if (!conversationId) conversationId = resolved.conversationId;
        if (!userId) userId = resolved.userId;
        if (!contactName) contactName = resolved.contactName;
        if (!contactId) contactId = resolved.contactId;
      }
    }

    if (!conversationId || !userId) return;

    await inbox.onMessage({
      orgId: organizationId,
      userId,
      conversationId,
      messagePreview,
      contactName,
      contactId,
      timestamp: event.timestamp.getTime(),
      incrementUnread: event.type === EventType.MESSAGE_RECEIVED,
    });
    return;
  }

  if (event.type === EventType.MESSAGE_READ) {
    const conversationId = data.conversationId as string;
    if (conversationId && event.userId) await inbox.markRead(organizationId, event.userId, conversationId);
    return;
  }

  if (event.type === EventType.MESSAGE_DELETED) {
    const messageId = typeof data.messageId === 'string' ? data.messageId : '';
    const bdAccountId = typeof data.bdAccountId === 'string' ? data.bdAccountId : '';
    const channelId = typeof data.channelId === 'string' ? data.channelId : '';

    let channel = 'telegram';
    let chId = channelId;
    let bdId = bdAccountId;

    if (messageId && isUuid(messageId)) {
      const before = await db.read.query<{ channel_id: string; bd_account_id: string | null; channel: string | null }>(
        'SELECT channel_id, bd_account_id, channel FROM messages WHERE id = $1 AND organization_id = $2',
        [messageId, organizationId],
      );
      if (before.rows.length) {
        const row = before.rows[0];
        chId = row.channel_id;
        bdId = row.bd_account_id || bdAccountId;
        channel = row.channel || 'telegram';
      }

      await db.write.query('DELETE FROM messages WHERE id = $1 AND organization_id = $2', [messageId, organizationId]);
    } else if (bdAccountId && channelId) {
      const tgIds = Array.isArray(data.telegramMessageIds)
        ? (data.telegramMessageIds as unknown[]).map((x) => String(x))
        : data.telegramMessageId != null
          ? [String(data.telegramMessageId)]
          : [];
      if (tgIds.length > 0) {
        await db.write.query(
          `DELETE FROM messages
           WHERE organization_id = $1 AND bd_account_id = $2 AND channel_id = $3
             AND telegram_message_id = ANY($4::text[])`,
          [organizationId, bdAccountId, channelId, tgIds],
        );
      }
    }

    if (chId && bdId) {
      await refreshInboxForChannel(deps, organizationId, bdId, channel, chId);
    }
    return;
  }

  if (event.type === EventType.MESSAGE_EDITED) {
    const messageId = typeof data.messageId === 'string' ? data.messageId : '';
    const content = typeof data.content === 'string' ? data.content : undefined;
    const bdAccountId = typeof data.bdAccountId === 'string' ? data.bdAccountId : '';
    const channelId = typeof data.channelId === 'string' ? data.channelId : '';
    const telegramMessageId = data.telegramMessageId;

    let entitiesJson: string | null = null;
    let mediaJson: string | null = null;
    if (data.telegram_entities != null) {
      entitiesJson =
        typeof data.telegram_entities === 'string'
          ? data.telegram_entities
          : JSON.stringify(data.telegram_entities);
    }
    if (data.telegram_media != null) {
      mediaJson = typeof data.telegram_media === 'string' ? data.telegram_media : JSON.stringify(data.telegram_media);
    }

    if (messageId && isUuid(messageId) && content !== undefined) {
      await db.write.query(
        `UPDATE messages SET
           content = $1,
           updated_at = NOW(),
           telegram_entities = COALESCE($2::jsonb, telegram_entities),
           telegram_media = COALESCE($3::jsonb, telegram_media)
         WHERE id = $4 AND organization_id = $5`,
        [content, entitiesJson, mediaJson, messageId, organizationId],
      );
    } else if (bdAccountId && channelId && telegramMessageId != null && content !== undefined) {
      await db.write.query(
        `UPDATE messages SET
           content = $1,
           updated_at = NOW(),
           telegram_entities = COALESCE($2::jsonb, telegram_entities),
           telegram_media = COALESCE($3::jsonb, telegram_media)
         WHERE organization_id = $4 AND bd_account_id = $5 AND channel_id = $6
           AND telegram_message_id::text = $7`,
        [content, entitiesJson, mediaJson, organizationId, bdAccountId, channelId, String(telegramMessageId)],
      );
    } else {
      log.warn({ message: 'MESSAGE_EDITED missing fields for DB update', event_id: event.id });
    }

    if (bdAccountId && channelId) {
      await refreshInboxForChannel(deps, organizationId, bdAccountId, 'telegram', channelId);
    }
    return;
  }
}
