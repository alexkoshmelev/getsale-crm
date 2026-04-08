import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import cookie from '@fastify/cookie';
import rateLimit from '@fastify/rate-limit';
import proxy from '@fastify/http-proxy';
import replyFrom from '@fastify/reply-from';
import Redis from 'ioredis';
import { Registry, Counter, Histogram, collectDefaultMetrics } from 'prom-client';
import { createLogger } from '@getsale/logger';
import { RedisClient } from '@getsale/cache';
import {
  PORT,
  REDIS_URL,
  INTERNAL_AUTH_SECRET,
  allowedOrigins,
  serviceUrls,
  RATE_LIMIT_GLOBAL_PER_SEC,
  RATE_LIMIT_AUTH_ROUTES,
  RATE_LIMIT_AUTH,
  RATE_LIMIT_ANON,
  RATE_LIMIT_WINDOW_MS,
} from './config';
import { authenticate } from './auth';

interface GatewayUser {
  id: string;
  organizationId: string;
  role: string;
}

const log = createLogger('gateway-v2');
const redis = new RedisClient({ url: REDIS_URL });
const rateLimitRedis = new Redis(REDIS_URL);

const SLIDING_WINDOW_LUA = `
  local key = KEYS[1]
  local now = tonumber(ARGV[1])
  local window = tonumber(ARGV[2])
  local limit = tonumber(ARGV[3])
  local member = ARGV[4]
  redis.call('ZREMRANGEBYSCORE', key, 0, now - window)
  local count = redis.call('ZCARD', key)
  if count >= limit then
    return 0
  end
  redis.call('ZADD', key, now, member)
  redis.call('PEXPIRE', key, window)
  return 1
`;

async function start() {
  const app = Fastify({
    logger: false,
    trustProxy: true,
    bodyLimit: 5 * 1024 * 1024,
    requestTimeout: 30_000,
    keepAliveTimeout: 72_000,
  });

  await app.register(cors, { origin: allowedOrigins, credentials: true });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cookie);

  await app.register(rateLimit, {
    global: true,
    max: RATE_LIMIT_GLOBAL_PER_SEC,
    timeWindow: 1000,
    redis: rateLimitRedis,
    keyGenerator: (request) => request.ip || 'unknown',
    addHeadersOnExceeding: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true },
    addHeaders: { 'x-ratelimit-limit': true, 'x-ratelimit-remaining': true, 'x-ratelimit-reset': true, 'retry-after': true },
  });

  app.decorateRequest('gatewayUser', null as unknown as GatewayUser | undefined);

  // --- Prometheus metrics ---
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request duration in seconds',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });

  const httpRequestsTotal = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });

  app.addHook('onResponse', (request, reply, done) => {
    const route = request.routeOptions?.url || request.url.split('?')[0] || 'unknown';
    const labels = {
      method: request.method,
      route,
      status: String(reply.statusCode),
    };
    httpRequestDuration.observe(labels, reply.elapsedTime / 1000);
    httpRequestsTotal.inc(labels);
    done();
  });

  // --- Health checks ---
  app.get('/health', async () => ({ status: 'ok', service: 'gateway-v2' }));
  app.get('/metrics', async (request, reply) => {
    reply.header('Content-Type', registry.contentType);
    return reply.send(await registry.metrics());
  });
  app.get('/ready', async (request, reply) => {
    try {
      await redis.ping();
      return { ready: true, service: 'gateway-v2', checks: { redis: 'ok' } };
    } catch {
      reply.code(503);
      return { ready: false, service: 'gateway-v2', checks: { redis: 'error' } };
    }
  });

  // --- Rate limit hook for auth mutation routes only (brute-force protection) ---
  const AUTH_MUTATION_PATHS = ['/api/auth/signin', '/api/auth/signup', '/api/auth/forgot-password', '/api/auth/reset-password', '/api/auth/verify-2fa'];

  async function authRateLimitHook(request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply): Promise<void> {
    const urlPath = request.url.split('?')[0] || '';
    const isMutation = AUTH_MUTATION_PATHS.some((p) => urlPath === p || urlPath.startsWith(p + '/'));
    if (!isMutation) return;

    const identifier = request.ip || 'unknown';
    const key = `rl:auth:${identifier}`;
    const now = Date.now();
    const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;

    const allowed = await redis.raw.eval(
      SLIDING_WINDOW_LUA, 1, key, String(now), String(RATE_LIMIT_WINDOW_MS), String(RATE_LIMIT_AUTH_ROUTES), member,
    ) as number;

    reply.header('X-RateLimit-Limit', String(RATE_LIMIT_AUTH_ROUTES));

    if (!allowed) {
      reply.code(429).send({ error: 'Too many requests' });
    }
  }

  // --- Rate limit hook for authenticated routes ---
  async function rateLimitHook(request: import('fastify').FastifyRequest, reply: import('fastify').FastifyReply): Promise<void> {
    const user = request.gatewayUser;
    const limit = user?.id ? RATE_LIMIT_AUTH : RATE_LIMIT_ANON;
    const identifier = user?.id || request.ip || 'unknown';
    const key = `rl:gw:${identifier}`;
    const now = Date.now();
    const member = `${now}:${Math.random().toString(36).slice(2, 8)}`;

    const allowed = await redis.raw.eval(
      SLIDING_WINDOW_LUA, 1, key, String(now), String(RATE_LIMIT_WINDOW_MS), String(limit), member,
    ) as number;

    reply.header('X-RateLimit-Limit', String(limit));

    if (!allowed) {
      reply.code(429).send({ error: 'Too many requests' });
    }
  }

  function addProxyHeaders(request: any, headers: Record<string, string>): Record<string, string> {
    if (INTERNAL_AUTH_SECRET) {
      headers['x-internal-auth'] = INTERNAL_AUTH_SECRET;
    }
    const user = request.gatewayUser;
    if (user) {
      headers['x-user-id'] = user.id;
      headers['x-organization-id'] = user.organizationId;
      headers['x-user-role'] = user.role;
    }
    const correlationId = (request.headers['x-correlation-id'] as string) || '';
    if (correlationId) {
      headers['x-correlation-id'] = correlationId;
    }
    return headers;
  }

  function rewriteHeaders(headers: Record<string, string>) {
    return headers;
  }

  // --- Auth routes (no auth required, strict brute-force rate limit) ---
  await app.register(proxy, {
    upstream: serviceUrls.auth,
    prefix: '/api/auth',
    rewritePrefix: '/api/auth',
    http: { agentOptions: { keepAlive: true } },
    preHandler: [authRateLimitHook] as any,
    replyOptions: { rewriteRequestHeaders: (req, headers) => addProxyHeaders(req, headers as Record<string, string>) },
  });

  await app.register(proxy, {
    upstream: serviceUrls.auth,
    prefix: '/api/invite',
    rewritePrefix: '/api/invite',
    http: { agentOptions: { keepAlive: true } },
    preHandler: [authRateLimitHook] as any,
    replyOptions: { rewriteRequestHeaders: (req, headers) => addProxyHeaders(req, headers as Record<string, string>) },
  });

  // --- Authenticated + rate-limited routes ---
  const authenticatedRoutes: Array<{ prefix: string; upstream: string; timeout?: number }> = [
    { prefix: '/api/crm', upstream: serviceUrls.coreApi },
    { prefix: '/api/pipeline', upstream: serviceUrls.coreApi },
    { prefix: '/api/team', upstream: serviceUrls.coreApi },
    { prefix: '/api/activity', upstream: serviceUrls.coreApi },
    { prefix: '/api/messaging', upstream: serviceUrls.messaging },
    { prefix: '/api/bd-accounts', upstream: serviceUrls.telegram, timeout: 300_000 },
    { prefix: '/api/campaigns', upstream: serviceUrls.campaign },
    { prefix: '/api/automation', upstream: serviceUrls.automation },
    { prefix: '/api/analytics', upstream: serviceUrls.analytics },
    { prefix: '/api/users', upstream: serviceUrls.user },
    { prefix: '/api/ai', upstream: serviceUrls.ai },
  ];

  for (const route of authenticatedRoutes) {
    const proxyOpts: any = {
      upstream: route.upstream,
      prefix: route.prefix,
      rewritePrefix: route.prefix,
      http: { agentOptions: { keepAlive: true } },
      preHandler: [authenticate, rateLimitHook] as any,
      replyOptions: {
        rewriteRequestHeaders: (req: any, headers: any) => addProxyHeaders(req, headers as Record<string, string>),
      },
    };

    if (route.timeout) {
      proxyOpts.httpMethods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
      proxyOpts.http = { requestOptions: { timeout: route.timeout } };
    }

    await app.register(proxy, proxyOpts);
  }

  // --- Stripe webhook (no auth, special rate limit) ---
  await app.register(proxy, {
    upstream: serviceUrls.user,
    prefix: '/api/users/stripe-webhook',
    rewritePrefix: '/api/users/stripe-webhook',
    http: { agentOptions: { keepAlive: true } },
    replyOptions: { rewriteRequestHeaders: (req, headers) => addProxyHeaders(req, headers as Record<string, string>) },
  });

  // --- Socket.IO WebSocket proxy (domain access: wss://domain/socket.io) ---
  await app.register(proxy, {
    upstream: serviceUrls.notificationHub,
    prefix: '/socket.io',
    rewritePrefix: '/socket.io',
    websocket: true,
    http: { agentOptions: { keepAlive: true } },
  });

  // --- Next.js HMR WebSocket proxy (/_next/webpack-hmr) ---
  await app.register(proxy, {
    upstream: serviceUrls.frontend,
    prefix: '/_next',
    rewritePrefix: '/_next',
    websocket: true,
  });

  // --- Frontend proxy (domain access: https://domain/* → Next.js) ---
  // Uses reply-from + setNotFoundHandler so it doesn't conflict with CORS/API routes.
  await app.register(replyFrom, {
    base: serviceUrls.frontend,
    undici: { connections: 100, pipelining: 10 },
  });

  app.setNotFoundHandler((request, reply) => {
    reply.from(request.url);
  });

  await app.listen({ port: PORT, host: '0.0.0.0' });
  log.info({ message: `Gateway v2 running on port ${PORT}` });

  const shutdown = async () => {
    log.info({ message: 'Gateway v2 shutting down' });
    await app.close();
    redis.disconnect();
    rateLimitRedis.disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

start().catch((err) => {
  log.error({ message: 'Gateway v2 failed to start', error: String(err) });
  process.exit(1);
});
