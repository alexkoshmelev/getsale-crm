function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}. Set it before starting the API gateway.`);
  }
  return value.trim();
}

export const JWT_SECRET = requireEnv('JWT_SECRET');
export const ACCESS_TOKEN_COOKIE = 'access_token';
export const INTERNAL_AUTH_HEADER = 'x-internal-auth';
export const INTERNAL_AUTH_SECRET = process.env.INTERNAL_AUTH_SECRET?.trim() || '';

export const PORT = parseInt(String(process.env.PORT || 8000), 10);

export const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

export const RATE_LIMIT_AUTH = parseInt(String(process.env.RATE_LIMIT_AUTH || 500), 10);
export const RATE_LIMIT_ANON = parseInt(String(process.env.RATE_LIMIT_ANON || 100), 10);

const corsOriginEnv = process.env.CORS_ORIGIN;
if (process.env.NODE_ENV === 'production' && (!corsOriginEnv || corsOriginEnv.trim() === '')) {
  throw new Error('CORS_ORIGIN must be set in production. Set it before starting the API gateway.');
}
export const allowedOrigins = corsOriginEnv ? corsOriginEnv.split(',').map(o => o.trim()).filter(Boolean) : [];
export const DEFAULT_ORIGIN = process.env.FRONTEND_ORIGIN?.trim() || 'http://localhost:3000';

export const serviceUrls = {
  auth: process.env.AUTH_SERVICE_URL || 'http://localhost:3001',
  crm: process.env.CRM_SERVICE_URL || 'http://localhost:3002',
  messaging: process.env.MESSAGING_SERVICE_URL || 'http://localhost:3003',
  ai: process.env.AI_SERVICE_URL || 'http://localhost:3005',
  user: process.env.USER_SERVICE_URL || 'http://localhost:3006',
  bdAccounts: process.env.BD_ACCOUNTS_SERVICE_URL || 'http://localhost:3007',
  pipeline: process.env.PIPELINE_SERVICE_URL || 'http://localhost:3008',
  automation: process.env.AUTOMATION_SERVICE_URL || 'http://localhost:3009',
  analytics: process.env.ANALYTICS_SERVICE_URL || 'http://localhost:3010',
  activity: process.env.ACTIVITY_SERVICE_URL || 'http://localhost:3013',
  team: process.env.TEAM_SERVICE_URL || 'http://localhost:3011',
  campaign: process.env.CAMPAIGN_SERVICE_URL || 'http://localhost:3012',
} as const;

export const CORRELATION_HEADER = 'x-correlation-id';
export const SSE_HEARTBEAT_MS = 28000;
/** Max SSE connections per user (prevents exhausting file descriptors). */
export const SSE_MAX_CONNECTIONS_PER_USER = parseInt(String(process.env.SSE_MAX_CONNECTIONS_PER_USER || 3), 10);
