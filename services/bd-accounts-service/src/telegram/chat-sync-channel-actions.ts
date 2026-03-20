// @ts-nocheck — GramJS types are incomplete
import { Api } from 'telegram';
import type { TelegramClient } from 'telegram';
import { getErrorMessage, getErrorCode } from '../helpers';
import type { StructuredLog } from './types';
import { telegramInvokeWithFloodRetry } from './telegram-invoke-flood';

/** Leave supergroup/channel. Extracted from ChatSync (C3). */
export async function leaveChatGlobal(
  log: StructuredLog,
  accountId: string,
  client: TelegramClient,
  chatId: string
): Promise<void> {
  let inputChannel: Api.TypeInputChannel;
  try {
    const peerId = Number(chatId);
    const fullId = Number.isNaN(peerId) ? chatId : peerId < 0 ? peerId : -1000000000 - Math.abs(peerId);
    const peer = await client.getInputEntity(fullId);
    if (peer instanceof Api.InputChannel) {
      inputChannel = peer;
    } else if (peer && typeof (peer as any).channelId !== 'undefined') {
      inputChannel = new Api.InputChannel({
        channelId: (peer as any).channelId,
        accessHash: (peer as any).accessHash ?? BigInt(0),
      });
    } else {
      throw new Error('Not a channel or supergroup');
    }
  } catch (e: unknown) {
    if (getErrorMessage(e).includes('CHANNEL_PRIVATE') || getErrorCode(e) === 'CHANNEL_PRIVATE') {
      const err = new Error('Channel is private or already left');
      (err as any).code = 'CHANNEL_PRIVATE';
      throw err;
    }
    throw e;
  }
  try {
    await telegramInvokeWithFloodRetry(log, accountId, 'LeaveChannel', () =>
      client.invoke(new Api.channels.LeaveChannel({ channel: inputChannel }))
    );
  } catch (e: unknown) {
    if (getErrorMessage(e).includes('USER_NOT_PARTICIPANT') || getErrorCode(e) === 'USER_NOT_PARTICIPANT') {
      return;
    }
    log.error({ message: 'leaveChat failed', accountId, chatId, error: getErrorMessage(e) });
    throw e;
  }
}

/** Revoke-delete a message in a channel/supergroup. Extracted from ChatSync (C3). */
export async function deleteMessageInTelegramGlobal(
  client: TelegramClient,
  channelId: string,
  telegramMessageId: number
): Promise<void> {
  const peerInput = (() => {
    const n = Number(channelId);
    if (!Number.isNaN(n)) return n;
    return channelId;
  })();
  const peer = await client.getInputEntity(peerInput);
  await (client as any).deleteMessages(peer, [telegramMessageId], { revoke: true });
}
