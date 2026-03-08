export const AUTH_COOKIE_ACCESS = 'access_token';
export const AUTH_COOKIE_REFRESH = 'refresh_token';
export const AUTH_COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: (process.env.NODE_ENV === 'production' ? 'strict' : 'lax') as 'strict' | 'lax',
  path: '/',
};

export const ACCESS_MAX_AGE_SEC = 15 * 60; // 15 min
export const REFRESH_MAX_AGE_SEC = 7 * 24 * 60 * 60; // 7 days
