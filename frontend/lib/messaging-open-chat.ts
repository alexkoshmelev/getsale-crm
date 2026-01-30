/**
 * Текущий открытый чат на странице Messaging.
 * Используется, чтобы не проигрывать звук уведомления, когда пользователь уже в этом чате (как в Telegram).
 */
let current: { bdAccountId: string; channelId: string } | null = null;

export function getCurrentMessagingChat(): { bdAccountId: string; channelId: string } | null {
  return current;
}

export function setCurrentMessagingChat(bdAccountId: string | null, channelId: string | null): void {
  if (bdAccountId && channelId) {
    current = { bdAccountId, channelId };
  } else {
    current = null;
  }
}
