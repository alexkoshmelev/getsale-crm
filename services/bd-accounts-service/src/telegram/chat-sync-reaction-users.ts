// @ts-nocheck — GramJS / TL vary by layer version
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { getErrorMessage } from '../helpers';
import type { StructuredLog } from './types';
import { telegramInvokeWithFloodRetry } from './telegram-invoke-flood';
import type { ChannelParticipantUser } from './chat-sync-participants';
import { getEntityForChatId } from './chat-sync-participants';

const DEFAULT_HISTORY = 80;
const MAX_MESSAGES_WITH_REACTIONS = 12;
const REACTORS_PER_MESSAGE = 40;
/** Batch refresh of view counts before prioritization (increment=false — не накручиваем счётчик). */
const MAX_IDS_FOR_VIEWS_REFRESH = 48;

function viewsFromMessage(m: { views?: number } | null | undefined): number {
  const v = m?.views;
  return typeof v === 'number' && v >= 0 ? v : 0;
}

/**
 * Users who reacted to recent channel posts (best-effort; TL method may be absent on older layers).
 * Complements active-participants (authors) for каналы без группы обсуждения (PLAN §3.1).
 *
 * **Просмотры:** MTProto не отдаёт список «кто посмотрел» обычному клиенту; `messages.getMessagesViews`
 * даёт только числа. Здесь они используются, чтобы брать реакции сначала с наиболее просматриваемых постов.
 */
export async function getReactionContributorsGlobal(
  log: StructuredLog,
  accountId: string,
  client: TelegramClient,
  chatId: string,
  options: { historyLimit?: number } = {}
): Promise<{ users: ChannelParticipantUser[] }> {
  const historyLimit = Math.min(200, Math.max(20, options.historyLimit ?? DEFAULT_HISTORY));

  let entity: any;
  try {
    entity = await getEntityForChatId(client, chatId);
  } catch (e: unknown) {
    log.error({ message: 'reaction-users: resolve entity', accountId, chatId, error: getErrorMessage(e) });
    throw e;
  }

  const inputPeer = await client.getInputEntity(entity);

  const hist = await telegramInvokeWithFloodRetry(log, accountId, 'GetHistory(reactions)', () =>
    client.invoke(
      new Api.messages.GetHistory({
        peer: entity,
        offsetId: 0,
        offsetDate: 0,
        addOffset: 0,
        limit: historyLimit,
        maxId: 0,
        minId: 0,
        hash: BigInt(0),
      })
    )
  );

  let messages = (hist?.messages || []).filter((m: any) => m?.id && (m.reactions || m.reactionsCount));

  const ViewsCtor = (Api.messages as { GetMessagesViews?: new (args: unknown) => unknown }).GetMessagesViews;
  if (typeof ViewsCtor === 'function' && messages.length > 0) {
    const ids = messages
      .slice(0, MAX_IDS_FOR_VIEWS_REFRESH)
      .map((m: { id: number }) => m.id)
      .filter((id: number) => id != null);
    if (ids.length > 0) {
      try {
        const mv = await telegramInvokeWithFloodRetry(log, accountId, 'GetMessagesViews(reactions-priority)', () =>
          client.invoke(
            new ViewsCtor({
              peer: inputPeer,
              id: ids,
              increment: false,
            })
          )
        );
        const viewRows = mv?.views || [];
        const idToViews = new Map<number, number>();
        for (let i = 0; i < ids.length && i < viewRows.length; i++) {
          const row = viewRows[i] as { views?: number } | undefined;
          const n = row && typeof row.views === 'number' ? row.views : 0;
          idToViews.set(ids[i], n);
        }
        messages = messages.map((m: any) => {
          const refreshed = idToViews.get(m.id);
          if (refreshed == null) return m;
          return { ...m, views: refreshed };
        });
      } catch {
        /* Use views from GetHistory only if refresh fails */
      }
    }
  }

  messages.sort((a: any, b: any) => {
    const dv = viewsFromMessage(b) - viewsFromMessage(a);
    if (dv !== 0) return dv;
    return (b.id ?? 0) - (a.id ?? 0);
  });
  const slice = messages.slice(0, MAX_MESSAGES_WITH_REACTIONS);

  const Ctor = (Api.messages as { GetMessageReactionsList?: new (args: unknown) => unknown }).GetMessageReactionsList;
  if (typeof Ctor !== 'function') {
    log.warn({
      message: 'GetMessageReactionsList not available in this GramJS build — returning empty reaction set',
      accountId,
      chatId,
    });
    return { users: [] };
  }

  const byId = new Map<string, ChannelParticipantUser>();

  for (const msg of slice) {
    try {
      const res = await telegramInvokeWithFloodRetry(
        log,
        accountId,
        `GetMessageReactionsList(${msg.id})`,
        () =>
          client.invoke(
            new Ctor({
              peer: inputPeer,
              id: msg.id,
              limit: REACTORS_PER_MESSAGE,
              offset: '',
            })
          )
      );
      const users = res?.users || [];
      for (const u of users) {
        const id = u?.id != null ? String(u.id) : '';
        if (!id || u.deleted || u.bot || byId.has(id)) continue;
        byId.set(id, {
          telegram_id: id,
          username: (u.username ?? '').trim() || undefined,
          first_name: (u.firstName ?? u.first_name ?? '').trim() || undefined,
          last_name: (u.lastName ?? u.last_name ?? '').trim() || undefined,
        });
      }
    } catch (e: unknown) {
      log.warn({
        message: 'GetMessageReactionsList failed for message',
        accountId,
        chatId,
        msgId: msg.id,
        error: getErrorMessage(e),
      });
    }
  }

  return { users: Array.from(byId.values()) };
}
