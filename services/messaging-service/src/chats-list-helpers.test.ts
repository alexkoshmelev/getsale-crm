import { describe, it, expect } from 'vitest';
import {
  dedupeTelegramUserChats,
  shouldDedupeTelegramDmRow,
  normalizeChatRows,
  type ChatListRow,
} from './chats-list-helpers';

describe('dedupeTelegramUserChats', () => {
  it('merges two DM rows with same telegram_id, keeps newer last_message_at and sums unread', () => {
    const rows: ChatListRow[] = normalizeChatRows([
      {
        channel_id: '8214410394',
        peer_type: 'user',
        telegram_id: '8214410394',
        contact_id: 'c1',
        last_message_at: '2026-04-01T21:49:00.000Z',
        last_message: 'newer',
        unread_count: 1,
      },
      {
        channel_id: 'someuser',
        peer_type: 'user',
        telegram_id: '8214410394',
        contact_id: 'c1',
        last_message_at: '2026-04-01T21:11:00.000Z',
        last_message: 'older',
        unread_count: 2,
      },
    ]);
    const out = dedupeTelegramUserChats(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.channel_id).toBe('8214410394');
    expect(out[0]!.last_message).toBe('newer');
    expect(out[0]!.unread_count).toBe(3);
  });

  it('does not merge negative (group) channel ids', () => {
    const rows: ChatListRow[] = normalizeChatRows([
      {
        channel_id: '-1001234567890',
        peer_type: 'chat',
        telegram_id: null,
        contact_id: 'c1',
        last_message_at: '2026-04-01T21:00:00.000Z',
        unread_count: 1,
      },
      {
        channel_id: '-1001234567890',
        peer_type: 'chat',
        telegram_id: null,
        contact_id: 'c1',
        last_message_at: '2026-04-01T20:00:00.000Z',
        unread_count: 0,
      },
    ]);
    const out = dedupeTelegramUserChats(rows);
    expect(out).toHaveLength(2);
  });

  it('merges by contact_id when telegram_id is missing', () => {
    const rows: ChatListRow[] = normalizeChatRows([
      {
        channel_id: '111',
        peer_type: 'user',
        telegram_id: null,
        contact_id: 'same-contact',
        last_message_at: '2026-04-01T22:00:00.000Z',
        unread_count: 0,
      },
      {
        channel_id: 'alias',
        peer_type: 'user',
        telegram_id: null,
        contact_id: 'same-contact',
        last_message_at: '2026-04-01T21:00:00.000Z',
        unread_count: 5,
      },
    ]);
    const out = dedupeTelegramUserChats(rows);
    expect(out).toHaveLength(1);
    expect(out[0]!.channel_id).toBe('111');
    expect(out[0]!.unread_count).toBe(5);
  });

  it('does not merge rows without telegram_id or contact_id', () => {
    const rows: ChatListRow[] = normalizeChatRows([
      {
        channel_id: 'a',
        peer_type: 'user',
        telegram_id: null,
        contact_id: null,
        last_message_at: '2026-04-01T21:00:00.000Z',
        unread_count: 1,
      },
      {
        channel_id: 'b',
        peer_type: 'user',
        telegram_id: null,
        contact_id: null,
        last_message_at: '2026-04-01T20:00:00.000Z',
        unread_count: 1,
      },
    ]);
    const out = dedupeTelegramUserChats(rows);
    expect(out).toHaveLength(2);
  });
});

describe('shouldDedupeTelegramDmRow', () => {
  it('returns false for negative peer ids', () => {
    expect(
      shouldDedupeTelegramDmRow({
        peer_type: 'user',
        channel_id: '-100',
      })
    ).toBe(false);
  });

  it('returns true for user DM with positive numeric id', () => {
    expect(
      shouldDedupeTelegramDmRow({
        peer_type: 'user',
        channel_id: '8214410394',
      })
    ).toBe(true);
  });
});
