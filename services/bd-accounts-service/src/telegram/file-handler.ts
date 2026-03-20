// @ts-nocheck — GramJS types are incomplete
import { Api } from 'telegram';
import { isUsernameLike, resolveUsernameToInputPeer } from './resolve-username';
import { telegramInvokeWithFloodRetry } from './telegram-invoke-flood';
import type { TelegramManagerDeps, TelegramClientInfo, StructuredLog } from './types';
import type { Pool } from 'pg';

/**
 * File operations: download media, upload/send files, profile photos.
 */
export class FileHandler {
  private readonly pool: Pool;
  private readonly log: StructuredLog;
  private readonly clients: Map<string, TelegramClientInfo>;

  constructor(private readonly deps: TelegramManagerDeps) {
    this.pool = deps.pool;
    this.log = deps.log;
    this.clients = deps.clients;
  }

  async downloadMessageMedia(
    accountId: string,
    channelId: string,
    messageId: string
  ): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }

    const client = clientInfo.client;
    const peerIdNum = Number(channelId);
    const peerInput = Number.isNaN(peerIdNum) ? channelId : peerIdNum;
    const peer = await client.getInputEntity(peerInput);
    const msgId = parseInt(messageId, 10);
    if (Number.isNaN(msgId)) return null;

    const messages = await client.getMessages(peer, { ids: [msgId] });
    const message = messages?.[0];
    if (!message || !(message as any).media) return null;

    const buffer = await client.downloadMedia(message as any, {});
    if (!buffer || !(buffer instanceof Buffer)) return null;

    const media = (message as any).media;
    let mimeType = 'application/octet-stream';
    if (media instanceof Api.MessageMediaPhoto || media?.className === 'MessageMediaPhoto') {
      mimeType = 'image/jpeg';
    } else if (media?.document) {
      mimeType = media.document.mimeType || 'application/octet-stream';
    }

    return { buffer, mimeType };
  }

  /** Numeric peer ids (e.g. -1000012345) must be passed as number to avoid PEER_ID_INVALID. */
  private peerInput(chatId: string): number | string {
    const n = Number(chatId);
    return Number.isNaN(n) ? chatId : n;
  }

  /** Use InputPeerChannel from sync_chats when access_hash present (e.g. newly created shared chat). Supports full/raw/-raw chatId. */
  private async resolvePeer(accountId: string, chatId: string): Promise<Api.TypeInputPeer | number | string> {
    const fullId = Number(chatId);
    const tryIds: string[] = [chatId];
    if (!Number.isNaN(fullId)) {
      if (fullId > 0) tryIds.push(String(-1000000000 - fullId));
      else if (fullId < 0 && fullId > -1000000000) tryIds.push(String(-1000000000 + fullId));
    }
    for (const tid of tryIds) {
      const r = await this.pool.query(
        'SELECT telegram_chat_id, access_hash FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
        [accountId, tid]
      );
      const row = r.rows[0] as { telegram_chat_id?: string; access_hash?: string | null } | undefined;
      const accessHashRaw = row?.access_hash;
      if (accessHashRaw != null && accessHashRaw !== '' && row?.telegram_chat_id != null) {
        const storedFull = Number(row.telegram_chat_id);
        const rawChannelId = Number.isNaN(storedFull) ? 0 : -1000000000 - storedFull;
        return new Api.InputPeerChannel({ channelId: rawChannelId, accessHash: BigInt(accessHashRaw) });
      }
    }
    return this.peerInput(chatId);
  }

  async sendFile(
    accountId: string,
    chatId: string,
    fileBuffer: Buffer,
    opts: { caption?: string; filename?: string; replyTo?: number } = {}
  ): Promise<Api.Message> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      throw new Error(`Account ${accountId} is not connected`);
    }
    try {
      const file = Object.assign(Buffer.from(fileBuffer), {
        name: opts.filename || 'file',
      });
      const client = clientInfo.client as any;
      let peer: Api.TypeInputPeer | number | string = await this.resolvePeer(accountId, chatId);
      if (typeof peer === 'string' && peer.length > 0 && isUsernameLike(peer)) {
        const resolved = await resolveUsernameToInputPeer(clientInfo.client, peer, {
          log: this.log,
          accountId,
        });
        if (resolved) peer = resolved;
        else peer = await client.getInputEntity(peer);
      } else if (typeof peer === 'string' && peer.length > 0 && Number.isNaN(Number(peer))) {
        peer = await client.getInputEntity(peer);
      }
      const message = await telegramInvokeWithFloodRetry(this.log, accountId, 'SendFile', () =>
        client.sendFile(peer, {
          file,
          caption: opts.caption || '',
          ...(opts.replyTo != null ? { replyTo: opts.replyTo } : {}),
        })
      );
      clientInfo.lastActivity = new Date();
      await this.pool.query(
        'UPDATE bd_accounts SET last_activity = NOW() WHERE id = $1',
        [accountId]
      );
      return message;
    } catch (error: any) {
      this.log.error({ message: `Error sending file`, error: error?.message || String(error) });
      throw error;
    }
  }

  async downloadAccountProfilePhoto(accountId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      return null;
    }
    try {
      const buffer = await clientInfo.client.downloadProfilePhoto('me', { isBig: false });
      if (!buffer || !(buffer instanceof Buffer)) return null;
      return { buffer, mimeType: 'image/jpeg' };
    } catch (e: any) {
      this.log.warn({ message: `downloadProfilePhoto for ${accountId}`, error: e?.message });
      return null;
    }
  }

  async downloadChatProfilePhoto(accountId: string, chatId: string): Promise<{ buffer: Buffer; mimeType: string } | null> {
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo || !clientInfo.isConnected) {
      return null;
    }
    const peerIdNum = Number(chatId);
    const peerInput = Number.isNaN(peerIdNum) ? chatId : peerIdNum;
    const tryFullForm =
      typeof peerInput === 'number' &&
      peerInput < 0 &&
      peerInput > -1000000000;
    for (let attempt = 0; attempt < (tryFullForm ? 2 : 1); attempt++) {
      try {
        const input = attempt === 1 ? -1000000000 + (peerInput as number) : peerInput;
        const peer = await clientInfo.client.getInputEntity(input);
        const buffer = await clientInfo.client.downloadProfilePhoto(peer as any, { isBig: false });
        if (!buffer || !(buffer instanceof Buffer)) return null;
        return { buffer, mimeType: 'image/jpeg' };
      } catch (e: any) {
        const msg = e?.message ?? '';
        const isChatIdInvalid = typeof msg === 'string' && msg.includes('CHAT_ID_INVALID');
        if (attempt === 0 && tryFullForm && isChatIdInvalid) {
          continue;
        }
        const isEntityMissing =
          typeof msg === 'string' &&
          (msg.includes('Could not find the input entity') || msg.includes('PeerUser'));
        if (isEntityMissing) {
          this.log.info({ message: `downloadChatProfilePhoto ${accountId}/${chatId}`, error: msg });
        } else {
          this.log.warn({ message: `downloadChatProfilePhoto ${accountId}/${chatId}`, error: msg });
        }
        return null;
      }
    }
    return null;
  }
}
