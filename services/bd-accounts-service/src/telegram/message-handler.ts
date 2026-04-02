// @ts-nocheck — GramJS types are incomplete
import { Api } from 'telegram';
import { randomUUID } from 'crypto';
import {
  EventType,
  type MessageReceivedEvent,
} from '@getsale/events';
import { MessageChannel, MessageDirection, MessageStatus } from '@getsale/types';
import { serializeMessage, getMessageText, type SerializedTelegramMessage } from '../telegram-serialize';
import { getErrorMessage } from '../helpers';
import type { TelegramManagerDeps, TelegramClientInfo, StructuredLog } from './types';
import type { ContactManager } from './contact-manager';
import type { MessageDb } from './message-db';
import type { Pool } from 'pg';
import type { RabbitMQClient } from '@getsale/utils';

/**
 * Handles incoming and outgoing Telegram messages (short + full).
 */
export class MessageHandler {
  private readonly pool: Pool;
  private readonly rabbitmq: RabbitMQClient;
  private readonly log: StructuredLog;
  private readonly clients: Map<string, TelegramClientInfo>;
  private contactManager!: ContactManager;
  private messageDb!: MessageDb;

  constructor(private readonly deps: TelegramManagerDeps) {
    this.pool = deps.pool;
    this.rabbitmq = deps.rabbitmq;
    this.log = deps.log;
    this.clients = deps.clients;
  }

  setContactManager(cm: ContactManager): void { this.contactManager = cm; }
  setMessageDb(mdb: MessageDb): void { this.messageDb = mdb; }

  async handleShortMessageUpdate(
    update: any,
    accountId: string,
    organizationId: string
  ): Promise<void> {
    try {
      const isOut = (update as any).out === true;
      const name = update?.className ?? update?.constructor?.name ?? '';
      const userId = (update as any).userId ?? (update as any).user_id;
      const fromId = (update as any).fromId ?? (update as any).from_id;
      const chatIdRaw = (update as any).chatId ?? (update as any).chat_id;
      const msgId = (update as any).id;
      const text = (update as any).message;
      const date = (update as any).date;
      this.log.info({ message: `Short message ${isOut ? 'outgoing' : 'incoming'}: ${name}, accountId=${accountId}, chatId=${chatIdRaw ?? userId}` });
      if (typeof text !== 'string' || !text.trim()) return;

      const chatId = name === 'UpdateShortChatMessage'
        ? String(chatIdRaw ?? fromId ?? '')
        : String(userId ?? '');
      const senderId = name === 'UpdateShortChatMessage'
        ? String(fromId ?? '')
        : String(userId ?? '');

      if (!chatId) return;

      let resolvedUsernameFromEntity: string | null = null;
      let allowed = await this.messageDb.isChatAllowedForAccount(accountId, chatId);
      if (!allowed && /^[0-9]+$/.test(chatId)) {
        const clientInfo = this.clients.get(accountId);
        if (clientInfo?.client) {
          try {
            const ent = await clientInfo.client.getEntity(parseInt(chatId, 10));
            if (ent && (ent as { className?: string }).className === 'User') {
              resolvedUsernameFromEntity = ((ent as Api.User).username ?? '').trim() || null;
              await this.messageDb.tryMigrateSyncChatUsernameAliases(
                accountId,
                chatId,
                (ent as Api.User).username ?? undefined
              );
              allowed = await this.messageDb.isChatAllowedForAccount(accountId, chatId);
            }
          } catch {
            /* ignore */
          }
        }
      }
      if (!allowed) {
        this.log.info({ message: `Short: chat not in sync list, skipping, accountId=${accountId}, chatId=${chatId}` });
        return;
      }

      const contactTelegramId = senderId || chatId;
      const contactId = resolvedUsernameFromEntity
        ? await this.contactManager.upsertContactFromTelegramUser(organizationId, contactTelegramId, {
            firstName: '',
            lastName: null,
            username: resolvedUsernameFromEntity,
          })
        : await this.contactManager.ensureContactEnrichedFromTelegram(organizationId, accountId, contactTelegramId);
      const direction = isOut ? MessageDirection.OUTBOUND : MessageDirection.INBOUND;
      const telegramDate = date ? (typeof date === 'number' ? new Date(date * 1000) : new Date(date)) : null;
      const serialized: SerializedTelegramMessage = {
        telegram_message_id: String(msgId),
        telegram_date: telegramDate,
        content: text.trim(),
        telegram_entities: null,
        telegram_media: null,
        reply_to_telegram_id: null,
        telegram_extra: {},
      };

      const savedMessage = await this.messageDb.saveMessageToDb({
        organizationId,
        bdAccountId: accountId,
        contactId,
        channel: MessageChannel.TELEGRAM,
        channelId: chatId,
        direction,
        status: MessageStatus.DELIVERED,
        unread: !isOut,
        serialized,
        metadata: { senderId, short: true },
      });

      const clientInfo = this.clients.get(accountId);
      if (clientInfo) {
        clientInfo.lastActivity = new Date();
        await this.pool.query('UPDATE bd_accounts SET last_activity = NOW() WHERE id = $1', [accountId]);
      }

      const event: MessageReceivedEvent = {
        id: randomUUID(),
        type: EventType.MESSAGE_RECEIVED,
        timestamp: new Date(),
        organizationId,
        data: {
          messageId: savedMessage.id,
          channel: MessageChannel.TELEGRAM,
          channelId: chatId,
          contactId: contactId || undefined,
          bdAccountId: accountId,
          content: serialized.content,
          direction: isOut ? 'outbound' : 'inbound',
          telegramMessageId: serialized.telegram_message_id || undefined,
          replyToTelegramId: serialized.reply_to_telegram_id || undefined,
          createdAt: new Date().toISOString(),
        },
      };
      await this.rabbitmq.publishEvent(event);
      this.log.info({ message: `Short message saved and event published, messageId=${savedMessage.id}, channelId=${chatId}` });
    } catch (error: unknown) {
      this.log.error({ message: `Error handling short message`, error: getErrorMessage(error) });
    }
  }

  async handleNewMessage(
    message: Api.Message,
    accountId: string,
    organizationId: string
  ): Promise<void> {
    try {
      const isOut = (message as any).out === true;
      let chatId = '';
      if (message.peerId) {
        if (message.peerId instanceof Api.PeerUser) chatId = String(message.peerId.userId);
        else if (message.peerId instanceof Api.PeerChat) chatId = String(message.peerId.chatId);
        else if (message.peerId instanceof Api.PeerChannel) chatId = String(message.peerId.channelId);
        else chatId = String(message.peerId);
      }
      this.log.info({ message: `New message ${isOut ? 'outgoing' : 'incoming'}`, context: { accountId, chatId } });
      const text = getMessageText(message);
      if (!text.trim() && !message.media) {
        return;
      }

      let senderId = '';
      if (message.fromId) {
        if (message.fromId instanceof Api.PeerUser) {
          senderId = String(message.fromId.userId);
        } else {
          senderId = String(message.fromId);
        }
      }

      let allowed = await this.messageDb.isChatAllowedForAccount(accountId, chatId);
      if (!allowed && /^[0-9]+$/.test(chatId) && message.fromId && message.fromId instanceof Api.PeerUser) {
        const clientInfo = this.clients.get(accountId);
        if (clientInfo?.client) {
          try {
            const ent = await clientInfo.client.getEntity(parseInt(chatId, 10));
            if (ent && (ent as { className?: string }).className === 'User') {
              await this.messageDb.tryMigrateSyncChatUsernameAliases(
                accountId,
                chatId,
                (ent as Api.User).username ?? undefined
              );
              allowed = await this.messageDb.isChatAllowedForAccount(accountId, chatId);
            }
          } catch {
            /* ignore */
          }
        }
      }
      if (!allowed) {
        this.log.info({ message: `Chat not in sync list, skipping message, accountId=${accountId}, chatId=${chatId}` });
        return;
      }

      let contactId: string | null = null;
      const tid = senderId || chatId;
      if (message.fromId && message.fromId instanceof Api.PeerUser) {
        const clientInfo = this.clients.get(accountId);
        if (clientInfo?.client) {
          try {
            const peer = await clientInfo.client.getInputEntity(parseInt(tid, 10));
            const entity = await clientInfo.client.getEntity(peer);
            if (entity && (entity as any).className === 'User') {
              const u = entity as Api.User;
              contactId = await this.contactManager.upsertContactFromTelegramUser(organizationId, tid, {
                firstName: (u.firstName ?? '').trim(),
                lastName: (u.lastName ?? '').trim() || null,
                username: (u.username ?? '').trim() || null,
              });
            }
          } catch (e: unknown) {
            const msg = getErrorMessage(e);
            if (msg !== 'TIMEOUT' && !msg.includes('Could not find')) {
              this.log.warn({ message: "getEntity for contact enrichment", error: msg });
            }
          }
        }
      }
      if (contactId == null) {
        const sender = (message as any)._sender;
        const senderUsername = sender?.username ? String(sender.username).trim() || null : null;
        contactId = await this.contactManager.upsertContactFromTelegramUser(
          organizationId,
          tid,
          senderUsername
            ? {
                firstName: (sender?.firstName ?? '').trim(),
                lastName: (sender?.lastName ?? '').trim() || null,
                username: senderUsername,
              }
            : undefined
        );
      }
      const direction = isOut ? MessageDirection.OUTBOUND : MessageDirection.INBOUND;

      const serialized = serializeMessage(message);
      const savedMessage = await this.messageDb.saveMessageToDb({
        organizationId,
        bdAccountId: accountId,
        contactId,
        channel: MessageChannel.TELEGRAM,
        channelId: chatId,
        direction,
        status: MessageStatus.DELIVERED,
        unread: !isOut,
        serialized,
        metadata: { senderId, hasMedia: !!message.media },
      });

      const clientInfo = this.clients.get(accountId);
      if (clientInfo) {
        clientInfo.lastActivity = new Date();
        await this.pool.query(
          'UPDATE bd_accounts SET last_activity = NOW() WHERE id = $1',
          [accountId]
        );
      }

      const event: MessageReceivedEvent = {
        id: randomUUID(),
        type: EventType.MESSAGE_RECEIVED,
        timestamp: new Date(),
        organizationId,
        data: {
          messageId: savedMessage.id,
          channel: MessageChannel.TELEGRAM,
          channelId: chatId,
          contactId: contactId || undefined,
          bdAccountId: accountId,
          content: serialized.content,
          direction: isOut ? 'outbound' : 'inbound',
          telegramMessageId: serialized.telegram_message_id || undefined,
          replyToTelegramId: serialized.reply_to_telegram_id || undefined,
          telegramMedia: serialized.telegram_media || undefined,
          telegramEntities: serialized.telegram_entities || undefined,
          createdAt: new Date().toISOString(),
        },
      };
      await this.rabbitmq.publishEvent(event);
      this.log.info({ message: `MessageReceivedEvent published, messageId=${savedMessage.id}, channelId=${chatId}` });
    } catch (error: unknown) {
      this.log.error({ message: `Error handling new message`, error: getErrorMessage(error) });
    }
  }
}
