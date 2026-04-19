import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { BASE_URL, THRESHOLDS } from './config.js';
import { authHeaders, randomString, setupTestUser } from './helpers.js';

const inboxDuration = new Trend('msg_inbox_duration');
const messagesDuration = new Trend('msg_messages_duration');
const sendDuration = new Trend('msg_send_duration');
const readMarkDuration = new Trend('msg_mark_read_duration');
const msgErrors = new Counter('msg_errors');

export const options = {
  stages: [
    { duration: '30s', target: 150 },
    { duration: '3m', target: 150 },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    ...THRESHOLDS,
    msg_inbox_duration: ['p(95)<200'],
    msg_messages_duration: ['p(95)<200'],
    msg_send_duration: ['p(95)<500'],
  },
};

export function setup() {
  const user = setupTestUser();
  if (!user) throw new Error('Setup failed: could not create test user');
  return { accessToken: user.accessToken };
}

export default function (data) {
  const headers = authHeaders(data.accessToken);
  let conversationId = null;

  group('list inbox', () => {
    const res = http.get(`${BASE_URL}/api/messaging/inbox?offset=0&limit=50`, {
      headers,
      tags: { name: 'list_inbox' },
    });

    check(res, {
      'inbox status 200': (r) => r.status === 200,
    });

    inboxDuration.add(res.timings.duration);

    if (res.status === 200) {
      const body = res.json();
      if (Array.isArray(body) && body.length > 0) {
        conversationId = body[0].conversationId;
      }
    }
  });

  sleep(Math.random() * 2 + 1);

  group('inbox count', () => {
    const res = http.get(`${BASE_URL}/api/messaging/inbox/count`, {
      headers,
      tags: { name: 'inbox_count' },
    });

    check(res, {
      'inbox count 200': (r) => r.status === 200,
    });

    inboxDuration.add(res.timings.duration);
  });

  sleep(Math.random() * 2 + 1);

  if (conversationId) {
    group('get conversation messages', () => {
      const res = http.get(
        `${BASE_URL}/api/messaging/conversations/${conversationId}/messages?limit=50`,
        { headers, tags: { name: 'get_messages' } },
      );

      check(res, {
        'messages status 200': (r) => r.status === 200,
        'messages has array': (r) => r.json('messages') !== undefined,
      });

      messagesDuration.add(res.timings.duration);
    });

    sleep(Math.random() * 2 + 1);

    group('get conversation detail', () => {
      const res = http.get(
        `${BASE_URL}/api/messaging/conversations/${conversationId}`,
        { headers, tags: { name: 'get_conversation' } },
      );

      check(res, {
        'conversation detail 200': (r) => r.status === 200,
      });

      messagesDuration.add(res.timings.duration);
    });

    sleep(Math.random() * 2 + 1);

    group('mark read', () => {
      const res = http.post(
        `${BASE_URL}/api/messaging/conversations/${conversationId}/read`,
        null,
        { headers, tags: { name: 'mark_read' } },
      );

      check(res, {
        'mark read 204': (r) => r.status === 204,
      });

      readMarkDuration.add(res.timings.duration);
    });

    sleep(Math.random() + 1);
  }

  group('send message (simulated)', () => {
    if (!conversationId) {
      sleep(1);
      return;
    }

    const payload = JSON.stringify({
      conversationId,
      text: `Load test message ${randomString(20)}`,
      bdAccountId: '00000000-0000-0000-0000-000000000000',
    });

    const res = http.post(`${BASE_URL}/api/messaging/send`, payload, {
      headers,
      tags: { name: 'send_message' },
    });

    check(res, {
      'send message 202 or 4xx': (r) => r.status === 202 || r.status >= 400,
    });

    sendDuration.add(res.timings.duration);
  });

  sleep(Math.random() * 2 + 1);
}
