import './types'; // Augment Express Request
import express from 'express';
import cookieParser from 'cookie-parser';
import { createLogger } from '@getsale/logger';
import { RedisClient } from '@getsale/utils';
import { UserRole } from '@getsale/types';
import {
  PORT,
  REDIS_URL,
  CORRELATION_HEADER,
} from './config';
import { corsMiddleware, correlationIdMiddleware } from './cors';
import { createAuthenticate, requireRole } from './auth';
import { createRateLimit } from './rate-limit';
import { addCorrelationToResponse } from './proxy-helpers';
import { createProxies } from './proxies';
import { setupRedisSubscriber, createSseRoute, closeSseConnections } from './sse';

const log = createLogger('api-gateway');
const redis = new RedisClient(REDIS_URL);

setupRedisSubscriber(log);

const app = express();

app.use(corsMiddleware);
app.use(correlationIdMiddleware);

app.use((req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  express.json()(req, res, next);
});

app.get('/health', (req, res) => {
  addCorrelationToResponse(res, req);
  res.json({ status: 'ok', service: 'api-gateway' });
});

app.use(cookieParser());

const authenticate = createAuthenticate(log);
const rateLimit = createRateLimit(redis);
const proxies = createProxies(log);

const sseRoute = createSseRoute(log);
app.get('/api/events/stream', authenticate, (req, res) => {
  addCorrelationToResponse(res, req);
  sseRoute(req, res);
});

app.use('/api/auth', proxies.authProxy);
app.use('/api/invite', (req, res, next) => {
  if (req.method === 'GET') return proxies.inviteProxy(req, res, next);
  return authenticate(req, res, next);
}, proxies.inviteProxy);

app.use('/api/crm', authenticate, rateLimit, proxies.crmProxy);
app.use('/api/messaging', authenticate, rateLimit, proxies.messagingProxy);
app.use('/api/ai', authenticate, rateLimit, proxies.aiProxy);
app.use('/api/users', authenticate, rateLimit, proxies.userProxy);
app.use('/api/bd-accounts', authenticate, rateLimit, proxies.bdAccountsProxy);
app.use('/api/pipeline', authenticate, rateLimit, proxies.pipelineProxy);
app.use('/api/automation', authenticate, rateLimit, proxies.automationProxy);
app.use('/api/analytics', authenticate, rateLimit, proxies.analyticsProxy);
app.use('/api/activity', authenticate, rateLimit, proxies.activityProxy);
app.use('/api/team', authenticate, rateLimit, proxies.teamProxy);
app.use('/api/campaigns', authenticate, rateLimit, proxies.campaignProxy);

const adminRouter = express.Router();
adminRouter.all('*', (_req, res) => {
  res.status(501).json({ error: 'Admin API is not implemented', code: 'NOT_IMPLEMENTED' });
});
app.use('/api/admin', authenticate, requireRole(UserRole.OWNER, UserRole.ADMIN), rateLimit, adminRouter);

const server = app.listen(PORT, () => {
  log.info({ message: 'API Gateway running', port: PORT });
});

async function shutdown(): Promise<void> {
  log.info({ message: 'API Gateway shutting down gracefully' });
  server.close(() => {
    closeSseConnections()
      .then(() => {
        redis.disconnect();
        process.exit(0);
      })
      .catch((err) => {
        log.error({ message: 'Error during SSE/Redis cleanup', error: String(err) });
        redis.disconnect();
        process.exit(1);
      });
  });
}

process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
