import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { BASE_URL, THRESHOLDS } from './config.js';
import {
  randomEmail, authHeaders, signupDirect, signinDirect,
  ACCESS_COOKIE, REFRESH_COOKIE,
} from './helpers.js';

const signupDuration = new Trend('auth_signup_duration');
const signinDuration = new Trend('auth_signin_duration');
const refreshDuration = new Trend('auth_refresh_duration');
const meDuration = new Trend('auth_me_duration');
const authErrors = new Counter('auth_errors');

export const options = {
  stages: [
    { duration: '30s', target: 100 },
    { duration: '2m', target: 100 },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    ...THRESHOLDS,
    auth_signup_duration: ['p(95)<300'],
    auth_signin_duration: ['p(95)<200'],
    auth_refresh_duration: ['p(95)<150'],
    auth_me_duration: ['p(95)<100'],
  },
};

export default function () {
  const email = randomEmail();
  const password = 'LoadTest1234!';

  group('signup', () => {
    const result = signupDirect(email, password);
    if (!result) {
      authErrors.add(1);
      return;
    }
    signupDuration.add(0);
  });

  sleep(0.5);

  let tokens = null;

  group('signin', () => {
    tokens = signinDirect(email, password);
    if (!tokens) {
      authErrors.add(1);
      return;
    }
    signinDuration.add(0);
  });

  if (!tokens) return;

  sleep(0.3);

  group('refresh', () => {
    const jar = http.cookieJar();
    jar.set(BASE_URL, REFRESH_COOKIE, tokens.refreshToken);
    const res = http.post(`${BASE_URL}/api/auth/refresh`, null, {
      tags: { name: 'refresh' },
    });

    const ok = check(res, {
      'refresh status 200': (r) => r.status === 200,
    });

    refreshDuration.add(res.timings.duration);

    if (!ok) {
      authErrors.add(1);
      return;
    }

    if (res.cookies[ACCESS_COOKIE]) {
      tokens.accessToken = res.cookies[ACCESS_COOKIE][0].value;
    }
  });

  sleep(0.3);

  group('get me', () => {
    const res = http.get(`${BASE_URL}/api/auth/me`, {
      headers: authHeaders(tokens.accessToken),
      tags: { name: 'me' },
    });

    check(res, {
      'me status 200': (r) => r.status === 200,
      'me has email': (r) => r.json('email') === email,
    });

    meDuration.add(res.timings.duration);
  });

  sleep(0.3);

  group('switch workspace', () => {
    const wsRes = http.get(`${BASE_URL}/api/auth/workspaces`, {
      headers: authHeaders(tokens.accessToken),
      tags: { name: 'list_workspaces' },
    });

    check(wsRes, {
      'workspaces status 200': (r) => r.status === 200,
    });

    if (wsRes.status === 200) {
      const workspaces = wsRes.json();
      if (Array.isArray(workspaces) && workspaces.length > 0) {
        const switchRes = http.post(
          `${BASE_URL}/api/auth/switch-workspace`,
          JSON.stringify({ organizationId: workspaces[0].id }),
          {
            headers: authHeaders(tokens.accessToken),
            tags: { name: 'switch_workspace' },
          },
        );

        check(switchRes, {
          'switch workspace status 200': (r) => r.status === 200,
        });
      }
    }
  });

  sleep(1);
}
