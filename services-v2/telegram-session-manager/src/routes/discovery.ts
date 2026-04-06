// @ts-nocheck — GramJS types are incomplete
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TelegramClient, Api } from 'telegram';
import { AppError, ErrorCodes, requireUser, DatabasePools } from '@getsale/service-framework';
import { RedisClient } from '@getsale/cache';
import { RabbitMQClient } from '@getsale/queue';
import { Logger } from '@getsale/logger';
import { telegramInvokeWithFloodRetry } from '@getsale/telegram';
import { SessionCoordinator } from '../coordinator';

interface Deps {
  db: DatabasePools;
  rabbitmq: RabbitMQClient;
  log: Logger;
  redis: RedisClient;
  coordinator: SessionCoordinator;
}

const RESOLVE_CHATS_MAX_INPUTS = 20;
const ENRICH_BATCH_MAX = 50;
const ENRICH_DELAY_MS = 80;

const ResolveChatsBody = z.object({
  inputs: z.array(z.string()).max(RESOLVE_CHATS_MAX_INPUTS),
});

const EnrichContactsBody = z.object({
  contactIds: z.array(z.string()).max(ENRICH_BATCH_MAX).optional().default([]),
  bdAccountId: z.string().optional(),
});

function getConnectedClient(
  coordinator: SessionCoordinator,
  accountId: string,
): TelegramClient {
  const actor = coordinator.getActor(accountId);
  if (!actor) {
    throw new AppError(
      503,
      'Telegram session not active on this instance. The account may be managed by another node or not connected.',
      ErrorCodes.SERVICE_UNAVAILABLE,
    );
  }
  if (actor.state === 'reauth_required') {
    throw new AppError(
      403,
      'Telegram session requires re-authentication',
      ErrorCodes.FORBIDDEN,
    );
  }
  if (actor.state !== 'connected') {
    throw new AppError(
      503,
      `Telegram session is currently ${actor.state}`,
      ErrorCodes.SERVICE_UNAVAILABLE,
    );
  }
  const client = actor.getClient();
  if (!client) {
    throw new AppError(
      503,
      'Telegram client is not initialized',
      ErrorCodes.SERVICE_UNAVAILABLE,
    );
  }
  return client;
}

async function verifyAccountOwnership(
  db: DatabasePools,
  accountId: string,
  organizationId: string,
): Promise<void> {
  const result = await db.read.query(
    'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
    [accountId, organizationId],
  );
  if (!result.rows.length) {
    throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
  }
}

function mapChatEntity(c: any): {
  chatId: string;
  title: string;
  peerType: string;
  membersCount: number | undefined;
  username: string | undefined;
} {
  return {
    chatId: String(c.id),
    title: (c.title ?? c.name ?? '').trim(),
    peerType: c.broadcast ? 'channel' : c.megagroup ? 'group' : 'chat',
    membersCount: c.participantsCount ?? c.participants_count ?? undefined,
    username: (c.username ?? '').trim() || undefined,
  };
}

export function registerDiscoveryRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, log, coordinator } = deps;

  /**
   * GET /api/bd-accounts/:id/search-groups
   * Search for Telegram groups/channels by keyword via GramJS contacts.Search.
   */
  app.get('/api/bd-accounts/:id/search-groups', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const { q, limit: limitStr, type } = request.query as { q?: string; limit?: string; type?: string };

    await verifyAccountOwnership(db, id, user.organizationId);

    const query = typeof q === 'string' ? q.trim() : '';
    if (query.length < 2) {
      throw new AppError(400, 'Query must be at least 2 characters', ErrorCodes.VALIDATION);
    }
    if (query.length > 200) {
      throw new AppError(400, 'Query must be at most 200 characters', ErrorCodes.VALIDATION);
    }

    const limit = Math.min(Math.max(parseInt(limitStr || '50', 10) || 50, 1), 100);
    const client = getConnectedClient(coordinator, id);

    const result = await telegramInvokeWithFloodRetry(
      log,
      id,
      'contacts.Search',
      () => client.invoke(new Api.contacts.Search({ q: query, limit })),
    ) as any;

    const chats = (result?.chats ?? []).map(mapChatEntity);

    const users = (result?.users ?? [])
      .filter((u: any) => !u.deleted && !u.bot && !u.self)
      .map((u: any) => ({
        chatId: String(u.id),
        title: [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || String(u.id),
        peerType: 'user',
        membersCount: undefined,
        username: (u.username ?? '').trim() || undefined,
      }));

    if (type === 'groups') return chats;
    if (type === 'users') return users;
    return [...chats, ...users];
  });

  /**
   * GET /api/bd-accounts/:id/admined-public-channels
   * Returns list of public channels/groups this account admins.
   */
  app.get('/api/bd-accounts/:id/admined-public-channels', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;

    await verifyAccountOwnership(db, id, user.organizationId);

    const client = getConnectedClient(coordinator, id);

    const result = await telegramInvokeWithFloodRetry(
      log,
      id,
      'channels.GetAdminedPublicChannels',
      () => client.invoke(new Api.channels.GetAdminedPublicChannels({})),
    ) as any;

    const chats = (result?.chats ?? []).map(mapChatEntity);
    return chats;
  });

  /**
   * POST /api/bd-accounts/:id/resolve-chats
   * Resolve usernames / invite links / numeric ids to stable chat identifiers.
   */
  app.post('/api/bd-accounts/:id/resolve-chats', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const body = ResolveChatsBody.parse(request.body);

    await verifyAccountOwnership(db, id, user.organizationId);

    if (!body.inputs.length) {
      return { results: [] };
    }

    const client = getConnectedClient(coordinator, id);
    const results: {
      input: string;
      resolved: boolean;
      id?: string;
      type?: string;
      username?: string | null;
      title?: string | null;
      firstName?: string | null;
      lastName?: string | null;
      phone?: string | null;
      error?: string;
    }[] = [];

    for (const input of body.inputs) {
      const raw = input.trim();
      if (!raw) {
        results.push({ input, resolved: false, error: 'Empty input' });
        continue;
      }

      try {
        const cleaned = raw.replace(/^@/, '').replace(/^https?:\/\/t\.me\//, '');
        const entity = await telegramInvokeWithFloodRetry(
          log,
          id,
          'getEntity',
          () => client.getEntity(cleaned),
        ) as any;

        const className = entity?.className ?? '';
        let type = 'unknown';
        if (className === 'User') type = 'user';
        else if (className === 'Channel') type = entity.broadcast ? 'channel' : 'group';
        else if (className === 'Chat') type = 'group';

        results.push({
          input,
          resolved: true,
          id: entity.id != null ? String(entity.id) : undefined,
          type,
          username: entity.username ?? null,
          title: entity.title ?? null,
          firstName: entity.firstName ?? entity.first_name ?? null,
          lastName: entity.lastName ?? entity.last_name ?? null,
          phone: entity.phone ?? null,
        });
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        log.warn({ message: 'resolve-chats: failed to resolve', input: raw, error: msg });
        results.push({ input, resolved: false, error: msg });
      }
    }

    return { results };
  });

  /**
   * POST /api/bd-accounts/enrich-contacts
   * Enrich contacts — bdAccountId taken from request body.
   */
  app.post('/api/bd-accounts/enrich-contacts', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const body = EnrichContactsBody.parse(request.body);

    return enrichContacts(db, log, coordinator, user.organizationId, body.contactIds, body.bdAccountId);
  });

  /**
   * POST /api/bd-accounts/:id/enrich-contacts
   * Enrich contacts — bdAccountId taken from URL param.
   */
  app.post('/api/bd-accounts/:id/enrich-contacts', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const body = EnrichContactsBody.parse(request.body);

    await verifyAccountOwnership(db, id, user.organizationId);

    return enrichContacts(db, log, coordinator, user.organizationId, body.contactIds, id);
  });
}

async function enrichContacts(
  db: DatabasePools,
  log: Logger,
  coordinator: SessionCoordinator,
  organizationId: string,
  contactIds: string[],
  bdAccountId?: string,
): Promise<{ enriched: number; total: number; errors: number }> {
  if (!contactIds.length) {
    return { enriched: 0, total: 0, errors: 0 };
  }

  let accountId = bdAccountId ?? null;

  if (accountId) {
    const check = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2 AND is_active = true LIMIT 1',
      [accountId, organizationId],
    );
    if (!check.rows.length) accountId = null;
  }

  if (!accountId) {
    const first = await db.read.query(
      "SELECT id FROM bd_accounts WHERE organization_id = $1 AND is_active = true AND session_string IS NOT NULL LIMIT 1",
      [organizationId],
    );
    accountId = first.rows[0]?.id ?? null;
  }

  if (!accountId) {
    throw new AppError(400, 'No active Telegram account available for enrichment', ErrorCodes.BAD_REQUEST);
  }

  const client = getConnectedClient(coordinator, accountId);

  const contactRows = await db.read.query(
    'SELECT id, telegram_id, username FROM contacts WHERE id = ANY($1::uuid[]) AND organization_id = $2',
    [contactIds, organizationId],
  );

  let enriched = 0;
  let errors = 0;

  for (const row of contactRows.rows as { id: string; telegram_id: string | null; username: string | null }[]) {
    try {
      const tid = row.telegram_id?.trim();
      const username = (row.username ?? '').trim().replace(/^@/, '');

      if (!tid && !username) {
        continue;
      }

      const lookupKey = tid && parseInt(tid, 10) > 0
        ? parseInt(tid, 10)
        : username || null;

      if (!lookupKey) continue;

      const entity = await telegramInvokeWithFloodRetry(
        log,
        accountId!,
        'getEntity(enrich)',
        () => client.getEntity(lookupKey),
      ) as any;

      if (!entity || entity.className !== 'User') continue;

      const u = entity as Api.User;
      const resolvedTid = u.id != null ? String(u.id) : tid;
      const firstName = (u.firstName ?? '').trim();
      const lastName = (u.lastName ?? '').trim() || null;
      const resolvedUsername = (u.username ?? '').trim() || null;
      const phone = (u.phone ?? '').trim() || null;
      const premium = typeof u.premium === 'boolean' ? u.premium : null;

      await db.write.query(
        `UPDATE contacts
         SET first_name  = COALESCE(NULLIF($2, ''), first_name),
             last_name   = COALESCE($3, last_name),
             username     = COALESCE($4, username),
             phone        = COALESCE($5, phone),
             telegram_id  = COALESCE($6, telegram_id),
             premium      = COALESCE($7, premium),
             updated_at   = NOW()
         WHERE id = $1 AND organization_id = $8`,
        [row.id, firstName, lastName, resolvedUsername, phone, resolvedTid, premium, organizationId],
      );

      enriched++;
    } catch (err: any) {
      errors++;
      log.warn({
        message: 'enrich-contacts: failed for contact',
        contactId: row.id,
        error: err?.message ?? String(err),
      });
    }

    if (ENRICH_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, ENRICH_DELAY_MS));
    }
  }

  return { enriched, total: contactRows.rows.length, errors };
}
