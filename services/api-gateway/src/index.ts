import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { RedisClient } from '@getsale/utils';
import { UserRole } from '@getsale/types';

/** Auth service response shape */
interface AuthUserData {
  id: string;
  email: string;
  organization_id?: string;
  organizationId?: string;
  role: UserRole;
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

// CORS middleware for API Gateway
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.header('Access-Control-Allow-Credentials', 'true');
  
  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'api-gateway' });
});

// Auth middleware
async function authenticate(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const authHeader = req.headers.authorization;
    console.log(`[API Gateway] Auth check for ${req.method} ${req.url}`);
    console.log(`[API Gateway] Authorization header: ${authHeader ? 'present' : 'missing'}`);
    
    if (!authHeader) {
      console.log(`[API Gateway] ❌ No authorization header`);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.replace('Bearer ', '');
    if (!token) {
      console.log(`[API Gateway] ❌ No token in authorization header`);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    console.log(`[API Gateway] Verifying token with auth service...`);
    // Verify token with auth service
    let response;
    try {
      response = await fetch(`${AUTH_SERVICE}/api/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
    } catch (fetchError: any) {
      console.error(`[API Gateway] ❌ Failed to connect to auth service:`, fetchError.message);
      return res.status(503).json({ error: 'Auth service unavailable' });
    }

    if (!response.ok) {
      const errorText = await response.text();
      console.log(`[API Gateway] ❌ Token verification failed: ${response.status} ${response.statusText}`);
      console.log(`[API Gateway] Error details: ${errorText}`);
      return res.status(401).json({ error: 'Invalid token' });
    }

    const userData = (await response.json()) as AuthUserData;
    console.log(`[API Gateway] ✅ Token verified, user data:`, JSON.stringify(userData));
    
    // Map user data to expected format
    const user = {
      id: userData.id,
      email: userData.email,
      organizationId: userData.organization_id || userData.organizationId,
      role: userData.role,
    };
    
    console.log(`[API Gateway] Mapped user:`, JSON.stringify(user));
    (req as any).user = user;
    next();
  } catch (error: any) {
    console.error(`[API Gateway] ❌ Authentication error:`, error.message);
    res.status(500).json({ error: 'Authentication failed' });
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

// Proxy configurations
const authProxy = createProxyMiddleware({
  target: AUTH_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/auth': '/api/auth' },
  logLevel: 'debug',
  timeout: 30000, // 30 seconds timeout
  proxyTimeout: 30000,
  onProxyReq: (proxyReq, req) => {
    console.log(`[API Gateway] Proxying ${req.method} ${req.url} to ${AUTH_SERVICE}${req.url}`);
    console.log(`[API Gateway] Request headers:`, JSON.stringify(req.headers, null, 2));
    
    // Body will be streamed automatically by http-proxy-middleware
    // Don't try to access req.body here as it may not be parsed yet
    
    // Set timeout for the request
    proxyReq.setTimeout(30000, () => {
      console.error(`[API Gateway] Request timeout for ${req.url}`);
    });
  },
  onProxyRes: (proxyRes, req, res) => {
    console.log(`[API Gateway] ✅ Response from ${AUTH_SERVICE}${req.url}: ${proxyRes.statusCode} ${proxyRes.statusMessage}`);
    console.log(`[API Gateway] Response headers:`, JSON.stringify(proxyRes.headers, null, 2));
    
    // Ensure CORS headers are set
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
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

const crmProxy = createProxyMiddleware({
  target: CRM_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/crm': '/api/crm' },
  onProxyReq: (proxyReq, req) => {
    const user = (req as any).user;
    if (user && user.id && user.organizationId) {
      proxyReq.setHeader('X-User-Id', user.id);
      proxyReq.setHeader('X-Organization-Id', user.organizationId);
    }
  },
  onProxyRes: (proxyRes, req, res) => {
    // Ensure CORS headers are set
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  },
});

const messagingProxy = createProxyMiddleware({
  target: MESSAGING_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/messaging': '/api/messaging' },
  onProxyReq: (proxyReq, req) => {
    const user = (req as any).user;
    if (user && user.id && user.organizationId) {
      proxyReq.setHeader('X-User-Id', user.id);
      proxyReq.setHeader('X-Organization-Id', user.organizationId);
    }
  },
  onProxyRes: (proxyRes, req, res) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  },
});

const aiProxy = createProxyMiddleware({
  target: AI_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/ai': '/api/ai' },
  onProxyReq: (proxyReq, req) => {
    const user = (req as any).user;
    if (user && user.id && user.organizationId) {
      proxyReq.setHeader('X-User-Id', user.id);
      proxyReq.setHeader('X-Organization-Id', user.organizationId);
    }
  },
  onProxyRes: (proxyRes, req, res) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  },
});

// Invite proxy (GET public, POST requires auth)
const inviteProxy = createProxyMiddleware({
  target: AUTH_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/invite': '/api/invite' },
  onProxyRes: (proxyRes, req, res) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
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
    const user = (req as any).user;
    console.log(`[API Gateway] User proxy - user:`, user);
    if (user && user.id && user.organizationId) {
      console.log(`[API Gateway] Setting headers - X-User-Id: ${user.id}, X-Organization-Id: ${user.organizationId}`);
      proxyReq.setHeader('X-User-Id', user.id);
      proxyReq.setHeader('X-Organization-Id', user.organizationId);
    } else {
      console.error(`[API Gateway] ❌ User not found in request for ${req.url}`);
    }
  },
  onProxyRes: (proxyRes, req, res) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
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
    const user = (req as any).user;
    console.log(`[API Gateway] Proxying ${req.method} ${req.url} to ${BD_ACCOUNTS_SERVICE}${req.url}`);
    if (user && user.id && user.organizationId) {
      proxyReq.setHeader('X-User-Id', user.id);
      proxyReq.setHeader('X-Organization-Id', user.organizationId);
    } else {
      console.error(`[API Gateway] ❌ User not found in request for ${req.url}`);
    }
  },
  onProxyRes: (proxyRes, req, res) => {
    console.log(`[API Gateway] ✅ Response from ${BD_ACCOUNTS_SERVICE}${req.url}: ${proxyRes.statusCode} ${proxyRes.statusMessage}`);
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
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
    const user = (req as any).user;
    if (user && user.id && user.organizationId) {
      proxyReq.setHeader('X-User-Id', user.id);
      proxyReq.setHeader('X-Organization-Id', user.organizationId);
    }
  },
  onProxyRes: (proxyRes, req, res) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  },
});

const automationProxy = createProxyMiddleware({
  target: AUTOMATION_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/automation': '/api/automation' },
  onProxyReq: (proxyReq, req) => {
    const user = (req as any).user;
    if (user && user.id && user.organizationId) {
      proxyReq.setHeader('X-User-Id', user.id);
      proxyReq.setHeader('X-Organization-Id', user.organizationId);
    }
  },
  onProxyRes: (proxyRes, req, res) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  },
});

const analyticsProxy = createProxyMiddleware({
  target: ANALYTICS_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/analytics': '/api/analytics' },
  onProxyReq: (proxyReq, req) => {
    const user = (req as any).user;
    if (user && user.id && user.organizationId) {
      proxyReq.setHeader('X-User-Id', user.id);
      proxyReq.setHeader('X-Organization-Id', user.organizationId);
    }
  },
  onProxyRes: (proxyRes, req, res) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  },
});

const teamProxy = createProxyMiddleware({
  target: TEAM_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/team': '/api/team' },
  onProxyReq: (proxyReq, req) => {
    const user = (req as any).user;
    if (user && user.id && user.organizationId) {
      proxyReq.setHeader('X-User-Id', user.id);
      proxyReq.setHeader('X-Organization-Id', user.organizationId);
      if (user.role) proxyReq.setHeader('X-User-Role', user.role);
    }
  },
  onProxyRes: (proxyRes, req, res) => {
    res.setHeader('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  },
});

app.use('/api/users', authenticate, rateLimit, userProxy);
app.use('/api/bd-accounts', authenticate, rateLimit, bdAccountsProxy);
app.use('/api/pipeline', authenticate, rateLimit, pipelineProxy);
app.use('/api/automation', authenticate, rateLimit, automationProxy);
app.use('/api/analytics', authenticate, rateLimit, analyticsProxy);
app.use('/api/team', authenticate, rateLimit, teamProxy);

// Admin routes
app.use('/api/admin', authenticate, requireRole(UserRole.OWNER, UserRole.ADMIN), rateLimit);

app.listen(PORT, () => {
  console.log(`API Gateway running on port ${PORT}`);
});

