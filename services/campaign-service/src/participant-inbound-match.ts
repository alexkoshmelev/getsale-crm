import type { Pool } from 'pg';

/** Row shape used by campaign MESSAGE_RECEIVED handler. */
export type InboundParticipantRow = {
  id: string;
  campaign_id: string;
  current_step: number;
  next_send_at: unknown;
  bd_account_id: string;
  channel_id: string;
};

export type FindInboundParticipantsResult = {
  rows: InboundParticipantRow[];
  /** True when rows were found by telegram_id / username identity (enrollment contact differed from event contact). */
  matchedViaIdentityAlias: boolean;
};

/**
 * Find campaign participants for an inbound Telegram message when the event `contactId`
 * may differ from the contact row used at enrollment (e.g. username-only list vs
 * contact resolved by numeric peer id).
 *
 * Order: strict channel match → same contact + bd → identity (telegram_id / username /
 * participant.channel_id as username vs inbound peer id / numeric channel_id without contact.telegram_id).
 */
export async function findCampaignParticipantsForInboundMessage(
  pool: Pool,
  opts: {
    organizationId: string;
    eventContactId: string;
    bdAccountId: string | null;
    channelId: string | null;
  }
): Promise<FindInboundParticipantsResult> {
  const { organizationId, eventContactId, bdAccountId, channelId } = opts;

  let res = await pool.query<InboundParticipantRow>(
    `SELECT cp.id, cp.campaign_id, cp.current_step, cp.next_send_at, cp.bd_account_id, cp.channel_id
     FROM campaign_participants cp
     JOIN campaigns c ON c.id = cp.campaign_id
     WHERE cp.contact_id = $1::uuid AND c.organization_id = $4
       AND c.status IN ('active', 'completed') AND cp.status IN ('pending', 'sent', 'completed')
       AND (($2::text IS NULL AND $3::text IS NULL) OR (cp.bd_account_id = $2::uuid AND cp.channel_id = $3))`,
    [eventContactId, bdAccountId, channelId, organizationId]
  );

  if (res.rows.length > 0) {
    return { rows: res.rows, matchedViaIdentityAlias: false };
  }

  if (bdAccountId) {
    res = await pool.query<InboundParticipantRow>(
      `SELECT cp.id, cp.campaign_id, cp.current_step, cp.next_send_at, cp.bd_account_id, cp.channel_id
       FROM campaign_participants cp
       JOIN campaigns c ON c.id = cp.campaign_id
       WHERE cp.contact_id = $1::uuid AND cp.bd_account_id = $2::uuid AND c.organization_id = $3
         AND c.status IN ('active', 'completed') AND cp.status IN ('pending', 'sent', 'completed')`,
      [eventContactId, bdAccountId, organizationId]
    );
  }

  if (res.rows.length > 0) {
    return { rows: res.rows, matchedViaIdentityAlias: false };
  }

  if (bdAccountId && channelId) {
    res = await pool.query<InboundParticipantRow>(
      `SELECT cp.id, cp.campaign_id, cp.current_step, cp.next_send_at, cp.bd_account_id, cp.channel_id
       FROM campaign_participants cp
       JOIN campaigns camp ON camp.id = cp.campaign_id
       JOIN contacts c_p ON c_p.id = cp.contact_id
       JOIN contacts c_ev ON c_ev.id = $1::uuid AND c_ev.organization_id = camp.organization_id
       WHERE camp.organization_id = $2
         AND cp.bd_account_id = $3::uuid
         AND camp.status IN ('active', 'completed')
         AND cp.status IN ('pending', 'sent', 'completed')
         AND c_p.organization_id = camp.organization_id
         AND cp.contact_id <> c_ev.id
         AND (
           (c_p.telegram_id IS NOT NULL AND c_ev.telegram_id IS NOT NULL
             AND TRIM(c_p.telegram_id) = TRIM(c_ev.telegram_id))
           OR (c_p.telegram_id IS NOT NULL AND TRIM(c_p.telegram_id) = TRIM($4))
           OR (
             c_ev.telegram_id IS NOT NULL
             AND TRIM(c_ev.telegram_id) = TRIM($4)
             AND c_p.telegram_id IS NULL
             AND LENGTH(TRIM(COALESCE(c_p.username, ''))) > 0
             AND LOWER(TRIM(REGEXP_REPLACE(COALESCE(c_p.username, ''), '^@', '')))
               = LOWER(TRIM(REGEXP_REPLACE(COALESCE(c_ev.username, ''), '^@', '')))
           )
           OR (
             c_ev.telegram_id IS NOT NULL
             AND TRIM(c_ev.telegram_id) = TRIM($4)
             AND c_p.telegram_id IS NULL
             AND LENGTH(TRIM(COALESCE(c_p.username, ''))) > 0
             AND LENGTH(TRIM(COALESCE(cp.channel_id, ''))) > 0
             AND LOWER(TRIM(REGEXP_REPLACE(COALESCE(c_p.username, ''), '^@', '')))
               = LOWER(TRIM(REGEXP_REPLACE(COALESCE(cp.channel_id, ''), '^@', '')))
           )
           OR (
             c_ev.telegram_id IS NOT NULL
             AND TRIM(c_ev.telegram_id) = TRIM($4)
             AND c_p.telegram_id IS NULL
             AND TRIM(COALESCE(cp.channel_id, '')) = TRIM(COALESCE($4::text, ''))
           )
         )`,
      [eventContactId, organizationId, bdAccountId, channelId]
    );
    if (res.rows.length > 0) {
      return { rows: res.rows, matchedViaIdentityAlias: true };
    }
  }

  return { rows: [], matchedViaIdentityAlias: false };
}

/** Reconcile channel_id on participant rows when inbound peer id differs from stored channel_id. */
export async function reconcileParticipantChannelIds(
  pool: Pool,
  rows: InboundParticipantRow[],
  channelId: string | null
): Promise<void> {
  if (!channelId || rows.length === 0) return;
  for (const row of rows) {
    if (row.channel_id !== channelId) {
      await pool.query(
        `UPDATE campaign_participants SET channel_id = $1, updated_at = NOW() WHERE id = $2`,
        [channelId, row.id]
      );
      row.channel_id = channelId;
    }
  }
}

/** Point participant at canonical event contact and channel after alias match. */
export async function mergeParticipantToEventContact(
  pool: Pool,
  rows: InboundParticipantRow[],
  eventContactId: string,
  channelId: string | null
): Promise<void> {
  for (const row of rows) {
    await pool.query(
      `UPDATE campaign_participants
       SET contact_id = $1::uuid,
           channel_id = COALESCE($2, channel_id),
           updated_at = NOW()
       WHERE id = $3`,
      [eventContactId, channelId, row.id]
    );
    if (channelId) row.channel_id = channelId;
  }
}
