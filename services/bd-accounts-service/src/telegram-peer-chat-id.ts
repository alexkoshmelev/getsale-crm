// @ts-nocheck — GramJS peer types
import { Api } from 'telegram';

/** Stable chat id string for bd_account_sync_chats / inbound allowlist (matches message-handler peer extraction). */
export function canonicalTelegramChatIdFromPeer(peerId: unknown): string | null {
  if (!peerId || typeof peerId !== 'object') return null;
  if (peerId instanceof Api.PeerUser) return String(peerId.userId);
  if (peerId instanceof Api.PeerChat) return String(peerId.chatId);
  if (peerId instanceof Api.PeerChannel) return String(peerId.channelId);
  return null;
}

export function canonicalTelegramChatIdFromMessage(message: { peerId?: unknown }): string | null {
  return canonicalTelegramChatIdFromPeer(message?.peerId);
}
