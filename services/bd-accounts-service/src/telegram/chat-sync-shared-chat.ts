// @ts-nocheck — GramJS types are incomplete
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { getErrorMessage, getErrorCode } from '../helpers';
import type { StructuredLog } from './types';
import { telegramInvokeWithFloodRetry } from './telegram-invoke-flood';

export type CreateSharedChatParams = {
  title: string;
  leadTelegramUserId?: number;
  leadUsername?: string;
  extraUsernames?: string[];
};

function dialogIdToUserIdStr(dialogIdRaw: unknown): string | null {
  if (dialogIdRaw == null) return null;
  if (typeof dialogIdRaw === 'object') {
    const o = dialogIdRaw as Record<string, unknown>;
    const cn = (o as { className?: string; _?: string }).className ?? (o as { _?: string })._;
    if (cn === 'PeerUser' || cn === 'peerUser') {
      const uid = o.userId ?? o.user_id;
      if (uid != null) return String(uid);
    }
    const uid = o.userId ?? o.user_id;
    if (uid != null) return String(uid);
  }
  if (typeof dialogIdRaw === 'bigint' || typeof dialogIdRaw === 'number') return String(dialogIdRaw);
  return String(dialogIdRaw).trim() || null;
}

async function resolveUsernameToInputUser(
  log: StructuredLog,
  accountId: string,
  client: TelegramClient,
  username: string
): Promise<Api.InputUser | null> {
  const u = (username ?? '').trim().replace(/^@/, '');
  if (!u) return null;
  try {
    const result = (await telegramInvokeWithFloodRetry(log, accountId, 'ResolveUsername(shared-chat)', () =>
      client.invoke(new Api.contacts.ResolveUsername({ username: u }))
    )) as {
      users?: Array<{ id?: bigint; accessHash?: bigint; className?: string }>;
    };
    const users = result?.users ?? [];
    const user = users.find((x) => x?.className === 'User' || (x as any)?._ === 'user') as Api.User | undefined;
    if (user?.id != null) {
      return new Api.InputUser({ userId: user.id, accessHash: user.accessHash ?? BigInt(0) });
    }
  } catch (e: unknown) {
    log.warn({ message: 'createSharedChat: could not resolve username', username: u, error: getErrorMessage(e) });
  }
  return null;
}

/**
 * Create megagroup, invite participants, export invite link.
 * Extracted from ChatSync (C3).
 */
export async function createSharedChatGlobal(
  log: StructuredLog,
  accountId: string,
  client: TelegramClient,
  params: CreateSharedChatParams
): Promise<{ channelId: string; title: string; inviteLink?: string; accessHash?: string }> {
  const { title, leadTelegramUserId, leadUsername, extraUsernames = [] } = params;

  const updates = (await telegramInvokeWithFloodRetry(log, accountId, 'CreateChannel', () =>
    client.invoke(
      new Api.channels.CreateChannel({
        title: title.slice(0, 255),
        about: '',
        megagroup: true,
        broadcast: false,
      })
    )
  )) as Api.Updates;

  let channelId: number | undefined;
  let accessHash: bigint | undefined;
  const chats = (updates as any).chats ?? [];
  for (const chat of chats) {
    if (chat?.className === 'Channel' || (chat as any)._ === 'channel') {
      channelId = chat.id;
      accessHash = chat.accessHash ?? (chat as any).accessHash;
      break;
    }
  }
  if (channelId == null || accessHash == null) {
    throw new Error('Failed to get created channel from response');
  }

  const inputUsers: Api.InputUser[] = [];
  const seenIds = new Set<string>();

  let leadAdded = false;
  if (leadUsername) {
    const inputUser = await resolveUsernameToInputUser(log, accountId, client, leadUsername);
    if (inputUser && !seenIds.has(String((inputUser as any).userId))) {
      seenIds.add(String((inputUser as any).userId));
      inputUsers.push(inputUser);
      leadAdded = true;
    }
  }
  if (!leadAdded && leadTelegramUserId != null && leadTelegramUserId > 0) {
    try {
      const peer = await client.getInputEntity(leadTelegramUserId);
      const entity = await client.getEntity(peer);
      if (entity && ((entity as any).className === 'User' || (entity as any)._ === 'user')) {
        const u = entity as Api.User;
        const key = String(u.id);
        if (!seenIds.has(key)) {
          seenIds.add(key);
          inputUsers.push(new Api.InputUser({ userId: u.id, accessHash: u.accessHash ?? BigInt(0) }));
          leadAdded = true;
        }
      }
    } catch (e: unknown) {
      log.warn({ message: 'createSharedChat: could not resolve lead by id', accountId, leadTelegramUserId, error: getErrorMessage(e) });
    }
  }
  if (!leadAdded && leadTelegramUserId != null && leadTelegramUserId > 0) {
    try {
      const contactsResult = (await telegramInvokeWithFloodRetry(log, accountId, 'GetContacts', () =>
        client.invoke(new Api.contacts.GetContacts({ hash: BigInt(0) }))
      )) as {
        users?: Array<{ id?: number | bigint; accessHash?: bigint; className?: string }>;
      };
      const users = contactsResult?.users ?? [];
      const leadIdStr = String(leadTelegramUserId);
      const contactUser = users.find(
        (x) => x && (x.className === 'User' || (x as any)?._ === 'user') && String(x.id) === leadIdStr
      ) as Api.User | undefined;
      if (contactUser?.id != null) {
        const key = String(contactUser.id);
        if (!seenIds.has(key)) {
          seenIds.add(key);
          inputUsers.push(new Api.InputUser({ userId: contactUser.id, accessHash: contactUser.accessHash ?? BigInt(0) }));
          leadAdded = true;
          log.info({ message: 'createSharedChat: lead resolved from contacts', accountId, leadTelegramUserId });
        }
      }
    } catch (e: unknown) {
      log.warn({ message: 'createSharedChat: contacts fallback failed', accountId, leadTelegramUserId, error: getErrorMessage(e) });
    }
  }
  if (!leadAdded && leadTelegramUserId != null && leadTelegramUserId > 0) {
    try {
      const leadIdStr = String(leadTelegramUserId);
      const folders = [0, 1] as const;
      let dialogsChecked = 0;
      for (const folderId of folders) {
        let dialogs: any[];
        try {
          dialogs = await client.getDialogs({ limit: 500, folderId });
        } catch (folderErr) {
          log.warn({ message: 'createSharedChat: getDialogs failed for folder', accountId, folderId, error: getErrorMessage(folderErr) });
          continue;
        }
        dialogsChecked += dialogs.length;
        for (const d of dialogs) {
          const ent = (d as any).entity;
          const dialogIdRaw = (d as any).id;
          const dialogUserIdStr = dialogIdToUserIdStr(dialogIdRaw);
          const entIdStr = ent != null ? String((ent as any).id ?? (ent as any).userId ?? '') : '';
          const entityIsUser = ent && ((ent as any).className === 'User' || (ent as any)._ === 'user');
          const idMatches =
            entityIsUser &&
            (entIdStr === leadIdStr ||
              dialogUserIdStr === leadIdStr ||
              (dialogUserIdStr != null && String(Number(dialogUserIdStr)) === leadIdStr));
          if (idMatches) {
            const u = ent as Api.User;
            const key = String(u.id);
            if (!seenIds.has(key)) {
              seenIds.add(key);
              inputUsers.push(new Api.InputUser({ userId: u.id, accessHash: u.accessHash ?? BigInt(0) }));
              log.info({ message: 'createSharedChat: lead resolved from dialogs', accountId, leadTelegramUserId, folderId });
              leadAdded = true;
              break;
            }
          }
        }
        if (leadAdded) break;
      }
      if (!leadAdded) {
        log.warn({
          message: 'createSharedChat: lead not found in dialogs',
          accountId,
          leadTelegramUserId,
          dialogsChecked,
        });
      }
    } catch (e: unknown) {
      log.warn({ message: 'createSharedChat: dialogs fallback failed', accountId, leadTelegramUserId, error: getErrorMessage(e) });
    }
  }

  for (const username of extraUsernames) {
    const inputUser = await resolveUsernameToInputUser(log, accountId, client, username);
    if (inputUser && !seenIds.has(String((inputUser as any).userId))) {
      seenIds.add(String((inputUser as any).userId));
      inputUsers.push(inputUser);
    }
  }

  if (inputUsers.length === 0) {
    log.warn({
      message: 'createSharedChat: no participants resolved',
      accountId,
      leadTelegramUserId: leadTelegramUserId ?? null,
      leadUsername: leadUsername ?? null,
      extraUsernamesCount: extraUsernames.length,
    });
    throw new Error(
      "Could not resolve any participant to invite. Add contact @username or ensure the lead is in this account's Telegram dialogs."
    );
  }

  const inputChannel = new Api.InputChannel({ channelId, accessHash });
  const inviteDelayMs = 300;
  for (let i = 0; i < inputUsers.length; i++) {
    const user = inputUsers[i];
    try {
      await telegramInvokeWithFloodRetry(log, accountId, 'InviteToChannel', () =>
        client.invoke(new Api.channels.InviteToChannel({ channel: inputChannel, users: [user] }))
      );
    } catch (e: unknown) {
      const code = getErrorCode(e);
      const msg = getErrorMessage(e);
      const knownInviteErrors = [
        'USER_PRIVACY_RESTRICTED',
        'USER_NOT_MUTUAL_CONTACT',
        'USER_KICKED',
        'CHAT_MEMBER_ADD_FAILED',
        'USER_CHANNELS_TOO_MUCH',
        'USER_BOT',
        'USER_ID_INVALID',
        'INPUT_USER_DEACTIVATED',
        'USER_BLOCKED',
        'USER_BANNED_IN_CHANNEL',
      ];
      const isKnown = knownInviteErrors.some((c) => code === c || (typeof msg === 'string' && msg.includes(c)));
      log.warn({
        message: 'createSharedChat: InviteToChannel failed for one participant',
        accountId,
        userId: (user as any).userId?.toString?.() ?? 'unknown',
        errorCode: code ?? null,
        error: msg,
        knownInviteError: isKnown,
      });
    }
    if (i < inputUsers.length - 1 && inviteDelayMs > 0) {
      await new Promise((r) => setTimeout(r, inviteDelayMs));
    }
  }

  let inviteLink: string | undefined;
  try {
    const peer = new Api.InputPeerChannel({ channelId, accessHash });
    const exported = (await telegramInvokeWithFloodRetry(log, accountId, 'ExportChatInvite', () =>
      client.invoke(
        new Api.messages.ExportChatInvite({
          peer,
          legacyRevokePermanent: false,
        })
      )
    )) as { link?: string };
    if (exported?.link && typeof exported.link === 'string') {
      inviteLink = exported.link.trim();
    }
  } catch (e: unknown) {
    log.warn({ message: 'createSharedChat: could not export invite link', error: getErrorMessage(e) });
  }

  return {
    channelId: String(channelId),
    title,
    inviteLink,
    accessHash: accessHash != null ? String(accessHash) : undefined,
  };
}
