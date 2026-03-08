import express from 'express';
import { randomUUID } from 'crypto';
import jwt from 'jsonwebtoken';
import cookieParser from 'cookie-parser';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { RedisClient } from '@getsale/utils';
import { UserRole } from '@getsale/types';

const CORRELATION_HEADER = 'x-correlation-id';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}. Set it before starting the API gateway.`);
  }
  return value.trim();
}

const JWT_SECRET = requireEnv('JWT_SECRET');
const ACCESS_TOKEN_COOKIE = 'access_token';
const INTERNAL_AUTH_HEADER = 'x-internal-auth';
const INTERNAL_AUTH_SECRET = process.env.INTERNAL_AUTH_SECRET?.trim() || '';

/** Fallback: parse access_token from Cookie header if cookieParser didn't (e.g. edge cases) */
function getAccessTokenFromRequest(req: express.Request): string | undefined {
  const fromCookie = req.cookies?.[ACCESS_TOKEN_COOKIE];
  if (fromCookie && typeof fromCookie === 'string') return fromCookie;
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader !== 'string') return undefined;
  const match = cookieHeader.match(new RegExp(`(?:^|;)\\s*${ACCESS_TOKEN_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1].trim()) : undefined;
}

/** JWT access token payload (must match auth-service signAccessToken shape) */
interface JwtPayload {
  userId: string;
  organizationId: string;
  role: UserRole;
  iat?: number;
  exp?: number;
}

const app = express();
const PORT = process.env.PORT || 8000;

// Redis for rate limiting and caching
const redis = new RedisClient(process.env.REDIS_URL || 'redis://localhost:6379');

// Service URLs
const AUTH_SERVICE = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const CRM_SERVICE = process.env.CRM_SERVICE_URL || 'http://localhost:3002';
const MESSAGING_SERVICE = process.env.MESSAGING_SERVICE_URL || 'http://localhost:3003';
const AI_SERVICE = process.env.AI_SERVICE_URL || 'http://localhost:3005';
const USER_SERVICE = process.env.USER_SERVICE_URL || 'http://localhost:3006';
const BD_ACCOUNTS_SERVICE = process.env.BD_ACCOUNTS_SERVICE_URL || 'http://localhost:3007';
const PIPELINE_SERVICE = process.env.PIPELINE_SERVICE_URL || 'http://localhost:3008';
const AUTOMATION_SERVICE = process.env.AUTOMATION_SERVICE_URL || 'http://localhost:3009';
const ANALYTICS_SERVICE = process.env.ANALYTICS_SERVICE_URL || 'http://localhost:3010';
const TEAM_SERVICE = process.env.TEAM_SERVICE_URL || 'http://localhost:3011';
const CAMPAIGN_SERVICE = process.env.CAMPAIGN_SERVICE_URL || 'http://localhost:3012';

// CORS: require explicit origin in production to avoid allowing any origin
const corsOriginEnv = process.env.CORS_ORIGIN;
if (process.env.NODE_ENV === 'production' && (!corsOriginEnv || corsOriginEnv.trim() === '')) {
  throw new Error('CORS_ORIGIN must be set in production. Set it before starting the API gateway.');
}
const allowedOrigins = corsOriginEnv ? corsOriginEnv.split(',').map(o => o.trim()).filter(Boolean) : [];

const DEFAULT_ORIGIN = process.env.FRONTEND_ORIGIN?.trim() || 'http://localhost:3000';

/** Valid origin: http(s)://hostname with optional port. Rejects malformed values (e.g. typos like localhost:31/3). */
function isValidOrigin(origin: string): boolean {
  if (!origin || typeof origin !== 'string') return false;
  const o = origin.trim();
  if (!o) return false;
  try {
    const u = new URL(o);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    if (!u.hostname) return false;
    return true;
  } catch {
    return false;
  }
}

/** With credentials: true we must never use '*'; browser will block. Return concrete origin that matches the request so the browser accepts Set-Cookie. */
function resolveOrigin(reqOrigin: string | undefined): string {
  const raw = typeof reqOrigin === 'string' ? reqOrigin.trim() : '';
  const fromRequest = raw && isValidOrigin(raw) ? raw : '';

  if (allowedOrigins.length > 0) {
    if (fromRequest && allowedOrigins.includes(fromRequest)) return fromRequest;
    // Dev: if request is from localhost/127.0.0.1, reflect it so any localhost port works (e.g. frontend on 3000 with CORS_ORIGIN=5173)
    if (process.env.NODE_ENV !== 'production' && fromRequest) {
      try {
        const u = new URL(fromRequest);
        if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return fromRequest;
      } catch {
        /* fall through */
      }
    }
    return allowedOrigins[0];
  }
  if (fromRequest) return fromRequest;
  return DEFAULT_ORIGIN;
}

app.use((req, res, next) => {
  const origin = resolveOrigin(req.headers.origin);
  res.header('Access-Control-Allow-Origin', origin);
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

// PHASE 2.9 — Correlation ID: generate in gateway, propagate to all downstream and response
app.use((req: express.Request, _res, next) => {
  const incoming = req.headers[CORRELATION_HEADER] as string | undefined;
  (req as any).correlationId = typeof incoming === 'string' && incoming.trim() ? incoming.trim() : randomUUID();
  next();
});

// Don't parse JSON for proxied requests - let http-proxy-middleware handle it
// Only parse JSON for non-proxied routes (like /health)
app.use((req, res, next) => {
  // Skip JSON parsing for API routes that will be proxied
  if (req.path.startsWith('/api/')) {
    return next();
  }
  express.json()(req, res, next);
});

function addCorrelationToProxyReq(proxyReq: any, req: express.Request) {
  const id = (req as any).correlationId;
  if (id) proxyReq.setHeader(CORRELATION_HEADER, id);
}

function addInternalAuthToProxyReq(proxyReq: any) {
  if (INTERNAL_AUTH_SECRET) proxyReq.setHeader(INTERNAL_AUTH_HEADER, INTERNAL_AUTH_SECRET);
}
function addCorrelationToResponse(res: express.Response, req: express.Request) {
  const id = (req as any).correlationId;
  if (id) res.setHeader(CORRELATION_HEADER, id);
}

function addCorsToProxyRes(proxyRes: { headers: Record<string, string | string[] | undefined> }, req: express.Request) {
  const origin = resolveOrigin(req.headers.origin);
  proxyRes.headers['access-control-allow-origin'] = origin;
  proxyRes.headers['access-control-allow-credentials'] = 'true';
}

// Health check (PHASE 2.9: include correlation id in response when present)
app.get('/health', (req, res) => {
  addCorrelationToResponse(res, req);
  res.json({ status: 'ok', service: 'api-gateway' });
});

app.use(cookieParser());

// Auth middleware — local JWT verification; token from httpOnly cookie or Authorization header
function authenticate(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const token =
      getAccessTokenFromRequest(req) ??
      req.headers.authorization?.replace(/^Bearer\s+/i, '')?.trim();
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    let payload: JwtPayload;
    try {
      payload = jwt.verify(token, JWT_SECRET) as JwtPayload;
    } catch (_err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    if (!payload.userId || !payload.organizationId) {
      return res.status(401).json({ error: 'Invalid token payload' });
    }

    (req as any).user = {
      id: payload.userId,
      organizationId: payload.organizationId,
      role: (payload.role as UserRole) || UserRole.VIEWER,
    };
    next();
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : 'Authentication failed';
    res.status(500).json({ error: msg });
  }
}

// Role-based access control
function requireRole(...roles: UserRole[]) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const user = (req as any).user;
    if (!user || !roles.includes(user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  };
}

// Rate limiting: выше лимит для авторизованных пользователей
const RATE_LIMIT_AUTH = parseInt(String(process.env.RATE_LIMIT_AUTH || 500), 10);
const RATE_LIMIT_ANON = parseInt(String(process.env.RATE_LIMIT_ANON || 100), 10);

async function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = (req as any).user;
  const limit = user?.id ? RATE_LIMIT_AUTH : RATE_LIMIT_ANON;
  const key = `rate_limit:${user?.id || req.ip}:${Date.now() / 60000 | 0}`;

  const count = await redis.get<number>(key) || 0;
  if (count >= limit) {
    return res.status(429).json({ error: 'Too many requests' });
  }

  await redis.set(key, count + 1, 60);
  next();
}

// Proxy configurations — every proxy MUST use addCorsToProxyRes(proxyRes, req) in onProxyRes so the
// response forwarded to the browser has valid CORS (concrete origin + credentials). Setting only res.setHeader
// can be overwritten when the proxy pipes the backend response to the client.
const authProxy = createProxyMiddleware({
  target: AUTH_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/auth': '/api/auth' },
  logLevel: 'debug',
  timeout: 30000, // 30 seconds timeout
  proxyTimeout: 30000,
  onProxyReq: (proxyReq, req) => {
    addCorrelationToProxyReq(proxyReq, req);
    addInternalAuthToProxyReq(proxyReq);
    proxyReq.setTimeout(30000, () => {});
  },
  onProxyRes: (proxyRes, req, res) => {
    addCorrelationToResponse(res, req);
    addCorsToProxyRes(proxyRes, req);
  },
  onError: (err, req, res) => {
    console.error(`[API Gateway] ❌ Proxy error for ${req.url}:`, err.message);
    console.error(`[API Gateway] Error details:`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Service unavailable', details: err.message });
    } else {
      console.error(`[API Gateway] Response already sent, cannot send error response`);
    }
  },
});

function addAuthHeadersToProxyReq(proxyReq: any, req: express.Request) {
  const user = (req as any).user;
  if (user?.id && user?.organizationId) {
    proxyReq.setHeader('X-User-Id', user.id);
    proxyReq.setHeader('X-Organization-Id', user.organizationId);
    if (user.role) proxyReq.setHeader('X-User-Role', user.role);
  }
  const token = getAccessTokenFromRequest(req) ?? req.headers.authorization?.replace(/^Bearer\s+/i, '')?.trim();
  if (token) proxyReq.setHeader('Authorization', `Bearer ${token}`);
}

const crmProxy = createProxyMiddleware({
  target: CRM_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/crm': '/api/crm' },
  onProxyReq: (proxyReq, req) => {
    addCorrelationToProxyReq(proxyReq, req);
    addInternalAuthToProxyReq(proxyReq);
    addAuthHeadersToProxyReq(proxyReq, req);
  },
  onProxyRes: (proxyRes, req, res) => {
    addCorrelationToResponse(res, req);
    addCorsToProxyRes(proxyRes, req);
  },
});

const messagingProxy = createProxyMiddleware({
  target: MESSAGING_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/messaging': '/api/messaging' },
  onProxyReq: (proxyReq, req) => {
    addCorrelationToProxyReq(proxyReq, req);
    addInternalAuthToProxyReq(proxyReq);
    addAuthHeadersToProxyReq(proxyReq, req);
  },
  onProxyRes: (proxyRes, req, res) => {
    addCorrelationToResponse(res, req);
    addCorsToProxyRes(proxyRes, req);
  },
});

const aiProxy = createProxyMiddleware({
  target: AI_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/ai': '/api/ai' },
  onProxyReq: (proxyReq, req) => {
    addCorrelationToProxyReq(proxyReq, req);
    addInternalAuthToProxyReq(proxyReq);
    addAuthHeadersToProxyReq(proxyReq, req);
  },
  onProxyRes: (proxyRes, req, res) => {
    addCorrelationToResponse(res, req);
    addCorsToProxyRes(proxyRes, req);
  },
});

// Invite proxy (GET public, POST requires auth)
const inviteProxy = createProxyMiddleware({
  target: AUTH_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/invite': '/api/invite' },
  onProxyReq: (proxyReq, req) => {
    addCorrelationToProxyReq(proxyReq, req);
    addInternalAuthToProxyReq(proxyReq);
  },
  onProxyRes: (proxyRes, req, res) => {
    addCorrelationToResponse(res, req);
    addCorsToProxyRes(proxyRes, req);
  },
});

// Routes
app.use('/api/auth', authProxy);
app.use('/api/invite', (req, res, next) => {
  if (req.method === 'GET') return inviteProxy(req, res, next);
  return authenticate(req, res, next);
}, inviteProxy);

app.use('/api/crm', authenticate, rateLimit, crmProxy);
app.use('/api/messaging', authenticate, rateLimit, messagingProxy);
app.use('/api/ai', authenticate, rateLimit, aiProxy);

// Additional service proxies
const userProxy = createProxyMiddleware({
  target: USER_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/users': '/api/users' },
  onProxyReq: (proxyReq, req) => {
    addCorrelationToProxyReq(proxyReq, req);
    addInternalAuthToProxyReq(proxyReq);
    addAuthHeadersToProxyReq(proxyReq, req);
  },
  onProxyRes: (proxyRes, req, res) => {
    addCorrelationToResponse(res, req);
    addCorsToProxyRes(proxyRes, req);
  },
});

const bdAccountsProxy = createProxyMiddleware({
  target: BD_ACCOUNTS_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/bd-accounts': '/api/bd-accounts' },
  timeout: 120000, // 2 min — dialogs-by-folders can take 60–120s for accounts with many chats
  proxyTimeout: 120000,
  logLevel: 'debug',
  onProxyReq: (proxyReq, req) => {
    addCorrelationToProxyReq(proxyReq, req);
    addInternalAuthToProxyReq(proxyReq);
    addAuthHeadersToProxyReq(proxyReq, req);
  },
  onProxyRes: (proxyRes, req, res) => {
    addCorrelationToResponse(res, req);
    addCorsToProxyRes(proxyRes, req);
  },
  onError: (err, req, res) => {
    console.error(`[API Gateway] ❌ Proxy error for ${req.url}:`, err.message);
    if (!res.headersSent) {
      res.status(504).json({ error: 'Service unavailable', details: err.message });
    }
  },
});

const pipelineProxy = createProxyMiddleware({
  target: PIPELINE_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/pipeline': '/api/pipeline' },
  onProxyReq: (proxyReq, req) => {
    addCorrelationToProxyReq(proxyReq, req);
    addInternalAuthToProxyReq(proxyReq);
    addAuthHeadersToProxyReq(proxyReq, req);
  },
  onProxyRes: (proxyRes, req, res) => {
    addCorrelationToResponse(res, req);
    addCorsToProxyRes(proxyRes, req);
  },
});

const automationProxy = createProxyMiddleware({
  target: AUTOMATION_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/automation': '/api/automation' },
  onProxyReq: (proxyReq, req) => {
    addCorrelationToProxyReq(proxyReq, req);
    addInternalAuthToProxyReq(proxyReq);
    addAuthHeadersToProxyReq(proxyReq, req);
  },
  onProxyRes: (proxyRes, req, res) => {
    addCorrelationToResponse(res, req);
    addCorsToProxyRes(proxyRes, req);
  },
});

const analyticsProxy = createProxyMiddleware({
  target: ANALYTICS_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/analytics': '/api/analytics' },
  onProxyReq: (proxyReq, req) => {
    addCorrelationToProxyReq(proxyReq, req);
    addInternalAuthToProxyReq(proxyReq);
    addAuthHeadersToProxyReq(proxyReq, req);
  },
  onProxyRes: (proxyRes, req, res) => {
    addCorrelationToResponse(res, req);
    addCorsToProxyRes(proxyRes, req);
  },
});

const teamProxy = createProxyMiddleware({
  target: TEAM_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/team': '/api/team' },
  onProxyReq: (proxyReq, req) => {
    addCorrelationToProxyReq(proxyReq, req);
    addInternalAuthToProxyReq(proxyReq);
    addAuthHeadersToProxyReq(proxyReq, req);
  },
  onProxyRes: (proxyRes, req, res) => {
    addCorrelationToResponse(res, req);
    addCorsToProxyRes(proxyRes, req);
  },
});

const campaignProxy = createProxyMiddleware({
  target: CAMPAIGN_SERVICE,
  changeOrigin: true,
  timeout: 30000,
  proxyTimeout: 30000,
  pathRewrite: { '^/api/campaigns': '/api/campaigns' },
  onProxyReq: (proxyReq, req) => {
    addCorrelationToProxyReq(proxyReq, req);
    addInternalAuthToProxyReq(proxyReq);
    addAuthHeadersToProxyReq(proxyReq, req);
  },
  onProxyRes: (proxyRes, req, res) => {
    addCorrelationToResponse(res, req);
    addCorsToProxyRes(proxyRes, req);
  },
});

app.use('/api/users', authenticate, rateLimit, userProxy);
app.use('/api/bd-accounts', authenticate, rateLimit, bdAccountsProxy);
app.use('/api/pipeline', authenticate, rateLimit, pipelineProxy);
app.use('/api/automation', authenticate, rateLimit, automationProxy);
app.use('/api/analytics', authenticate, rateLimit, analyticsProxy);
app.use('/api/team', authenticate, rateLimit, teamProxy);
app.use('/api/campaigns', authenticate, rateLimit, campaignProxy);

// Admin routes
app.use('/api/admin', authenticate, requireRole(UserRole.OWNER, UserRole.ADMIN), rateLimit);

app.listen(PORT, () => {
  console.log(`API Gateway running on port ${PORT}`);
});

