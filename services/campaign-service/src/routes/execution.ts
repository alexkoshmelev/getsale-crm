import { Router } from 'express';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, CampaignStartedEvent, CampaignPausedEvent } from '@getsale/events';
import { CampaignStatus } from '@getsale/types';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, withOrgContext } from '@getsale/service-core';
import { resolveDelayRange, sampleDelaySeconds, staggeredFirstSendAtByOffset, type Schedule } from '../helpers';

interface Deps {
  pool: Pool;
  rabbitmq: RabbitMQClient;
  log: Logger;
}

export function executionRouter({ pool, rabbitmq, log }: Deps): Router {
  const router = Router();

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

    if (campaign.status === CampaignStatus.COMPLETED) {
      await pool.query('DELETE FROM campaign_participants WHERE campaign_id = $1', [id]);
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
    };
    const limit = Math.min(audience.limit ?? 5000, 10000);
    const schedule = (campaign.schedule ?? {}) as Schedule;
    const delayRange = resolveDelayRange(audience, 60);

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

    const hadExplicitContactIds =
      Array.isArray(audience.contactIds) && audience.contactIds.length > 0;
    if (hadExplicitContactIds && contacts.length === 0) {
      throw new AppError(
        400,
        'None of the selected contacts have a Telegram ID or username. Add Telegram data to contacts or enable enrich-before-start.',
        ErrorCodes.VALIDATION
      );
    }

    const bdAccountIdsRaw = audience.bdAccountIds ?? (audience.bdAccountId ? [audience.bdAccountId] : []);
    const bdAccountIdsFiltered = bdAccountIdsRaw.filter((id): id is string => typeof id === 'string');
    let accountIds: string[] = [];
    if (bdAccountIdsFiltered.length > 0) {
      const check = await pool.query(
        'SELECT id FROM bd_accounts WHERE id = ANY($1::uuid[]) AND organization_id = $2 AND is_active = true',
        [bdAccountIdsFiltered, organizationId]
      );
      const order = new Map(bdAccountIdsFiltered.map((id, i) => [id, i]));
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

    const now = new Date();
    let insertedCount = 0;
    let cumulativeOffsetSeconds = 0;
    let contactIndex = 0;
    for (const row of contacts) {
      let bdAccountId = accountIds.length > 0 ? accountIds[contactIndex % accountIds.length]! : null;
      contactIndex++;
      const telegramId = row.telegram_id != null && String(row.telegram_id).trim() !== '' ? String(row.telegram_id).trim() : null;
      const usernameRaw = row.username != null ? String(row.username).trim().replace(/^@/, '') : null;
      const usernameNorm = usernameRaw !== '' ? usernameRaw : null;
      let channelId: string | null = telegramId ?? usernameNorm;
      if (channelId && bdAccountId) {
        const chatRes = await pool.query(
          `SELECT bd_account_id, telegram_chat_id FROM bd_account_sync_chats WHERE bd_account_id = $1 AND telegram_chat_id = $2 LIMIT 1`,
          [bdAccountId, channelId]
        );
        if (chatRes.rows.length > 0) {
          bdAccountId = chatRes.rows[0].bd_account_id;
          channelId = String(chatRes.rows[0].telegram_chat_id);
        }
      }
      if (!channelId || !bdAccountId) continue;
      const nextSendAt = staggeredFirstSendAtByOffset(now, cumulativeOffsetSeconds, schedule);
      const ins = await pool.query(
        `INSERT INTO campaign_participants (campaign_id, contact_id, bd_account_id, channel_id, status, current_step, next_send_at, enqueue_order)
         VALUES ($1, $2, $3, $4, 'pending', 0, $5, $6)
         ON CONFLICT (campaign_id, contact_id) DO NOTHING
         RETURNING id`,
        [id, row.contact_id, bdAccountId, channelId, nextSendAt, insertedCount]
      );
      if (ins.rowCount && ins.rows.length > 0) {
        insertedCount++;
        cumulativeOffsetSeconds += sampleDelaySeconds(delayRange);
      }
    }

    // Fresh start: need at least one INSERT. Resume from pause: participants often already exist;
    // INSERT ... ON CONFLICT DO NOTHING yields insertedCount === 0 but rows are valid.
    if (contacts.length > 0 && insertedCount === 0) {
      const existing = await pool.query(
        'SELECT COUNT(*)::int AS c FROM campaign_participants WHERE campaign_id = $1',
        [id]
      );
      const existingCount = Number((existing.rows[0] as { c?: number })?.c ?? 0);
      if (existingCount === 0) {
        throw new AppError(
          400,
          'No participants could be added. Ensure contacts have Telegram ID or username and an active BD account is selected.',
          ErrorCodes.VALIDATION
        );
      }
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
