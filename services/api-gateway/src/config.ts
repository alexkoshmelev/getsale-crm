function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required environment variable: ${name}. Set it before starting the API gateway.`);
  }
  return value.trim();
}

export const JWT_SECRET = requireEnv('JWT_SECRET');
/** Same env as auth-service (AUTH_COOKIE_ACCESS). */
export const ACCESS_TOKEN_COOKIE = (process.env.AUTH_COOKIE_ACCESS || 'access_token').trim() || 'access_token';
export const INTERNAL_AUTH_HEADER = 'x-internal-auth';
export const INTERNAL_AUTH_SECRET = process.env.INTERNAL_AUTH_SECRET?.trim() || '';

if (process.env.NODE_ENV === 'production') {
  if (!INTERNAL_AUTH_SECRET || INTERNAL_AUTH_SECRET === 'dev_internal_auth_secret') {
    throw new Error(
      'INTERNAL_AUTH_SECRET must be set to a non-default value in production. ' +
        'Add to your .env (same value for API Gateway and all backends): INTERNAL_AUTH_SECRET=<secret>. ' +
        'Generate: openssl rand -hex 32. See docs/DEPLOYMENT.md.'
    );
  }
}

export const PORT = parseInt(String(process.env.PORT || 8000), 10);

export const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

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
