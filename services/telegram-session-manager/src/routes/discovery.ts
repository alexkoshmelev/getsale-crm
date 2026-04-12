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
const SEARCH_FLOOD_BACKOFF_MS = 8000;
const PAGINATION_DELAY_MS = 1500;
const SEARCH_SOURCE_DELAY_MS = 400;

type SearchItem = { chatId: string; title: string; peerType: string; membersCount?: number; username?: string };

function extractChatsFromResult(
  result: { messages?: any[]; chats?: any[] },
  chatsAcc: SearchItem[],
  seenIds: Set<string>,
  excludeChatIds: Set<string>,
): void {
  const chats = result?.chats ?? [];
  const messages = result?.messages ?? [];
  for (const msg of messages) {
    const peer = msg?.peer ?? msg?.peerId ?? msg?.peer_id;
    if (!peer) continue;
    const cn = String(peer.className ?? peer.constructor?.className ?? '').toLowerCase();
    let cid: string | null = null;
    if (cn.includes('peerchannel')) {
      const id = peer.channelId ?? peer.channel_id;
      if (id != null) cid = String(id);
    } else if (cn.includes('peerchat')) {
      const id = peer.chatId ?? peer.chat_id;
      if (id != null) cid = String(id);
    }
    if (cid && !seenIds.has(cid) && !excludeChatIds.has(cid)) {
      seenIds.add(cid);
      const chat = chats.find((c: any) => {
        const id = c.id ?? c.channelId ?? c.chat_id ?? c.chatId;
        return id != null && String(id) === cid;
      });
      const title = (chat?.title ?? chat?.name ?? '').trim() || cid;
      const peerType = (chat as any)?.broadcast ? 'channel' : (chat as any)?.megagroup ? 'group' : 'chat';
      const membersCount = chat?.participantsCount ?? chat?.participants_count ?? undefined;
      const username = (chat?.username ?? '').trim() || undefined;
      chatsAcc.push({ chatId: cid, title, peerType, membersCount, username });
    }
  }
  for (const c of chats) {
    const id = c.id ?? c.channelId ?? c.chat_id ?? c.chatId;
    if (id == null) continue;
    const cid = String(id);
    const cn = String(c.className ?? c.constructor?.className ?? '').toLowerCase();
    const isChannel = cn.includes('channel');
    const isChat = cn.includes('chat') && !cn.includes('peer');
    if (!isChannel && !isChat) continue;
    if (seenIds.has(cid) || excludeChatIds.has(cid)) continue;
    seenIds.add(cid);
    const title = (c.title ?? c.name ?? '').trim() || cid;
    const peerType = (c as any)?.broadcast ? 'channel' : (c as any)?.megagroup ? 'group' : 'chat';
    const membersCount = c?.participantsCount ?? c?.participants_count ?? undefined;
    const username = (c?.username ?? '').trim() || undefined;
    chatsAcc.push({ chatId: cid, title, peerType, membersCount, username });
  }
}

async function searchGlobal(
  log: Logger,
  accountId: string,
  client: TelegramClient,
  q: string,
  limit: number,
  type: 'groups' | 'channels' | 'all',
  maxPages: number,
): Promise<SearchItem[]> {
  const groupsOnly = type === 'groups';
  const broadcastOnly = type === 'channels';
  const requestLimit = Math.min(100, Math.max(1, limit));
  const seen = new Set<string>();
  const out: SearchItem[] = [];
  let offsetRate = 0;
  let offsetPeer: any = new Api.InputPeerEmpty();
  let offsetId = 0;
  let page = 0;

  const myChatIds = new Set<string>();
  try {
    const dialogs = await client.getDialogs({ limit: 150, folderId: 0 });
    for (const d of dialogs) {
      const ent = (d as any).entity;
      if (!ent) continue;
      const cls = String(ent.className ?? ent.constructor?.className ?? '').toLowerCase();
      if (cls.includes('channel') || cls.includes('chat')) {
        const id = ent.id ?? ent.channelId ?? ent.chatId;
        if (id != null) myChatIds.add(String(id));
      }
    }
  } catch {
    log.warn({ message: 'Could not load dialogs for search filter', accountId });
  }

  while (page < maxPages) {
    let result: any;
    result = await telegramInvokeWithFloodRetry(log, accountId, 'SearchGlobal', () =>
      (client as any).invoke(
        new Api.messages.SearchGlobal({
          q,
          filter: new Api.InputMessagesFilterEmpty(),
          minDate: 0,
          maxDate: 0,
          offsetRate,
          offsetPeer,
          offsetId,
          limit: requestLimit,
          folderId: 0,
          broadcastOnly,
          groupsOnly,
          samePeer: false,
        }),
      ),
    );

    const searchFlood = !!(result?.searchFlood ?? result?.search_flood);
    if (searchFlood) {
      log.warn({ message: 'SearchGlobal search_flood, backing off', accountId, query: q, page });
      await new Promise((r) => setTimeout(r, SEARCH_FLOOD_BACKOFF_MS));
      result = await telegramInvokeWithFloodRetry(log, accountId, 'SearchGlobal(retry)', () =>
        (client as any).invoke(
          new Api.messages.SearchGlobal({
            q,
            filter: new Api.InputMessagesFilterEmpty(),
            minDate: 0,
            maxDate: 0,
            offsetRate,
            offsetPeer,
            offsetId,
            limit: requestLimit,
            folderId: 0,
            broadcastOnly,
            groupsOnly,
            samePeer: false,
          }),
        ),
      );
      if (result?.searchFlood ?? result?.search_flood) return out;
    }

    extractChatsFromResult(result, out, seen, myChatIds);

    const messages = result?.messages ?? [];
    const isSlice = result?.className === 'messages.messagesSlice' || result?.constructor?.className === 'messages.messagesSlice';
    if (out.length >= limit) break;
    if (!isSlice || messages.length === 0) break;

    const nextRate = result?.nextRate ?? result?.next_rate;
    if (nextRate == null) break;

    const lastMsg = messages[messages.length - 1];
    offsetRate = typeof nextRate === 'number' ? nextRate : Number(nextRate) || 0;
    offsetId = lastMsg?.id ?? offsetId;
    try {
      const lastPeer = lastMsg?.peer ?? lastMsg?.peerId ?? lastMsg?.peer_id;
      if (lastPeer) offsetPeer = await client.getInputEntity(lastPeer);
    } catch {
      break;
    }

    page++;
    await new Promise((r) => setTimeout(r, PAGINATION_DELAY_MS));
  }

  return out;
}

async function searchPosts(
  log: Logger,
  accountId: string,
  client: TelegramClient,
  q: string,
  limit: number,
  maxPages: number,
  searchMode: 'query' | 'hashtag',
): Promise<SearchItem[]> {
  const requestLimit = Math.min(100, Math.max(1, limit));
  const seen = new Set<string>();
  const out: SearchItem[] = [];
  let offsetRate = 0;
  let offsetPeer: any = new Api.InputPeerEmpty();
  let offsetId = 0;
  let page = 0;
  const emptyExclude = new Set<string>();

  while (page < maxPages) {
    let result: any;
    const invokeArgs: any = searchMode === 'hashtag'
      ? { hashtag: (q.startsWith('#') ? q.slice(1) : q).trim() || ' ', offsetRate, offsetPeer: offsetPeer ?? new Api.InputPeerEmpty(), offsetId, limit: requestLimit }
      : { query: q, hashtag: '', offsetRate, offsetPeer: offsetPeer ?? new Api.InputPeerEmpty(), offsetId, limit: requestLimit };

    result = await telegramInvokeWithFloodRetry(log, accountId, 'SearchPosts', () =>
      (client as any).invoke(new Api.channels.SearchPosts(invokeArgs)),
    );

    const searchFlood = !!(result?.searchFlood ?? result?.search_flood);
    if (searchFlood) {
      log.warn({ message: 'SearchPosts search_flood, backing off', accountId, query: q, page });
      await new Promise((r) => setTimeout(r, SEARCH_FLOOD_BACKOFF_MS));
      result = await telegramInvokeWithFloodRetry(log, accountId, 'SearchPosts(retry)', () =>
        (client as any).invoke(new Api.channels.SearchPosts(invokeArgs)),
      );
      if (result?.searchFlood ?? result?.search_flood) return out;
    }

    extractChatsFromResult(result, out, seen, emptyExclude);

    const messages = result?.messages ?? [];
    const isSlice = result?.className === 'messages.messagesSlice' || result?.constructor?.className === 'messages.messagesSlice';
    if (out.length >= limit) break;
    if (!isSlice || messages.length === 0) break;

    const nextRate = result?.nextRate ?? result?.next_rate;
    if (nextRate == null) break;

    const lastMsg = messages[messages.length - 1];
    offsetRate = typeof nextRate === 'number' ? nextRate : Number(nextRate) || 0;
    offsetId = lastMsg?.id ?? offsetId;
    try {
      const lastPeer = lastMsg?.peer ?? lastMsg?.peerId ?? lastMsg?.peer_id;
      if (lastPeer) offsetPeer = await client.getInputEntity(lastPeer);
    } catch {
      break;
    }

    page++;
    await new Promise((r) => setTimeout(r, PAGINATION_DELAY_MS));
  }

  return out;
}

async function searchByContacts(
  log: Logger,
  accountId: string,
  client: TelegramClient,
  q: string,
  limit: number,
): Promise<SearchItem[]> {
  const requestLimit = Math.min(100, Math.max(1, limit));
  const seen = new Set<string>();
  const out: SearchItem[] = [];

  const result = (await telegramInvokeWithFloodRetry(log, accountId, 'contacts.Search', () =>
    (client as any).invoke(new Api.contacts.Search({ q, limit: requestLimit })),
  )) as any;

  const allPeers = [...(result?.my_results ?? []), ...(result?.results ?? [])];
  const chats = result?.chats ?? [];

  for (const peer of allPeers) {
    const cn = String(peer?.className ?? peer?.constructor?.className ?? '').toLowerCase();
    if (cn.includes('peeruser')) continue;
    let cid: string | null = null;
    if (cn.includes('peerchannel')) {
      const id = peer.channelId ?? peer.channel_id;
      if (id != null) cid = String(id);
    } else if (cn.includes('peerchat')) {
      const id = peer.chatId ?? peer.chat_id;
      if (id != null) cid = String(id);
    }
    if (!cid || seen.has(cid)) continue;
    seen.add(cid);
    const chat = chats.find((c: any) => {
      const id = c.id ?? c.channelId ?? c.chat_id ?? c.chatId;
      return id != null && String(id) === cid;
    });
    const title = (chat?.title ?? chat?.name ?? '').trim() || cid;
    const peerType = (chat as any)?.broadcast ? 'channel' : (chat as any)?.megagroup ? 'group' : 'chat';
    const membersCount = chat?.participantsCount ?? chat?.participants_count ?? undefined;
    const username = (chat?.username ?? '').trim() || undefined;
    out.push({ chatId: cid, title, peerType, membersCount, username });
  }

  return out;
}

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
   * Search for Telegram groups/channels using SearchGlobal, SearchPosts, and contacts.Search.
   * Matches v1 behavior with multi-page pagination and result merging.
   */
  app.get('/api/bd-accounts/:id/search-groups', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    const { q, limit: limitStr, type: typeParam, maxPages: maxPagesStr } = request.query as {
      q?: string; limit?: string; type?: string; maxPages?: string;
    };

    await verifyAccountOwnership(db, id, user.organizationId);

    const query = typeof q === 'string' ? q.trim() : '';
    if (query.length < 2) {
      throw new AppError(400, 'Query must be at least 2 characters', ErrorCodes.VALIDATION);
    }
    if (query.length > 200) {
      throw new AppError(400, 'Query must be at most 200 characters', ErrorCodes.VALIDATION);
    }

    const limit = Math.min(Math.max(parseInt(limitStr || '50', 10) || 50, 1), 100);
    const maxPages = Math.min(15, Math.max(1, parseInt(maxPagesStr || '10', 10) || 10));
    const type = (typeParam || 'all').toLowerCase();
    const searchMode = (query.startsWith('#') || (request.query as any).searchMode === 'hashtag') ? 'hashtag' as const : 'query' as const;
    const client = getConnectedClient(coordinator, id);

    let groups: SearchItem[];

    if (type === 'groups') {
      groups = await searchGlobal(log, id, client, query, limit, 'groups', maxPages);
      try {
        await new Promise((r) => setTimeout(r, SEARCH_SOURCE_DELAY_MS));
        const fromContacts = await searchByContacts(log, id, client, query, limit);
        const onlyGroups = fromContacts.filter((item) => item.peerType === 'chat' || item.peerType === 'group');
        const seenIds = new Set(groups.map((g) => g.chatId));
        for (const item of onlyGroups) {
          if (!seenIds.has(item.chatId)) {
            seenIds.add(item.chatId);
            groups.push(item);
          }
        }
      } catch (e: any) {
        log.warn({ message: 'contacts.Search failed for type=groups', accountId: id, query, error: e?.message });
      }
      groups = groups.slice(0, limit);
    } else if (type === 'channels') {
      groups = await searchPosts(log, id, client, query, limit, maxPages, searchMode);
      groups = groups.slice(0, limit);
    } else {
      groups = await searchPosts(log, id, client, query, limit, maxPages, searchMode);
      try {
        await new Promise((r) => setTimeout(r, SEARCH_SOURCE_DELAY_MS));
        const fromContacts = await searchByContacts(log, id, client, query, limit);
        const seenIds = new Set(groups.map((g) => g.chatId));
        for (const item of fromContacts) {
          if (!seenIds.has(item.chatId)) {
            seenIds.add(item.chatId);
            groups.push(item);
          }
        }
      } catch (e: any) {
        log.warn({ message: 'contacts.Search failed, returning SearchPosts only', accountId: id, query, error: e?.message });
      }
      groups = groups.slice(0, limit);
    }

    return groups;
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

  /**
   * GET /api/bd-accounts/:id/chats/:chatId/participants
   * Fetch participants of a Telegram group/channel via GramJS.
   */
  app.get('/api/bd-accounts/:id/chats/:chatId/participants', { preHandler: [requireUser] }, async (request) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const user = request.user!;
    const { limit: limitStr, offset: offsetStr, excludeAdmins, username: usernameParam } = request.query as {
      limit?: string; offset?: string; excludeAdmins?: string; username?: string;
    };

    await verifyAccountOwnership(db, id, user.organizationId);

    const limit = Math.min(200, Math.max(1, parseInt(limitStr || '200', 10) || 200));
    const offset = Math.max(0, parseInt(offsetStr || '0', 10) || 0);
    const filterAdmins = excludeAdmins === 'true' || excludeAdmins === '1';
    const chatUsername = (usernameParam || '').replace(/^@/, '').trim();

    const client = getConnectedClient(coordinator, id);

    try {
      let entity: any = null;
      let isChannel = false;
      let isBasicGroup = false;

      const syncRow = await db.read.query(
        `SELECT peer_type, access_hash FROM bd_account_sync_chats
         WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1`,
        [id, chatId],
      );

      if (syncRow.rows.length > 0) {
        const { peer_type, access_hash } = syncRow.rows[0] as { peer_type: string | null; access_hash: string | null };
        const numId = BigInt(chatId);

        if (peer_type === 'channel' || peer_type === 'supergroup') {
          const ah = access_hash ? BigInt(access_hash) : BigInt(0);
          entity = new Api.InputPeerChannel({ channelId: numId, accessHash: ah });
          isChannel = true;
        } else if (peer_type === 'chat') {
          entity = new Api.InputPeerChat({ chatId: numId });
          isBasicGroup = true;
        } else if (peer_type === 'user') {
          const ah = access_hash ? BigInt(access_hash) : BigInt(0);
          entity = new Api.InputPeerUser({ userId: numId, accessHash: ah });
        } else {
          const ah = access_hash ? BigInt(access_hash) : BigInt(0);
          entity = new Api.InputPeerChannel({ channelId: numId, accessHash: ah });
          isChannel = true;
        }
      }

      if (!entity && chatUsername) {
        try {
          entity = await client.getEntity(chatUsername);
          const cn = String(entity?.className ?? '').toLowerCase();
          if (cn === 'channel' || entity?.megagroup) isChannel = true;
          else if (cn === 'chat') isBasicGroup = true;
          else isChannel = true;
        } catch (e) {
          log.warn({ message: 'Username entity resolution failed', chatId, username: chatUsername, error: String(e) });
        }
      }

      if (!entity) {
        try {
          entity = await client.getEntity(`-100${chatId}`);
          isChannel = true;
        } catch {
          try {
            entity = await client.getEntity(`-${chatId}`);
            isBasicGroup = true;
          } catch {
            try {
              await client.getDialogs({ limit: 100 });
              entity = await client.getEntity(`-100${chatId}`);
              isChannel = true;
            } catch {
              throw new AppError(404, `Chat ${chatId} not found or not accessible`, ErrorCodes.NOT_FOUND);
            }
          }
        }
        const cn = String(entity?.className ?? '').toLowerCase();
        if (cn === 'channel' || entity?.megagroup) isChannel = true;
        else if (cn === 'chat') isBasicGroup = true;
      }

      if (isChannel) {
        let channelInput: any = entity;
        if (entity instanceof Api.InputPeerChannel) {
          channelInput = new Api.InputChannel({ channelId: entity.channelId, accessHash: entity.accessHash });
        }
        const result = await telegramInvokeWithFloodRetry(
          log, id, 'GetParticipants',
          () => client.invoke(new Api.channels.GetParticipants({
            channel: channelInput,
            filter: new Api.ChannelParticipantsRecent(),
            offset,
            limit,
            hash: BigInt(0),
          })),
        ) as any;

        const users = (result?.users ?? [])
          .filter((u: any) => !u.deleted && !u.bot && !u.fake && !u.scam)
          .filter((u: any) => {
            if (!filterAdmins) return true;
            const participant = (result?.participants ?? []).find((p: any) =>
              (p.userId ?? p.user_id) === u.id
            );
            if (!participant) return true;
            const cn = String(participant.className || '').toLowerCase();
            return !cn.includes('admin') && !cn.includes('creator');
          })
          .map((u: any) => ({
            userId: String(u.id),
            firstName: (u.firstName ?? '').trim(),
            lastName: (u.lastName ?? '').trim(),
            username: (u.username ?? '').trim() || null,
            phone: (u.phone ?? '').trim() || null,
          }));

        return { participants: users, nextOffset: users.length >= limit ? offset + limit : null };
      }

      if (isBasicGroup) {
        const groupChatId = entity instanceof Api.InputPeerChat ? entity.chatId : (entity.id ?? BigInt(chatId));
        const full = await telegramInvokeWithFloodRetry(
          log, id, 'GetFullChat',
          () => client.invoke(new Api.messages.GetFullChat({ chatId: groupChatId })),
        ) as any;

        const participants = full?.fullChat?.participants?.participants ?? [];
        const userMap = new Map<number, any>();
        for (const u of (full?.users ?? [])) {
          if (u.id != null) userMap.set(Number(u.id), u);
        }

        const users = participants
          .filter((p: any) => {
            if (!filterAdmins) return true;
            const cn = String(p.className || '').toLowerCase();
            return !cn.includes('admin') && !cn.includes('creator');
          })
          .map((p: any) => {
            const uid = p.userId ?? p.user_id;
            const u = userMap.get(Number(uid));
            if (!u || u.deleted || u.bot || u.fake || u.scam) return null;
            return {
              userId: String(uid),
              firstName: (u.firstName ?? '').trim(),
              lastName: (u.lastName ?? '').trim(),
              username: (u.username ?? '').trim() || null,
              phone: (u.phone ?? '').trim() || null,
            };
          })
          .filter(Boolean);

        return { participants: users, nextOffset: null };
      }

      return { participants: [], nextOffset: null };
    } catch (err: any) {
      const msg = err?.message ?? String(err);
      if (msg.includes('CHAT_ADMIN_REQUIRED')) {
        throw new AppError(403, 'No permission to get participants', ErrorCodes.FORBIDDEN);
      }
      if (msg.includes('CHANNEL_PRIVATE')) {
        throw new AppError(404, 'Channel is private', ErrorCodes.NOT_FOUND);
      }
      throw err;
    }
  });

  // ── Active Participants (message history scan) ─────────────────────────

  app.get('/api/bd-accounts/:id/chats/:chatId/active-participants', { preHandler: [requireUser] }, async (request) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const user = request.user!;
    const { depth: depthStr, excludeAdmins, username: usernameParam } = request.query as {
      depth?: string; excludeAdmins?: string; username?: string;
    };

    await verifyAccountOwnership(db, id, user.organizationId);

    const depth = Math.min(2000, Math.max(20, parseInt(depthStr || '200', 10) || 200));
    const filterAdmins = excludeAdmins === 'true' || excludeAdmins === '1';
    const chatUsername = (usernameParam || '').replace(/^@/, '').trim();

    const client = getConnectedClient(coordinator, id);

    let entity: any = null;
    if (chatUsername) {
      try { entity = await client.getEntity(chatUsername); } catch { /* fallback below */ }
    }
    if (!entity) {
      entity = await resolveEntityForChat(client, db, id, chatId);
    }
    if (!entity) throw new AppError(404, `Chat ${chatId} not found`, ErrorCodes.NOT_FOUND);

    const uniqueUsers = new Map<string, any>();
    let offsetId = 0;
    let fetched = 0;

    while (fetched < depth) {
      const fetchLimit = Math.min(100, depth - fetched);
      const result = await telegramInvokeWithFloodRetry(log, id, 'GetHistory(active)', () =>
        client.invoke(new Api.messages.GetHistory({
          peer: entity,
          offsetId,
          offsetDate: 0,
          addOffset: 0,
          limit: fetchLimit,
          maxId: 0,
          minId: 0,
          hash: BigInt(0),
        })),
      ) as any;

      const messages = result?.messages || [];
      const users = result?.users || [];
      if (messages.length === 0) break;

      const usersMap = new Map<string, any>();
      for (const u of users) {
        const uid = u?.id ?? u?.userId;
        if (uid != null) usersMap.set(String(uid), u);
      }

      for (const msg of messages) {
        const fromId = msg?.fromId;
        if (fromId && (fromId.className === 'PeerUser' || fromId.userId != null)) {
          const uid = String(fromId.userId ?? fromId.user_id ?? '');
          if (uid && !uniqueUsers.has(uid) && usersMap.has(uid)) {
            uniqueUsers.set(uid, usersMap.get(uid));
          }
        }
      }

      fetched += messages.length;
      offsetId = messages[messages.length - 1].id;
    }

    let usersResult = Array.from(uniqueUsers.values())
      .filter((u: any) => !u.deleted && !u.bot && !u.fake && !u.scam)
      .map((u: any) => ({
        userId: String(u.id ?? u.userId ?? ''),
        firstName: (u.firstName ?? '').trim(),
        lastName: (u.lastName ?? '').trim(),
        username: (u.username ?? '').trim() || null,
        phone: (u.phone ?? '').trim() || null,
      }))
      .filter((u) => u.userId !== '');

    if (filterAdmins) {
      try {
        const cn = String(entity?.className ?? '').toLowerCase();
        if (cn === 'channel' || entity?.megagroup) {
          const channelInput = entity instanceof Api.InputPeerChannel
            ? new Api.InputChannel({ channelId: entity.channelId, accessHash: entity.accessHash })
            : entity;
          const adminResult = await telegramInvokeWithFloodRetry(log, id, 'GetParticipants(admins)', () =>
            client.invoke(new Api.channels.GetParticipants({
              channel: channelInput,
              filter: new Api.ChannelParticipantsAdmins(),
              offset: 0,
              limit: 100,
              hash: BigInt(0),
            })),
          ) as any;
          const adminIds = new Set(
            (adminResult?.participants || []).map((p: any) => String(p.userId ?? '')).filter(Boolean),
          );
          usersResult = usersResult.filter((u) => !adminIds.has(u.userId));
        }
      } catch {
        log.warn({ message: 'Failed to fetch admins for exclusion (active-participants)', accountId: id });
      }
    }

    return { participants: usersResult, nextOffset: null };
  });

  // ── Comment Participants (channel post replies) ────────────────────────

  app.get('/api/bd-accounts/:id/chats/:chatId/comment-participants', { preHandler: [requireUser] }, async (request) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const user = request.user!;
    const { linkedChatId, postLimit: postLimitStr, maxRepliesPerPost: maxRepliesStr, excludeAdmins, username: usernameParam } = request.query as {
      linkedChatId?: string; postLimit?: string; maxRepliesPerPost?: string; excludeAdmins?: string; username?: string;
    };

    await verifyAccountOwnership(db, id, user.organizationId);

    const postLimit = Math.min(100, Math.max(5, parseInt(postLimitStr || '40', 10) || 40));
    const maxRepliesPerPost = Math.min(500, Math.max(20, parseInt(maxRepliesStr || '80', 10) || 80));
    const filterAdmins = excludeAdmins === 'true' || excludeAdmins === '1';
    const chatUsername = (usernameParam || '').replace(/^@/, '').trim();

    const client = getConnectedClient(coordinator, id);

    let channelEntity: any = null;
    if (chatUsername) {
      try { channelEntity = await client.getEntity(chatUsername); } catch { /* fallback below */ }
    }
    if (!channelEntity) {
      channelEntity = await resolveEntityForChat(client, db, id, chatId);
    }
    if (!channelEntity) throw new AppError(404, `Channel ${chatId} not found`, ErrorCodes.NOT_FOUND);

    const cn = String(channelEntity?.className ?? '').toLowerCase();
    if (cn !== 'channel' && !channelEntity?.broadcast && !channelEntity?.megagroup) {
      throw new AppError(400, 'Not a channel', ErrorCodes.BAD_REQUEST);
    }

    let inputPeer: any;
    try {
      inputPeer = await client.getInputEntity(channelEntity);
    } catch {
      inputPeer = channelEntity;
    }

    const posts = await telegramInvokeWithFloodRetry(log, id, 'GetHistory(posts)', () =>
      client.invoke(new Api.messages.GetHistory({
        peer: channelEntity,
        offsetId: 0,
        offsetDate: 0,
        addOffset: 0,
        limit: postLimit,
        maxId: 0,
        minId: 0,
        hash: BigInt(0),
      })),
    ) as any;

    const postMessages = (posts?.messages || []).filter((m: any) => m?.id);
    const uniqueUsers = new Map<string, any>();

    let adminIds: Set<string> | null = null;
    if (filterAdmins) {
      try {
        const channelInput = channelEntity instanceof Api.InputPeerChannel
          ? new Api.InputChannel({ channelId: channelEntity.channelId, accessHash: channelEntity.accessHash })
          : channelEntity;
        const adminResult = await telegramInvokeWithFloodRetry(log, id, 'GetParticipants(admins,comment)', () =>
          client.invoke(new Api.channels.GetParticipants({
            channel: channelInput,
            filter: new Api.ChannelParticipantsAdmins(),
            offset: 0,
            limit: 200,
            hash: BigInt(0),
          })),
        ) as any;
        adminIds = new Set(
          (adminResult?.participants || []).map((p: any) => String(p.userId ?? '')).filter(Boolean),
        );
      } catch {
        adminIds = new Set();
      }
    }

    const MAX_PAGES = 8;
    for (const post of postMessages) {
      const msgId = post.id;
      if (msgId == null) continue;

      let collected = 0;
      let replyOffsetId = 0;
      let replyOffsetDate = 0;
      let pages = 0;

      while (collected < maxRepliesPerPost && pages < MAX_PAGES) {
        pages++;
        const pageLimit = Math.min(100, maxRepliesPerPost - collected);
        if (pageLimit <= 0) break;

        try {
          const batch = await telegramInvokeWithFloodRetry(log, id, `GetReplies(post=${msgId},p=${pages})`, () =>
            client.invoke(new Api.messages.GetReplies({
              peer: inputPeer,
              msgId,
              offsetId: replyOffsetId,
              offsetDate: replyOffsetDate,
              addOffset: 0,
              offset: 0,
              limit: pageLimit,
              maxId: 0,
              minId: 0,
              hash: BigInt(0),
            })),
          ) as any;

          const messages = batch?.messages || [];
          const users = batch?.users || [];
          const usersMap = new Map<string, any>();
          for (const u of users) {
            const uid = u?.id ?? u?.userId;
            if (uid != null) usersMap.set(String(uid), u);
          }

          for (const m of messages) {
            const fromId = m?.fromId;
            let uid: string | null = null;
            if (fromId && (fromId.className === 'PeerUser' || fromId.userId != null)) {
              uid = String(fromId.userId ?? fromId.user_id ?? '');
            }
            if (!uid || uniqueUsers.has(uid)) continue;
            const u = usersMap.get(uid);
            if (!u || u.deleted || u.bot || u.fake || u.scam) continue;
            if (adminIds && adminIds.has(uid)) continue;
            uniqueUsers.set(uid, {
              userId: uid,
              firstName: (u.firstName ?? '').trim(),
              lastName: (u.lastName ?? '').trim(),
              username: (u.username ?? '').trim() || null,
              phone: (u.phone ?? '').trim() || null,
            });
            collected++;
          }

          if (messages.length < pageLimit) break;
          const last = messages[messages.length - 1];
          replyOffsetId = last.id;
          replyOffsetDate = last.date ?? 0;
        } catch (e: any) {
          log.warn({ message: 'GetReplies failed for post', accountId: id, chatId, msgId, error: String(e) });
          break;
        }
      }
    }

    return { participants: Array.from(uniqueUsers.values()) };
  });

  // ── Reaction Participants (reaction users on posts) ────────────────────

  app.get('/api/bd-accounts/:id/chats/:chatId/reaction-participants', { preHandler: [requireUser] }, async (request) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const user = request.user!;
    const { depth: depthStr, username: usernameParam } = request.query as {
      depth?: string; username?: string;
    };

    await verifyAccountOwnership(db, id, user.organizationId);

    const historyLimit = Math.min(200, Math.max(20, parseInt(depthStr || '80', 10) || 80));
    const chatUsername = (usernameParam || '').replace(/^@/, '').trim();

    const client = getConnectedClient(coordinator, id);

    let entity: any = null;
    if (chatUsername) {
      try { entity = await client.getEntity(chatUsername); } catch { /* fallback below */ }
    }
    if (!entity) {
      entity = await resolveEntityForChat(client, db, id, chatId);
    }
    if (!entity) throw new AppError(404, `Chat ${chatId} not found`, ErrorCodes.NOT_FOUND);

    let inputPeer: any;
    try { inputPeer = await client.getInputEntity(entity); } catch { inputPeer = entity; }

    const hist = await telegramInvokeWithFloodRetry(log, id, 'GetHistory(reactions)', () =>
      client.invoke(new Api.messages.GetHistory({
        peer: entity,
        offsetId: 0,
        offsetDate: 0,
        addOffset: 0,
        limit: historyLimit,
        maxId: 0,
        minId: 0,
        hash: BigInt(0),
      })),
    ) as any;

    let messages = (hist?.messages || []).filter((m: any) => m?.id && (m.reactions || m.reactionsCount));

    const MAX_MESSAGES_WITH_REACTIONS = 12;
    const REACTORS_PER_MESSAGE = 40;
    const MAX_IDS_FOR_VIEWS = 48;

    const ViewsCtor = (Api.messages as any).GetMessagesViews;
    if (typeof ViewsCtor === 'function' && messages.length > 0) {
      const ids = messages.slice(0, MAX_IDS_FOR_VIEWS).map((m: any) => m.id).filter(Boolean);
      if (ids.length > 0) {
        try {
          const mv = await telegramInvokeWithFloodRetry(log, id, 'GetMessagesViews', () =>
            client.invoke(new ViewsCtor({ peer: inputPeer, id: ids, increment: false })),
          ) as any;
          const viewRows = mv?.views || [];
          const idToViews = new Map<number, number>();
          for (let i = 0; i < ids.length && i < viewRows.length; i++) {
            const v = viewRows[i]?.views;
            if (typeof v === 'number') idToViews.set(ids[i], v);
          }
          messages = messages.map((m: any) => {
            const refreshed = idToViews.get(m.id);
            return refreshed != null ? { ...m, views: refreshed } : m;
          });
        } catch { /* use views from GetHistory */ }
      }
    }

    messages.sort((a: any, b: any) => {
      const dv = (b.views ?? 0) - (a.views ?? 0);
      return dv !== 0 ? dv : (b.id ?? 0) - (a.id ?? 0);
    });
    const slice = messages.slice(0, MAX_MESSAGES_WITH_REACTIONS);

    const ReactionListCtor = (Api.messages as any).GetMessageReactionsList;
    if (typeof ReactionListCtor !== 'function') {
      log.warn({ message: 'GetMessageReactionsList not available in this GramJS build', accountId: id, chatId });
      return { participants: [] };
    }

    const byId = new Map<string, any>();

    for (const msg of slice) {
      try {
        const res = await telegramInvokeWithFloodRetry(log, id, `GetMessageReactionsList(${msg.id})`, () =>
          client.invoke(new ReactionListCtor({
            peer: inputPeer,
            id: msg.id,
            limit: REACTORS_PER_MESSAGE,
            offset: '',
          })),
        ) as any;
        const users = res?.users || [];
        for (const u of users) {
          const uid = u?.id != null ? String(u.id) : '';
          if (!uid || u.deleted || u.bot || u.fake || u.scam || byId.has(uid)) continue;
          byId.set(uid, {
            userId: uid,
            firstName: (u.firstName ?? '').trim(),
            lastName: (u.lastName ?? '').trim(),
            username: (u.username ?? '').trim() || null,
            phone: (u.phone ?? '').trim() || null,
          });
        }
      } catch (e: any) {
        log.warn({ message: 'GetMessageReactionsList failed', accountId: id, chatId, msgId: msg.id, error: String(e) });
      }
    }

    return { participants: Array.from(byId.values()) };
  });

  // ── Leave Chat ─────────────────────────────────────────────────────────

  app.post('/api/bd-accounts/:id/chats/:chatId/leave', { preHandler: [requireUser] }, async (request, reply) => {
    const { id, chatId } = request.params as { id: string; chatId: string };
    const user = request.user!;

    await verifyAccountOwnership(db, id, user.organizationId);

    const client = getConnectedClient(coordinator, id);

    let inputChannel: any;
    try {
      const peerId = Number(chatId);
      const fullId = Number.isNaN(peerId) ? chatId : peerId < 0 ? peerId : -1000000000 - Math.abs(peerId);
      const peer = await client.getInputEntity(fullId);
      if (peer instanceof Api.InputChannel) {
        inputChannel = peer;
      } else if (peer && typeof (peer as any).channelId !== 'undefined') {
        inputChannel = new Api.InputChannel({
          channelId: (peer as any).channelId,
          accessHash: (peer as any).accessHash ?? BigInt(0),
        });
      } else {
        throw new Error('Not a channel or supergroup');
      }
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (msg.includes('CHANNEL_PRIVATE')) {
        reply.code(204);
        return;
      }
      throw new AppError(404, `Chat ${chatId} not found or not accessible`, ErrorCodes.NOT_FOUND);
    }

    try {
      await telegramInvokeWithFloodRetry(log, id, 'LeaveChannel', () =>
        client.invoke(new Api.channels.LeaveChannel({ channel: inputChannel })),
      );
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      if (msg.includes('USER_NOT_PARTICIPANT')) {
        reply.code(204);
        return;
      }
      log.error({ message: 'leaveChat failed', accountId: id, chatId, error: msg });
      throw e;
    }

    reply.code(204);
    return;
  });
}

/**
 * Resolve entity for a chatId using DB sync data + GramJS fallbacks.
 * Shared helper for all participant endpoints.
 */
async function resolveEntityForChat(
  client: TelegramClient,
  db: DatabasePools,
  accountId: string,
  chatId: string,
): Promise<any> {
  const syncRow = await db.read.query(
    `SELECT peer_type, access_hash FROM bd_account_sync_chats
     WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1`,
    [accountId, chatId],
  );

  if (syncRow.rows.length > 0) {
    const { peer_type, access_hash } = syncRow.rows[0] as { peer_type: string | null; access_hash: string | null };
    const numId = BigInt(chatId);
    const ah = access_hash ? BigInt(access_hash) : BigInt(0);

    if (peer_type === 'channel' || peer_type === 'supergroup') {
      return new Api.InputPeerChannel({ channelId: numId, accessHash: ah });
    } else if (peer_type === 'chat') {
      return new Api.InputPeerChat({ chatId: numId });
    } else if (peer_type === 'user') {
      return new Api.InputPeerUser({ userId: numId, accessHash: ah });
    } else {
      return new Api.InputPeerChannel({ channelId: numId, accessHash: ah });
    }
  }

  const candidates = [
    async () => client.getEntity(`-100${chatId}`),
    async () => client.getEntity(`-${chatId}`),
    async () => { await client.getDialogs({ limit: 100 }); return client.getEntity(`-100${chatId}`); },
  ];
  for (const attempt of candidates) {
    try {
      const entity = await attempt();
      const cn = String(entity?.className ?? '');
      if (cn === 'ChannelForbidden' || cn === 'ChatForbidden') return null;
      if (entity?.deactivated) return null;
      if (entity?.left && !entity?.megagroup && !entity?.broadcast) return null;
      return entity;
    } catch { /* continue */ }
  }

  return null;
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
