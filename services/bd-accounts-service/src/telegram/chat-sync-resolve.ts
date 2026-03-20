// @ts-nocheck — GramJS types are incomplete
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { getErrorMessage, getErrorCode } from '../helpers';
import type { StructuredLog, TelegramSourceType, ResolvedSource } from './types';
import { telegramInvokeWithFloodRetry } from './telegram-invoke-flood';

export type ResolveChatBasic = { chatId: string; title: string; peerType: string };

/** Fallback when client disconnects after basic resolve (matches legacy ChatSync behavior). */
export function resolvedSourceFromBasicInput(basic: ResolveChatBasic, input: string): ResolvedSource {
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

/**
 * Resolve invite / username / t.me link to chat id + title.
 * Extracted from ChatSync for SRP (C3).
 */
export async function resolveChatFromInputGlobal(
  log: StructuredLog,
  accountId: string,
  client: TelegramClient,
  input: string
): Promise<ResolveChatBasic> {
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
      const updates = (await telegramInvokeWithFloodRetry(log, accountId, 'ImportChatInvite', () =>
        client.invoke(new Api.messages.ImportChatInvite({ hash }))
      )) as any;
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
    const resolved = (await telegramInvokeWithFloodRetry(log, accountId, 'ResolveUsername(basic)', () =>
      client.invoke(new Api.contacts.ResolveUsername({ username }))
    )) as any;
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
    log.error({ message: 'resolveChatFromInput failed', accountId, input: raw, error: getErrorMessage(e) });
    throw e;
  }
}

/**
 * Enrich basic resolve with GetFullChannel / GetFullChat (parse flow).
 */
export async function enrichResolvedSourceFromBasic(
  log: StructuredLog,
  accountId: string,
  client: TelegramClient,
  input: string,
  basic: ResolveChatBasic
): Promise<ResolvedSource> {
  const raw = (input || '').trim();
  const chatId = basic.chatId;

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
    log.warn({ message: 'resolveSourceFromInput getEntity failed, using basic', accountId, input: raw, error: getErrorMessage(e) });
    return resolvedSourceFromBasicInput(basic, input);
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
        const inputChannel = (await client.getInputEntity(entity)) as any;
        const full = (await telegramInvokeWithFloodRetry(log, accountId, 'GetFullChannel(broadcast)', () =>
          client.invoke(new Api.channels.GetFullChannel({ channel: inputChannel }))
        )) as any;
        const fullChat = full?.fullChat ?? full?.full_chat;
        if (fullChat?.linkedChatId) {
          linkedChatId = Number(fullChat.linkedChatId);
          type = 'comment_group';
        } else {
          type = 'channel';
        }
        if (fullChat?.participantsCount != null) membersCount = Number(fullChat.participantsCount);
      } catch (e: unknown) {
        log.warn({ message: 'GetFullChannel failed in resolveSource', accountId, chatId, error: getErrorMessage(e) });
        type = 'channel';
      }
    } else {
      type = ch.username ? 'public_group' : 'private_group';
      canGetMembers = !!ch.username;
      try {
        const inputChannel = (await client.getInputEntity(entity)) as any;
        const full = (await telegramInvokeWithFloodRetry(log, accountId, 'GetFullChannel(group)', () =>
          client.invoke(new Api.channels.GetFullChannel({ channel: inputChannel }))
        )) as any;
        const fullChat = full?.fullChat ?? full?.full_chat;
        if (fullChat?.participantsCount != null) membersCount = Number(fullChat.participantsCount);
      } catch (e: unknown) {
        log.warn({ message: 'GetFullChannel failed in resolveSource', accountId, chatId, error: getErrorMessage(e) });
      }
    }
  } else if (entity instanceof Api.Chat) {
    type = 'public_group';
    canGetMembers = true;
    try {
      const chatIdNum = (entity as any).id ?? (entity as any).chatId;
      const full = (await telegramInvokeWithFloodRetry(log, accountId, 'GetFullChat(enrich)', () =>
        client.invoke(new Api.messages.GetFullChat({ chatId: chatIdNum }))
      )) as any;
      const fullChat = full?.fullChat ?? full?.full_chat;
      if (fullChat?.participantsCount != null) membersCount = Number(fullChat.participantsCount);
    } catch (e: unknown) {
      log.warn({ message: 'GetFullChat failed in resolveSource', accountId, chatId, error: getErrorMessage(e) });
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

/**
 * Rich resolve for parse flow (full path: basic + enrich).
 * Extracted from ChatSync for SRP (C3).
 */
export async function resolveSourceFromInputGlobal(
  log: StructuredLog,
  accountId: string,
  client: TelegramClient,
  input: string
): Promise<ResolvedSource> {
  const basic = await resolveChatFromInputGlobal(log, accountId, client, input);
  return enrichResolvedSourceFromBasic(log, accountId, client, input, basic);
}
