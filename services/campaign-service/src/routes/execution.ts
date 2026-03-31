import { Router } from 'express';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { EventType, CampaignStartedEvent, CampaignPausedEvent } from '@getsale/events';
import { CampaignStatus } from '@getsale/types';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, withOrgContext } from '@getsale/service-core';
import { type Schedule } from '../helpers';
import { bulkInsertCampaignParticipants } from '../campaign-participant-bulk';
import { recalculatePendingNextSendAtForCampaign } from '../campaign-pending-reschedule';

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
    };
    const limit = Math.min(audience.limit ?? 5000, 10000);
    const campaignSchedule = (campaign.schedule ?? {}) as Schedule;

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

    const mergedContactIds = [...new Set([...(Array.isArray(audience.contactIds) ? audience.contactIds : []), ...contactIds])];
    const nextAudience = { ...audience, contactIds: mergedContactIds };
    let nextStatus = status;
    if (inserted > 0 && status === CampaignStatus.COMPLETED) {
      nextStatus = CampaignStatus.ACTIVE;
    }
    await pool.query(
      `UPDATE campaigns SET target_audience = $1::jsonb, status = $2, updated_at = NOW() WHERE id = $3 AND organization_id = $4`,
      [JSON.stringify(nextAudience), nextStatus, id, organizationId]
    );

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
