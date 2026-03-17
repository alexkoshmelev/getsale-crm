// @ts-nocheck — GramJS types are incomplete
import { Api } from 'telegram';
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
      const message = await client.sendFile(chatId, {
        file,
        caption: opts.caption || '',
        ...(opts.replyTo != null ? { replyTo: opts.replyTo } : {}),
      });
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
    try {
      const peerIdNum = Number(chatId);
      const peerInput = Number.isNaN(peerIdNum) ? chatId : peerIdNum;
      const peer = await clientInfo.client.getInputEntity(peerInput);
      const buffer = await clientInfo.client.downloadProfilePhoto(peer as any, { isBig: false });
      if (!buffer || !(buffer instanceof Buffer)) return null;
      return { buffer, mimeType: 'image/jpeg' };
    } catch (e: any) {
      const msg = e?.message ?? '';
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
}
