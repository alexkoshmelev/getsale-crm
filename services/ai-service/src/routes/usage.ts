import { FastifyInstance } from 'fastify';
import { Logger } from '@getsale/logger';
import { requireUser } from '@getsale/service-framework';
import { AIRateLimiter } from '../rate-limiter';

interface Deps {
  log: Logger;
  rateLimiter: AIRateLimiter;
}

export function registerUsageRoutes(app: FastifyInstance, { rateLimiter }: Deps): void {
  app.get(
    '/api/ai/usage',
    { preHandler: [requireUser] },
    async (request) => {
      const { organizationId } = request.user!;
      return rateLimiter.getUsage(organizationId);
    },
  );
}
