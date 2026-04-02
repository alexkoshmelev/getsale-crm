// @ts-nocheck — GramJS types are incomplete
import { Api } from 'telegram';
import type { Pool } from 'pg';
import { getErrorMessage } from '../helpers';
import type { TelegramManagerDeps, TelegramClientInfo, StructuredLog } from './types';
import { telegramInvokeWithFloodRetry } from './telegram-invoke-flood';
import { resolveUsernameToInputPeer } from './resolve-username';

/**
 * Contact enrichment/upsert from Telegram user data.
 */
export class ContactManager {
  private readonly pool: Pool;
  private readonly log: StructuredLog;
  private readonly clients: Map<string, TelegramClientInfo>;

  constructor(private readonly deps: TelegramManagerDeps) {
    this.pool = deps.pool;
    this.log = deps.log;
    this.clients = deps.clients;
  }

  async upsertContactFromTelegramUser(
    organizationId: string,
    telegramId: string,
    userInfo?: {
      firstName: string;
      lastName: string | null;
      username: string | null;
      phone?: string | null;
      bio?: string | null;
      premium?: boolean | null;
    }
  ): Promise<string | null> {
    if (!telegramId?.trim()) return null;
    const firstName = userInfo?.firstName?.trim() ?? '';
    const lastName = (userInfo?.lastName?.trim() || null) ?? null;
    const username = (userInfo?.username?.trim() || null) ?? null;
    let existing = await this.pool.query(
      'SELECT id, first_name, last_name, username, phone, bio, premium FROM contacts WHERE telegram_id = $1 AND organization_id = $2 LIMIT 1',
      [telegramId, organizationId]
    );

    if (existing.rows.length === 0 && username) {
      const uNorm = username.replace(/^@/, '').trim().toLowerCase();
      if (uNorm) {
        const byUsername = await this.pool.query(
          `SELECT id, first_name, last_name, username, phone, bio, premium FROM contacts
           WHERE organization_id = $1
             AND LOWER(TRIM(REGEXP_REPLACE(COALESCE(username, ''), '^@', ''))) = $2
             AND (telegram_id IS NULL OR TRIM(telegram_id) = '')
           LIMIT 1`,
          [organizationId, uNorm]
        );
        if (byUsername.rows.length > 0) {
          const rowId = (byUsername.rows[0] as { id: string }).id;
          await this.pool.query(
            'UPDATE contacts SET telegram_id = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3',
            [telegramId, rowId, organizationId]
          );
          existing = byUsername;
        }
      }
    }

    const phone = userInfo?.phone != null ? (String(userInfo.phone).trim() || null) : null;
    const bio = userInfo?.bio != null ? (String(userInfo.bio).trim() || null) : null;
    const premium = userInfo?.premium ?? null;

    if (existing.rows.length > 0) {
      const row = existing.rows[0] as { id: string; first_name: string; last_name: string | null; username: string | null; phone: string | null; bio: string | null; premium: boolean | null };
      const id = row.id;
      if (userInfo) {
        const newFirst = firstName || row.first_name || '';
        const newLast = lastName !== null ? lastName : row.last_name;
        const newUsername = username !== null ? username : row.username;
        const newPhone = phone !== null ? phone : row.phone;
        const newBio = bio !== null ? bio : row.bio;
        const newPremium = premium !== null ? premium : row.premium;
        await this.pool.query(
          `UPDATE contacts SET first_name = $2, last_name = $3, username = $4, phone = $5, bio = $6, premium = $7, updated_at = NOW()
           WHERE id = $1 AND organization_id = $8`,
          [id, newFirst, newLast, newUsername, newPhone, newBio, newPremium, organizationId]
        );
      }
      return id;
    }
    const insert = await this.pool.query(
      `INSERT INTO contacts (organization_id, telegram_id, first_name, last_name, username, phone, bio, premium)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (organization_id, telegram_id) WHERE (telegram_id IS NOT NULL AND trim(telegram_id) <> '')
       DO UPDATE SET
         first_name = COALESCE(NULLIF(trim(EXCLUDED.first_name), ''), contacts.first_name),
         last_name = COALESCE(EXCLUDED.last_name, contacts.last_name),
         username = COALESCE(EXCLUDED.username, contacts.username),
         phone = COALESCE(EXCLUDED.phone, contacts.phone),
         bio = COALESCE(EXCLUDED.bio, contacts.bio),
         premium = COALESCE(EXCLUDED.premium, contacts.premium),
         updated_at = NOW()
       RETURNING id`,
      [organizationId, telegramId, firstName || '', lastName, username, phone, bio, premium]
    );
    if (insert.rows.length > 0) return (insert.rows[0] as { id: string }).id;
    return null;
  }

  async ensureContactForTelegramId(organizationId: string, telegramId: string): Promise<string | null> {
    return this.upsertContactFromTelegramUser(organizationId, telegramId);
  }

  async ensureContactEnrichedFromTelegram(
    organizationId: string,
    accountId: string,
    telegramId: string,
    opts?: { skipGetFullUser?: boolean }
  ): Promise<string | null> {
    const existing = await this.pool.query(
      'SELECT id, first_name, last_name FROM contacts WHERE telegram_id = $1 AND organization_id = $2 LIMIT 1',
      [telegramId, organizationId]
    );
    if (existing.rows.length > 0) {
      const row = existing.rows[0] as { id: string; first_name: string | null; last_name: string | null };
      const hasName = (row.first_name != null && String(row.first_name).trim() !== '') ||
        (row.last_name != null && String(row.last_name).trim() !== '');
      if (hasName) return row.id;
    }

    const userIdNum = parseInt(telegramId, 10);
    const clientInfo = this.clients.get(accountId);
    if (!clientInfo?.client || !Number.isInteger(userIdNum) || userIdNum <= 0) {
      return this.ensureContactForTelegramId(organizationId, telegramId);
    }
    const skipGetFullUser = opts?.skipGetFullUser !== false;
    let resolvedUsername: string | null = null;
    try {
      const client = clientInfo.client;
      const peer = await client.getInputEntity(userIdNum);
      const entity = await client.getEntity(peer);
      const isUser = entity && ((entity as any).className === 'User' || (entity as any)._ === 'user');
      if (!isUser) return this.ensureContactForTelegramId(organizationId, telegramId);

      const u = entity as Api.User;
      resolvedUsername = (u.username ?? '').trim() || null;
      let phone: string | null = (u.phone != null ? String(u.phone).trim() : null) || null;
      let bio: string | null = null;
      const premiumRaw = (u as any).premium;
      const premium: boolean | null = typeof premiumRaw === 'boolean' ? premiumRaw : null;

      if (!skipGetFullUser) {
        try {
          const fullResult = (await telegramInvokeWithFloodRetry(this.log, accountId, 'GetFullUser', () =>
            client.invoke(new Api.users.GetFullUser({ id: peer }))
          )) as Api.users.UserFull;
          const fullUser = (fullResult as any).fullUser ?? fullResult?.fullUser;
          if (fullUser?.about != null) bio = String(fullUser.about).trim() || null;
          if (fullUser?.phone != null && !phone) phone = String(fullUser.phone).trim() || null;
        } catch (fullErr: any) {
          if (fullErr?.message !== 'TIMEOUT' && !fullErr?.message?.includes('Could not find')) {
            this.log.warn({ message: 'GetFullUser for contact enrichment', error: fullErr?.message });
          }
        }
      }

      return this.upsertContactFromTelegramUser(organizationId, telegramId, {
        firstName: (u.firstName ?? '').trim(),
        lastName: (u.lastName ?? '').trim() || null,
        username: (u.username ?? '').trim() || null,
        phone,
        bio,
        premium,
      });
    } catch (e: unknown) {
      const msg = getErrorMessage(e);
      if (msg !== 'TIMEOUT' && !msg.includes('Could not find')) {
        this.log.warn({ message: "getEntity for contact enrichment", error: msg });
      }
      return this.upsertContactFromTelegramUser(
        organizationId,
        telegramId,
        resolvedUsername ? { firstName: '', lastName: null, username: resolvedUsername } : undefined
      );
    }
  }

  async enrichContactFromDialog(
    organizationId: string,
    telegramId: string,
    userInfo?: { firstName?: string; lastName?: string | null; username?: string | null }
  ): Promise<void> {
    if (!telegramId?.trim()) return;
    const firstName = userInfo?.firstName?.trim() ?? '';
    const lastName = userInfo?.lastName != null ? (userInfo.lastName?.trim() || null) : null;
    const username = userInfo?.username != null ? (userInfo.username?.trim() || null) : null;
    const hasInfo = firstName || lastName || username;
    await this.upsertContactFromTelegramUser(organizationId, telegramId, hasInfo ? { firstName: firstName || '', lastName, username } : undefined);
  }

  async enrichContactsFromTelegram(
    organizationId: string,
    contactIds: string[],
    bdAccountId?: string
  ): Promise<{ enriched: number }> {
    if (!contactIds?.length) return { enriched: 0 };
    let accountId = bdAccountId ?? null;
    if (accountId) {
      const check = await this.pool.query(
        'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2 AND is_active = true LIMIT 1',
        [accountId, organizationId]
      );
      if (check.rows.length === 0) accountId = null;
    }
    if (!accountId) {
      const first = await this.pool.query(
        'SELECT id FROM bd_accounts WHERE organization_id = $1 AND is_active = true LIMIT 1',
        [organizationId]
      );
      accountId = first.rows[0]?.id ?? null;
    }
    if (!accountId || !this.clients.has(accountId)) return { enriched: 0 };
    const clientInfo = this.clients.get(accountId);
    const client = clientInfo?.client;
    if (!client) return { enriched: 0 };

    const rows = await this.pool.query(
      'SELECT id, telegram_id, username FROM contacts WHERE id = ANY($1) AND organization_id = $2',
      [contactIds, organizationId]
    );
    let enriched = 0;
    const delayBetweenUsernameMs = 80;

    for (const row of rows.rows as { id: string; telegram_id: string | null; username: string | null }[]) {
      const tid = row.telegram_id?.trim();
      if (tid && parseInt(tid, 10) > 0) {
        await this.ensureContactEnrichedFromTelegram(organizationId, accountId, tid);
        enriched++;
        continue;
      }

      const u = (row.username ?? '').trim().replace(/^@/, '');
      if (!u) continue;

      try {
        let resolvedId: string | null = null;
        const peer = await resolveUsernameToInputPeer(client, u, { log: this.log, accountId });
        if (peer?.className === 'InputPeerUser') {
          const uid = (peer as Api.InputPeerUser).userId;
          if (uid != null) resolvedId = String(uid);
        }
        if (!resolvedId) {
          try {
            const ent = await client.getInputEntity(u);
            if (ent && (ent as any).className === 'User') {
              const id = (ent as Api.User).id;
              if (id != null) resolvedId = String(id);
            }
          } catch (e: unknown) {
            this.log.warn({
              message: 'enrichContactsFromTelegram: getInputEntity(username) failed',
              username: u,
              error: getErrorMessage(e),
            });
          }
        }
        if (!resolvedId) {
          this.log.warn({
            message: 'enrichContactsFromTelegram: could not resolve username to user id',
            username: u,
            contactId: row.id,
          });
          if (delayBetweenUsernameMs > 0) await new Promise((r) => setTimeout(r, delayBetweenUsernameMs));
          continue;
        }

        await this.pool.query(
          `UPDATE contacts SET telegram_id = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3`,
          [resolvedId, row.id, organizationId]
        );
        await this.ensureContactEnrichedFromTelegram(organizationId, accountId, resolvedId);
        enriched++;
      } catch (e: unknown) {
        this.log.warn({
          message: 'enrichContactsFromTelegram: username branch failed',
          contactId: row.id,
          error: getErrorMessage(e),
        });
      }
      if (delayBetweenUsernameMs > 0) await new Promise((r) => setTimeout(r, delayBetweenUsernameMs));
    }

    return { enriched };
  }

  async enrichContactsForAccountSyncChats(
    organizationId: string,
    accountId: string,
    opts?: { delayMs?: number }
  ): Promise<{ enriched: number }> {
    const accountRow = await this.pool.query(
      'SELECT telegram_id FROM bd_accounts WHERE id = $1 AND organization_id = $2 LIMIT 1',
      [accountId, organizationId]
    );
    if (accountRow.rows.length === 0) return { enriched: 0 };
    const selfTelegramId = accountRow.rows[0].telegram_id != null ? String(accountRow.rows[0].telegram_id).trim() : null;

    const chats = await this.pool.query(
      'SELECT telegram_chat_id, peer_type FROM bd_account_sync_chats WHERE bd_account_id = $1 AND peer_type = $2',
      [accountId, 'user']
    );
    const delayMs = typeof opts?.delayMs === 'number' ? Math.max(0, opts.delayMs) : 80;
    let enriched = 0;
    for (const row of chats.rows as { telegram_chat_id: string; peer_type: string }[]) {
      const tid = String(row.telegram_chat_id).trim();
      if (!tid || (selfTelegramId && tid === selfTelegramId)) continue;
      if (parseInt(tid, 10) <= 0) continue;
      try {
        await this.ensureContactEnrichedFromTelegram(organizationId, accountId, tid, { skipGetFullUser: true });
        enriched++;
        if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      } catch (e: unknown) {
        this.log.warn({ message: 'enrichContactsForAccountSyncChats single', telegramId: tid, error: getErrorMessage(e) });
      }
    }
    return { enriched };
  }
}
