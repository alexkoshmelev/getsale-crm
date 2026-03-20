// @ts-nocheck — GramJS types are incomplete
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { getErrorMessage } from '../helpers';
import type { StructuredLog } from './types';
import { telegramInvokeWithFloodRetry } from './telegram-invoke-flood';
import type { ChannelParticipantUser } from './chat-sync-participants';
import { getEntityForChatId } from './chat-sync-participants';

const MAX_PAGES_REPLIES = 8;
const DEFAULT_POST_LIMIT = 40;
const DEFAULT_REPLIES_PER_PAGE = 80;

/**
 * Unique authors from replies under recent channel posts (discussion / comments).
 * `linkedChatId` is reserved for future validation; Telegram expects GetReplies with channel peer + post id.
 */
export async function getCommentGroupParticipantsGlobal(
  log: StructuredLog,
  accountId: string,
  client: TelegramClient,
  channelId: string,
  _linkedChatId: string,
  options: {
    postLimit?: number;
    maxRepliesPerPost?: number;
    excludeAdmins?: boolean;
  } = {}
): Promise<{ users: ChannelParticipantUser[] }> {
  const postLimit = Math.min(100, Math.max(5, options.postLimit ?? DEFAULT_POST_LIMIT));
  const maxRepliesPerPost = Math.min(500, Math.max(20, options.maxRepliesPerPost ?? DEFAULT_REPLIES_PER_PAGE));
  const excludeAdmins = options.excludeAdmins ?? false;

  let channelEntity: any;
  try {
    channelEntity = await getEntityForChatId(client, channelId);
  } catch (e: unknown) {
    log.error({ message: 'comment-participants: resolve channel', accountId, channelId, error: getErrorMessage(e) });
    throw e;
  }

  if (!(channelEntity instanceof Api.Channel)) {
    throw new Error('Not a channel');
  }

  let inputPeer: any;
  try {
    inputPeer = await client.getInputEntity(channelEntity);
  } catch (e: unknown) {
    log.error({ message: 'comment-participants: getInputEntity', accountId, channelId, error: getErrorMessage(e) });
    throw e;
  }

  const posts = await telegramInvokeWithFloodRetry(log, accountId, 'GetHistory(posts)', () =>
    client.invoke(
      new Api.messages.GetHistory({
        peer: channelEntity,
        offsetId: 0,
        offsetDate: 0,
        addOffset: 0,
        limit: postLimit,
        maxId: 0,
        minId: 0,
        hash: BigInt(0),
      })
    )
  );

  const postMessages = (posts?.messages || []).filter((m: any) => m && m.id);
  const uniqueUsers = new Map<string, ChannelParticipantUser>();

  let adminIds: Set<string> | null = null;
  if (excludeAdmins) {
    try {
      const adminResult = (await telegramInvokeWithFloodRetry(log, accountId, 'GetParticipants(admins,comment)', () =>
        client.invoke(
          new Api.channels.GetParticipants({
            channel: channelEntity,
            filter: new Api.ChannelParticipantsAdmins(),
            offset: 0,
            limit: 200,
            hash: BigInt(0),
          })
        )
      )) as { participants?: any[] };
      adminIds = new Set(
        (adminResult.participants || [])
          .map((p: any) => String(p.userId ?? p.user_id ?? ''))
          .filter(Boolean)
      );
    } catch {
      adminIds = new Set();
    }
  }

  for (const post of postMessages) {
    const msgId = post.id;
    if (msgId == null) continue;

    let collected = 0;
    let offsetId = 0;
    let offsetDate = 0;
    let addOffset = 0;
    let pages = 0;

    while (collected < maxRepliesPerPost && pages < MAX_PAGES_REPLIES) {
      pages++;
      const pageLimit = Math.min(100, maxRepliesPerPost - collected);
      if (pageLimit <= 0) break;

      const batch = await telegramInvokeWithFloodRetry(log, accountId, `GetReplies(post=${msgId},p=${pages})`, () =>
        client.invoke(
          new Api.messages.GetReplies({
            peer: inputPeer,
            msgId,
            offsetId,
            offsetDate,
            addOffset,
            offset: 0,
            limit: pageLimit,
            maxId: 0,
            minId: 0,
            hash: BigInt(0),
          })
        )
      );

      const messages = batch?.messages || [];
      const users = batch?.users || [];
      const usersMap = new Map<string, any>();
      for (const u of users) {
        const id = u?.id ?? u?.userId;
        if (id != null) usersMap.set(String(id), u);
      }

      for (const m of messages) {
        const fromId = m?.fromId;
        let uid: string | null = null;
        if (fromId && (fromId.className === 'PeerUser' || (fromId as any).userId != null)) {
          uid = String((fromId as any).userId ?? (fromId as any).user_id ?? '');
        }
        if (!uid || uniqueUsers.has(uid)) continue;
        const u = usersMap.get(uid);
        if (!u || u.deleted || u.bot) continue;
        if (adminIds && adminIds.has(uid)) continue;
        uniqueUsers.set(uid, {
          telegram_id: uid,
          username: (u.username ?? '').trim() || undefined,
          first_name: (u.firstName ?? u.first_name ?? '').trim() || undefined,
          last_name: (u.lastName ?? u.last_name ?? '').trim() || undefined,
        });
        collected++;
      }

      if (messages.length < pageLimit) break;
      const last = messages[messages.length - 1];
      offsetId = last.id;
      offsetDate = last.date ?? 0;
      addOffset = 0;
    }
  }

  return { users: Array.from(uniqueUsers.values()) };
}
