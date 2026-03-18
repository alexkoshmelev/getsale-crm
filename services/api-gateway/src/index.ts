import './types'; // Augment Express Request
import express from 'express';
import helmet from 'helmet';
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
import { createRateLimit, createWebhookRateLimit, createInviteRateLimit } from './rate-limit';
import { addCorrelationToResponse } from './proxy-helpers';
import { createProxies } from './proxies';

const log = createLogger('api-gateway');
const redis = new RedisClient(REDIS_URL);

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'", "https:", "wss:"],
      fontSrc: ["'self'"],
      frameAncestors: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));
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

app.get('/ready', async (req, res) => {
  addCorrelationToResponse(res, req);
  try {
    await redis.ping();
    res.json({ ready: true, service: 'api-gateway', checks: { redis: 'ok' } });
  } catch {
    res.status(503).json({ ready: false, service: 'api-gateway', checks: { redis: 'error' } });
  }
});

app.use(cookieParser());

const authenticate = createAuthenticate(log);
const rateLimit = createRateLimit(redis);
const webhookRateLimit = createWebhookRateLimit(redis);
const inviteRateLimit = createInviteRateLimit(redis);
const proxies = createProxies(log);

app.use('/api/auth', proxies.authProxy);
app.use('/api/invite', inviteRateLimit, (req, res, next) => {
  if (req.method === 'GET') return proxies.inviteProxy(req, res, next);
  return authenticate(req, res, next);
}, proxies.inviteProxy);

app.use('/api/crm', authenticate, rateLimit, proxies.crmProxy);
app.use('/api/messaging', authenticate, rateLimit, proxies.messagingProxy);
app.use('/api/ai', authenticate, rateLimit, proxies.aiProxy);
app.use('/api/users/stripe-webhook', webhookRateLimit, proxies.stripeWebhookProxy);
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

// Long proxy responses (e.g. dialogs-by-folders?refresh=1) can take 3–5+ min; Node default headersTimeout is 60s
server.headersTimeout = 330_000; // 5.5 min
server.requestTimeout = 330_000; // 5.5 min

async function shutdown(): Promise<void> {
  log.info({ message: 'API Gateway shutting down gracefully' });
  server.close(() => {
    redis.disconnect();
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown());
process.on('SIGINT', () => shutdown());
