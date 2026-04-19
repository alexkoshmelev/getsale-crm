// @ts-nocheck — GramJS types are incomplete
import type { Pool } from 'pg';
import { Logger } from '@getsale/logger';
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { telegramInvokeWithFloodRetry } from '@getsale/telegram';

export interface ExecuteCreateSharedChatTelegramInput {
  client: TelegramClient;
  pool: Pool;
  log: Logger;
  bdAccountId: string;
  title: string;
  leadTelegramUserId?: number;
  leadUsername?: string;
  extraUsernames: string[];
}

export interface CreateSharedChatTelegramResult {
  /** Raw positive channel id from Telegram (string) */
  channelId: string;
  title: string;
  inviteLink: string | null;
  /** Supergroup id form for DB (e.g. -100...) as string for bigint column */
  sharedChatChannelIdForDb: string | null;
}

/**
 * Creates a Telegram megagroup, invites users, exports invite link, DMs link, syncs bd_account_sync_chats.
 * Shared by HTTP route and queue handler (AccountActor).
 */
export async function executeCreateSharedChatTelegram(
  input: ExecuteCreateSharedChatTelegramInput,
): Promise<CreateSharedChatTelegramResult> {
  const { client, pool, log, bdAccountId, title: rawTitle } = input;
  const title = rawTitle.trim().slice(0, 255);
  const leadId =
    input.leadTelegramUserId != null && Number.isInteger(Number(input.leadTelegramUserId)) && Number(input.leadTelegramUserId) > 0
      ? Number(input.leadTelegramUserId)
      : undefined;
  const leadUser =
    typeof input.leadUsername === 'string' && input.leadUsername.trim()
      ? input.leadUsername.trim().replace(/^@/, '')
      : undefined;
  const extraUsernames = input.extraUsernames ?? [];

  log.info({ message: 'create-shared-chat executor', account_id: bdAccountId, extra_count: extraUsernames.length });

  const createResult = await telegramInvokeWithFloodRetry(log, bdAccountId, 'CreateChannel', () =>
    client.invoke(
      new Api.channels.CreateChannel({
        title,
        about: '',
        megagroup: true,
      }),
    ),
  ) as any;

  const chats = createResult?.chats ?? [];
  const channel = chats[0];
  if (!channel) {
    throw new Error('Failed to create Telegram group: empty chats');
  }

  const channelId = String(channel.id);
  const accessHash = channel.accessHash != null ? String(channel.accessHash) : null;

  const usersToInvite: any[] = [];
  if (leadId) {
    try {
      const entity = await client.getInputEntity(leadId);
      usersToInvite.push(entity);
    } catch (e) {
      log.warn({ message: 'Could not resolve lead by ID for invite', account_id: bdAccountId, leadId, error: String(e) });
    }
  }
  if (leadUser && usersToInvite.length === 0) {
    try {
      const entity = await client.getInputEntity(leadUser);
      usersToInvite.push(entity);
    } catch (e) {
      log.warn({ message: 'Could not resolve lead by username for invite', account_id: bdAccountId, leadUser, error: String(e) });
    }
  }
  for (const uname of extraUsernames) {
    const u = (uname ?? '').trim().replace(/^@/, '');
    if (!u) continue;
    try {
      const entity = await client.getInputEntity(u);
      usersToInvite.push(entity);
    } catch (e) {
      log.warn({ message: 'Could not resolve extra username for invite', account_id: bdAccountId, username: u, error: String(e) });
    }
  }

  if (usersToInvite.length > 0) {
    try {
      await telegramInvokeWithFloodRetry(log, bdAccountId, 'InviteToChannel', () =>
        client.invoke(
          new Api.channels.InviteToChannel({
            channel: channel,
            users: usersToInvite,
          }),
        ),
      );
    } catch (e) {
      log.warn({ message: 'InviteToChannel partially failed', account_id: bdAccountId, error: String(e) });
    }
  }

  let inviteLink: string | null = null;
  try {
    const exportResult = (await client.invoke(
      new Api.messages.ExportChatInvite({
        peer: channel,
      }),
    )) as any;
    inviteLink = exportResult?.link ?? null;
  } catch (e) {
    log.warn({ message: 'ExportChatInvite failed', account_id: bdAccountId, error: String(e) });
  }

  if (inviteLink) {
    const inviteMessage = `Присоединяйтесь к группе:\n${inviteLink}`;
    const dmTargets: string[] = [];
    if (leadId && Number.isInteger(leadId) && leadId > 0) dmTargets.push(String(leadId));
    else if (leadUser) dmTargets.push(leadUser);
    for (const uname of extraUsernames) {
      const u = (uname ?? '').trim().replace(/^@/, '');
      if (u) dmTargets.push(u);
    }
    for (const target of dmTargets) {
      try {
        await client.sendMessage(target, { message: inviteMessage });
      } catch (e) {
        log.warn({ message: 'Failed to send invite DM', account_id: bdAccountId, target, error: String(e) });
      }
    }
  }

  const rawId = Number(channelId);
  const fullChannelId =
    Number.isInteger(rawId) && rawId > 0 ? String(BigInt(-1000000000000) - BigInt(rawId)) : channelId;
  if (fullChannelId) {
    await pool.query(
      `INSERT INTO bd_account_sync_chats (bd_account_id, telegram_chat_id, title, peer_type, is_folder, folder_id, access_hash, sync_list_origin)
       VALUES ($1, $2, $3, 'chat', false, NULL, $4, 'outbound_send')
       ON CONFLICT (bd_account_id, telegram_chat_id)
       DO UPDATE SET title = EXCLUDED.title, access_hash = COALESCE(EXCLUDED.access_hash, bd_account_sync_chats.access_hash)`,
      [bdAccountId, fullChannelId, (channel.title ?? title).slice(0, 500), accessHash],
    );
  }

  const sharedChatChannelIdForDb =
    Number.isInteger(rawId) && rawId > 0 ? String(BigInt(-1000000000000) - BigInt(rawId)) : null;

  return {
    channelId,
    title: channel.title ?? title,
    inviteLink,
    sharedChatChannelIdForDb,
  };
}
