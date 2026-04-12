function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === '') {
    throw new Error(`Missing required env: ${name}`);
  }
  return value.trim();
}

export const JWT_SECRET = requireEnv('JWT_SECRET');
export const ACCESS_TOKEN_COOKIE = (process.env.AUTH_COOKIE_ACCESS || 'access_token').trim();
export const INTERNAL_AUTH_SECRET = process.env.INTERNAL_AUTH_SECRET?.trim() || '';

if (process.env.NODE_ENV === 'production') {
  if (!INTERNAL_AUTH_SECRET || INTERNAL_AUTH_SECRET === 'dev_internal_auth_secret') {
    throw new Error('INTERNAL_AUTH_SECRET must be set to a non-default value in production.');
  }
}

export const PORT = parseInt(process.env.PORT || '8000', 10);
export const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6380';

/** Per-process global request cap (incoming to this gateway instance). Tune via RATE_LIMIT_GLOBAL_PER_SEC for expected traffic and replica count. */
export const RATE_LIMIT_GLOBAL_PER_SEC = parseInt(process.env.RATE_LIMIT_GLOBAL_PER_SEC || '10000', 10);
export const RATE_LIMIT_AUTH_ROUTES = parseInt(process.env.RATE_LIMIT_AUTH_ROUTES || '10', 10);
export const RATE_LIMIT_AUTH = parseInt(process.env.RATE_LIMIT_AUTH || '1000', 10);
export const RATE_LIMIT_ANON = parseInt(process.env.RATE_LIMIT_ANON || '100', 10);
export const RATE_LIMIT_WINDOW_MS = 60_000;

const corsOriginEnv = process.env.CORS_ORIGIN;
if (process.env.NODE_ENV === 'production' && !corsOriginEnv?.trim()) {
  throw new Error('CORS_ORIGIN must be set in production.');
}
export const allowedOrigins = corsOriginEnv
  ? corsOriginEnv.split(',').map((o) => o.trim()).filter(Boolean)
  : [process.env.FRONTEND_ORIGIN?.trim() || 'http://localhost:3000'];

export const serviceUrls = {
  auth: process.env.AUTH_SERVICE_URL || 'http://localhost:4001',
  coreApi: process.env.CORE_API_SERVICE_URL || 'http://localhost:4002',
  messaging: process.env.MESSAGING_SERVICE_URL || 'http://localhost:4003',
  telegram: process.env.TELEGRAM_SERVICE_URL || 'http://localhost:4005',
  campaign: process.env.CAMPAIGN_SERVICE_URL || 'http://localhost:4006',
  automation: process.env.AUTOMATION_SERVICE_URL || 'http://localhost:4007',
  notificationHub: process.env.NOTIFICATION_HUB_URL || 'http://localhost:4008',
  analytics: process.env.ANALYTICS_SERVICE_URL || process.env.CORE_API_SERVICE_URL || 'http://localhost:4002',
  user: process.env.USER_SERVICE_URL || 'http://localhost:4009',
  ai: process.env.AI_SERVICE_URL || 'http://localhost:4010',
  frontend: process.env.FRONTEND_SERVICE_URL || 'http://localhost:3000',
} as const;
