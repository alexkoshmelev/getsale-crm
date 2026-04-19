import http from 'k6/http';
import { check, sleep } from 'k6';
import { BASE_URL } from './config.js';

export const ACCESS_COOKIE = __ENV.AUTH_COOKIE_ACCESS || 'access_token_dev';
export const REFRESH_COOKIE = __ENV.AUTH_COOKIE_REFRESH || 'refresh_token_dev';
export const AUTH_SERVICE_URL = __ENV.AUTH_SERVICE_URL || 'http://auth-service:4001';
export const INTERNAL_AUTH_SECRET = __ENV.INTERNAL_AUTH_SECRET || 'dev_internal_auth_secret';

const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function randomString(len) {
  let result = '';
  for (let i = 0; i < len; i++) {
    result += CHARS.charAt(Math.floor(Math.random() * CHARS.length));
  }
  return result;
}

export function randomEmail() {
  return `loadtest-${randomString(8)}-${Date.now()}@test.local`;
}

export function authHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };
}

export function jsonHeaders() {
  return { 'Content-Type': 'application/json' };
}

function internalHeaders() {
  return {
    'Content-Type': 'application/json',
    'x-internal-auth': INTERNAL_AUTH_SECRET,
  };
}

function extractToken(cookies, primary, fallback) {
  if (cookies[primary] && cookies[primary][0]) return cookies[primary][0].value;
  if (cookies[fallback] && cookies[fallback][0]) return cookies[fallback][0].value;
  return null;
}

/**
 * Create a user by calling auth-service directly (bypasses gateway rate limiting).
 * Used in setup() to pre-create a pool of users for load testing.
 */
export function signupDirect(email, password) {
  const payload = JSON.stringify({
    email,
    password,
    organizationName: `LoadTest Org ${randomString(4)}`,
  });

  const res = http.post(`${AUTH_SERVICE_URL}/api/auth/signup`, payload, {
    headers: internalHeaders(),
    tags: { name: 'setup_signup' },
  });

  if (res.status !== 200) {
    console.warn(`signupDirect failed: ${res.status} ${res.body}`);
    return null;
  }

  const accessToken = extractToken(res.cookies, ACCESS_COOKIE, 'access_token');
  const refreshToken = extractToken(res.cookies, REFRESH_COOKIE, 'refresh_token');
  const body = res.json();

  return { accessToken, refreshToken, user: body.user };
}

/**
 * Create N test users via direct auth-service calls.
 * Returns array of { email, password, accessToken, refreshToken }.
 * Run `make k6-reset` before this to flush auth:signup rate limit keys.
 */
export function createUserPool(count) {
  const users = [];
  let failures = 0;
  for (let i = 0; i < count; i++) {
    const email = randomEmail();
    const password = 'LoadTest1234!';
    const result = signupDirect(email, password);
    if (result && result.accessToken) {
      users.push({ email, password, ...result });
    } else {
      failures++;
      if (failures >= 5 && users.length > 0) {
        console.warn(`Stopping pool creation after ${failures} consecutive failures. Got ${users.length}/${count} users.`);
        break;
      }
    }
    if (i % 10 === 9) sleep(0.3);
  }
  console.log(`User pool: ${users.length} created, ${failures} failed out of ${count} requested`);
  return users;
}

/** signup via GATEWAY (subject to rate limiting — for auth flow scenario). */
export function signup(email, password) {
  const payload = JSON.stringify({
    email,
    password,
    organizationName: `LoadTest Org ${randomString(4)}`,
  });

  const res = http.post(`${BASE_URL}/api/auth/signup`, payload, {
    headers: jsonHeaders(),
    tags: { name: 'signup' },
  });

  const ok = check(res, {
    'signup status 200': (r) => r.status === 200,
  });

  if (!ok) return null;

  const accessToken = extractToken(res.cookies, ACCESS_COOKIE, 'access_token');
  const refreshToken = extractToken(res.cookies, REFRESH_COOKIE, 'refresh_token');
  const body = res.json();

  return { accessToken, refreshToken, user: body.user };
}

export function signin(email, password) {
  const payload = JSON.stringify({ email, password });

  const res = http.post(`${BASE_URL}/api/auth/signin`, payload, {
    headers: jsonHeaders(),
    tags: { name: 'signin' },
  });

  const ok = check(res, {
    'signin status 200': (r) => r.status === 200,
  });

  if (!ok) return null;

  const accessToken = extractToken(res.cookies, ACCESS_COOKIE, 'access_token');
  const refreshToken = extractToken(res.cookies, REFRESH_COOKIE, 'refresh_token');
  const body = res.json();

  return { accessToken, refreshToken, user: body.user };
}

/** signin via auth-service directly (bypasses gateway rate limiting). */
export function signinDirect(email, password) {
  const payload = JSON.stringify({ email, password });

  const res = http.post(`${AUTH_SERVICE_URL}/api/auth/signin`, payload, {
    headers: internalHeaders(),
    tags: { name: 'setup_signin' },
  });

  if (res.status !== 200) return null;

  const accessToken = extractToken(res.cookies, ACCESS_COOKIE, 'access_token');
  const refreshToken = extractToken(res.cookies, REFRESH_COOKIE, 'refresh_token');
  const body = res.json();

  return { accessToken, refreshToken, user: body.user };
}

export function setupTestUser() {
  const email = randomEmail();
  const password = 'LoadTest1234!';
  const result = signupDirect(email, password);
  if (!result) return null;
  return { email, password, ...result };
}
