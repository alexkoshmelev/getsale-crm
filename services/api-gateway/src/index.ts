import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import { RedisClient } from '@getsale/utils';
import { UserRole } from '@getsale/types';

const app = express();
const PORT = process.env.PORT || 8000;

// Redis for rate limiting and caching
const redis = new RedisClient(process.env.REDIS_URL || 'redis://localhost:6379');

// Service URLs
const AUTH_SERVICE = process.env.AUTH_SERVICE_URL || 'http://localhost:3001';
const CRM_SERVICE = process.env.CRM_SERVICE_URL || 'http://localhost:3002';
const MESSAGING_SERVICE = process.env.MESSAGING_SERVICE_URL || 'http://localhost:3003';
const AI_SERVICE = process.env.AI_SERVICE_URL || 'http://localhost:3005';

// Middleware
app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'api-gateway' });
});

// Auth middleware
async function authenticate(req: express.Request, res: express.Response, next: express.NextFunction) {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Verify token with auth service
    const response = await fetch(`${AUTH_SERVICE}/api/auth/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    });

    if (!response.ok) {
      return res.status(401).json({ error: 'Invalid token' });
    }

    const user = await response.json();
    (req as any).user = user;
    next();
  } catch (error) {
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

// Rate limiting
async function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const user = (req as any).user;
  const key = `rate_limit:${user?.id || req.ip}:${Date.now() / 60000 | 0}`;
  
  const count = await redis.get<number>(key) || 0;
  if (count >= 100) { // 100 requests per minute
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
});

const crmProxy = createProxyMiddleware({
  target: CRM_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/crm': '/api/crm' },
  onProxyReq: (proxyReq, req) => {
    const user = (req as any).user;
    if (user) {
      proxyReq.setHeader('X-User-Id', user.id);
      proxyReq.setHeader('X-Organization-Id', user.organizationId);
    }
  },
});

const messagingProxy = createProxyMiddleware({
  target: MESSAGING_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/messaging': '/api/messaging' },
  onProxyReq: (proxyReq, req) => {
    const user = (req as any).user;
    if (user) {
      proxyReq.setHeader('X-User-Id', user.id);
      proxyReq.setHeader('X-Organization-Id', user.organizationId);
    }
  },
});

const aiProxy = createProxyMiddleware({
  target: AI_SERVICE,
  changeOrigin: true,
  pathRewrite: { '^/api/ai': '/api/ai' },
  onProxyReq: (proxyReq, req) => {
    const user = (req as any).user;
    if (user) {
      proxyReq.setHeader('X-User-Id', user.id);
      proxyReq.setHeader('X-Organization-Id', user.organizationId);
    }
  },
});

// Routes
app.use('/api/auth', authProxy);

app.use('/api/crm', authenticate, rateLimit, crmProxy);
app.use('/api/messaging', authenticate, rateLimit, messagingProxy);
app.use('/api/ai', authenticate, rateLimit, aiProxy);

// Admin routes
app.use('/api/admin', authenticate, requireRole(UserRole.OWNER, UserRole.ADMIN), rateLimit);

app.listen(PORT, () => {
  console.log(`API Gateway running on port ${PORT}`);
});

