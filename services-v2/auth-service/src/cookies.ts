export const AUTH_COOKIE_ACCESS = (process.env.AUTH_COOKIE_ACCESS || 'access_token').trim();
export const AUTH_COOKIE_REFRESH = (process.env.AUTH_COOKIE_REFRESH || 'refresh_token').trim();

const cookieDomain = process.env.COOKIE_DOMAIN?.trim();
const isProduction = process.env.NODE_ENV === 'production';

export const AUTH_COOKIE_OPTS = {
  httpOnly: true,
  secure: isProduction,
  sameSite: (isProduction && cookieDomain ? 'lax' : isProduction ? 'strict' : 'lax') as 'strict' | 'lax',
  path: '/',
  ...(cookieDomain ? { domain: cookieDomain } : {}),
};

export const ACCESS_MAX_AGE_SEC = 15 * 60;
export const REFRESH_MAX_AGE_SEC = 7 * 24 * 60 * 60;
export const REFRESH_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
