// @ts-nocheck
import { Api } from 'telegram';

type JsonSafe = string | number | boolean | null | JsonSafe[] | { [key: string]: JsonSafe };

function toJsonSafe(value: unknown): JsonSafe | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return String(value);
  if (Array.isArray(value)) return value.map(toJsonSafe).filter((x): x is JsonSafe => x !== undefined) as JsonSafe[];
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (typeof (obj as { toJSON?: () => unknown }).toJSON === 'function') {
      try { return (obj as { toJSON: () => unknown }).toJSON() as JsonSafe; } catch { /* skip */ }
    }
    const out: Record<string, JsonSafe> = {};
    for (const k of Object.keys(obj)) {
      if (k.startsWith('_')) continue;
      const v = toJsonSafe(obj[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return undefined;
}

function serializeEntities(entities: Api.TypeMessageEntity[] | undefined): Record<string, unknown>[] | null {
  if (!entities || !Array.isArray(entities)) return null;
  return entities.map((e) => {
    const o = toJsonSafe(e);
    return typeof o === 'object' && o !== null ? (o as Record<string, unknown>) : {};
  });
}

function serializeMedia(media: Api.TypeMessageMedia | undefined): Record<string, unknown> | null {
  if (!media) return null;
  const o = toJsonSafe(media);
  if (typeof o !== 'object' || o === null) return null;
  const out = o as Record<string, unknown>;
  out._ = (media as any).className ?? (media as any).CONSTRUCTOR_ID ?? 'unknown';
  return out;
}

function serializeReplyTo(replyTo: Api.TypeMessageReplyHeader | undefined): Record<string, unknown> | null {
  if (!replyTo) return null;
  const o = toJsonSafe(replyTo);
  return typeof o === 'object' && o !== null ? (o as Record<string, unknown>) : null;
}

function serializeFwdFrom(fwdFrom: Api.TypeMessageFwdHeader | undefined): Record<string, unknown> | null {
  if (!fwdFrom) return null;
  const o = toJsonSafe(fwdFrom);
  return typeof o === 'object' && o !== null ? (o as Record<string, unknown>) : null;
}

function serializeReactions(reactions: Api.TypeMessageReactions | undefined): Record<string, unknown> | null {
  if (!reactions) return null;
  const o = toJsonSafe(reactions);
  return typeof o === 'object' && o !== null ? (o as Record<string, unknown>) : null;
}

export interface SerializedTelegramMessage {
  telegram_message_id: string;
  telegram_date: Date | null;
  content: string;
  telegram_entities: Record<string, unknown>[] | null;
  telegram_media: Record<string, unknown> | null;
  reply_to_telegram_id: string | null;
  telegram_extra: Record<string, unknown>;
}

function readString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (typeof value === 'object' && typeof (value as any).toString === 'function') return (value as any).toString();
  return String(value);
}

export function getMessageText(msg: Api.Message | Record<string, unknown>): string {
  const m = msg as Record<string, unknown>;
  let raw: unknown = (m as any).message;
  if (raw != null && raw !== '') return readString(raw);
  raw = (m as any).rawText;
  if (raw != null && raw !== '') return readString(raw);
  raw = (m as any).text;
  if (raw != null && raw !== '') return readString(raw);
  raw = m.message ?? m.rawText ?? m.text;
  if (raw != null && raw !== '') return readString(raw);
  const args = (m.originalArgs && typeof m.originalArgs === 'object' ? (m.originalArgs as Record<string, unknown>) : null)
    ?? ((m as any).args && typeof (m as any).args === 'object' ? (m as any).args as Record<string, unknown> : null);
  if (args) {
    raw = args.message ?? args.rawText ?? args.text;
    if (raw != null && raw !== '') return readString(raw);
  }
  for (const key of ['message', 'rawText', 'text']) {
    const desc = Object.getOwnPropertyDescriptor(m, key) ?? Object.getOwnPropertyDescriptor(Object.getPrototypeOf(m), key);
    if (desc) {
      raw = typeof desc.get === 'function' ? desc.get.call(m) : desc.value;
      if (raw != null && raw !== '') return readString(raw);
    }
  }
  return '';
}

export function serializeMessage(msg: Api.Message): SerializedTelegramMessage {
  const id = String((msg as any).id ?? '');
  const date = (msg as any).date ? new Date((msg as any).date * 1000) : null;
  const text = getMessageText(msg);

  let replyToTelegramId: string | null = null;
  const replyTo = msg.replyTo ?? (msg as any).replyTo ?? (msg as any).reply_to;
  if (replyTo) {
    const replyHeader = replyTo as any;
    replyToTelegramId =
      replyHeader.replyToMsgId != null ? String(replyHeader.replyToMsgId)
        : replyHeader.reply_to_msg_id != null ? String(replyHeader.reply_to_msg_id) : null;
  }
  if (!replyToTelegramId && (msg as any).reply_to?.reply_to_msg_id != null)
    replyToTelegramId = String((msg as any).reply_to.reply_to_msg_id);
  if (!replyToTelegramId && (msg as any).reply_to_msg_id != null)
    replyToTelegramId = String((msg as any).reply_to_msg_id);

  const raw = msg as any;
  const extra: Record<string, unknown> = {};
  if (msg.views != null || raw.views != null) extra.views = msg.views ?? raw.views;
  if (msg.forwards != null || raw.forwards != null) extra.forwards = msg.forwards ?? raw.forwards;
  if (msg.editDate != null || raw.editDate != null || raw.edit_date != null) extra.edit_date = msg.editDate ?? raw.editDate ?? raw.edit_date;
  if (msg.postAuthor != null || raw.postAuthor != null) extra.post_author = msg.postAuthor ?? raw.postAuthor;
  if (msg.groupedId != null || raw.groupedId != null) extra.grouped_id = String(msg.groupedId ?? raw.groupedId ?? '');
  if (msg.viaBotId != null || raw.viaBotId != null) extra.via_bot_id = String(msg.viaBotId ?? raw.viaBotId ?? '');
  if (msg.post !== undefined || raw.post !== undefined) extra.post = msg.post ?? raw.post;
  if (msg.silent !== undefined || raw.silent !== undefined) extra.silent = msg.silent ?? raw.silent;
  if (msg.pinned !== undefined || raw.pinned !== undefined) extra.pinned = msg.pinned ?? raw.pinned;
  if (msg.noforwards !== undefined || raw.noforwards !== undefined) extra.noforwards = msg.noforwards ?? raw.noforwards;
  if (msg.mentioned !== undefined || raw.mentioned !== undefined) extra.mentioned = msg.mentioned ?? raw.mentioned;
  if (msg.mediaUnread !== undefined || raw.mediaUnread !== undefined) extra.media_unread = msg.mediaUnread ?? raw.mediaUnread;
  const fwd = serializeFwdFrom(msg.fwdFrom ?? raw.fwdFrom ?? raw.fwd_from);
  if (fwd) extra.fwd_from = fwd;
  const reactions = serializeReactions(msg.reactions ?? raw.reactions);
  if (reactions) extra.reactions = reactions;
  if (msg.replyMarkup || raw.replyMarkup || raw.reply_markup) extra.reply_markup = toJsonSafe(msg.replyMarkup ?? raw.replyMarkup ?? raw.reply_markup);
  if (msg.replies || raw.replies) extra.replies = toJsonSafe(msg.replies ?? raw.replies);

  return {
    telegram_message_id: id,
    telegram_date: date,
    content: text,
    telegram_entities: serializeEntities(msg.entities ?? raw.entities ?? undefined),
    telegram_media: serializeMedia(msg.media ?? raw.media ?? undefined),
    reply_to_telegram_id: replyToTelegramId,
    telegram_extra: Object.keys(extra).length ? extra : {},
  };
}
