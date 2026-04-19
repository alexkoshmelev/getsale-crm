import { FastifyInstance } from 'fastify';
import { requireUser } from '@getsale/service-framework';
import type { MessagingDeps } from '../types';

export function registerInboxRoutes(app: FastifyInstance, deps: MessagingDeps): void {
  const { inbox, db } = deps;

  /**
   * CQRS read path: inbox from Redis sorted set.
   * Falls back to DB if Redis is empty (cold start).
   */
  app.get('/api/messaging/inbox', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { offset = 0, limit = 50 } = request.query as { offset?: number; limit?: number };

    const entries = await inbox.getInbox(user.organizationId, user.id, offset, Math.min(limit, 100));

    if (entries.length > 0) {
      return entries;
    }

    // Fallback: rebuild from DB
    const result = await db.read.query(
      `SELECT c.id as conversation_id, c.updated_at, c.contact_id,
              ct.first_name as contact_first_name, ct.last_name as contact_last_name,
              m.content as last_message, m.created_at as last_message_at,
              (SELECT COUNT(*) FROM messages WHERE channel_id = c.channel_id AND bd_account_id = c.bd_account_id AND organization_id = c.organization_id AND unread = true AND direction = 'inbound')::int as unread_count
       FROM conversations c
       LEFT JOIN contacts ct ON c.contact_id = ct.id
       LEFT JOIN LATERAL (SELECT content, created_at FROM messages WHERE channel_id = c.channel_id AND bd_account_id = c.bd_account_id AND organization_id = c.organization_id ORDER BY created_at DESC LIMIT 1) m ON true
       WHERE c.organization_id = $1
       ORDER BY c.updated_at DESC
       LIMIT $2 OFFSET $3`,
      [user.organizationId, Math.min(limit, 100), offset],
    );

    // Warm the cache
    for (const row of result.rows) {
      await inbox.onMessage({
        orgId: user.organizationId,
        userId: user.id,
        conversationId: row.conversation_id,
        messagePreview: row.last_message || '',
        contactName: [row.contact_first_name, row.contact_last_name].filter(Boolean).join(' '),
        contactId: row.contact_id || '',
        timestamp: new Date(row.last_message_at || row.updated_at).getTime(),
      }).catch(() => {});
    }

    return result.rows.map((r: Record<string, unknown>) => ({
      conversationId: r.conversation_id,
      score: new Date(r.last_message_at as string || r.updated_at as string).getTime(),
      meta: {
        lastMessage: (r.last_message as string) || '',
        unreadCount: r.unread_count || 0,
        contactName: [r.contact_first_name, r.contact_last_name].filter(Boolean).join(' '),
        contactId: r.contact_id || '',
        updatedAt: new Date(r.updated_at as string).getTime(),
      },
    }));
  });

  app.get('/api/messaging/inbox/count', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const total = await inbox.getInboxCount(user.organizationId, user.id);
    const unread = await inbox.getTotalUnread(user.organizationId, user.id);
    return { total, unread };
  });
}
