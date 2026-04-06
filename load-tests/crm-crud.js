import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { BASE_URL, THRESHOLDS, THRESHOLDS_WRITE } from './config.js';
import { authHeaders, randomString, setupTestUser } from './helpers.js';

const readDuration = new Trend('crm_read_duration');
const writeDuration = new Trend('crm_write_duration');
const crmErrors = new Counter('crm_errors');

export const options = {
  stages: [
    { duration: '30s', target: 200 },
    { duration: '3m', target: 200 },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    ...THRESHOLDS,
    crm_read_duration: ['p(95)<200'],
    crm_write_duration: ['p(95)<500'],
  },
};

export function setup() {
  const user = setupTestUser();
  if (!user) throw new Error('Setup failed: could not create test user');
  return { accessToken: user.accessToken };
}

export default function (data) {
  const headers = authHeaders(data.accessToken);
  let contactId = null;
  let companyId = null;
  let dealId = null;

  group('create company', () => {
    const payload = JSON.stringify({
      name: `LoadTest Co ${randomString(6)}`,
      website: `https://${randomString(8)}.example.com`,
      industry: 'Technology',
    });

    const res = http.post(`${BASE_URL}/api/crm/companies`, payload, {
      headers,
      tags: { name: 'create_company' },
    });

    const ok = check(res, {
      'create company 201': (r) => r.status === 201,
    });

    writeDuration.add(res.timings.duration);

    if (ok) {
      companyId = res.json('id');
    } else {
      crmErrors.add(1);
    }
  });

  sleep(0.5);

  group('create contact', () => {
    const payload = JSON.stringify({
      firstName: `Load${randomString(4)}`,
      lastName: `Test${randomString(4)}`,
      email: `${randomString(8)}@loadtest.local`,
      phone: `+1${Math.floor(Math.random() * 9000000000) + 1000000000}`,
      companyId: companyId || undefined,
    });

    const res = http.post(`${BASE_URL}/api/crm/contacts`, payload, {
      headers,
      tags: { name: 'create_contact' },
    });

    const ok = check(res, {
      'create contact 201': (r) => r.status === 201,
    });

    writeDuration.add(res.timings.duration);

    if (ok) {
      contactId = res.json('id');
    } else {
      crmErrors.add(1);
    }
  });

  sleep(0.5);

  group('create deal', () => {
    const payload = JSON.stringify({
      title: `Deal ${randomString(6)}`,
      value: Math.floor(Math.random() * 50000) + 1000,
      contactId: contactId || undefined,
      companyId: companyId || undefined,
    });

    const res = http.post(`${BASE_URL}/api/crm/deals`, payload, {
      headers,
      tags: { name: 'create_deal' },
    });

    const ok = check(res, {
      'create deal 201': (r) => r.status === 201,
    });

    writeDuration.add(res.timings.duration);

    if (ok) {
      dealId = res.json('id');
    } else {
      crmErrors.add(1);
    }
  });

  sleep(0.5);

  group('list contacts paginated', () => {
    for (let page = 1; page <= 3; page++) {
      const res = http.get(
        `${BASE_URL}/api/crm/contacts?page=${page}&limit=50`,
        { headers, tags: { name: 'list_contacts' } },
      );

      check(res, {
        'list contacts 200': (r) => r.status === 200,
        'list contacts has items': (r) => r.json('items') !== undefined,
      });

      readDuration.add(res.timings.duration);
      sleep(0.2);
    }
  });

  sleep(0.3);

  group('list companies', () => {
    const res = http.get(`${BASE_URL}/api/crm/companies?page=1&limit=50`, {
      headers,
      tags: { name: 'list_companies' },
    });

    check(res, {
      'list companies 200': (r) => r.status === 200,
    });

    readDuration.add(res.timings.duration);
  });

  sleep(0.3);

  group('list deals', () => {
    const res = http.get(`${BASE_URL}/api/crm/deals?page=1&limit=50`, {
      headers,
      tags: { name: 'list_deals' },
    });

    check(res, {
      'list deals 200': (r) => r.status === 200,
    });

    readDuration.add(res.timings.duration);
  });

  sleep(0.3);

  if (contactId) {
    group('update contact', () => {
      const payload = JSON.stringify({
        firstName: `Updated${randomString(4)}`,
        lastName: `User${randomString(4)}`,
      });

      const res = http.put(`${BASE_URL}/api/crm/contacts/${contactId}`, payload, {
        headers,
        tags: { name: 'update_contact' },
      });

      check(res, {
        'update contact 200': (r) => r.status === 200,
      });

      writeDuration.add(res.timings.duration);
    });

    sleep(0.3);

    group('delete contact', () => {
      const res = http.del(`${BASE_URL}/api/crm/contacts/${contactId}`, null, {
        headers,
        tags: { name: 'delete_contact' },
      });

      check(res, {
        'delete contact 204': (r) => r.status === 204,
      });

      writeDuration.add(res.timings.duration);
    });
  }

  sleep(1);
}
