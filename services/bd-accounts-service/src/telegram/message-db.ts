// @ts-nocheck — GramJS types are incomplete
import type { Pool } from 'pg';
import type { Counter } from 'prom-client';
import type { ServiceHttpClient } from '@getsale/service-core';
import type { SerializedTelegramMessage } from '../telegram-serialize';
import { reactionsFromTelegramExtra, ourReactionsFromTelegramExtra } from './helpers';
import type { StructuredLog } from './types';

/**
 * DB operations for conversations and messages.
 * When messagingClient is set, conversation and message persistence go through messaging-service internal API (A1: single owner for messages/conversations).
 * Without client — temporary SQL bypass (A3); increments messageDbSqlBypassTotal + one warn per operation type.
 * If env `BD_ACCOUNTS_MESSAGE_DB_STRICT` is `1` or `true`, bypass is disabled and operations throw (`MESSAGE_DB_STRICT_NO_CLIENT`).
 */
export class MessageDb {
  private readonly sqlBypassWarned = new Set<string>();

  constructor(
    private readonly pool: Pool,
    private readonly log: StructuredLog,
    private readonly messagingClient?: ServiceHttpClient | null,
    private readonly sqlBypassCounter?: Counter | null
  ) {}

  private recordMessageDbSqlBypass(operation: string): void {
    const strict =
      process.env.BD_ACCOUNTS_MESSAGE_DB_STRICT?.trim() === '1' ||
      process.env.BD_ACCOUNTS_MESSAGE_DB_STRICT?.trim()?.toLowerCase() === 'true';
    if (strict) {
      const err = new Error(
        `MessageDb SQL bypass blocked (A3 strict, operation=${operation}). Configure MESSAGING_SERVICE_URL and a healthy messaging-service, or unset BD_ACCOUNTS_MESSAGE_DB_STRICT.`
      );
      (err as { code?: string }).code = 'MESSAGE_DB_STRICT_NO_CLIENT';
      throw err;
    }
    this.sqlBypassCounter?.inc({ operation });
    if (this.sqlBypassWarned.has(operation)) return;
    this.sqlBypassWarned.add(operation);
    this.log.warn({
      message: 'message_db_sql_bypass',
      operation,
      hint: 'No messaging HTTP client — bd-accounts writes messages/conversations directly (A3). Production: set MESSAGING_SERVICE_URL. Metric: bd_accounts_message_db_sql_bypass_total.',
    });
  }

  async ensureConversation(params: {
    organizationId: string;
    bdAccountId: string;
    channel: string;
    channelId: string;
    contactId: string | null;
  }): Promise<void> {
    if (this.messagingClient) {
      try {
        await this.messagingClient.post(
          '/internal/conversations/ensure',
          {
            organizationId: params.organizationId,
            bdAccountId: params.bdAccountId,
            channel: params.channel,
            channelId: params.channelId,
            contactId: params.contactId,
          },
          undefined,
          { organizationId: params.organizationId }
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.log.warn({ message: 'ensureConversation (messaging) failed, continuing', error: msg, channelId: params.channelId });
      }
      return;
    }
    this.recordMessageDbSqlBypass('ensure_conversation');
    await this.pool.query(
      `INSERT INTO conversations (id, organization_id, bd_account_id, channel, channel_id, contact_id, created_at, updated_at)
       VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW(), NOW())
       ON CONFLICT (organization_id, bd_account_id, channel, channel_id)
       DO UPDATE SET contact_id = COALESCE(EXCLUDED.contact_id, conversations.contact_id), updated_at = NOW()`,
      [params.organizationId, params.bdAccountId, params.channel, params.channelId, params.contactId]
    );
  }

  async saveMessageToDb(params: {
    organizationId: string;
    bdAccountId: string;
    contactId: string | null;
    channel: string;
    channelId: string;
    direction: string;
    status: string;
    unread: boolean;
    serialized: SerializedTelegramMessage;
    metadata?: Record<string, unknown>;
  }): Promise<{ id: string }> {
    const {
      organizationId,
      bdAccountId,
      contactId,
      channel,
      channelId,
      direction,
      status,
      unread,
      serialized,
      metadata = {},
    } = params;

    if (this.messagingClient) {
      await this.ensureConversation({ organizationId, bdAccountId, channel, channelId, contactId });
      const reactionsFromTg = reactionsFromTelegramExtra(serialized.telegram_extra);
      const ourReactionsFromTg = ourReactionsFromTelegramExtra(serialized.telegram_extra);
      const telegramMsgId =
        serialized.telegram_message_id != null && String(serialized.telegram_message_id).trim() !== ''
          ? parseInt(String(serialized.telegram_message_id), 10)
          : null;
      const replyToTgId =
        serialized.reply_to_telegram_id != null && String(serialized.reply_to_telegram_id).trim() !== ''
          ? parseInt(String(serialized.reply_to_telegram_id), 10)
          : null;
      const res = await this.messagingClient.post<{ id: string }>(
        '/internal/messages',
        {
          organizationId,
          bdAccountId,
          contactId,
          channel,
          channelId,
          direction,
          status,
          unread,
          serialized: {
            telegram_message_id: telegramMsgId != null && !Number.isNaN(telegramMsgId) ? telegramMsgId : null,
            telegram_date: serialized.telegram_date ?? null,
            content: serialized.content ?? '',
            telegram_entities: serialized.telegram_entities ?? null,
            telegram_media: serialized.telegram_media ?? null,
            reply_to_telegram_id: replyToTgId != null && !Number.isNaN(replyToTgId) ? replyToTgId : null,
            telegram_extra: serialized.telegram_extra ?? {},
          },
          metadata,
          reactions: reactionsFromTg ?? undefined,
          our_reactions: ourReactionsFromTg?.length ? ourReactionsFromTg : undefined,
        },
        undefined,
        { organizationId }
      );
      return { id: res.id };
    }

    await this.ensureConversation({ organizationId, bdAccountId, channel, channelId, contactId });
    this.recordMessageDbSqlBypass('save_message');

    const {
      telegram_message_id,
      telegram_date,
      content,
      telegram_entities,
      telegram_media,
      reply_to_telegram_id,
      telegram_extra,
    } = serialized;

    const reactionsFromTg = reactionsFromTelegramExtra(telegram_extra);
    const reactionsJson = reactionsFromTg ? JSON.stringify(reactionsFromTg) : null;
    const ourReactionsFromTg = ourReactionsFromTelegramExtra(telegram_extra);
    const ourReactionsJson = ourReactionsFromTg?.length ? JSON.stringify(ourReactionsFromTg) : null;

    const result = await this.pool.query(
      `INSERT INTO messages (
        organization_id, bd_account_id, contact_id, channel, channel_id, direction, content, status, unread,
        metadata, telegram_message_id, telegram_date, loaded_at, reply_to_telegram_id, telegram_entities, telegram_media, telegram_extra, reactions, our_reactions
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), $13, $14, $15, $16, $17, $18)
      ON CONFLICT (bd_account_id, channel_id, telegram_message_id, organization_id) WHERE (telegram_message_id IS NOT NULL)
      DO UPDATE SET
        content = EXCLUDED.content,
        reply_to_telegram_id = COALESCE(EXCLUDED.reply_to_telegram_id, messages.reply_to_telegram_id),
        telegram_entities = EXCLUDED.telegram_entities,
        telegram_media = EXCLUDED.telegram_media,
        telegram_extra = EXCLUDED.telegram_extra,
        reactions = COALESCE(EXCLUDED.reactions, messages.reactions),
        our_reactions = COALESCE(EXCLUDED.our_reactions, messages.our_reactions),
        unread = EXCLUDED.unread,
        updated_at = NOW()
      RETURNING id`,
      [
        organizationId,
        bdAccountId,
        contactId,
        channel,
        channelId,
        direction,
        content,
        status,
        unread,
        JSON.stringify(metadata),
        telegram_message_id || null,
        telegram_date,
        reply_to_telegram_id,
        telegram_entities ? JSON.stringify(telegram_entities) : null,
        telegram_media ? JSON.stringify(telegram_media) : null,
        Object.keys(telegram_extra).length ? JSON.stringify(telegram_extra) : null,
        reactionsJson,
        ourReactionsJson,
      ]
    );
    return result.rows[0];
  }

  async isChatAllowedForAccount(accountId: string, telegramChatId: string): Promise<boolean> {
    const result = await this.pool.query(
      'SELECT 1 FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
      [accountId, telegramChatId]
    );
    return result.rows.length > 0;
  }

  /**
   * If outbound used @username but sync row still has username, migrate row to numeric user id so inbound matches.
   */
  async tryMigrateSyncChatUsernameAliases(
    accountId: string,
    numericChatId: string,
    username: string | null | undefined
  ): Promise<void> {
    const u = (username || '').trim();
    if (!u) return;
    const aliases = [`@${u}`, u];
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE bd_account_sync_chats SET telegram_chat_id = $3, sync_list_origin = 'outbound_send'
         WHERE bd_account_id = $1 AND telegram_chat_id = ANY($2::text[])`,
        [accountId, aliases, numericChatId]
      );
      await client.query(
        `UPDATE messages SET channel_id = $3, updated_at = NOW()
         WHERE bd_account_id = $1 AND channel = 'telegram' AND channel_id = ANY($2::text[])`,
        [accountId, aliases, numericChatId]
      );
      await client.query(
        `UPDATE conversations SET channel_id = $3, updated_at = NOW()
         WHERE bd_account_id IS NOT DISTINCT FROM $1::uuid AND channel = 'telegram' AND channel_id = ANY($2::text[])
           AND NOT EXISTS (
             SELECT 1 FROM conversations c2
             WHERE c2.organization_id = conversations.organization_id
               AND c2.bd_account_id IS NOT DISTINCT FROM $1::uuid
               AND c2.channel = 'telegram' AND c2.channel_id = $3
           )`,
        [accountId, aliases, numericChatId]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      this.log.warn({
        message: 'tryMigrateSyncChatUsernameAliases failed',
        accountId,
        numericChatId,
        username: u,
        error: e instanceof Error ? e.message : String(e),
      });
    } finally {
      client.release();
    }
  }

  async isChatInNonAllChatsFolder(accountId: string, telegramChatId: string): Promise<boolean> {
    const result = await this.pool.query(
      `SELECT 1 FROM (
        SELECT folder_id FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 AND folder_id IS NOT NULL AND folder_id <> 0
        UNION
        SELECT folder_id FROM bd_account_sync_chat_folders WHERE bd_account_id = $1 AND telegram_chat_id = $2 AND folder_id <> 0
      ) u LIMIT 1`,
      [accountId, telegramChatId]
    );
    return result.rows.length > 0;
  }

  /** A1 Stage 2: delete messages by Telegram ids via messaging-service or direct DB. S4: pass organizationId for X-Organization-Id. */
  async deleteByTelegram(params: {
    bdAccountId: string;
    organizationId: string;
    channelId?: string;
    telegramMessageIds: number[];
  }): Promise<Array<{ id: string; organization_id: string; channel_id: string; telegram_message_id: number }>> {
    const { bdAccountId, organizationId, channelId, telegramMessageIds } = params;
    if (this.messagingClient) {
      const res = await this.messagingClient.post<{ deleted: Array<{ id: string; organization_id: string; channel_id: string; telegram_message_id: number }> }>(
        '/internal/messages/delete-by-telegram',
        { bdAccountId, channelId, telegramMessageIds },
        undefined,
        { organizationId }
      );
      return res.deleted ?? [];
    }
    this.recordMessageDbSqlBypass('delete_by_telegram');
    const result =
      channelId != null
        ? await this.pool.query(
            `DELETE FROM messages WHERE bd_account_id = $1 AND channel_id = $2 AND telegram_message_id = ANY($3::bigint[])
             RETURNING id, organization_id, channel_id, telegram_message_id`,
            [bdAccountId, channelId, telegramMessageIds]
          )
        : await this.pool.query(
            `DELETE FROM messages WHERE bd_account_id = $1 AND telegram_message_id = ANY($2::bigint[])
             RETURNING id, organization_id, channel_id, telegram_message_id`,
            [bdAccountId, telegramMessageIds]
          );
    return result.rows as Array<{ id: string; organization_id: string; channel_id: string; telegram_message_id: number }>;
  }

  /** A1 Stage 2: edit message by Telegram id via messaging-service or direct DB. S4: pass organizationId for X-Organization-Id. */
  async editByTelegram(params: {
    bdAccountId: string;
    organizationId: string;
    channelId: string;
    telegramMessageId: number;
    content: string;
    telegram_entities?: unknown;
    telegram_media?: unknown;
  }): Promise<{ id: string; organization_id: string } | null> {
    const { bdAccountId, organizationId, channelId, telegramMessageId, content, telegram_entities, telegram_media } = params;
    if (this.messagingClient) {
      try {
        const res = await this.messagingClient.patch<{ id: string; organization_id: string }>(
          '/internal/messages/edit-by-telegram',
          { bdAccountId, channelId, telegramMessageId, content, telegram_entities, telegram_media },
          undefined,
          { organizationId }
        );
        return res;
      } catch (err: unknown) {
        const code = typeof (err as { statusCode?: number }).statusCode === 'number' ? (err as { statusCode: number }).statusCode : 0;
        if (code === 404) return null;
        throw err;
      }
    }
    this.recordMessageDbSqlBypass('edit_by_telegram');
    const result = await this.pool.query(
      `UPDATE messages SET content = $1, updated_at = NOW(), telegram_entities = $2, telegram_media = $3
       WHERE bd_account_id = $4 AND channel_id = $5 AND telegram_message_id = $6
       RETURNING id, organization_id`,
      [
        content,
        telegram_entities != null ? JSON.stringify(telegram_entities) : null,
        telegram_media != null ? JSON.stringify(telegram_media) : null,
        bdAccountId,
        channelId,
        telegramMessageId,
      ]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0] as { id: string; organization_id: string };
    return { id: row.id, organization_id: row.organization_id };
  }
}
