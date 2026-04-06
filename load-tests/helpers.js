import http from 'k6/http';
import { check } from 'k6';
import { BASE_URL } from './config.js';

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

  const accessToken = res.cookies.access_token
    ? res.cookies.access_token[0].value
    : null;
  const refreshToken = res.cookies.refresh_token
    ? res.cookies.refresh_token[0].value
    : null;

  const body = res.json();

  return {
    accessToken,
    refreshToken,
    user: body.user,
  };
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

  const accessToken = res.cookies.access_token
    ? res.cookies.access_token[0].value
    : null;
  const refreshToken = res.cookies.refresh_token
    ? res.cookies.refresh_token[0].value
    : null;

  const body = res.json();

  return {
    accessToken,
    refreshToken,
    user: body.user,
  };
}

export function setupTestUser() {
  const email = randomEmail();
  const password = 'LoadTest1234!';
  const result = signup(email, password);
  if (!result) return null;
  return { email, password, ...result };
}
