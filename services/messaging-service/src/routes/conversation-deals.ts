import { Router } from 'express';
import { Pool } from 'pg';
import { Counter } from 'prom-client';
import { MessageDirection, MessageStatus, ConversationSystemEvent } from '@getsale/types';
import { Logger } from '@getsale/logger';
import { asyncHandler, AppError, ErrorCodes, validate } from '@getsale/service-core';
import { getLeadConversationOrThrow } from '../queries/conversation-queries';
import { SYSTEM_MESSAGES } from '../system-messages';
import { MsgMarkWonSchema, MsgMarkLostSchema } from '../validation';

interface Deps {
  pool: Pool;
  log: Logger;
  conflicts409Total: Counter;
  dealsWonTotal: Counter;
}

export function conversationDealsRouter({ pool, log, conflicts409Total, dealsWonTotal }: Deps): Router {
  const router = Router();

  router.post('/mark-won', validate(MsgMarkWonSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { conversation_id: conversationId, revenue_amount: revenueAmountRaw, currency } = req.body;
    const c = await getLeadConversationOrThrow<{
      id: string; bd_account_id: string; channel_id: string; contact_id: string | null;
      shared_chat_created_at: Date | null; won_at: Date | null; lost_at: Date | null;
    }>(pool, conversationId, organizationId, 'id, bd_account_id, channel_id, contact_id, shared_chat_created_at, won_at, lost_at');
    if (c.won_at != null) {
      conflicts409Total.inc({ endpoint: 'mark-won' });
      log.warn({ message: 'conflict_409 mark-won already won', correlation_id: req.correlationId, endpoint: 'POST /mark-won', conversationId, event: 'conflict_409' });
      throw new AppError(409, 'Deal already marked as won', ErrorCodes.CONFLICT);
    }
    if (c.lost_at != null) {
      conflicts409Total.inc({ endpoint: 'mark-won' });
      log.warn({ message: 'conflict_409 mark-won already lost', correlation_id: req.correlationId, endpoint: 'POST /mark-won', conversationId, event: 'conflict_409' });
      throw new AppError(409, 'Deal already marked as lost', ErrorCodes.CONFLICT);
    }
    if (c.shared_chat_created_at == null) {
      throw new AppError(400, 'Shared chat must be created before marking as won', ErrorCodes.BAD_REQUEST);
    }

    const revenueAmount = revenueAmountRaw != null ? parseFloat(String(revenueAmountRaw)) : null;
    const amount = revenueAmount != null ? Math.round(revenueAmount * 100) / 100 : null;
    const systemContent = amount != null
      ? SYSTEM_MESSAGES.DEAL_WON_WITH_AMOUNT(amount, currency)
      : SYSTEM_MESSAGES.DEAL_WON;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE conversations SET won_at = NOW(), revenue_amount = $3, updated_at = NOW()
         WHERE id = $1 AND organization_id = $2`,
        [conversationId, organizationId, amount]
      );
      await client.query(
        `INSERT INTO messages (organization_id, bd_account_id, channel, channel_id, contact_id, direction, content, status, unread, metadata)
         VALUES ($1, $2, 'telegram', $3, $4, $5, $6, $7, false, $8)`,
        [
          organizationId,
          c.bd_account_id,
          c.channel_id,
          c.contact_id,
          MessageDirection.OUTBOUND,
          systemContent,
          MessageStatus.DELIVERED,
          JSON.stringify({ system: true, event: ConversationSystemEvent.DEAL_WON, revenue_amount: amount }),
        ]
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    dealsWonTotal.inc();
    res.json({
      conversation_id: conversationId,
      won_at: new Date().toISOString(),
      revenue_amount: amount,
    });
  }));

  router.post('/mark-lost', validate(MsgMarkLostSchema), asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { conversation_id: conversationId, reason } = req.body;
    const c = await getLeadConversationOrThrow<{
      id: string; bd_account_id: string; channel_id: string;
      contact_id: string | null; won_at: Date | null; lost_at: Date | null;
    }>(pool, conversationId, organizationId, 'id, bd_account_id, channel_id, contact_id, won_at, lost_at');
    if (c.won_at != null) {
      conflicts409Total.inc({ endpoint: 'mark-lost' });
      log.warn({ message: 'conflict_409 mark-lost already won', correlation_id: req.correlationId, endpoint: 'POST /mark-lost', conversationId, event: 'conflict_409' });
      throw new AppError(409, 'Deal already marked as won', ErrorCodes.CONFLICT);
    }
    if (c.lost_at != null) {
      conflicts409Total.inc({ endpoint: 'mark-lost' });
      log.warn({ message: 'conflict_409 mark-lost already lost', correlation_id: req.correlationId, endpoint: 'POST /mark-lost', conversationId, event: 'conflict_409' });
      throw new AppError(409, 'Deal already marked as lost', ErrorCodes.CONFLICT);
    }

    const lossReason = reason != null && typeof reason === 'string' ? reason.trim().slice(0, 2000) : null;
    const systemContent = lossReason
      ? SYSTEM_MESSAGES.DEAL_LOST_WITH_REASON(lossReason.slice(0, 500))
      : SYSTEM_MESSAGES.DEAL_LOST;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE conversations SET lost_at = NOW(), loss_reason = $3, updated_at = NOW()
         WHERE id = $1 AND organization_id = $2`,
        [conversationId, organizationId, lossReason]
      );
      await client.query(
        `INSERT INTO messages (organization_id, bd_account_id, channel, channel_id, contact_id, direction, content, status, unread, metadata)
         VALUES ($1, $2, 'telegram', $3, $4, $5, $6, $7, false, $8)`,
        [
          organizationId,
          c.bd_account_id,
          c.channel_id,
          c.contact_id,
          MessageDirection.OUTBOUND,
          systemContent,
          MessageStatus.DELIVERED,
          JSON.stringify({ system: true, event: ConversationSystemEvent.DEAL_LOST, reason: lossReason }),
        ]
      );
      await client.query('COMMIT');
    } catch (txErr) {
      await client.query('ROLLBACK').catch(() => {});
      throw txErr;
    } finally {
      client.release();
    }

    res.json({
      conversation_id: conversationId,
      lost_at: new Date().toISOString(),
      loss_reason: lossReason,
    });
  }));

  return router;
}
