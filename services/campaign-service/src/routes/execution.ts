import { Router } from 'express';
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { RabbitMQClient } from '@getsale/utils';
import { EventType } from '@getsale/events';
import { CampaignStatus } from '@getsale/types';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes } from '@getsale/service-core';

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
    };
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
        SELECT c.id as contact_id, c.organization_id, c.telegram_id
        FROM contacts c
        WHERE c.organization_id = $1 AND c.telegram_id IS NOT NULL AND c.telegram_id != ''
        AND c.id = ANY($${paramIdx}::uuid[])
      `;
      queryParams.push(ids);
      paramIdx++;
    } else {
      contactsQuery = `
        SELECT c.id as contact_id, c.organization_id, c.telegram_id
        FROM contacts c
        WHERE c.organization_id = $1 AND c.telegram_id IS NOT NULL AND c.telegram_id != ''
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

    let defaultBdAccountId: string | null = null;
    if (audience.bdAccountId) {
      const check = await pool.query(
        'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2 AND is_active = true',
        [audience.bdAccountId, organizationId]
      );
      defaultBdAccountId = check.rows[0]?.id || null;
    }
    if (!defaultBdAccountId) {
      const bdAccountRes = await pool.query(
        `SELECT id FROM bd_accounts WHERE organization_id = $1 AND is_active = true LIMIT 1`,
        [organizationId]
      );
      defaultBdAccountId = bdAccountRes.rows[0]?.id || null;
    }

    const now = new Date();
    let insertedCount = 0;
    for (const row of contacts) {
      let bdAccountId = defaultBdAccountId;
      let channelId: string | null = row.telegram_id;
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
      await pool.query(
        `INSERT INTO campaign_participants (campaign_id, contact_id, bd_account_id, channel_id, status, current_step, next_send_at)
         VALUES ($1, $2, $3, $4, 'pending', 0, $5)
         ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
        [id, row.contact_id, bdAccountId, channelId, now]
      );
      insertedCount++;
    }

    if (contacts.length > 0 && insertedCount === 0) {
      throw new AppError(
        400,
        'No participants could be added. Ensure contacts have Telegram ID and an active BD account is selected.',
        ErrorCodes.VALIDATION
      );
    }

    await pool.query(
      "UPDATE campaigns SET status = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3",
      [CampaignStatus.ACTIVE, id, organizationId]
    );
    try {
      await rabbitmq.publishEvent({
        id: randomUUID(),
        type: EventType.CAMPAIGN_STARTED,
        timestamp: new Date(),
        organizationId,
        userId,
        data: { campaignId: id },
      } as any);
    } catch (err) {
      log.warn({ message: 'CAMPAIGN_STARTED publish failed', campaignId: id, error: err instanceof Error ? err.message : String(err) });
    }
    const updated = await pool.query('SELECT * FROM campaigns WHERE id = $1', [id]);
    res.json(updated.rows[0]);
  }));

  router.post('/:id/pause', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { id } = req.params;
    const r = await pool.query(
      "UPDATE campaigns SET status = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3 AND status = $4 RETURNING *",
      [CampaignStatus.PAUSED, id, organizationId, CampaignStatus.ACTIVE]
    );
    if (r.rows.length === 0) {
      throw new AppError(404, 'Campaign not found or not active', ErrorCodes.NOT_FOUND);
    }
    try {
      await rabbitmq.publishEvent({
        id: randomUUID(),
        type: EventType.CAMPAIGN_PAUSED,
        timestamp: new Date(),
        organizationId,
        userId,
        data: { campaignId: id },
      } as any);
    } catch (err) {
      log.warn({ message: 'CAMPAIGN_PAUSED publish failed', campaignId: id, error: err instanceof Error ? err.message : String(err) });
    }
    res.json(r.rows[0]);
  }));

  return router;
}
