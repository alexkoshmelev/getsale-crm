import type { Logger } from '@getsale/logger';
import type { ServiceHttpClient } from '@getsale/service-core';

/** Row from bd-accounts `GET /internal/sync-chats` (folder_ids optional by path). */
export type BdInternalSyncChat = {
  telegram_chat_id: string;
  title: string | null;
  peer_type: string;
  folder_id: number | null;
  folder_ids?: number[];
};

/**
 * Fetches sync chat list for one BD account. Propagates HTTP/client errors for the router to map to AppError.
 */
export async function fetchBdInternalSyncChats(
  bdAccountsClient: ServiceHttpClient,
  organizationId: string,
  bdAccountId: string
): Promise<BdInternalSyncChat[]> {
  const data = await bdAccountsClient.get<{ chats: BdInternalSyncChat[] }>(
    `/internal/sync-chats?bdAccountId=${encodeURIComponent(bdAccountId)}`,
    undefined,
    { organizationId }
  );
  return data?.chats ?? [];
}

export type BdInternalSyncChatWithAccount = BdInternalSyncChat & { bd_account_id: string };

/**
 * Parallel fetch for all org accounts used on GET /chats without bdAccountId. Failures are logged; empty chunk for that account.
 */
export async function fetchBdInternalSyncChatsForManyAccounts(
  bdAccountsClient: ServiceHttpClient,
  log: Logger,
  organizationId: string,
  accountIds: string[]
): Promise<BdInternalSyncChatWithAccount[]> {
  const chunks = await Promise.all(
    accountIds.map(async (bdId) => {
      try {
        const chats = await fetchBdInternalSyncChats(bdAccountsClient, organizationId, bdId);
        return chats.map((c) => ({
          bd_account_id: bdId,
          telegram_chat_id: c.telegram_chat_id,
          title: c.title,
          peer_type: c.peer_type,
          folder_id: c.folder_id,
        }));
      } catch (err) {
        log.warn({
          message: 'sync-chats fetch failed for default chat list',
          bdAccountId: bdId,
          error: String(err),
        });
        return [];
      }
    })
  );
  return chunks.flat();
}
