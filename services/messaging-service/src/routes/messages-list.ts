import { Router } from 'express';
import { asyncHandler, AppError, ErrorCodes, canPermission, parsePageLimit, buildPagedResponse } from '@getsale/service-core';
import {
  buildMessagesListWhere,
  runMessagesCount,
  runMessagesListQuery,
  getHistoryExhausted,
  maybeLoadInitialHistory,
  maybeLoadOlderHistoryAndGetTotal,
  enrichMessagesWithSenderNames,
} from '../messages-list-helpers';
import type { MessageRow } from '../types';
import type { MessagesRouterDeps } from './messages-deps';

export function registerListRoutes(router: Router, deps: MessagesRouterDeps): void {
  const { pool, log, bdAccountsClient } = deps;

  router.get('/inbox', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const result = await pool.query(
      `SELECT m.*, c.first_name, c.last_name, c.email
       FROM messages m
       LEFT JOIN contacts c ON m.contact_id = c.id
       WHERE m.organization_id = $1 AND m.unread = true
       ORDER BY m.created_at DESC`,
      [organizationId]
    );
    res.json(result.rows);
  }));

  router.get('/messages', asyncHandler(async (req, res) => {
    const { id: userId, organizationId } = req.user;
    const { contactId, channel, channelId, bdAccountId, page: pageQ, limit: limitQ } = req.query;

    const { page: pageNum, limit: limitNum, offset } = parsePageLimit(
      { page: pageQ ?? 1, limit: limitQ ?? 50 } as Record<string, unknown>,
      50,
      100
    );
    const bdId = bdAccountId && String(bdAccountId).trim() ? String(bdAccountId).trim() : null;
    const chId = channelId && String(channelId).trim() ? String(channelId).trim() : null;

    const filters: Parameters<typeof buildMessagesListWhere>[0] = {
      organizationId,
      contactId: contactId ? String(contactId) : null,
      channel: channel ? String(channel) : null,
      channelId: chId,
      bdAccountId: bdId,
    };
    const where = buildMessagesListWhere(filters);

    const apiOpts = bdId && organizationId ? { bdAccountsClient, organizationId } : undefined;
    if (bdId && chId && channel === 'telegram' && pageNum === 1) {
      const totalForChat = await runMessagesCount(pool, where);
      if (totalForChat === 0) {
        const exhausted = await getHistoryExhausted(pool, bdId, chId, apiOpts);
        if (!exhausted) {
          await maybeLoadInitialHistory(bdAccountsClient, bdId, chId, userId || '', organizationId || '', log);
        }
      }
    }

    let total = await runMessagesCount(pool, where);
    if (bdId && chId && channel === 'telegram' && pageNum > 1) {
      const needOffset = (pageNum - 1) * limitNum;
      total = await maybeLoadOlderHistoryAndGetTotal(
        pool,
        bdAccountsClient,
        where,
        bdId,
        chId,
        String(channel || 'telegram'),
        userId || '',
        organizationId || '',
        total,
        needOffset,
        log
      );
    }

    let rows = await runMessagesListQuery(pool, where, limitNum, offset);

    if (bdId && chId && rows.length > 0) {
      rows = await enrichMessagesWithSenderNames(pool, rows, bdId, chId, apiOpts);
    }

    let historyExhausted: boolean | undefined;
    if (bdId && chId) {
      historyExhausted = await getHistoryExhausted(pool, bdId, chId, apiOpts);
    }

    const paged = buildPagedResponse(rows, total, pageNum, limitNum);
    const payload: {
      messages: MessageRow[];
      pagination: { page: number; limit: number; total: number; totalPages: number };
      historyExhausted?: boolean;
    } = {
      messages: paged.items,
      pagination: paged.pagination,
    };
    if (historyExhausted !== undefined) payload.historyExhausted = historyExhausted;
    res.json(payload);
  }));

  router.get('/messages/:id', asyncHandler(async (req, res) => {
    const { organizationId } = req.user;
    const { id } = req.params;

    const result = await pool.query(
      'SELECT * FROM messages WHERE id = $1 AND organization_id = $2',
      [id, organizationId]
    );
    if (result.rows.length === 0) {
      throw new AppError(404, 'Message not found', ErrorCodes.NOT_FOUND);
    }
    res.json(result.rows[0]);
  }));
}
