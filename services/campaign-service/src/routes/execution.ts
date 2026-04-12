import { Router } from 'express';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, CampaignStartedEvent, CampaignPausedEvent } from '@getsale/events';
import { CampaignStatus } from '@getsale/types';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, withOrgContext } from '@getsale/service-core';
import {
  type Schedule,
  resolveCampaignChannelId,
  scheduleFromBdAccountRow,
  getEffectiveSchedule,
  resolveDelayRange,
  spreadOffsetSecondsForSlot,
  staggeredFirstSendAtByOffset,
  DEFAULT_DAILY_SEND_CAP,
} from '../helpers';
import { bulkInsertCampaignParticipants } from '../campaign-participant-bulk';
import { recalculatePendingNextSendAtForCampaign, recalculatePendingForCampaignsUsingBdAccount } from '../campaign-pending-reschedule';

function getBdAccountIdsFromTargetAudience(aud: unknown): string[] {
  if (!aud || typeof aud !== 'object') return [];
  const a = aud as { bdAccountIds?: unknown; bdAccountId?: unknown };
  if (Array.isArray(a.bdAccountIds) && a.bdAccountIds.length > 0) {
    return a.bdAccountIds.filter((id): id is string => typeof id === 'string');
  }
  if (typeof a.bdAccountId === 'string' && a.bdAccountId) return [a.bdAccountId];
  return [];
}

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
}

export function executionRouter({ pool, rabbitmq, log }: Deps): Router {
  const router = Router();

  /** Pause sends from this BD account (global 2h block) and bump this campaign's participants on that account. */
  router.post('/:id/accounts/:accountId/pause', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id: campaignId, accountId } = req.params;
    const camp = await pool.query(
      'SELECT id, target_audience FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [campaignId, organizationId]
    );
    if (camp.rows.length === 0) {
      throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);
    }
    const aud = camp.rows[0].target_audience;
    const bdIds = getBdAccountIdsFromTargetAudience(aud);
    if (!bdIds.includes(accountId)) {
      throw new AppError(400, 'BD account is not part of this campaign audience', ErrorCodes.BAD_REQUEST);
    }
    const acc = await pool.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [accountId, organizationId]
    );
    if (acc.rows.length === 0) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }
    const until = new Date(Date.now() + 2 * 3600 * 1000);
    await pool.query(
      `UPDATE bd_accounts SET send_blocked_until = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3`,
      [until.toISOString(), accountId, organizationId]
    );
    await pool.query(
      `UPDATE campaign_participants
       SET next_send_at = CASE
         WHEN next_send_at IS NULL THEN NULL
         ELSE GREATEST(next_send_at::timestamptz, $3::timestamptz)
       END,
       metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('campaignAccountPausedUntil', $3::text),
       updated_at = NOW()
       WHERE campaign_id = $1 AND bd_account_id = $2 AND status IN ('pending', 'sent')`,
      [campaignId, accountId, until.toISOString()]
    );
    res.json({ ok: true, sendBlockedUntil: until.toISOString() });
  }));

  /** Clear global send block and reschedule pending first sends for this BD account. */
  router.post('/:id/accounts/:accountId/resume', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id: campaignId, accountId } = req.params;
    const camp = await pool.query(
      'SELECT id FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [campaignId, organizationId]
    );
    if (camp.rows.length === 0) {
      throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);
    }
    const audRow = await pool.query(
      'SELECT target_audience FROM campaigns WHERE id = $1 AND organization_id = $2',
      [campaignId, organizationId]
    );
    const aud = audRow.rows[0]?.target_audience;
    const bdIds = getBdAccountIdsFromTargetAudience(aud);
    if (!bdIds.includes(accountId)) {
      throw new AppError(400, 'BD account is not part of this campaign audience', ErrorCodes.BAD_REQUEST);
    }
    await pool.query(
      `UPDATE bd_accounts SET send_blocked_until = NULL, updated_at = NOW() WHERE id = $1 AND organization_id = $2`,
      [accountId, organizationId]
    );
    await recalculatePendingForCampaignsUsingBdAccount(pool, accountId, log);
    res.json({ ok: true });
  }));

  /** Remove a BD account from campaign audience and reassign its participants to remaining accounts. */
  router.delete('/:id/accounts/:accountId', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id: campaignId, accountId } = req.params;
    const camp = await pool.query(
      'SELECT id, target_audience, schedule FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [campaignId, organizationId]
    );
    if (camp.rows.length === 0) {
      throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);
    }
    const row = camp.rows[0] as { target_audience: Record<string, unknown>; schedule: unknown };
    const bdIds = getBdAccountIdsFromTargetAudience(row.target_audience);
    if (!bdIds.includes(accountId)) {
      throw new AppError(400, 'BD account is not part of this campaign audience', ErrorCodes.BAD_REQUEST);
    }
    if (bdIds.length <= 1) {
      throw new AppError(
        400,
        'Cannot remove the only sending account. Add another account first or pause the campaign.',
        ErrorCodes.BAD_REQUEST
      );
    }
    const remaining = bdIds.filter((x) => x !== accountId);
    const nextAudience = { ...row.target_audience } as Record<string, unknown>;
    if (remaining.length === 1) {
      nextAudience.bdAccountId = remaining[0];
      delete nextAudience.bdAccountIds;
    } else {
      nextAudience.bdAccountIds = remaining;
      delete nextAudience.bdAccountId;
    }
    await pool.query(
      `UPDATE campaigns SET target_audience = $1::jsonb, updated_at = NOW() WHERE id = $2 AND organization_id = $3`,
      [JSON.stringify(nextAudience), campaignId, organizationId]
    );
    const parts = await pool.query(
      `SELECT id FROM campaign_participants WHERE campaign_id = $1 AND bd_account_id = $2`,
      [campaignId, accountId]
    );
    let reassign = 0;
    for (let i = 0; i < parts.rows.length; i++) {
      const pid = (parts.rows[i] as { id: string }).id;
      const newBd = remaining[i % remaining.length];
      const r = await pool.query(
        `UPDATE campaign_participants SET bd_account_id = $1, updated_at = NOW() WHERE id = $2 AND campaign_id = $3`,
        [newBd, pid, campaignId]
      );
      reassign += r.rowCount ?? 0;
    }
    const audience = nextAudience as {
      bdAccountId?: string;
      bdAccountIds?: string[];
      sendDelaySeconds?: number;
      sendDelayMinSeconds?: number;
      sendDelayMaxSeconds?: number;
      dailySendTarget?: number;
    };
    const campaignSchedule = (row.schedule ?? {}) as Schedule;
    await recalculatePendingNextSendAtForCampaign(pool, {
      campaignId,
      organizationId,
      audience,
      campaignSchedule,
    });
    res.json({ ok: true, reassignedParticipants: reassign, remainingBdAccountIds: remaining });
  }));

  router.post('/:id/start', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { id } = req.params;
    const campaignRes = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (campaignRes.rows.length === 0) {
      throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);
    }
    const campaign = campaignRes.rows[0];
    if (campaign.status !== CampaignStatus.DRAFT && campaign.status !== CampaignStatus.PAUSED && campaign.status !== CampaignStatus.COMPLETED) {
      throw new AppError(400, 'Campaign can be started only from draft, paused or completed', ErrorCodes.BAD_REQUEST);
    }

    const seqRes = await pool.query('SELECT 1 FROM campaign_sequences WHERE campaign_id = $1 LIMIT 1', [id]);
    if (seqRes.rows.length === 0) {
      throw new AppError(400, 'Add at least one sequence step before starting the campaign', ErrorCodes.VALIDATION);
    }

    const audience = (campaign.target_audience || {}) as {
      filters?: Record<string, unknown>;
      limit?: number;
      onlyNew?: boolean;
      contactIds?: string[];
      bdAccountId?: string;
      bdAccountIds?: string[];
      sendDelaySeconds?: number;
      sendDelayMinSeconds?: number;
      sendDelayMaxSeconds?: number;
      dailySendTarget?: number;
      enrichContactsBeforeStart?: boolean;
    };
    const campaignSchedule = (campaign.schedule ?? {}) as Schedule;

    // Check if campaign_participants already exist (new flow: contacts added during draft)
    const existingParticipants = await pool.query(
      'SELECT COUNT(*)::int AS cnt FROM campaign_participants WHERE campaign_id = $1',
      [id]
    );
    const existingCount = Number((existingParticipants.rows[0] as { cnt?: number })?.cnt ?? 0);

    if (existingCount > 0) {
      // Enrich existing campaign_participants: resolve channels, assign bd_accounts, set next_send_at
      const enrichContacts = await pool.query(
        `SELECT cp.id AS participant_id, cp.contact_id, cp.bd_account_id, cp.channel_id, cp.enqueue_order,
                c.telegram_id, c.username
         FROM campaign_participants cp
         JOIN contacts c ON c.id = cp.contact_id
         WHERE cp.campaign_id = $1
         ORDER BY cp.enqueue_order ASC NULLS LAST, cp.created_at ASC`,
        [id]
      );

      // Resolve active BD accounts
      const bdAccountIdsRaw = audience.bdAccountIds ?? (audience.bdAccountId ? [audience.bdAccountId] : []);
      const bdAccountIdsFiltered = bdAccountIdsRaw.filter((x): x is string => typeof x === 'string');
      let accountIds: string[] = [];
      if (bdAccountIdsFiltered.length > 0) {
        const check = await pool.query(
          'SELECT id FROM bd_accounts WHERE id = ANY($1::uuid[]) AND organization_id = $2 AND is_active = true',
          [bdAccountIdsFiltered, organizationId]
        );
        const order = new Map(bdAccountIdsFiltered.map((bdId, i) => [bdId, i]));
        accountIds = (check.rows as { id: string }[])
          .map((r) => r.id)
          .sort((a, b) => (order.get(a) ?? 999) - (order.get(b) ?? 999));
      }
      if (accountIds.length === 0) {
        const fallback = await pool.query(
          'SELECT id FROM bd_accounts WHERE organization_id = $1 AND is_active = true LIMIT 1',
          [organizationId]
        );
        accountIds = fallback.rows.length > 0 ? [fallback.rows[0].id] : [];
      }

      if (accountIds.length === 0) {
        throw new AppError(400, 'No active BD account available for sending', ErrorCodes.VALIDATION);
      }

      let accScheduleFallback: Schedule = null;
      const accSch = await pool.query(
        'SELECT timezone, working_hours_start, working_hours_end, working_days FROM bd_accounts WHERE id = $1',
        [accountIds[0]]
      );
      accScheduleFallback = scheduleFromBdAccountRow(accSch.rows[0]);
      const effectiveSchedule = getEffectiveSchedule(campaignSchedule, accScheduleFallback);
      const delayRange = resolveDelayRange(audience);

      const now = new Date();
      let enrichedCount = 0;
      let contactIndex = 0;

      for (const row of enrichContacts.rows as {
        participant_id: string; contact_id: string; bd_account_id: string | null;
        channel_id: string | null; enqueue_order: number | null;
        telegram_id: string | null; username: string | null;
      }[]) {
        const bdAccountId = accountIds[contactIndex % accountIds.length]!;
        contactIndex++;

        let channelId: string | null = resolveCampaignChannelId(row.telegram_id, row.username);
        if (channelId && bdAccountId) {
          const chatRes = await pool.query(
            'SELECT bd_account_id, telegram_chat_id FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1',
            [bdAccountId, channelId]
          );
          if (chatRes.rows.length > 0) {
            channelId = String(chatRes.rows[0].telegram_chat_id);
          }
        }

        if (!channelId) continue;

        const capRow = await pool.query('SELECT COALESCE(max_dm_per_day, -1) AS m FROM bd_accounts WHERE id = $1', [bdAccountId]);
        const dm = Number((capRow.rows[0] as { m?: number })?.m);
        const audienceDaily =
          typeof audience.dailySendTarget === 'number'
            ? Math.min(500, Math.max(1, Math.floor(audience.dailySendTarget)))
            : null;
        const dailyCap = audienceDaily ?? (Number.isFinite(dm) && dm >= 0 ? dm : DEFAULT_DAILY_SEND_CAP);

        const slotIndex = row.enqueue_order ?? enrichedCount;
        const spreadSec = spreadOffsetSecondsForSlot(slotIndex, dailyCap, effectiveSchedule, delayRange);
        const nextSendAt = staggeredFirstSendAtByOffset(now, spreadSec, effectiveSchedule);

        await pool.query(
          `UPDATE campaign_participants
           SET bd_account_id = $1, channel_id = $2, next_send_at = $3, status = 'pending', current_step = 0, updated_at = NOW()
           WHERE id = $4`,
          [bdAccountId, channelId, nextSendAt, row.participant_id]
        );
        enrichedCount++;
      }

      if (enrichedCount === 0) {
        throw new AppError(
          400,
          'No participants could be enriched. Ensure contacts have Telegram ID or username and an active BD account is selected.',
          ErrorCodes.VALIDATION
        );
      }
    } else {
      // Legacy path: no pre-existing participants, read from audience filters or contactIds
      const limit = Math.min(audience.limit ?? 5000, 10000);
      let contactsQuery: string;
      const queryParams: any[] = [organizationId];
      let paramIdx = 2;

      if (audience.contactIds && Array.isArray(audience.contactIds) && audience.contactIds.length > 0) {
        const ids = audience.contactIds.slice(0, limit).filter((x) => typeof x === 'string');
        if (ids.length === 0) {
          throw new AppError(400, 'No valid contact IDs in audience', ErrorCodes.VALIDATION);
        }
        contactsQuery = `
          SELECT c.id as contact_id, c.organization_id, c.telegram_id, c.username
          FROM contacts c
          WHERE c.organization_id = $1
          AND (
            (c.telegram_id IS NOT NULL AND TRIM(c.telegram_id) != '')
            OR (c.username IS NOT NULL AND TRIM(c.username) != '')
          )
          AND c.id = ANY($${paramIdx}::uuid[])
        `;
        queryParams.push(ids);
        paramIdx++;
      } else {
        contactsQuery = `
          SELECT c.id as contact_id, c.organization_id, c.telegram_id, c.username
          FROM contacts c
          WHERE c.organization_id = $1
          AND (
            (c.telegram_id IS NOT NULL AND TRIM(c.telegram_id) != '')
            OR (c.username IS NOT NULL AND TRIM(c.username) != '')
          )
        `;
        if (audience.filters?.companyId) {
          contactsQuery += ` AND c.company_id = $${paramIdx++}`;
          queryParams.push(audience.filters.companyId);
        }
        if (audience.filters?.pipelineId) {
          contactsQuery += ` AND EXISTS (SELECT 1 FROM leads l WHERE l.contact_id = c.id AND l.pipeline_id = $${paramIdx})`;
          queryParams.push(audience.filters.pipelineId);
          paramIdx++;
        }
        if (audience.onlyNew) {
          contactsQuery += ` AND NOT EXISTS (
            SELECT 1 FROM campaign_participants cp
            JOIN campaigns c2 ON c2.id = cp.campaign_id
            WHERE cp.contact_id = c.id AND c2.organization_id = c.organization_id
          )`;
        }
        contactsQuery += ` LIMIT ${limit}`;
      }

      const contactsResult = await pool.query(contactsQuery, queryParams);
      const contacts = contactsResult.rows;

      if (contacts.length === 0) {
        throw new AppError(
          400,
          'No contacts found matching the audience criteria. Add contacts with Telegram data or check audience settings.',
          ErrorCodes.VALIDATION
        );
      }

      const ordRow = await pool.query(
        `SELECT COALESCE(MAX(enqueue_order), -1) + 1 AS n FROM campaign_participants WHERE campaign_id = $1`,
        [id]
      );
      const enqueueOrderBase = Number((ordRow.rows[0] as { n?: number })?.n ?? 0);
      const { inserted: insertedCount } = await bulkInsertCampaignParticipants(pool, {
        campaignId: id,
        organizationId,
        contacts,
        audience,
        campaignSchedule,
        enqueueOrderBase,
      });

      if (insertedCount === 0) {
        throw new AppError(
          400,
          'No participants could be added. Ensure contacts have Telegram ID or username and an active BD account is selected.',
          ErrorCodes.VALIDATION
        );
      }
    }

    if (campaign.status === CampaignStatus.PAUSED) {
      await recalculatePendingNextSendAtForCampaign(pool, {
        campaignId: id,
        organizationId,
        audience,
        campaignSchedule,
      });
    }

    await pool.query(
      "UPDATE campaigns SET status = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3",
      [CampaignStatus.ACTIVE, id, organizationId]
    );
    try {
      const event: CampaignStartedEvent = {
        id: randomUUID(),
        type: EventType.CAMPAIGN_STARTED,
        timestamp: new Date(),
        organizationId,
        userId,
        correlationId: req.correlationId,
        data: { campaignId: id },
      };
      await rabbitmq.publishEvent(event);
    } catch (err) {
      log.warn({ message: 'CAMPAIGN_STARTED publish failed', campaignId: id, error: err instanceof Error ? err.message : String(err) });
    }
    const updated = await pool.query('SELECT * FROM campaigns WHERE id = $1', [id]);
    res.json(updated.rows[0]);
  }));

  router.post('/:id/participants/add', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;
    const rawIds = req.body?.contactIds;
    if (!Array.isArray(rawIds) || rawIds.length === 0) {
      throw new AppError(400, 'contactIds array required', ErrorCodes.VALIDATION);
    }
    const contactIds = [...new Set(rawIds.map((x) => String(x).trim()).filter((x) => x.length > 0))].slice(0, 2000);
    if (contactIds.length === 0) {
      throw new AppError(400, 'No valid contact IDs', ErrorCodes.VALIDATION);
    }

    const campaignRes = await pool.query(
      'SELECT * FROM campaigns WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (campaignRes.rows.length === 0) {
      throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);
    }
    const campaign = campaignRes.rows[0];
    const status = campaign.status as string;
    if (status === CampaignStatus.DRAFT || status === CampaignStatus.PAUSED || status === CampaignStatus.ACTIVE || status === CampaignStatus.COMPLETED) {
      // ok
    } else {
      throw new AppError(400, 'Cannot add participants to this campaign status', ErrorCodes.BAD_REQUEST);
    }

    const seqRes = await pool.query('SELECT 1 FROM campaign_sequences WHERE campaign_id = $1 LIMIT 1', [id]);
    if (seqRes.rows.length === 0) {
      throw new AppError(400, 'Add at least one sequence step first', ErrorCodes.VALIDATION);
    }

    const audience = (campaign.target_audience || {}) as {
      bdAccountId?: string;
      bdAccountIds?: string[];
      dailySendTarget?: number;
      contactIds?: string[];
    };
    const campaignSchedule = (campaign.schedule ?? {}) as Schedule;

    const contactsResult = await pool.query(
      `SELECT c.id as contact_id, c.telegram_id, c.username
       FROM contacts c
       WHERE c.organization_id = $1
       AND c.id = ANY($2::uuid[])
       AND (
         (c.telegram_id IS NOT NULL AND TRIM(c.telegram_id) != '')
         OR (c.username IS NOT NULL AND TRIM(c.username) != '')
       )`,
      [organizationId, contactIds]
    );
    const contacts = contactsResult.rows as { contact_id: string; telegram_id: string | null; username: string | null }[];

    const ordRow = await pool.query(
      `SELECT COALESCE(MAX(enqueue_order), -1) + 1 AS n FROM campaign_participants WHERE campaign_id = $1`,
      [id]
    );
    const enqueueOrderBase = Number((ordRow.rows[0] as { n?: number })?.n ?? 0);
    const { inserted } = await bulkInsertCampaignParticipants(pool, {
      campaignId: id,
      organizationId,
      contacts,
      audience,
      campaignSchedule,
      enqueueOrderBase,
    });

    let nextStatus = status;
    if (inserted > 0 && status === CampaignStatus.COMPLETED) {
      nextStatus = CampaignStatus.ACTIVE;
      await pool.query(
        `UPDATE campaigns SET status = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3`,
        [nextStatus, id, organizationId]
      );
    }

    res.json({
      inserted,
      requested: contactIds.length,
      eligibleWithTelegram: contacts.length,
      campaignStatus: nextStatus,
    });
  }));

  router.post('/:id/pause', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { id } = req.params;
    const r = await withOrgContext(pool, organizationId, (client) =>
      client.query(
        "UPDATE campaigns SET status = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3 AND status = $4 RETURNING *",
        [CampaignStatus.PAUSED, id, organizationId, CampaignStatus.ACTIVE]
      )
    );
    if (r.rows.length === 0) {
      throw new AppError(404, 'Campaign not found or not active', ErrorCodes.NOT_FOUND);
    }
    try {
      const event: CampaignPausedEvent = {
        id: randomUUID(),
        type: EventType.CAMPAIGN_PAUSED,
        timestamp: new Date(),
        organizationId,
        userId,
        correlationId: req.correlationId,
        data: { campaignId: id },
      };
      await rabbitmq.publishEvent(event);
    } catch (err) {
      log.warn({ message: 'CAMPAIGN_PAUSED publish failed', campaignId: id, error: err instanceof Error ? err.message : String(err) });
    }
    res.json(r.rows[0]);
  }));

  return router;
}
