import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError, ErrorCodes, requireUser, DatabasePools } from '@getsale/service-framework';
import { RedisClient } from '@getsale/cache';
import { RabbitMQClient } from '@getsale/queue';
import { Logger } from '@getsale/logger';
import { SessionCoordinator } from '../coordinator';
import { CommandType } from '../command-types';

interface Deps {
  db: DatabasePools;
  rabbitmq: RabbitMQClient;
  log: Logger;
  redis: RedisClient;
  coordinator: SessionCoordinator;
}

const PatchAccountBody = z.object({
  display_name: z.string().max(200).optional(),
  proxy_config: z
    .union([
      z.null(),
      z.object({
        type: z.enum(['socks5']).default('socks5'),
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535),
        username: z.string().optional(),
        password: z.string().optional(),
      }),
    ])
    .optional(),
  timezone: z.string().max(100).nullable().optional(),
  working_hours_start: z.string().max(10).nullable().optional(),
  working_hours_end: z.string().max(10).nullable().optional(),
  working_days: z.array(z.number().int().min(0).max(6)).nullable().optional(),
  auto_responder_enabled: z.boolean().optional(),
  auto_responder_system_prompt: z.string().max(4000).nullable().optional(),
  auto_responder_history_count: z.number().int().min(1).max(100).optional(),
});

function assertNotViewer(user: { role: string }): void {
  if (user.role === 'viewer') {
    throw new AppError(403, 'Viewers cannot perform this action', ErrorCodes.FORBIDDEN);
  }
}

export function registerAccountRoutes(app: FastifyInstance, deps: Deps): void {
  const { db, log, rabbitmq } = deps;

  /**
   * GET /api/bd-accounts/health-summary
   * Aggregate health stats for the organization's BD accounts.
   */
  app.get('/api/bd-accounts/health-summary', { preHandler: [requireUser] }, async (request) => {
    const user = request.user!;

    const [floodR, spamR, campR, riskR] = await Promise.all([
      db.read.query(
        `SELECT COUNT(*)::int AS c FROM bd_accounts
         WHERE organization_id = $1 AND flood_wait_until IS NOT NULL AND flood_wait_until > NOW()`,
        [user.organizationId],
      ),
      db.read.query(
        `SELECT COUNT(*)::int AS c FROM bd_accounts
         WHERE organization_id = $1 AND spam_restricted_at IS NOT NULL`,
        [user.organizationId],
      ),
      db.read.query(
        `SELECT status, COUNT(*)::int AS c FROM campaigns WHERE organization_id = $1 GROUP BY status`,
        [user.organizationId],
      ).catch(() => ({ rows: [] as { status: string; c: number }[] })),
      db.read.query(
        `SELECT a.id, a.telegram_id, a.display_name, a.connection_state,
                a.flood_wait_until, a.spam_restricted_at, a.peer_flood_count_1h
         FROM bd_accounts a
         WHERE a.organization_id = $1
           AND (
             (a.flood_wait_until IS NOT NULL AND a.flood_wait_until > NOW())
             OR a.spam_restricted_at IS NOT NULL
             OR (a.connection_state IS NOT NULL AND a.connection_state <> 'connected')
           )
         ORDER BY a.created_at DESC
         LIMIT 50`,
        [user.organizationId],
      ),
    ]);

    const campaignCounts: Record<string, number> = {};
    for (const row of campR.rows as { status: string; c: number }[]) {
      campaignCounts[row.status] = row.c;
    }

    return {
      generatedAt: new Date().toISOString(),
      floodActiveCount: Number((floodR.rows[0] as { c?: number })?.c ?? 0),
      spamRestrictedCount: Number((spamR.rows[0] as { c?: number })?.c ?? 0),
      campaigns: {
        active: campaignCounts.active ?? 0,
        paused: campaignCounts.paused ?? 0,
        draft: campaignCounts.draft ?? 0,
        completed: campaignCounts.completed ?? 0,
      },
      riskAccounts: riskR.rows,
    };
  });

  /**
   * GET /api/bd-accounts/:id/status
   * Single account status with connection info.
   */
  app.get('/api/bd-accounts/:id/status', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;

    const result = await db.read.query(
      `SELECT a.id, a.phone_number, a.telegram_id, a.is_active, a.connection_state,
              a.spam_restricted_at, a.peer_flood_count_1h, a.flood_wait_until,
              a.sync_status, a.sync_error, a.last_activity, a.display_name, a.username
       FROM bd_accounts a
       WHERE a.id = $1 AND a.organization_id = $2`,
      [id, user.organizationId],
    );
    if (!result.rows.length) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    return result.rows[0];
  });

  /**
   * POST /api/bd-accounts/:id/enable
   * Re-enable a disconnected account (set is_active=true, trigger reconnect via RabbitMQ).
   */
  app.post('/api/bd-accounts/:id/enable', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    assertNotViewer(user);

    const accountResult = await db.read.query(
      `SELECT id, connection_state, session_string IS NOT NULL AS has_session
       FROM bd_accounts WHERE id = $1 AND organization_id = $2`,
      [id, user.organizationId],
    );
    if (!accountResult.rows.length) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    const account = accountResult.rows[0] as { connection_state?: string; has_session: boolean };
    if (account.connection_state === 'reauth_required') {
      throw new AppError(409, 'Session expired. Please reconnect via QR or phone login.', ErrorCodes.BAD_REQUEST);
    }
    if (!account.has_session) {
      throw new AppError(400, 'Account has no session; reconnect via QR or phone', ErrorCodes.BAD_REQUEST);
    }

    await db.write.query(
      "UPDATE bd_accounts SET is_active = true, connection_state = 'reconnecting', updated_at = NOW() WHERE id = $1 AND organization_id = $2",
      [id, user.organizationId],
    );

    await rabbitmq.publishCommand(`telegram:commands:${id}`, {
      type: CommandType.RECONNECT,
      payload: { accountId: id, organizationId: user.organizationId },
    });

    return { success: true };
  });

  /**
   * PATCH /api/bd-accounts/:id
   * Partial update of display_name, proxy_config, schedule settings, auto-responder.
   */
  app.patch('/api/bd-accounts/:id', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    assertNotViewer(user);
    const body = PatchAccountBody.parse(request.body);

    const exists = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!exists.rows.length) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    let idx = 1;

    if (body.display_name !== undefined) {
      sets.push(`display_name = $${idx++}`);
      params.push(typeof body.display_name === 'string' ? body.display_name.trim() || null : null);
    }
    if (body.proxy_config !== undefined) {
      sets.push(`proxy_config = $${idx++}`);
      params.push(body.proxy_config ? JSON.stringify(body.proxy_config) : null);
    }
    if (body.timezone !== undefined) {
      sets.push(`timezone = $${idx++}`);
      params.push(body.timezone === null || body.timezone === '' ? null : String(body.timezone).trim());
    }
    if (body.working_hours_start !== undefined) {
      sets.push(`working_hours_start = $${idx++}`);
      params.push(body.working_hours_start ?? null);
    }
    if (body.working_hours_end !== undefined) {
      sets.push(`working_hours_end = $${idx++}`);
      params.push(body.working_hours_end ?? null);
    }
    if (body.working_days !== undefined) {
      sets.push(`working_days = $${idx++}`);
      params.push(body.working_days);
    }
    if (body.auto_responder_enabled !== undefined) {
      sets.push(`auto_responder_enabled = $${idx++}`);
      params.push(body.auto_responder_enabled);
    }
    if (body.auto_responder_system_prompt !== undefined) {
      sets.push(`auto_responder_system_prompt = $${idx++}`);
      params.push(body.auto_responder_system_prompt ?? null);
    }
    if (body.auto_responder_history_count !== undefined) {
      sets.push(`auto_responder_history_count = $${idx++}`);
      params.push(body.auto_responder_history_count);
    }

    if (sets.length === 0) {
      const row = await db.read.query(
        'SELECT id, phone_number, telegram_id, display_name, is_active, connection_state, proxy_config FROM bd_accounts WHERE id = $1 AND organization_id = $2',
        [id, user.organizationId],
      );
      return row.rows[0];
    }

    sets.push('updated_at = NOW()');
    params.push(id, user.organizationId);

    await db.write.query(
      `UPDATE bd_accounts SET ${sets.join(', ')} WHERE id = $${idx} AND organization_id = $${idx + 1}`,
      params,
    );

    const updated = await db.read.query(
      'SELECT id, phone_number, telegram_id, display_name, is_active, connection_state, proxy_config, timezone, working_hours_start, working_hours_end, working_days, auto_responder_enabled, auto_responder_system_prompt, auto_responder_history_count FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    return updated.rows[0];
  });

  /**
   * POST /api/bd-accounts/:id/spambot-check
   * Trigger a @SpamBot check for this account.
   * Publishes command to RabbitMQ for the actor to execute via GramJS.
   */
  app.post('/api/bd-accounts/:id/spambot-check', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    assertNotViewer(user);

    const account = await db.read.query(
      'SELECT id, connection_state FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!account.rows.length) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    await rabbitmq.publishCommand(`telegram:commands:${id}`, {
      type: CommandType.SPAMBOT_CHECK,
      payload: { accountId: id, organizationId: user.organizationId },
    });

    return { status: 'check_queued', accountId: id };
  });

  /**
   * POST /api/bd-accounts/:id/spam-clear
   * Clear spam restriction status for an account after user resolved it in Telegram.
   */
  app.post('/api/bd-accounts/:id/spam-clear', { preHandler: [requireUser] }, async (request) => {
    const { id } = request.params as { id: string };
    const user = request.user!;
    assertNotViewer(user);

    const account = await db.read.query(
      'SELECT id FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    if (!account.rows.length) {
      throw new AppError(404, 'BD account not found', ErrorCodes.NOT_FOUND);
    }

    await db.write.query(
      `UPDATE bd_accounts
       SET spam_restricted_at = NULL, spam_restriction_source = NULL,
           peer_flood_count_1h = 0, peer_flood_first_at = NULL,
           send_blocked_until = NULL, updated_at = NOW()
       WHERE id = $1 AND organization_id = $2`,
      [id, user.organizationId],
    );

    const updated = await db.read.query(
      'SELECT id, phone_number, telegram_id, display_name, is_active, connection_state, spam_restricted_at, peer_flood_count_1h FROM bd_accounts WHERE id = $1 AND organization_id = $2',
      [id, user.organizationId],
    );
    return updated.rows[0];
  });
}
