import { FastifyInstance } from 'fastify';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { EventType, type Event } from '@getsale/events';
import { AppError, ErrorCodes, requireUser, DatabasePools } from '@getsale/service-framework';
import { RabbitMQClient, JobQueue } from '@getsale/queue';
import { RedisClient } from '@getsale/cache';
import { Logger } from '@getsale/logger';
import { recalculatePendingForCampaignsUsingBdAccount } from '../spam-flood-handlers';
import { type CampaignJobData } from '../scheduler';

interface Deps {
  db: DatabasePools;
  rabbitmq: RabbitMQClient;
  log: Logger;
  redis?: RedisClient;
  jobQueue?: JobQueue<CampaignJobData>;
}

function getBdAccountIdsFromTargetAudience(aud: unknown): string[] {
  if (!aud || typeof aud !== 'object') return [];
  const a = aud as { bdAccountIds?: unknown; bdAccountId?: unknown };
  if (Array.isArray(a.bdAccountIds) && a.bdAccountIds.length > 0) {
    return a.bdAccountIds.filter((id): id is string => typeof id === 'string');
  }
  if (typeof a.bdAccountId === 'string' && a.bdAccountId) return [a.bdAccountId];
  return [];
}

function canManageCampaignLifecycle(
  role: string | undefined,
  userId: string | undefined,
  createdByUserId: string | null,
): boolean {
  const r = (role || '').toLowerCase();
  if (r === 'owner' || r === 'admin') return true;
  return createdByUserId != null && userId != null && createdByUserId === userId;
}

const AddParticipantsSchema = z.object({
  contactIds: z.array(z.string().uuid()).min(1).max(2000),
});

export function registerExecutionRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, rabbitmq, log } = deps;

  app.post('/api/campaigns/:id/accounts/:accountId/pause', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id: campaignId, accountId } = request.params as { id: string; accountId: string };

    const camp = await db.read.query(
      'SELECT id, target_audience FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [campaignId, user.organizationId],
    );
    if (!camp.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const bdIds = getBdAccountIdsFromTargetAudience(camp.rows[0].target_audience);
    if (!bdIds.includes(accountId)) {
      throw new AppError(400, 'BD account is not part of this campaign audience', ErrorCodes.BAD_REQUEST);
    }

    const acc = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [accountId, user.organizationId],
    );
    if (!acc.rows.length) throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);

    const until = new Date(Date.now() + 2 * 3600 * 1000);
    await db.write.query(
      'UPDATE bd_accounts SET send_blocked_until = $1, updated_at = NOW() WHERE id = $2 AND organization_id = $3',
      [until.toISOString(), accountId, user.organizationId],
    );
    await db.write.query(
      `UPDATE campaign_participants
       SET next_send_at = CASE
         WHEN next_send_at IS NULL THEN NULL
         ELSE GREATEST(next_send_at::timestamptz, $3::timestamptz)
       END,
       metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('campaignAccountPausedUntil', $3::text),
       updated_at = NOW()
       WHERE campaign_id = $1 AND bd_account_id = $2 AND status IN ('pending', 'sent')`,
      [campaignId, accountId, until.toISOString()],
    );

    return { ok: true, sendBlockedUntil: until.toISOString() };
  });

  app.post('/api/campaigns/:id/accounts/:accountId/resume', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id: campaignId, accountId } = request.params as { id: string; accountId: string };

    const camp = await db.read.query(
      'SELECT id, target_audience FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [campaignId, user.organizationId],
    );
    if (!camp.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const bdIds = getBdAccountIdsFromTargetAudience(camp.rows[0].target_audience);
    if (!bdIds.includes(accountId)) {
      throw new AppError(400, 'BD account is not part of this campaign audience', ErrorCodes.BAD_REQUEST);
    }

    await db.write.query(
      'UPDATE bd_accounts SET send_blocked_until = NULL, spam_restricted_at = NULL, spam_check_retry_count = 0, spam_restriction_source = NULL, updated_at = NOW() WHERE id = $1 AND organization_id = $2',
      [accountId, user.organizationId],
    );

    if (deps.redis && deps.jobQueue) {
      recalculatePendingForCampaignsUsingBdAccount(db.write, log, deps.redis, deps.jobQueue, accountId).catch((e) => {
        log.warn({ message: 'recalculatePending after resume failed', error: String(e) });
      });
    }

    return { ok: true };
  });

  app.delete('/api/campaigns/:id/accounts/:accountId', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id: campaignId, accountId } = request.params as { id: string; accountId: string };

    const camp = await db.read.query(
      'SELECT id, target_audience, schedule FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [campaignId, user.organizationId],
    );
    if (!camp.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const row = camp.rows[0] as { target_audience: Record<string, unknown>; schedule: unknown };
    const bdIds = getBdAccountIdsFromTargetAudience(row.target_audience);
    if (!bdIds.includes(accountId)) {
      throw new AppError(400, 'BD account is not part of this campaign audience', ErrorCodes.BAD_REQUEST);
    }
    if (bdIds.length <= 1) {
      throw new AppError(400, 'Cannot remove the only sending account. Add another account first or pause the campaign.', ErrorCodes.BAD_REQUEST);
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

    await db.write.query(
      'UPDATE campaigns SET target_audience = $1::jsonb, updated_at = NOW() WHERE id = $2 AND organization_id = $3',
      [JSON.stringify(nextAudience), campaignId, user.organizationId],
    );

    const parts = await db.read.query(
      'SELECT id FROM campaign_participants WHERE campaign_id = $1 AND bd_account_id = $2',
      [campaignId, accountId],
    );
    let reassign = 0;
    for (let i = 0; i < parts.rows.length; i++) {
      const pid = (parts.rows[i] as { id: string }).id;
      const newBd = remaining[i % remaining.length];
      const r = await db.write.query(
        'UPDATE campaign_participants SET bd_account_id = $1, updated_at = NOW() WHERE id = $2 AND campaign_id = $3',
        [newBd, pid, campaignId],
      );
      reassign += r.rowCount ?? 0;
    }

    return { ok: true, reassignedParticipants: reassign, remainingBdAccountIds: remaining };
  });

  app.post('/api/campaigns/:id/participants/add', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };
    const { contactIds } = AddParticipantsSchema.parse(request.body);

    const campaignRes = await db.read.query(
      'SELECT * FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, user.organizationId],
    );
    if (!campaignRes.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const campaign = campaignRes.rows[0] as { status: string; target_audience: Record<string, unknown> | null };
    const validStatuses = ['draft', 'paused', 'active', 'completed'];
    if (!validStatuses.includes(campaign.status)) {
      throw new AppError(400, 'Cannot add participants to this campaign status', ErrorCodes.BAD_REQUEST);
    }

    const seqRes = await db.read.query('SELECT 1 FROM campaign_sequences WHERE campaign_id = $1 LIMIT 1', [id]);
    if (!seqRes.rows.length) {
      throw new AppError(400, 'Add at least one sequence step first', ErrorCodes.BAD_REQUEST);
    }

    const audience = (campaign.target_audience || {}) as Record<string, unknown>;
    const bdAccountId = (audience.bdAccountId as string) || ((audience.bdAccountIds as string[]) ?? [])[0] || null;

    const contactsResult = await db.read.query(
      `SELECT c.id as contact_id, c.telegram_id, c.username
       FROM contacts c
       WHERE c.organization_id = $1
       AND c.id = ANY($2::uuid[])
       AND (
         (c.telegram_id IS NOT NULL AND TRIM(c.telegram_id) != '')
         OR (c.username IS NOT NULL AND TRIM(c.username) != '')
       )`,
      [user.organizationId, contactIds],
    );

    const ordRow = await db.read.query(
      'SELECT COALESCE(MAX(enqueue_order), -1) + 1 AS n FROM campaign_participants WHERE campaign_id = $1',
      [id],
    );
    let enqueueOrder = Number((ordRow.rows[0] as { n?: number })?.n ?? 0);

    let inserted = 0;
    for (const contact of contactsResult.rows as { contact_id: string }[]) {
      const r = await db.write.query(
        `INSERT INTO campaign_participants (id, campaign_id, contact_id, bd_account_id, status, enqueue_order, created_at, updated_at)
         VALUES ($1, $2, $3, $4, 'pending', $5, NOW(), NOW())
         ON CONFLICT (campaign_id, contact_id) DO NOTHING`,
        [randomUUID(), id, contact.contact_id, bdAccountId, enqueueOrder++],
      );
      inserted += r.rowCount ?? 0;
    }

    return {
      inserted,
      requested: contactIds.length,
      eligibleWithTelegram: contactsResult.rows.length,
      campaignStatus: campaign.status as string,
    };
  });

  app.post('/api/campaigns/:id/duplicate', { preHandler: [requireUser] }, async (request, reply) => {
    const user = request.user!;
    const { id: sourceId } = request.params as { id: string };

    const srcRes = await db.read.query(
      'SELECT * FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [sourceId, user.organizationId],
    );
    if (!srcRes.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const src = srcRes.rows[0] as {
      company_id: string | null;
      pipeline_id: string | null;
      name: string;
      target_audience: unknown;
      schedule: unknown;
      lead_creation_settings: unknown;
      created_by_user_id: string | null;
    };

    if (!canManageCampaignLifecycle(user.role, user.id, src.created_by_user_id)) {
      throw new AppError(403, 'Insufficient permissions', ErrorCodes.FORBIDDEN);
    }

    const newId = randomUUID();
    const rawName = `Copy of ${src.name}`;
    const newName = rawName.length > 255 ? `${rawName.slice(0, 252)}...` : rawName;

    // Strip contactIds from target_audience — participants are now stored in campaign_participants
    let cleanedAudience = src.target_audience;
    if (cleanedAudience && typeof cleanedAudience === 'object') {
      const aud = { ...(cleanedAudience as Record<string, unknown>) };
      delete aud.contactIds;
      cleanedAudience = aud;
    }

    const client = await db.write.connect();
    try {
      await client.query('BEGIN');

      await client.query(
        `INSERT INTO campaigns (id, organization_id, company_id, pipeline_id, name, status, target_audience, schedule, lead_creation_settings, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9)`,
        [newId, user.organizationId, src.company_id, src.pipeline_id, newName, JSON.stringify(cleanedAudience), src.schedule, src.lead_creation_settings, user.id],
      );

      const tmpls = await client.query(
        'SELECT * FROM campaign_templates WHERE campaign_id = $1 ORDER BY created_at ASC',
        [sourceId],
      );
      const idMap = new Map<string, string>();
      for (const t of tmpls.rows as Record<string, unknown>[]) {
        const nid = randomUUID();
        idMap.set(String(t.id), nid);
        await client.query(
          `INSERT INTO campaign_templates (id, organization_id, campaign_id, name, channel, content, conditions, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())`,
          [nid, user.organizationId, newId, t.name, t.channel, t.content, t.conditions ?? {}],
        );
      }

      const seqs = await client.query(
        'SELECT * FROM campaign_sequences WHERE campaign_id = $1 ORDER BY order_index ASC',
        [sourceId],
      );
      for (const s of seqs.rows as Record<string, unknown>[]) {
        const tid = idMap.get(String(s.template_id));
        if (!tid) continue;
        await client.query(
          `INSERT INTO campaign_sequences (id, campaign_id, order_index, template_id, delay_hours, delay_minutes, conditions, trigger_type, is_hidden, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW(), NOW())`,
          [randomUUID(), newId, s.order_index, tid, s.delay_hours, s.delay_minutes ?? 0, s.conditions ?? {}, s.trigger_type ?? 'delay', s.is_hidden ?? false],
        );
      }

      // Copy campaign_participants from source to new campaign (reset runtime state)
      await client.query(
        `INSERT INTO campaign_participants (id, campaign_id, contact_id, bd_account_id, status, enqueue_order, created_at, updated_at)
         SELECT gen_random_uuid(), $1, contact_id, bd_account_id, 'pending', enqueue_order, NOW(), NOW()
         FROM campaign_participants
         WHERE campaign_id = $2`,
        [newId, sourceId],
      );

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const out = await db.read.query('SELECT * FROM campaigns WHERE id = $1', [newId]);
    reply.code(201);
    return out.rows[0];
  });

  app.delete('/api/campaigns/:id/participants/:contactId', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id, contactId } = request.params as { id: string; contactId: string };

    const camp = await db.read.query(
      'SELECT id, status FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, user.organizationId],
    );
    if (!camp.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const status = (camp.rows[0] as { status: string }).status;
    if (status !== 'draft' && status !== 'paused') {
      throw new AppError(400, 'Can only remove participants from draft or paused campaigns', ErrorCodes.BAD_REQUEST);
    }

    const result = await db.write.query(
      'DELETE FROM campaign_participants WHERE campaign_id = $1 AND contact_id = $2',
      [id, contactId],
    );
    return { deleted: result.rowCount ?? 0 };
  });

  app.delete('/api/campaigns/:id/participants', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const camp = await db.read.query(
      'SELECT id, status FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, user.organizationId],
    );
    if (!camp.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const status = (camp.rows[0] as { status: string }).status;
    if (status !== 'draft' && status !== 'paused') {
      throw new AppError(400, 'Can only remove participants from draft or paused campaigns', ErrorCodes.BAD_REQUEST);
    }

    const result = await db.write.query(
      'DELETE FROM campaign_participants WHERE campaign_id = $1',
      [id],
    );
    return { deleted: result.rowCount ?? 0 };
  });

  app.post('/api/campaigns/:id/reset-progress', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;
    const { id } = request.params as { id: string };

    const srcRes = await db.read.query(
      'SELECT id, created_by_user_id FROM campaigns WHERE id = $1 AND organization_id = $2 AND deleted_at IS NULL',
      [id, user.organizationId],
    );
    if (!srcRes.rows.length) throw new AppError(404, 'Campaign not found', ErrorCodes.NOT_FOUND);

    const createdBy = (srcRes.rows[0] as { created_by_user_id: string | null }).created_by_user_id;
    if (!canManageCampaignLifecycle(user.role, user.id, createdBy)) {
      throw new AppError(403, 'Insufficient permissions', ErrorCodes.FORBIDDEN);
    }

    const client = await db.write.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM campaign_participants WHERE campaign_id = $1', [id]);
      await client.query(
        "UPDATE campaigns SET status = 'draft', updated_at = NOW() WHERE id = $1 AND organization_id = $2",
        [id, user.organizationId],
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    const out = await db.read.query('SELECT * FROM campaigns WHERE id = $1', [id]);
    return out.rows[0];
  });
}
