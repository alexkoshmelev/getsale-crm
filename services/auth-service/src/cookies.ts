/** Must match api-gateway ACCESS_TOKEN_COOKIE and websocket-service handshake cookie. Use distinct names per env on the same registrable domain (e.g. dev-app vs app under .getsale.ai). */
export const AUTH_COOKIE_ACCESS = (process.env.AUTH_COOKIE_ACCESS || 'access_token').trim() || 'access_token';
export const AUTH_COOKIE_REFRESH = (process.env.AUTH_COOKIE_REFRESH || 'refresh_token').trim() || 'refresh_token';

const cookieDomain = process.env.COOKIE_DOMAIN?.trim();
const isProduction = process.env.NODE_ENV === 'production';
export const AUTH_COOKIE_OPTS: {
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'strict' | 'lax';
  path: string;
  domain?: string;
} = {
  httpOnly: true,
  secure: isProduction,
  sameSite: (isProduction && cookieDomain ? 'lax' : isProduction ? 'strict' : 'lax') as 'strict' | 'lax',
  path: '/',
  ...(cookieDomain ? { domain: cookieDomain } : {}),
};

export const ACCESS_MAX_AGE_SEC = 15 * 60; // 15 min
export const REFRESH_MAX_AGE_SEC = 7 * 24 * 60 * 60; // 7 days
/** Refresh token TTL in ms (7 days). Use for DB expires_at and any logic needing milliseconds. */
export const REFRESH_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
