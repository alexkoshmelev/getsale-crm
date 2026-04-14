import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser, validate, type DatabasePools } from '@getsale/service-framework';
import { Logger } from '@getsale/logger';

interface Deps {
  db: DatabasePools;
  log: Logger;
}

const ProfileUpdateSchema = z.object({
  firstName: z.string().max(200).trim().optional().nullable(),
  lastName: z.string().max(200).trim().optional().nullable(),
  avatarUrl: z.string().max(2000).trim().optional().nullable(),
  timezone: z.string().max(128).optional().nullable(),
  preferences: z.record(z.string(), z.unknown()).optional(),
});

export function registerProfileRoutes(app: FastifyInstance, { db, log }: Deps): void {
  app.get('/api/users/profile', { preHandler: [requireUser] }, async (request) => {
    const { id, organizationId } = request.user!;

    let result = await db.read.query('SELECT * FROM user_profiles WHERE user_id = $1', [id]);

    if (result.rows.length === 0) {
      log.info({ message: 'Creating default profile', user_id: id, correlation_id: request.correlationId });
      result = await db.write.query(
        `INSERT INTO user_profiles (user_id, organization_id, first_name, last_name, preferences)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING *`,
        [id, organizationId, null, null, JSON.stringify({})],
      );
    }

    return result.rows[0];
  });

  app.put('/api/users/profile', { preHandler: [requireUser, validate(ProfileUpdateSchema)] }, async (request) => {
    const { id, organizationId } = request.user!;
    const { firstName, lastName, avatarUrl, timezone, preferences } = request.body as z.infer<typeof ProfileUpdateSchema>;

    const result = await db.write.query(
      `INSERT INTO user_profiles (user_id, organization_id, first_name, last_name, avatar_url, timezone, preferences)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (user_id)
       DO UPDATE SET
         first_name = EXCLUDED.first_name,
         last_name = EXCLUDED.last_name,
         avatar_url = EXCLUDED.avatar_url,
         timezone = EXCLUDED.timezone,
         preferences = EXCLUDED.preferences,
         updated_at = NOW()
       RETURNING *`,
      [id, organizationId, firstName, lastName, avatarUrl, timezone, JSON.stringify(preferences || {})],
    );

    return result.rows[0];
  });
}
