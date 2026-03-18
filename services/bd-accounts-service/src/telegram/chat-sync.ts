// @ts-nocheck — GramJS types are incomplete
import { TelegramClient, Api } from 'telegram';
import { randomUUID } from 'crypto';
import { getErrorMessage, getErrorCode } from '../helpers';
import type { TelegramManagerDeps, TelegramClientInfo, StructuredLog, TelegramSourceType, ResolvedSource, SearchResultChat } from './types';
import type { ContactManager } from './contact-manager';
import type { Pool } from 'pg';

export class ChatSync {
  private readonly pool: Pool;
  private readonly log: StructuredLog;
  private readonly clients: Map<string, TelegramClientInfo>;
  private readonly dialogFiltersCache: Map<string, { ts: number; filters: unknown[] }>;
  private readonly DIALOG_FILTERS_CACHE_TTL_MS = 90 * 1000;
  private contactManager!: ContactManager;

  constructor(private readonly deps: TelegramManagerDeps) {
    this.pool = deps.pool;
    this.log = deps.log;
    this.clients = deps.clients;
    this.dialogFiltersCache = deps.dialogFiltersCache;
  }

  setContactManager(cm: ContactManager): void {
    this.contactManager = cm;
  }

  static mapDialogToItem(dialog: any): any {
    const pinned = !!(dialog.pinned ?? dialog.dialog?.pinned);
    const entity = dialog.entity;
    const isUser = dialog.isUser ?? (entity && (entity.className === 'User' || entity.constructor?.className === 'User'));
    let first_name: string | undefined;
    let last_name: string | null | undefined;
    let username: string | null | undefined;
    if (entity && isUser) {
      first_name = (entity.firstName ?? entity.first_name ?? '').trim() || undefined;
      last_name = (entity.lastName ?? entity.last_name ?? '').trim() || null;
      username = (entity.username ?? '').trim() || null;
    }
    return {
      id: String(dialog.id),
      name: dialog.name || dialog.title || 'Unknown',
      unreadCount: dialog.unreadCount || 0,
      lastMessage: dialog.message?.text || '',
      lastMessageDate: dialog.message?.date,
      isUser: dialog.isUser ?? !!isUser,
      isGroup: dialog.isGroup,
      isChannel: dialog.isChannel,
      pinned,
      ...(isUser && { first_name, last_name, username }),
    };
  }

  /**
   * Yields to the event loop every yieldEveryN dialogs so other accounts' update loops and keepalive can run (reduces TIMEOUT on other accounts).
   * Optional offsetDate (unix timestamp): only include dialogs whose last message is >= this date. We iterate from newest and stop when dialog date < offsetDate.
   */
  async getDialogsAll(
    accountId: string,
    folderId: number,
    options?: { maxDialogs?: number; delayEveryN?: number; delayMs?: number; yieldEveryN?: number; offsetDate?: number }
  ): Promise<any[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const maxDialogs = options?.maxDialogs ?? 3000;
    const delayEveryN = options?.delayEveryN ?? 100;
    const delayMs = options?.delayMs ?? 600;
    const yieldEveryN = options?.yieldEveryN ?? 25;
    const minActivityDate = options?.offsetDate;
    const result: any[] = [];
    let count = 0;
    const client = clientInfo.client as any;
    if (typeof client.iterDialogs !== 'function') {
      return this.getDialogs(accountId, folderId);
    }
    try {
      const iter = client.iterDialogs({ folder: folderId, limit: maxDialogs });
      for await (const dialog of iter) {
        if (minActivityDate != null) {
          const msgDate = dialog.message?.date;
          const msgDateSec = typeof msgDate === 'number' ? (msgDate > 1e10 ? Math.floor(msgDate / 1000) : msgDate) : (msgDate instanceof Date ? Math.floor(msgDate.getTime() / 1000) : 0);
          if (msgDateSec > 0 && msgDateSec < minActivityDate) break;
        }
        if (dialog.isUser || dialog.isGroup) {
          result.push(ChatSync.mapDialogToItem(dialog));
          count++;
          if (count % delayEveryN === 0 && count < maxDialogs) {
            await new Promise((r) => setTimeout(r, delayMs));
          }
          if (count % yieldEveryN === 0) {
            await new Promise<void>((r) => setImmediate(r));
          }
        }
        if (count >= maxDialogs) break;
      }
      this.log.info({ message: `getDialogsAll folder=${folderId} fetched ${result.length} dialogs` });
      return result;
    } catch (error: unknown) {
      const msg = getErrorMessage(error);
      if (msg === 'TIMEOUT' || msg.includes('TIMEOUT')) throw error;
      this.log.error({ message: `Error getDialogsAll for ${accountId} folder ${folderId}`, error: msg });
      throw error;
    }
  }

  async getDialogs(accountId: string, folderId?: number): Promise<any[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }

    try {
      const opts: { limit: number; folderId?: number } = { limit: 100 };
      if (folderId !== undefined && folderId !== null) {
        opts.folderId = folderId;
      }
      const dialogs = await clientInfo.client.getDialogs(opts);
      const mapped = dialogs.map((dialog: any) => ChatSync.mapDialogToItem(dialog));
      return mapped.filter((d: any) => d.isUser || d.isGroup);
    } catch (error) {
      this.log.error({ message: `Error getting dialogs for ${accountId}`, error: error?.message || String(error) });
      throw error;
    }
  }

  async searchGroupsByKeyword(
    accountId: string,
    query: string,
    limit: number = 50,
    type: 'groups' | 'channels' | 'all' = 'all',
    maxPages: number = 10
  ): Promise<{ chatId: string; title: string; peerType: string; membersCount?: number; username?: string }[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
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
    const out: { chatId: string; title: string; peerType: string; membersCount?: number; username?: string }[] = [];
    let offsetRate = 0;
    let offsetPeer: InstanceType<typeof Api.InputPeerEmpty> = new Api.InputPeerEmpty();
    let offsetId = 0;
    let page = 0;
    const SEARCH_FLOOD_BACKOFF_MS = 8000;
    const PAGINATION_DELAY_MS = 1500;

    const myChatIds = new Set<string>();
    try {
      const dialogs = await clientInfo.client.getDialogs({ limit: 150, folderId: 0 });
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
      this.log.warn({ message: 'Could not load dialogs for search filter', accountId, error: getErrorMessage(e) });
    }

    function extractChatsFromResult(
      result: { messages?: any[]; chats?: any[] },
      chatsAcc: typeof out,
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

    try {
      const client = clientInfo.client;

      while (page < maxPages) {
        let result: any;
        try {
          result = await client.invoke(
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
          this.log.warn({ message: 'SearchGlobal search_flood, backing off', accountId, query: q, page });
          await new Promise((r) => setTimeout(r, SEARCH_FLOOD_BACKOFF_MS));
          const retryResult = await client.invoke(
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
          ) as any;
          if (retryResult?.searchFlood ?? retryResult?.search_flood) {
            this.log.warn({ message: 'SearchGlobal search_flood on retry, returning collected results', accountId, query: q });
            return out;
          }
          result = retryResult;
        }

        if (page === 0) {
          const msgCount = result?.messages?.length ?? 0;
          const chatCount = result?.chats?.length ?? 0;
          const firstMsgKeys = result?.messages?.[0] ? Object.keys(result.messages[0]).filter((k) => ['peer', 'peerId', 'peer_id'].includes(k)) : [];
          this.log.info({
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
          this.log.debug({ message: 'getInputEntity failed, stopping pagination', accountId, error: getErrorMessage(err) });
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
      this.log.error({ message: 'searchGroupsByKeyword failed', accountId, query: q, error: getErrorMessage(e) });
      throw e;
    }
  }

  async searchPublicChannelsByKeyword(
    accountId: string,
    query: string,
    limit: number = 50,
    maxPages: number = 10,
    searchMode: 'query' | 'hashtag' = 'query'
  ): Promise<{ chatId: string; title: string; peerType: string; membersCount?: number; username?: string }[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const q = (query || '').trim();
    if (q.length < 2) {
      const err = new Error('Query too short');
      (err as any).code = 'QUERY_TOO_SHORT';
      throw err;
    }
    const requestLimit = Math.min(100, Math.max(1, limit));
    const seen = new Set<string>();
    const out: { chatId: string; title: string; peerType: string; membersCount?: number; username?: string }[] = [];
    let offsetRate = 0;
    let offsetPeer: InstanceType<typeof Api.InputPeerEmpty> = new Api.InputPeerEmpty();
    let offsetId = 0;
    let page = 0;
    const SEARCH_FLOOD_BACKOFF_MS = 8000;
    const PAGINATION_DELAY_MS = 1500;
    const emptyExclude = new Set<string>();

    function extract(result: { messages?: any[]; chats?: any[] }, chatsAcc: typeof out, seenIds: Set<string>, excludeChatIds: Set<string>) {
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

    try {
      const client = clientInfo.client;

      const safeOffsetPeer = () => offsetPeer ?? new Api.InputPeerEmpty();

      while (page < maxPages) {
        let result: any;
        try {
          if (searchMode === 'hashtag') {
            const hashtagVal = (q.startsWith('#') ? q.slice(1) : q).trim() || ' ';
            result = await client.invoke(new Api.channels.SearchPosts({
              hashtag: hashtagVal,
              offsetRate,
              offsetPeer: safeOffsetPeer(),
              offsetId,
              limit: requestLimit,
            }));
          } else {
            result = await client.invoke(new Api.channels.SearchPosts({
              query: q,
              hashtag: '',
              offsetRate,
              offsetPeer: safeOffsetPeer(),
              offsetId,
              limit: requestLimit,
            }));
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
          this.log.warn({ message: 'SearchPosts search_flood, backing off', accountId, query: q, page });
          await new Promise((r) => setTimeout(r, SEARCH_FLOOD_BACKOFF_MS));
          if (searchMode === 'hashtag') {
            const hashtagVal = (q.startsWith('#') ? q.slice(1) : q).trim() || ' ';
            result = await client.invoke(new Api.channels.SearchPosts({
              hashtag: hashtagVal,
              offsetRate,
              offsetPeer: safeOffsetPeer(),
              offsetId,
              limit: requestLimit,
            })) as any;
          } else {
            result = await client.invoke(new Api.channels.SearchPosts({
              query: q,
              hashtag: '',
              offsetRate,
              offsetPeer: safeOffsetPeer(),
              offsetId,
              limit: requestLimit,
            })) as any;
          }
          if (result?.searchFlood ?? result?.search_flood) {
            this.log.warn({ message: 'SearchPosts search_flood on retry, returning collected results', accountId, query: q });
            return out;
          }
        }

        extract(result, out, seen, emptyExclude);

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
          this.log.debug({ message: 'getInputEntity failed, stopping pagination', accountId, error: getErrorMessage(err) });
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
      this.log.error({ message: 'searchPublicChannelsByKeyword failed', accountId, query: q, error: getErrorMessage(e) });
      throw e;
    }
  }

  async searchByContacts(
    accountId: string,
    query: string,
    limit: number = 50
  ): Promise<{ chatId: string; title: string; peerType: string; membersCount?: number; username?: string }[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const q = (query || '').trim();
    if (q.length < 2) {
      const err = new Error('Query too short');
      (err as any).code = 'QUERY_TOO_SHORT';
      throw err;
    }
    const requestLimit = Math.min(100, Math.max(1, limit));
    const seen = new Set<string>();
    const out: { chatId: string; title: string; peerType: string; membersCount?: number; username?: string }[] = [];

    try {
      const result = await clientInfo.client.invoke(
        new Api.contacts.Search({ q, limit: requestLimit })
      ) as { my_results?: any[]; results?: any[]; chats?: any[]; users?: any[] };

      const allPeers = [
        ...(result?.my_results ?? []),
        ...(result?.results ?? []),
      ];
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
      if (getErrorMessage(e).includes('QUERY_TOO_SHORT') || getErrorMessage(e).includes('SEARCH_QUERY_EMPTY') || getErrorCode(e) === 'QUERY_TOO_SHORT') {
        const err = new Error('Query too short');
        (err as any).code = 'QUERY_TOO_SHORT';
        throw err;
      }
      this.log.error({ message: 'searchByContacts failed', accountId, query: q, error: getErrorMessage(e) });
      throw e;
    }
  }

  async getAdminedPublicChannels(
    accountId: string
  ): Promise<{ chatId: string; title: string; peerType: string; membersCount?: number; username?: string }[]> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    try {
      const result = await clientInfo.client.invoke(new Api.channels.GetAdminedPublicChannels({})) as { chats?: any[] };
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
      this.log.error({ message: 'getAdminedPublicChannels failed', accountId, error: getErrorMessage(e) });
      throw e;
    }
  }

  private async getBasicGroupParticipants(
    client: any,
    chatEntity: any,
    excludeAdmins: boolean
  ): Promise<{ users: Array<{ telegram_id: string; username?: string; first_name?: string; last_name?: string }>; nextOffset: number | null }> {
    const chatId = chatEntity.id ?? chatEntity.chatId;
    const full = await client.invoke(new Api.messages.GetFullChat({ chatId })) as any;
    const fullChat = full?.fullChat ?? full?.full_chat;
    const participants = fullChat?.participants?.participants ?? fullChat?.participants ?? [];
    const users = full?.users ?? [];
    const userMap = new Map<number, any>();
    for (const u of users) {
      const id = (u as any).id ?? (u as any).userId;
      if (id != null) userMap.set(Number(id), u);
    }
    const out: Array<{ telegram_id: string; username?: string; first_name?: string; last_name?: string }> = [];
    for (const p of participants) {
      const uid = (p as any).userId ?? (p as any).user_id;
      if (uid == null) continue;
      if (excludeAdmins) {
        const cn = String((p as any).className ?? (p as any).constructor?.className ?? '').toLowerCase();
        if (cn.includes('chatparticipantadmin') || cn.includes('chatparticipantcreator')) continue;
      }
      const u = userMap.get(Number(uid));
      if ((u as any)?.deleted || (u as any)?.bot) continue;
      out.push({
        telegram_id: String(uid),
        username: (u?.username ?? '').trim() || undefined,
        first_name: (u?.firstName ?? u?.first_name ?? '').trim() || undefined,
        last_name: (u?.lastName ?? u?.last_name ?? '').trim() || undefined,
      });
    }
    return { users: out, nextOffset: null };
  }

  async getChannelParticipants(
    accountId: string,
    channelId: string,
    offset: number,
    limit: number,
    excludeAdmins: boolean = false
  ): Promise<{ users: Array<{ telegram_id: string; username?: string; first_name?: string; last_name?: string }>; nextOffset: number | null }> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const client = clientInfo.client;
    let entity: any;

    try {
      const peerId = Number(channelId);
      const isNumericId = !Number.isNaN(peerId) && !channelId.startsWith('@') && !channelId.includes('://');
      if (isNumericId && peerId > 0) {
        try {
          entity = await client.getEntity(`-100${channelId}`);
        } catch {
          try {
            entity = await client.getEntity(`-${channelId}`);
          } catch {
            try {
              entity = await client.getEntity(channelId);
            } catch (err2) {
              throw err2;
            }
          }
        }
      } else {
        entity = await client.getEntity(channelId);
      }

      if (!(entity instanceof Api.Chat || entity instanceof Api.Channel)) {
        throw new Error('Not a group or channel');
      }
      if (entity instanceof Api.Chat) {
        return this.getBasicGroupParticipants(client, entity, excludeAdmins);
      }
    } catch (e: unknown) {
      if (getErrorMessage(e).includes('CHAT_ADMIN_REQUIRED') || getErrorCode(e) === 'CHAT_ADMIN_REQUIRED') {
        const err = new Error('No permission to get participants');
        (err as any).code = 'CHAT_ADMIN_REQUIRED';
        throw err;
      }
      if (getErrorMessage(e).includes('CHANNEL_PRIVATE') || getErrorCode(e) === 'CHANNEL_PRIVATE') {
        const err = new Error('Channel is private');
        (err as any).code = 'CHANNEL_PRIVATE';
        throw err;
      }
      throw e;
    }

    try {
      const result = await client.invoke(
        new Api.channels.GetParticipants({
          channel: entity,
          filter: new Api.ChannelParticipantsRecent(),
          offset,
          limit: Math.min(limit, 200),
          hash: BigInt(0),
        })
      ) as { participants?: any[]; users?: any[]; count?: number };
      const participants = result?.participants ?? [];
      const users = result?.users ?? [];
      const userMap = new Map<number, any>();
      for (const u of users) {
        const id = (u as any).id ?? (u as any).userId;
        if (id != null) userMap.set(Number(id), u);
      }
      const out: Array<{ telegram_id: string; username?: string; first_name?: string; last_name?: string }> = [];
      for (const p of participants) {
        if (excludeAdmins) {
          const cn = String((p as any).className ?? (p as any).constructor?.className ?? '').toLowerCase();
          if (cn.includes('channelparticipantadmin') || cn.includes('channelparticipantcreator')) continue;
        }
        const uid = (p as any).userId;
        if (uid == null) continue;
        const u = userMap.get(Number(uid));
        out.push({
          telegram_id: String(uid),
          username: (u?.username ?? '').trim() || undefined,
          first_name: (u?.firstName ?? u?.first_name ?? '').trim() || undefined,
          last_name: (u?.lastName ?? u?.last_name ?? '').trim() || undefined,
        });
      }
      const count = result?.count ?? 0;
      const nextOffset = offset + participants.length < count && participants.length >= Math.min(limit, 200)
        ? offset + participants.length
        : null;
      return { users: out, nextOffset };
    } catch (e: unknown) {
      if (getErrorMessage(e).includes('CHAT_ADMIN_REQUIRED') || getErrorCode(e) === 'CHAT_ADMIN_REQUIRED') {
        const err = new Error('No permission to get participants');
        (err as any).code = 'CHAT_ADMIN_REQUIRED';
        throw err;
      }
      if (getErrorMessage(e).includes('CHANNEL_PRIVATE') || getErrorCode(e) === 'CHANNEL_PRIVATE') {
        const err = new Error('Channel is private');
        (err as any).code = 'CHANNEL_PRIVATE';
        throw err;
      }
      this.log.error({ message: 'getChannelParticipants failed', accountId, channelId, error: getErrorMessage(e) });
      throw e;
    }
  }

  async getActiveParticipants(
    accountId: string,
    chatId: string,
    depth: number,
    excludeAdmins: boolean = false
  ): Promise<{ users: Array<{ telegram_id: string; username?: string; first_name?: string; last_name?: string }> }> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const client = clientInfo.client;
    let entity: any;

    try {
      const peerId = Number(chatId);
      const isNumericId = !Number.isNaN(peerId) && !chatId.startsWith('@') && !chatId.includes('://');
      if (isNumericId && peerId > 0) {
        try {
          entity = await client.getEntity(`-100${chatId}`);
        } catch {
          try {
            entity = await client.getEntity(`-${chatId}`);
          } catch {
            try {
              entity = await client.getEntity(chatId);
            } catch (err2) {
              throw err2;
            }
          }
        }
      } else {
        entity = await client.getEntity(chatId);
      }
    } catch (e: unknown) {
      this.log.error({ message: 'Failed to resolve entity for getActiveParticipants', accountId, chatId, error: getErrorMessage(e) });
      throw e;
    }

    const uniqueUsers = new Map<string, any>();
    let offsetId = 0;
    const limit = 100;
    let fetched = 0;

    try {
      while (fetched < depth) {
        const fetchLimit = Math.min(limit, depth - fetched);
        const result = await client.invoke(
          new Api.messages.GetHistory({
            peer: entity,
            offsetId,
            offsetDate: 0,
            addOffset: 0,
            limit: fetchLimit,
            maxId: 0,
            minId: 0,
            hash: BigInt(0),
          })
        ) as any;

        const messages = result.messages || [];
        const users = result.users || [];
        
        if (messages.length === 0) break;

        const usersMap = new Map<string, any>();
        for (const u of users) {
          const id = (u as any).id ?? (u as any).userId;
          if (id != null) usersMap.set(String(id), u);
        }

        for (const msg of messages) {
          const fromId = msg.fromId;
          if (fromId && (fromId.className === 'PeerUser' || (fromId as any).userId != null)) {
            const uid = String((fromId as any).userId ?? (fromId as any).user_id ?? '');
            if (uid && !uniqueUsers.has(uid) && usersMap.has(uid)) {
              uniqueUsers.set(uid, usersMap.get(uid));
            }
          }
        }
        
        fetched += messages.length;
        offsetId = messages[messages.length - 1].id;
      }

      let usersResult = Array.from(uniqueUsers.values())
        .filter((u: any) => !u.deleted && !u.bot)
        .map((u: any) => {
          const uid = (u as any).id ?? (u as any).userId;
          return {
            telegram_id: uid != null ? String(uid) : '',
            username: (u as any).username ?? (u as any).user_name,
            first_name: (u as any).firstName ?? (u as any).first_name,
            last_name: (u as any).lastName ?? (u as any).last_name,
          };
        })
        .filter((u) => u.telegram_id !== '');

      if (excludeAdmins) {
         try {
           if (entity instanceof Api.Channel) {
             const adminResult = await client.invoke(new Api.channels.GetParticipants({
               channel: entity,
               filter: new Api.ChannelParticipantsAdmins(),
               offset: 0,
               limit: 100,
               hash: BigInt(0),
             })) as { participants?: any[]; users?: any[] };
             const adminIds = new Set(
               (adminResult.participants || [])
               .filter(p => p instanceof Api.ChannelParticipantAdmin || p instanceof Api.ChannelParticipantCreator)
               .map(p => String(p.userId))
             );
             usersResult = usersResult.filter(u => !adminIds.has(u.telegram_id));
           }
         } catch(err) {
           this.log.warn({ message: 'Failed to fetch admins for exclusion in getActiveParticipants', error: String(err) });
         }
      }

      return { users: usersResult };
    } catch (e: unknown) {
      this.log.error({ message: 'getActiveParticipants failed', accountId, chatId, error: getErrorMessage(e) });
      throw e;
    }
  }

  async leaveChat(accountId: string, chatId: string): Promise<void> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const client = clientInfo.client;
    let inputChannel: Api.TypeInputChannel;
    try {
      const peerId = Number(chatId);
      const fullId = Number.isNaN(peerId) ? chatId : (peerId < 0 ? peerId : -1000000000 - Math.abs(peerId));
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
    } catch (e: unknown) {
      if (getErrorMessage(e).includes('CHANNEL_PRIVATE') || getErrorCode(e) === 'CHANNEL_PRIVATE') {
        const err = new Error('Channel is private or already left');
        (err as any).code = 'CHANNEL_PRIVATE';
        throw err;
      }
      throw e;
    }
    try {
      await client.invoke(new Api.channels.LeaveChannel({ channel: inputChannel }));
    } catch (e: unknown) {
      if (getErrorMessage(e).includes('USER_NOT_PARTICIPANT') || getErrorCode(e) === 'USER_NOT_PARTICIPANT') {
        return;
      }
      this.log.error({ message: 'leaveChat failed', accountId, chatId, error: getErrorMessage(e) });
      throw e;
    }
  }

  async resolveChatFromInput(
    accountId: string,
    input: string
  ): Promise<{ chatId: string; title: string; peerType: string }> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const client = clientInfo.client;
    const raw = (input || '').trim();
    if (!raw) {
      const err = new Error('Empty input');
      (err as any).code = 'VALIDATION';
      throw err;
    }
    const lower = raw.toLowerCase();
    const isInvite = lower.includes('/joinchat/') || lower.startsWith('+') || lower.includes('t.me/+');
    if (isInvite) {
      let hash = '';
      const joinchatMatch = raw.match(/joinchat\/([a-zA-Z0-9_-]+)/i) || raw.match(/t\.me\/\+?([a-zA-Z0-9_-]+)/i);
      if (joinchatMatch) hash = joinchatMatch[1];
      else if (raw.startsWith('+')) hash = raw.slice(1).trim();
      if (!hash) {
        const err = new Error('Invalid invite link');
        (err as any).code = 'INVALID_INVITE';
        throw err;
      }
      try {
        const updates = await client.invoke(new Api.messages.ImportChatInvite({ hash })) as any;
        const chats = updates?.chats ?? [];
        const c = Array.isArray(chats) ? chats[0] : chats;
        if (!c) {
          const err = new Error('No chat in invite response');
          (err as any).code = 'INVALID_INVITE';
          throw err;
        }
        const id = c.id ?? c.channelId ?? c.chatId;
        const title = (c.title ?? c.name ?? '').trim() || String(id);
        const peerType = (c as any).broadcast ? 'channel' : (c as any).megagroup ? 'group' : 'chat';
        return { chatId: String(id), title, peerType };
      } catch (e: unknown) {
        if (getErrorMessage(e).includes('INVITE_HASH_EXPIRED') || getErrorCode(e) === 'INVITE_HASH_EXPIRED') {
          const err = new Error('Invite link expired');
          (err as any).code = 'INVITE_EXPIRED';
          throw err;
        }
        if (getErrorMessage(e).includes('INVITE_HASH_INVALID') || getErrorCode(e) === 'INVITE_HASH_INVALID') {
          const err = new Error('Invalid invite link');
          (err as any).code = 'INVALID_INVITE';
          throw err;
        }
        throw e;
      }
    }
    let username = raw
      .replace(/^@/, '')
      .replace(/^https?:\/\/t\.me\//i, '')
      .replace(/^t\.me\//i, '')
      .trim();
    if (!username) {
      const err = new Error('Invalid username or link');
      (err as any).code = 'VALIDATION';
      throw err;
    }
    try {
      const resolved = await client.invoke(new Api.contacts.ResolveUsername({ username })) as any;
      const peer = resolved?.peer;
      const chats = resolved?.chats ?? [];
      if (!peer) {
        const err = new Error('Chat not found');
        (err as any).code = 'CHAT_NOT_FOUND';
        throw err;
      }
      let cid: string | null = null;
      const pn = String(peer.className ?? peer.constructor?.className ?? '').toLowerCase();
      if (pn.includes('peerchannel') && (peer as any).channelId != null) {
        cid = String((peer as any).channelId);
      } else if (pn.includes('peerchat') && (peer as any).chatId != null) {
        cid = String((peer as any).chatId);
      }
      if (!cid) {
        const err = new Error('Not a group or channel');
        (err as any).code = 'CHAT_NOT_FOUND';
        throw err;
      }
      const chat = (Array.isArray(chats) ? chats : [chats]).find((ch: any) => {
        const id = ch?.id ?? ch?.channelId ?? ch?.chatId;
        return id != null && String(id) === cid;
      });
      const title = (chat?.title ?? chat?.name ?? '').trim() || cid;
      const peerType = (chat as any)?.broadcast ? 'channel' : (chat as any)?.megagroup ? 'group' : 'chat';
      return { chatId: cid, title, peerType };
    } catch (e: unknown) {
      if (getErrorMessage(e).includes('USERNAME_NOT_OCCUPIED') || getErrorCode(e) === 'USERNAME_NOT_OCCUPIED') {
        const err = new Error('Chat not found');
        (err as any).code = 'CHAT_NOT_FOUND';
        throw err;
      }
      this.log.error({ message: 'resolveChatFromInput failed', accountId, input: raw, error: getErrorMessage(e) });
      throw e;
    }
  }

  async resolveSourceFromInput(
    accountId: string,
    input: string
  ): Promise<ResolvedSource> {
    const basic = await this.resolveChatFromInput(accountId, input);
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo?.isConnected) {
      return this.basicToResolvedSource(basic, input);
    }
    const client = clientInfo.client;
    const chatId = basic.chatId;
    const raw = (input || '').trim();

    const peerId = Number(chatId);
    const isNumericId = !Number.isNaN(peerId) && !chatId.startsWith('@') && !chatId.includes('://');
    let entity: any;
    try {
      if (isNumericId && peerId > 0) {
        try {
          entity = await client.getEntity(`-100${chatId}`);
        } catch {
          entity = await client.getEntity(chatId);
        }
      } else {
        entity = await client.getEntity(chatId);
      }
    } catch (e: unknown) {
      this.log.warn({ message: 'resolveSourceFromInput getEntity failed, using basic', accountId, input: raw, error: getErrorMessage(e) });
      return this.basicToResolvedSource(basic, input);
    }

    let type: TelegramSourceType = 'unknown';
    let membersCount: number | undefined;
    let linkedChatId: number | undefined;
    let canGetMembers = false;
    let canGetMessages = true;
    const username = (entity as any)?.username ? String((entity as any).username) : undefined;

    if (entity instanceof Api.Channel) {
      const ch = entity as any;
      if (ch.broadcast) {
        canGetMembers = false;
        try {
          const inputChannel = await client.getInputEntity(entity) as any;
          const full = await client.invoke(new Api.channels.GetFullChannel({ channel: inputChannel })) as any;
          const fullChat = full?.fullChat ?? full?.full_chat;
          if (fullChat?.linkedChatId) {
            linkedChatId = Number(fullChat.linkedChatId);
            type = 'comment_group';
          } else {
            type = 'channel';
          }
          if (fullChat?.participantsCount != null) membersCount = Number(fullChat.participantsCount);
        } catch (e: unknown) {
          this.log.warn({ message: 'GetFullChannel failed in resolveSource', accountId, chatId, error: getErrorMessage(e) });
          type = 'channel';
        }
      } else {
        type = ch.username ? 'public_group' : 'private_group';
        canGetMembers = !!ch.username;
        try {
          const inputChannel = await client.getInputEntity(entity) as any;
          const full = await client.invoke(new Api.channels.GetFullChannel({ channel: inputChannel })) as any;
          const fullChat = full?.fullChat ?? full?.full_chat;
          if (fullChat?.participantsCount != null) membersCount = Number(fullChat.participantsCount);
        } catch (e: unknown) {
          this.log.warn({ message: 'GetFullChannel failed in resolveSource', accountId, chatId, error: getErrorMessage(e) });
        }
      }
    } else if (entity instanceof Api.Chat) {
      type = 'public_group';
      canGetMembers = true;
      try {
        const chatIdNum = (entity as any).id ?? (entity as any).chatId;
        const full = await client.invoke(new Api.messages.GetFullChat({ chatId: chatIdNum })) as any;
        const fullChat = full?.fullChat ?? full?.full_chat;
        if (fullChat?.participantsCount != null) membersCount = Number(fullChat.participantsCount);
      } catch (e: unknown) {
        this.log.warn({ message: 'GetFullChat failed in resolveSource', accountId, chatId, error: getErrorMessage(e) });
      }
    } else {
      type = basic.peerType === 'channel' ? 'public_group' : 'unknown';
      canGetMembers = type === 'public_group';
    }

    return {
      input: raw,
      type,
      title: basic.title,
      username,
      chatId: basic.chatId,
      membersCount,
      linkedChatId,
      canGetMembers,
      canGetMessages,
    };
  }

  private basicToResolvedSource(
    basic: { chatId: string; title: string; peerType: string },
    input: string
  ): ResolvedSource {
    const type: TelegramSourceType =
      basic.peerType === 'channel' ? 'public_group' : basic.peerType === 'chat' ? 'public_group' : 'unknown';
    return {
      input: (input || '').trim(),
      type,
      title: basic.title,
      chatId: basic.chatId,
      canGetMembers: type === 'public_group',
      canGetMessages: true,
    };
  }

  static inputPeerToDialogIds(peer: any, out: Set<string>): void {
    if (!peer) return;
    const c = String(peer.className ?? peer.constructor?.className ?? '').toLowerCase();
    const userId = peer.userId ?? peer.user_id;
    const chatId = peer.chatId ?? peer.chat_id;
    const channelId = peer.channelId ?? peer.channel_id;
    if ((c === 'inputpeeruser') && userId != null) {
      out.add(String(userId));
      return;
    }
    if ((c === 'inputpeerchat') && chatId != null) {
      const n = Number(chatId);
      out.add(String(n));
      out.add(String(-n));
      return;
    }
    if ((c === 'inputpeerchannel') && channelId != null) {
      const n = Number(channelId);
      out.add(String(n));
      out.add(String(-n));
      out.add(String(-1000000000 - n));
      out.add(String(-1000000000000 - n));
      return;
    }
  }

  private async getDialogFiltersRaw(accountId: string): Promise<any[]> {
    const now = Date.now();
    const cached = this.dialogFiltersCache.get(accountId);
    if (cached && now - cached.ts < this.DIALOG_FILTERS_CACHE_TTL_MS) {
      return cached.filters as any[];
    }
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const result = await clientInfo.client.invoke(new Api.messages.GetDialogFilters({}));
    const filters = (result as any).filters ?? [];
    this.dialogFiltersCache.set(accountId, { ts: now, filters });
    return filters;
  }

  async getDialogFilterPeerIds(accountId: string, filterId: number): Promise<Set<string>> {
    const filters = await this.getDialogFiltersRaw(accountId);
    const f = filters.find((x: any) => (x.id ?? -1) === filterId);
    if (!f) return new Set();
    const ids = new Set<string>();
    const pinned = f.pinned_peers ?? f.pinnedPeers ?? [];
    const included = f.include_peers ?? f.includePeers ?? [];
    const peers = [...pinned, ...included];
    for (const p of peers) {
      ChatSync.inputPeerToDialogIds(p, ids);
    }
    return ids;
  }

  async getDialogFilterRaw(accountId: string, filterId: number): Promise<any | null> {
    const filters = await this.getDialogFiltersRaw(accountId);
    return filters.find((x: any) => (x.id ?? -1) === filterId) ?? null;
  }

  private static dialogIdToVariants(dialogId: string | number): Set<string> {
    const s = String(dialogId).trim();
    const n = Number(s);
    const out = new Set<string>([s]);
    if (!Number.isNaN(n)) {
      out.add(String(n));
      out.add(String(-n));
      if (n > 0 && n < 1000000000) {
        out.add(String(-1000000000 - n));
        out.add(String(-1000000000000 - n));
      }
      if (n < -1000000000) {
        const channelId = -(n + 1000000000);
        if (Number.isInteger(channelId)) out.add(String(channelId));
        const channelIdAlt = -(n + 1000000000000);
        if (Number.isInteger(channelIdAlt)) out.add(String(channelIdAlt));
      }
    }
    return out;
  }

  static dialogMatchesFilter(
    dialog: { id: string; isUser?: boolean; isGroup?: boolean; isChannel?: boolean },
    filterRaw: any,
    includePeerIds: Set<string>,
    excludePeerIds: Set<string>
  ): boolean {
    if (!filterRaw) return false;
    const variants = ChatSync.dialogIdToVariants(dialog.id);
    for (const v of variants) {
      if (excludePeerIds.has(v)) return false;
    }
    for (const v of variants) {
      if (includePeerIds.has(v)) return true;
    }
    const contacts = !!(filterRaw.contacts === true);
    const non_contacts = !!(filterRaw.non_contacts === true);
    const groups = !!(filterRaw.groups === true);
    const broadcasts = !!(filterRaw.broadcasts === true);
    const bots = !!(filterRaw.bots === true);
    const isUser = !!dialog.isUser;
    const isGroup = !!dialog.isGroup;
    const isChannel = !!dialog.isChannel;
    if ((contacts || non_contacts || bots) && isUser) return true;
    if (groups && isGroup) return true;
    if (broadcasts && isChannel) return true;
    return false;
  }

  static getFilterIncludeExcludePeerIds(filterRaw: any): { include: Set<string>; exclude: Set<string> } {
    const include = new Set<string>();
    const exclude = new Set<string>();
    if (!filterRaw) return { include, exclude };
    const pinned = filterRaw.pinned_peers ?? filterRaw.pinnedPeers ?? [];
    const included = filterRaw.include_peers ?? filterRaw.includePeers ?? [];
    const excluded = filterRaw.exclude_peers ?? filterRaw.excludePeers ?? [];
    for (const p of [...pinned, ...included]) {
      ChatSync.inputPeerToDialogIds(p, include);
    }
    for (const p of excluded) {
      ChatSync.inputPeerToDialogIds(p, exclude);
    }
    return { include, exclude };
  }

  async getDialogFilters(accountId: string): Promise<{ id: number; title: string; isCustom: boolean; emoticon?: string }[]> {
    try {
      const filters = await this.getDialogFiltersRaw(accountId);
      const list: { id: number; title: string; isCustom: boolean; emoticon?: string }[] = [];
      for (let i = 0; i < filters.length; i++) {
        const f = filters[i];
        const id = f.id ?? i;
        const rawTitle = typeof f.title === 'string' ? f.title : (f.title?.text ?? '');
        const title = (typeof rawTitle === 'string' ? rawTitle : String(rawTitle)).trim() || (id === 0 ? 'Все чаты' : id === 1 ? 'Архив' : `Папка ${id}`);
        const emoticon = typeof f.emoticon === 'string' && f.emoticon.trim() ? f.emoticon.trim() : undefined;
        list.push({ id, title, isCustom: id >= 2, emoticon });
      }
      return list;
    } catch (error: any) {
      this.log.error({ message: `Error getting dialog filters for ${accountId}`, error: error?.message || String(error) });
      throw error;
    }
  }

  async pushFoldersToTelegram(accountId: string): Promise<{ updated: number; errors: string[] }> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    const client = clientInfo.client;
    const errors: string[] = [];
    let updated = 0;

    const foldersRows = await this.pool.query(
      'SELECT id, folder_id, folder_title, icon FROM bd_account_sync_folders WHERE bd_account_id = $1 AND folder_id >= 2 ORDER BY order_index',
      [accountId]
    );
    if (foldersRows.rows.length === 0) {
      return { updated: 0, errors: [] };
    }

    for (const row of foldersRows.rows) {
      const folderId = Number(row.folder_id);
      const title = String(row.folder_title || '').trim() || `Folder ${folderId}`;
      const emoticon = row.icon && String(row.icon).trim() ? String(row.icon).trim().slice(0, 4) : undefined;

      const chatsRows = await this.pool.query(
        'SELECT telegram_chat_id FROM bd_account_sync_chat_folders WHERE bd_account_id = $1 AND folder_id = $2',
        [accountId, folderId]
      );
      const includePeers: any[] = [];
      for (const c of chatsRows.rows) {
        const tid = String(c.telegram_chat_id || '').trim();
        if (!tid) continue;
        try {
          const peerIdNum = Number(tid);
          const peerInput = Number.isNaN(peerIdNum) ? tid : peerIdNum;
          const peer = await client.getInputEntity(peerInput);
          includePeers.push(new Api.InputDialogPeer({ peer }));
        } catch (e: unknown) {
          errors.push(`Chat ${tid}: ${getErrorMessage(e)}`);
        }
      }

      try {
        const filter = new Api.DialogFilter({
          id: folderId,
          title,
          emoticon: emoticon || '',
          pinnedPeers: [],
          includePeers: includePeers,
          excludePeers: [],
          contacts: false,
          nonContacts: false,
          groups: false,
          broadcasts: false,
          bots: false,
        });
        await client.invoke(new Api.messages.UpdateDialogFilter({ id: folderId, filter }));
        updated += 1;
      } catch (e: unknown) {
        if (getErrorMessage(e).includes('includePeers') || getErrorMessage(e).includes('include_peers')) {
          try {
            const filterAlt = new (Api as any).DialogFilter({
              id: folderId,
              title,
              emoticon: emoticon || '',
              pinned_peers: [],
              include_peers: includePeers,
              exclude_peers: [],
              contacts: false,
              non_contacts: false,
              groups: false,
              broadcasts: false,
              bots: false,
            });
            await client.invoke(new Api.messages.UpdateDialogFilter({ id: folderId, filter: filterAlt }));
            updated += 1;
          } catch (e2: any) {
            errors.push(`Folder "${title}" (id=${folderId}): ${e2?.message || String(e2)}`);
          }
        } else {
          const msg = getErrorMessage(e);
          errors.push(`Folder "${title}" (id=${folderId}): ${msg}`);
        }
      }
    }
    return { updated, errors };
  }

  async getDialogsByFolder(accountId: string, folderId: number): Promise<any[]> {
    if (folderId === 0) {
      return this.getDialogsAll(accountId, 0, { maxDialogs: 3000, delayEveryN: 100, delayMs: 600 });
    }
    if (folderId === 1) {
      return this.getDialogsAll(accountId, 1, { maxDialogs: 2000, delayEveryN: 100, delayMs: 600 }).catch(() => []);
    }
    const [all0, all1] = await Promise.all([
      this.getDialogsAll(accountId, 0, { maxDialogs: 3000, delayEveryN: 100, delayMs: 600 }),
      this.getDialogsAll(accountId, 1, { maxDialogs: 2000, delayEveryN: 100, delayMs: 600 }).catch(() => []),
    ]);
    const mergedById = new Map<string, any>();
    for (const d of [...all0, ...all1]) {
      if (!mergedById.has(String(d.id))) mergedById.set(String(d.id), d);
    }
    const merged = Array.from(mergedById.values());
    const filterRaw = await this.getDialogFilterRaw(accountId, folderId);
    const { include: includePeerIds, exclude: excludePeerIds } = ChatSync.getFilterIncludeExcludePeerIds(filterRaw);
    return merged.filter((d: any) =>
      ChatSync.dialogMatchesFilter(d, filterRaw, includePeerIds, excludePeerIds)
    );
  }

  async tryAddChatFromSelectedFolders(accountId: string, chatId: string): Promise<boolean> {
    const foldersRows = await this.pool.query(
      'SELECT folder_id FROM bd_account_sync_folders WHERE bd_account_id = $1 LIMIT 1',
      [accountId]
    );
    if (foldersRows.rows.length === 0) return false;

    const clientInfo = this.clients.get(accountId);
    if (!clientInfo?.isConnected) return false;

    const accRow = await this.pool.query(
      'SELECT organization_id, display_name, username, first_name FROM bd_accounts WHERE id = $1 LIMIT 1',
      [accountId]
    );
    const row = accRow.rows[0] as { organization_id?: string; display_name?: string | null; username?: string | null; first_name?: string | null } | undefined;
    const organizationId = row?.organization_id;
    const account = row;

    let title = chatId;
    let peerType = 'user';
    const isAccountName = (t: string) => {
      const s = (t || '').trim();
      if (!s) return false;
      const d = (account?.display_name || '').trim();
      const u = (account?.username || '').trim();
      const f = (account?.first_name || '').trim();
      return (d && d === s) || (u && u === s) || (f && f === s);
    };
    try {
      const peerIdNum = Number(chatId);
      const peerInput = Number.isNaN(peerIdNum) ? chatId : peerIdNum;
      const peer = await clientInfo.client.getInputEntity(peerInput);
      const entity = await clientInfo.client.getEntity(peer);
      if (entity) {
        const c = (entity as any).className;
        if (c === 'User') {
          const u = entity as any;
          title = [u.firstName, u.lastName].filter(Boolean).join(' ').trim() || title;
          if (account && isAccountName(title)) title = chatId;
          peerType = 'user';
          if (organizationId && this.contactManager) {
            await this.contactManager.upsertContactFromTelegramUser(organizationId, chatId, {
              firstName: (u.firstName ?? '').trim(),
              lastName: (u.lastName ?? '').trim() || null,
              username: (u.username ?? '').trim() || null,
            });
          }
        } else if (c === 'Chat') {
          title = (entity as any).title?.trim() || title;
          if (account && isAccountName(title)) title = chatId;
          peerType = 'chat';
        } else if (c === 'Channel') {
          title = (entity as any).title?.trim() || title;
          if (account && isAccountName(title)) title = chatId;
          peerType = 'channel';
        }
      }
    } catch (err: unknown) {
      if (err?.message !== 'TIMEOUT' && !err?.message?.includes('builder.resolve')) {
        this.log.warn({ message: `tryAddChatFromSelectedFolders getEntity ${chatId}`, error: err?.message });
      }
      return false;
    }

    const folderId = 0;
    await this.pool.query(
      `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id)
       VALUES ($1, $2, $3, $4, false, $5)
       ON CONFLICT (bd_account_id, telegram_chat_id) DO UPDATE SET
         title = CASE WHEN EXISTS (
           SELECT 1 FROM bd_accounts a WHERE a.id = EXCLUDED.bd_account_id
             AND (NULLIF(TRIM(COALESCE(a.display_name, '')), '') = TRIM(EXCLUDED.title)
               OR a.username = TRIM(EXCLUDED.title)
               OR NULLIF(TRIM(COALESCE(a.first_name, '')), '') = TRIM(EXCLUDED.title))
         ) THEN bd_account_sync_chats.telegram_chat_id::text ELSE EXCLUDED.title END,
         peer_type = EXCLUDED.peer_type,
         folder_id = COALESCE(bd_account_sync_chats.folder_id, EXCLUDED.folder_id)`,
      [accountId, chatId, title, peerType, folderId]
    );
    await this.pool.query(
      `INSERT INTO bd_account_sync_chat_folders (bd_account_id, telegram_chat_id, folder_id)
       VALUES ($1, $2, $3) ON CONFLICT (bd_account_id, telegram_chat_id, folder_id) DO NOTHING`,
      [accountId, chatId, folderId]
    );
    this.log.info({ message: `Auto-added chat ${chatId} (${title}) for account ${accountId} via getEntity` });
    return true;
  }

  /** User id from GramJS dialog.id (number, PeerUser, or object with userId). */
  private static dialogIdToUserIdStr(dialogIdRaw: unknown): string | null {
    if (dialogIdRaw == null) return null;
    if (typeof dialogIdRaw === 'object') {
      const o = dialogIdRaw as Record<string, unknown>;
      const cn = (o as { className?: string; _?: string }).className ?? (o as { _?: string })._;
      if (cn === 'PeerUser' || cn === 'peerUser') {
        const uid = o.userId ?? o.user_id;
        if (uid != null) return String(uid);
      }
      const uid = o.userId ?? o.user_id;
      if (uid != null) return String(uid);
    }
    if (typeof dialogIdRaw === 'bigint' || typeof dialogIdRaw === 'number') return String(dialogIdRaw);
    return String(dialogIdRaw).trim() || null;
  }

  /** Resolve @username to InputUser via contacts.ResolveUsername (reliable for inviting to channel). */
  private async resolveUsernameToInputUser(client: TelegramClient, username: string): Promise<Api.InputUser | null> {
    const u = (username ?? '').trim().replace(/^@/, '');
    if (!u) return null;
    try {
      const result = await client.invoke(
        new Api.contacts.ResolveUsername({ username: u })
      ) as { users?: Array<{ id?: bigint; accessHash?: bigint; className?: string }> };
      const users = result?.users ?? [];
      const user = users.find((x) => x?.className === 'User' || (x as any)?._ === 'user') as Api.User | undefined;
      if (user?.id != null) {
        return new Api.InputUser({ userId: user.id, accessHash: user.accessHash ?? BigInt(0) });
      }
    } catch (e: unknown) {
      this.log.warn('[ChatSync] createSharedChat: could not resolve username', u, getErrorMessage(e));
    }
    return null;
  }

  async createSharedChat(
    accountId: string,
    params: { title: string; leadTelegramUserId?: number; leadUsername?: string; extraUsernames?: string[] }
  ): Promise<{ channelId: string; title: string; inviteLink?: string }> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo?.isConnected || !clientInfo.client) {
      throw new Error('BD account not connected');
    }
    const client = clientInfo.client;
    const { title, leadTelegramUserId, leadUsername, extraUsernames = [] } = params;

    const updates = await client.invoke(
      new Api.channels.CreateChannel({
        title: title.slice(0, 255),
        about: '',
        megagroup: true,
        broadcast: false,
      })
    ) as Api.Updates;

    let channelId: number | undefined;
    let accessHash: bigint | undefined;
    const chats = (updates as any).chats ?? [];
    for (const chat of chats) {
      if (chat?.className === 'Channel' || (chat as any)._ === 'channel') {
        channelId = chat.id;
        accessHash = chat.accessHash ?? (chat as any).accessHash;
        break;
      }
    }
    if (channelId == null || accessHash == null) {
      throw new Error('Failed to get created channel from response');
    }

    const inputUsers: Api.InputUser[] = [];
    const seenIds = new Set<string>();

    // Resolve lead: try username first (does not depend on cache), then by id, then from dialogs
    let leadAdded = false;
    if (leadUsername) {
      const inputUser = await this.resolveUsernameToInputUser(client, leadUsername);
      if (inputUser && !seenIds.has(String((inputUser as any).userId))) {
        seenIds.add(String((inputUser as any).userId));
        inputUsers.push(inputUser);
        leadAdded = true;
      }
    }
    if (!leadAdded && leadTelegramUserId != null && leadTelegramUserId > 0) {
      try {
        const peer = await client.getInputEntity(leadTelegramUserId);
        const entity = await client.getEntity(peer);
        if (entity && ((entity as any).className === 'User' || (entity as any)._ === 'user')) {
          const u = entity as Api.User;
          const key = String(u.id);
          if (!seenIds.has(key)) {
            seenIds.add(key);
            inputUsers.push(new Api.InputUser({ userId: u.id, accessHash: u.accessHash ?? BigInt(0) }));
            leadAdded = true;
          }
        }
      } catch (e: unknown) {
        this.log.warn({ message: 'createSharedChat: could not resolve lead by id', accountId, leadTelegramUserId, error: getErrorMessage(e) });
      }
    }
    // Fallback: find lead in contacts (does not require entity cache)
    if (!leadAdded && leadTelegramUserId != null && leadTelegramUserId > 0) {
      try {
        const contactsResult = await client.invoke(
          new Api.contacts.GetContacts({ hash: BigInt(0) })
        ) as { users?: Array<{ id?: number | bigint; accessHash?: bigint; className?: string }> };
        const users = contactsResult?.users ?? [];
        const leadIdStr = String(leadTelegramUserId);
        const contactUser = users.find(
          (x) => x && (x.className === 'User' || (x as any)?._ === 'user') && String(x.id) === leadIdStr
        ) as Api.User | undefined;
        if (contactUser?.id != null) {
          const key = String(contactUser.id);
          if (!seenIds.has(key)) {
            seenIds.add(key);
            inputUsers.push(new Api.InputUser({ userId: contactUser.id, accessHash: contactUser.accessHash ?? BigInt(0) }));
            leadAdded = true;
            this.log.info({ message: 'createSharedChat: lead resolved from contacts', accountId, leadTelegramUserId });
          }
        }
      } catch (e: unknown) {
        this.log.warn({ message: 'createSharedChat: contacts fallback failed', accountId, leadTelegramUserId, error: getErrorMessage(e) });
      }
    }
    if (!leadAdded && leadTelegramUserId != null && leadTelegramUserId > 0) {
      try {
        const leadIdStr = String(leadTelegramUserId);
        const folders = [0, 1] as const;
        let dialogsChecked = 0;
        for (const folderId of folders) {
          let dialogs: any[];
          try {
            dialogs = await client.getDialogs({ limit: 500, folderId });
          } catch (folderErr) {
            this.log.warn({ message: 'createSharedChat: getDialogs failed for folder', accountId, folderId, error: getErrorMessage(folderErr) });
            continue;
          }
          dialogsChecked += dialogs.length;
          for (const d of dialogs) {
            const ent = (d as any).entity;
            const dialogIdRaw = (d as any).id;
            const dialogUserIdStr = ChatSync.dialogIdToUserIdStr(dialogIdRaw);
            const entIdStr = ent != null ? String((ent as any).id ?? (ent as any).userId ?? '') : '';
            const entityIsUser = ent && ((ent as any).className === 'User' || (ent as any)._ === 'user');
            const idMatches =
              entityIsUser &&
              (entIdStr === leadIdStr ||
                dialogUserIdStr === leadIdStr ||
                (dialogUserIdStr != null && String(Number(dialogUserIdStr)) === leadIdStr));
            if (idMatches) {
              const u = ent as Api.User;
              const key = String(u.id);
              if (!seenIds.has(key)) {
                seenIds.add(key);
                inputUsers.push(new Api.InputUser({ userId: u.id, accessHash: u.accessHash ?? BigInt(0) }));
                this.log.info({ message: 'createSharedChat: lead resolved from dialogs', accountId, leadTelegramUserId, folderId });
                leadAdded = true;
                break;
              }
            }
          }
          if (leadAdded) break;
        }
        if (!leadAdded) {
          this.log.warn({
            message: 'createSharedChat: lead not found in dialogs',
            accountId,
            leadTelegramUserId,
            dialogsChecked,
          });
        }
      } catch (e: unknown) {
        this.log.warn({ message: 'createSharedChat: dialogs fallback failed', accountId, leadTelegramUserId, error: getErrorMessage(e) });
      }
    }

    for (const username of extraUsernames) {
      const inputUser = await this.resolveUsernameToInputUser(client, username);
      if (inputUser && !seenIds.has(String((inputUser as any).userId))) {
        seenIds.add(String((inputUser as any).userId));
        inputUsers.push(inputUser);
      }
    }

    if (inputUsers.length === 0) {
      this.log.warn({
        message: 'createSharedChat: no participants resolved',
        accountId,
        leadTelegramUserId: leadTelegramUserId ?? null,
        leadUsername: leadUsername ?? null,
        extraUsernamesCount: extraUsernames.length,
      });
      throw new Error(
        'Could not resolve any participant to invite. Add contact @username or ensure the lead is in this account\'s Telegram dialogs.'
      );
    }

    const inputChannel = new Api.InputChannel({ channelId, accessHash });
    const inviteDelayMs = 300;
    for (let i = 0; i < inputUsers.length; i++) {
      const user = inputUsers[i];
      try {
        await client.invoke(new Api.channels.InviteToChannel({ channel: inputChannel, users: [user] }));
      } catch (e: unknown) {
        const code = getErrorCode(e);
        const msg = getErrorMessage(e);
        const knownInviteErrors = [
          'USER_PRIVACY_RESTRICTED',
          'USER_NOT_MUTUAL_CONTACT',
          'USER_KICKED',
          'CHAT_MEMBER_ADD_FAILED',
          'USER_CHANNELS_TOO_MUCH',
          'USER_BOT',
          'USER_ID_INVALID',
          'INPUT_USER_DEACTIVATED',
          'USER_BLOCKED',
          'USER_BANNED_IN_CHANNEL',
        ];
        const isKnown = knownInviteErrors.some((c) => code === c || (typeof msg === 'string' && msg.includes(c)));
        this.log.warn({
          message: 'createSharedChat: InviteToChannel failed for one participant',
          accountId,
          userId: (user as any).userId?.toString?.() ?? 'unknown',
          errorCode: code ?? null,
          error: msg,
          knownInviteError: isKnown,
        });
      }
      if (i < inputUsers.length - 1 && inviteDelayMs > 0) {
        await new Promise((r) => setTimeout(r, inviteDelayMs));
      }
    }

    // Используем InputPeerChannel напрямую: getInputEntity только что созданного канала может дать PEER_ID_INVALID.
    let inviteLink: string | undefined;
    try {
      const peer = new Api.InputPeerChannel({ channelId, accessHash });
      const exported = await client.invoke(
        new Api.messages.ExportChatInvite({
          peer,
          legacyRevokePermanent: false,
        })
      ) as { link?: string };
      if (exported?.link && typeof exported.link === 'string') {
        inviteLink = exported.link.trim();
      }
    } catch (e: unknown) {
      this.log.warn({ message: "createSharedChat: could not export invite link", error: getErrorMessage(e) });
    }

    return { channelId: String(channelId), title, inviteLink, accessHash: accessHash != null ? String(accessHash) : undefined };
  }

  async deleteMessageInTelegram(accountId: string, channelId: string, telegramMessageId: number): Promise<void> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo?.client) throw new Error('Account not connected');
    const client = clientInfo.client;
    const peerInput = (() => {
      const n = Number(channelId);
      if (!Number.isNaN(n)) return n;
      return channelId;
    })();
    const peer = await client.getInputEntity(peerInput);
    await (client as any).deleteMessages(peer, [telegramMessageId], { revoke: true });
  }
}
