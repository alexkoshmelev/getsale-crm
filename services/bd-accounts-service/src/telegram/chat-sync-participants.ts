// @ts-nocheck — GramJS types are incomplete
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { getErrorMessage, getErrorCode } from '../helpers';
import type { StructuredLog } from './types';
import { telegramInvokeWithFloodRetry } from './telegram-invoke-flood';

export type ChannelParticipantUser = {
  telegram_id: string;
  username?: string;
  first_name?: string;
  last_name?: string;
};

export type GetChannelParticipantsResult = {
  users: ChannelParticipantUser[];
  nextOffset: number | null;
};

export async function getEntityForChatId(client: TelegramClient, channelId: string): Promise<any> {
  const peerId = Number(channelId);
  const isNumericId = !Number.isNaN(peerId) && !channelId.startsWith('@') && !channelId.includes('://');
  if (isNumericId && peerId > 0) {
    try {
      return await client.getEntity(`-100${channelId}`);
    } catch {
      try {
        return await client.getEntity(`-${channelId}`);
      } catch {
        return await client.getEntity(channelId);
      }
    }
  }
  return await client.getEntity(channelId);
}

async function getBasicGroupParticipants(
  log: StructuredLog,
  accountId: string,
  client: TelegramClient,
  chatEntity: any,
  excludeAdmins: boolean
): Promise<GetChannelParticipantsResult> {
  const chatId = chatEntity.id ?? chatEntity.chatId;
  const full = (await telegramInvokeWithFloodRetry(log, accountId, 'GetFullChat', () =>
    client.invoke(new Api.messages.GetFullChat({ chatId }))
  )) as any;
  const fullChat = full?.fullChat ?? full?.full_chat;
  const participants = fullChat?.participants?.participants ?? fullChat?.participants ?? [];
  const users = full?.users ?? [];
  const userMap = new Map<number, any>();
  for (const u of users) {
    const id = (u as any).id ?? (u as any).userId;
    if (id != null) userMap.set(Number(id), u);
  }
  const out: ChannelParticipantUser[] = [];
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

function mapParticipantErrors(e: unknown): never {
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

/**
 * Channel/supergroup/basic chat participants (GetParticipants / GetFullChat).
 * Extracted from ChatSync for SRP (C3).
 */
export async function getChannelParticipantsGlobal(
  log: StructuredLog,
  accountId: string,
  client: TelegramClient,
  channelId: string,
  offset: number,
  limit: number,
  excludeAdmins: boolean = false
): Promise<GetChannelParticipantsResult> {
  let entity: any;

  try {
    entity = await getEntityForChatId(client, channelId);

    if (!(entity instanceof Api.Chat || entity instanceof Api.Channel)) {
      throw new Error('Not a group or channel');
    }
    if (entity instanceof Api.Chat) {
      return getBasicGroupParticipants(log, accountId, client, entity, excludeAdmins);
    }
  } catch (e: unknown) {
    mapParticipantErrors(e);
  }

  try {
    const result = (await telegramInvokeWithFloodRetry(log, accountId, 'channels.GetParticipants', () =>
      client.invoke(
        new Api.channels.GetParticipants({
          channel: entity,
          filter: new Api.ChannelParticipantsRecent(),
          offset,
          limit: Math.min(limit, 200),
          hash: BigInt(0),
        })
      )
    )) as { participants?: any[]; users?: any[]; count?: number };
    const participants = result?.participants ?? [];
    const users = result?.users ?? [];
    const userMap = new Map<number, any>();
    for (const u of users) {
      const id = (u as any).id ?? (u as any).userId;
      if (id != null) userMap.set(Number(id), u);
    }
    const out: ChannelParticipantUser[] = [];
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
    const nextOffset =
      offset + participants.length < count && participants.length >= Math.min(limit, 200)
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
    log.error({ message: 'getChannelParticipants failed', accountId, channelId, error: getErrorMessage(e) });
    throw e;
  }
}

/**
 * Recent active users from message history (+ optional admin filter for channels).
 * Extracted from ChatSync for SRP (C3).
 */
export async function getActiveParticipantsGlobal(
  log: StructuredLog,
  accountId: string,
  client: TelegramClient,
  chatId: string,
  depth: number,
  excludeAdmins: boolean = false
): Promise<{ users: ChannelParticipantUser[] }> {
  let entity: any;

  try {
    entity = await getEntityForChatId(client, chatId);
  } catch (e: unknown) {
    log.error({ message: 'Failed to resolve entity for getActiveParticipants', accountId, chatId, error: getErrorMessage(e) });
    throw e;
  }

  const uniqueUsers = new Map<string, any>();
  let offsetId = 0;
  const limit = 100;
  let fetched = 0;

  try {
    while (fetched < depth) {
      const fetchLimit = Math.min(limit, depth - fetched);
      const result = (await telegramInvokeWithFloodRetry(log, accountId, 'GetHistory', () =>
        client.invoke(
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
        )
      )) as any;

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
          const adminResult = (await telegramInvokeWithFloodRetry(log, accountId, 'GetParticipants(admins)', () =>
            client.invoke(
              new Api.channels.GetParticipants({
                channel: entity,
                filter: new Api.ChannelParticipantsAdmins(),
                offset: 0,
                limit: 100,
                hash: BigInt(0),
              })
            )
          )) as { participants?: any[]; users?: any[] };
          const adminIds = new Set(
            (adminResult.participants || [])
              .filter((p) => p instanceof Api.ChannelParticipantAdmin || p instanceof Api.ChannelParticipantCreator)
              .map((p) => String(p.userId))
          );
          usersResult = usersResult.filter((u) => !adminIds.has(u.telegram_id));
        }
      } catch (err) {
        log.warn({ message: 'Failed to fetch admins for exclusion in getActiveParticipants', error: String(err) });
      }
    }

    return { users: usersResult };
  } catch (e: unknown) {
    log.error({ message: 'getActiveParticipants failed', accountId, chatId, error: getErrorMessage(e) });
    throw e;
  }
}
