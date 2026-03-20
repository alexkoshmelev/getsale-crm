// @ts-nocheck — GramJS types are incomplete
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { getErrorMessage, getErrorCode } from '../helpers';
import type { StructuredLog, SearchResultChat } from './types';
import { telegramInvokeWithFloodRetry } from './telegram-invoke-flood';

const SEARCH_FLOOD_BACKOFF_MS = 8000;
const PAGINATION_DELAY_MS = 1500;

function extractChatsFromResult(
  result: { messages?: any[]; chats?: any[] },
  chatsAcc: SearchResultChat[],
  seenIds: Set<string>,
  excludeChatIds: Set<string>
): void {
  const chats = result?.chats ?? [];
  const messages = result?.messages ?? [];
  for (const msg of messages) {
    const peer = msg?.peer ?? msg?.peerId ?? msg?.peer_id;
    if (!peer) continue;
    const p = peer as any;
    let cid: string | null = null;
    const cn = String(peer.className ?? peer.constructor?.className ?? '').toLowerCase();
    if (cn.includes('peerchannel')) {
      const id = p.channelId ?? p.channel_id;
      if (id != null) cid = String(id);
    } else if (cn.includes('peerchat')) {
      const id = p.chatId ?? p.chat_id;
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

/**
 * Global message search (SearchGlobal) for groups/channels; excludes user's existing dialogs from results where possible.
 * Extracted from ChatSync for SRP (C3).
 */
export async function searchGroupsByKeywordGlobal(
  log: StructuredLog,
  accountId: string,
  client: TelegramClient,
  query: string,
  limit: number = 50,
  type: 'groups' | 'channels' | 'all' = 'all',
  maxPages: number = 10
): Promise<SearchResultChat[]> {
  const q = (query || '').trim();
  if (q.length < 2) {
    const err = new Error('Query too short');
    (err as any).code = 'QUERY_TOO_SHORT';
    throw err;
  }
  const groupsOnly = type === 'groups';
  const broadcastOnly = type === 'channels';
  const requestLimit = Math.min(100, Math.max(1, limit));
  const seen = new Set<string>();
  const out: SearchResultChat[] = [];
  let offsetRate = 0;
  let offsetPeer: InstanceType<typeof Api.InputPeerEmpty> = new Api.InputPeerEmpty();
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
  } catch (e: unknown) {
    log.warn({ message: 'Could not load dialogs for search filter', accountId, error: getErrorMessage(e) });
  }

  try {
    const clientAny = client as any;

    while (page < maxPages) {
      let result: any;
      try {
        result = await telegramInvokeWithFloodRetry(log, accountId, 'SearchGlobal', () =>
          clientAny.invoke(
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
            })
          )
        );
      } catch (e: unknown) {
        if (getErrorMessage(e).includes('QUERY_TOO_SHORT') || getErrorCode(e) === 'QUERY_TOO_SHORT') {
          const err = new Error('Query too short');
          (err as any).code = 'QUERY_TOO_SHORT';
          throw err;
        }
        throw e;
      }

      const messages = result?.messages ?? [];
      const isSlice = result?.className === 'messages.messagesSlice' || (result?.constructor?.className === 'messages.messagesSlice');
      const searchFlood = !!(result?.searchFlood ?? result?.search_flood);

      if (searchFlood) {
        log.warn({ message: 'SearchGlobal search_flood, backing off', accountId, query: q, page });
        await new Promise((r) => setTimeout(r, SEARCH_FLOOD_BACKOFF_MS));
        const retryResult = (await telegramInvokeWithFloodRetry(log, accountId, 'SearchGlobal(search_flood)', () =>
          clientAny.invoke(
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
            })
          )
        )) as any;
        if (retryResult?.searchFlood ?? retryResult?.search_flood) {
          log.warn({ message: 'SearchGlobal search_flood on retry, returning collected results', accountId, query: q });
          return out;
        }
        result = retryResult;
      }

      if (page === 0) {
        const msgCount = result?.messages?.length ?? 0;
        const chatCount = result?.chats?.length ?? 0;
        const firstMsgKeys = result?.messages?.[0]
          ? Object.keys(result.messages[0]).filter((k) => ['peer', 'peerId', 'peer_id'].includes(k))
          : [];
        log.info({
          message: 'SearchGlobal first response',
          accountId,
          query: q,
          messagesCount: msgCount,
          chatsCount: chatCount,
          firstMessagePeerKeys: firstMsgKeys,
        });
      }

      extractChatsFromResult(result, out, seen, myChatIds);

      if (out.length >= limit) break;
      if (!isSlice || messages.length === 0) break;

      const nextRate = result?.nextRate ?? result?.next_rate;
      if (nextRate == null) break;

      const lastMsg = messages[messages.length - 1];
      offsetRate = typeof nextRate === 'number' ? nextRate : Number(nextRate) || 0;
      offsetId = lastMsg?.id ?? offsetId;
      try {
        const lastPeer = lastMsg?.peer ?? lastMsg?.peerId ?? lastMsg?.peer_id;
        if (lastPeer) {
          offsetPeer = await client.getInputEntity(lastPeer) as any;
        }
      } catch (err) {
        log.debug({ message: 'getInputEntity failed, stopping pagination', accountId, error: getErrorMessage(err) });
        break;
      }

      page++;
      await new Promise((r) => setTimeout(r, PAGINATION_DELAY_MS));
    }

    return out;
  } catch (e: unknown) {
    if (getErrorMessage(e).includes('QUERY_TOO_SHORT') || getErrorCode(e) === 'QUERY_TOO_SHORT') {
      const err = new Error('Query too short');
      (err as any).code = 'QUERY_TOO_SHORT';
      throw err;
    }
    log.error({ message: 'searchGroupsByKeyword failed', accountId, query: q, error: getErrorMessage(e) });
    throw e;
  }
}

/**
 * Public channel search via `channels.SearchPosts` (query or hashtag mode). Extracted from ChatSync (C3).
 */
export async function searchPublicChannelsByKeywordGlobal(
  log: StructuredLog,
  accountId: string,
  client: TelegramClient,
  query: string,
  limit: number = 50,
  maxPages: number = 10,
  searchMode: 'query' | 'hashtag' = 'query'
): Promise<SearchResultChat[]> {
  const q = (query || '').trim();
  if (q.length < 2) {
    const err = new Error('Query too short');
    (err as any).code = 'QUERY_TOO_SHORT';
    throw err;
  }
  const requestLimit = Math.min(100, Math.max(1, limit));
  const seen = new Set<string>();
  const out: SearchResultChat[] = [];
  let offsetRate = 0;
  let offsetPeer: InstanceType<typeof Api.InputPeerEmpty> = new Api.InputPeerEmpty();
  let offsetId = 0;
  let page = 0;
  const emptyExclude = new Set<string>();
  const clientAny = client as any;

  const safeOffsetPeer = () => offsetPeer ?? new Api.InputPeerEmpty();

  try {
    while (page < maxPages) {
      let result: any;
      try {
        if (searchMode === 'hashtag') {
          const hashtagVal = (q.startsWith('#') ? q.slice(1) : q).trim() || ' ';
          result = await telegramInvokeWithFloodRetry(log, accountId, 'SearchPosts(hashtag)', () =>
            clientAny.invoke(
              new Api.channels.SearchPosts({
                hashtag: hashtagVal,
                offsetRate,
                offsetPeer: safeOffsetPeer(),
                offsetId,
                limit: requestLimit,
              })
            )
          );
        } else {
          result = await telegramInvokeWithFloodRetry(log, accountId, 'SearchPosts(query)', () =>
            clientAny.invoke(
              new Api.channels.SearchPosts({
                query: q,
                hashtag: '',
                offsetRate,
                offsetPeer: safeOffsetPeer(),
                offsetId,
                limit: requestLimit,
              })
            )
          );
        }
      } catch (e: unknown) {
        if (getErrorMessage(e).includes('QUERY_TOO_SHORT') || getErrorCode(e) === 'QUERY_TOO_SHORT') {
          const err = new Error('Query too short');
          (err as any).code = 'QUERY_TOO_SHORT';
          throw err;
        }
        throw e;
      }

      const messages = result?.messages ?? [];
      const isSlice = result?.className === 'messages.messagesSlice' || (result?.constructor?.className === 'messages.messagesSlice');
      const searchFlood = !!(result?.searchFlood ?? result?.search_flood);

      if (searchFlood) {
        log.warn({ message: 'SearchPosts search_flood, backing off', accountId, query: q, page });
        await new Promise((r) => setTimeout(r, SEARCH_FLOOD_BACKOFF_MS));
        if (searchMode === 'hashtag') {
          const hashtagVal = (q.startsWith('#') ? q.slice(1) : q).trim() || ' ';
          result = (await telegramInvokeWithFloodRetry(log, accountId, 'SearchPosts(search_flood,hashtag)', () =>
            clientAny.invoke(
              new Api.channels.SearchPosts({
                hashtag: hashtagVal,
                offsetRate,
                offsetPeer: safeOffsetPeer(),
                offsetId,
                limit: requestLimit,
              })
            )
          )) as any;
        } else {
          result = (await telegramInvokeWithFloodRetry(log, accountId, 'SearchPosts(search_flood,query)', () =>
            clientAny.invoke(
              new Api.channels.SearchPosts({
                query: q,
                hashtag: '',
                offsetRate,
                offsetPeer: safeOffsetPeer(),
                offsetId,
                limit: requestLimit,
              })
            )
          )) as any;
        }
        if (result?.searchFlood ?? result?.search_flood) {
          log.warn({ message: 'SearchPosts search_flood on retry, returning collected results', accountId, query: q });
          return out;
        }
      }

      extractChatsFromResult(result, out, seen, emptyExclude);

      if (out.length >= limit) break;
      if (!isSlice || messages.length === 0) break;

      const nextRate = result?.nextRate ?? result?.next_rate;
      if (nextRate == null) break;

      const lastMsg = messages[messages.length - 1];
      offsetRate = typeof nextRate === 'number' ? nextRate : Number(nextRate) || 0;
      offsetId = lastMsg?.id ?? offsetId;
      try {
        const lastPeer = lastMsg?.peer ?? lastMsg?.peerId ?? lastMsg?.peer_id;
        if (lastPeer) {
          offsetPeer = await client.getInputEntity(lastPeer) as any;
        }
      } catch (err) {
        log.debug({ message: 'getInputEntity failed, stopping pagination', accountId, error: getErrorMessage(err) });
        break;
      }

      page++;
      await new Promise((r) => setTimeout(r, PAGINATION_DELAY_MS));
    }

    return out;
  } catch (e: unknown) {
    if (getErrorMessage(e).includes('QUERY_TOO_SHORT') || getErrorCode(e) === 'QUERY_TOO_SHORT') {
      const err = new Error('Query too short');
      (err as any).code = 'QUERY_TOO_SHORT';
      throw err;
    }
    log.error({ message: 'searchPublicChannelsByKeyword failed', accountId, query: q, error: getErrorMessage(e) });
    throw e;
  }
}

/** `contacts.Search` — чаты/каналы из адресной книги Telegram (C3). */
export async function searchByContactsGlobal(
  log: StructuredLog,
  accountId: string,
  client: TelegramClient,
  query: string,
  limit: number = 50
): Promise<SearchResultChat[]> {
  const q = (query || '').trim();
  if (q.length < 2) {
    const err = new Error('Query too short');
    (err as any).code = 'QUERY_TOO_SHORT';
    throw err;
  }
  const requestLimit = Math.min(100, Math.max(1, limit));
  const seen = new Set<string>();
  const out: SearchResultChat[] = [];
  const clientAny = client as any;

  try {
    const result = (await telegramInvokeWithFloodRetry(log, accountId, 'contacts.Search', () =>
      clientAny.invoke(new Api.contacts.Search({ q, limit: requestLimit }))
    )) as {
      my_results?: any[];
      results?: any[];
      chats?: any[];
      users?: any[];
    };

    const allPeers = [...(result?.my_results ?? []), ...(result?.results ?? [])];
    const chats = result?.chats ?? [];

    for (const peer of allPeers) {
      const cn = String(peer?.className ?? peer?.constructor?.className ?? '').toLowerCase();
      if (cn.includes('peeruser')) continue;
      let cid: string | null = null;
      if (cn.includes('peerchannel')) {
        const id = (peer as any).channelId ?? (peer as any).channel_id;
        if (id != null) cid = String(id);
      } else if (cn.includes('peerchat')) {
        const id = (peer as any).chatId ?? (peer as any).chat_id;
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
  } catch (e: unknown) {
    if (
      getErrorMessage(e).includes('QUERY_TOO_SHORT') ||
      getErrorMessage(e).includes('SEARCH_QUERY_EMPTY') ||
      getErrorCode(e) === 'QUERY_TOO_SHORT'
    ) {
      const err = new Error('Query too short');
      (err as any).code = 'QUERY_TOO_SHORT';
      throw err;
    }
    log.error({ message: 'searchByContacts failed', accountId, query: q, error: getErrorMessage(e) });
    throw e;
  }
}

/** Каналы, где аккаунт админ (`channels.GetAdminedPublicChannels`) — C3. */
export async function getAdminedPublicChannelsGlobal(
  log: StructuredLog,
  accountId: string,
  client: TelegramClient
): Promise<SearchResultChat[]> {
  const clientAny = client as any;
  try {
    const result = (await telegramInvokeWithFloodRetry(log, accountId, 'GetAdminedPublicChannels', () =>
      clientAny.invoke(new Api.channels.GetAdminedPublicChannels({}))
    )) as { chats?: any[] };
    const chats = result?.chats ?? [];
    return chats.map((c: any) => {
      const id = c.id ?? c.channelId ?? c.chat_id ?? c.chatId;
      const chatId = id != null ? String(id) : '';
      const title = (c.title ?? c.name ?? '').trim() || chatId;
      const peerType = (c as any)?.broadcast ? 'channel' : (c as any)?.megagroup ? 'group' : 'chat';
      const membersCount = c?.participantsCount ?? c?.participants_count ?? undefined;
      const username = (c?.username ?? '').trim() || undefined;
      return { chatId, title, peerType, membersCount, username };
    });
  } catch (e: unknown) {
    log.error({ message: 'getAdminedPublicChannels failed', accountId, error: getErrorMessage(e) });
    throw e;
  }
}
