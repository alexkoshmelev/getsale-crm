import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';
const AUTH_TOKEN = __ENV.AUTH_TOKEN || '';

const errorRate = new Rate('errors');
const inboxLatency = new Trend('inbox_latency', true);
const pipelineLatency = new Trend('pipeline_latency', true);
const contactsLatency = new Trend('contacts_latency', true);

export const options = {
  scenarios: {
    // Scenario 1: Sustained API load (target: 10,000 RPS total)
    inbox_load: {
      executor: 'constant-arrival-rate',
      rate: 3000,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 200,
      maxVUs: 500,
      exec: 'inboxScenario',
    },
    pipeline_board: {
      executor: 'constant-arrival-rate',
      rate: 2000,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 150,
      maxVUs: 400,
      exec: 'pipelineBoardScenario',
    },
    contact_search: {
      executor: 'constant-arrival-rate',
      rate: 3000,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 200,
      maxVUs: 500,
      exec: 'contactSearchScenario',
    },
    campaign_sends: {
      executor: 'constant-arrival-rate',
      rate: 1000,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 100,
      maxVUs: 300,
      exec: 'campaignSendScenario',
    },
    mixed_writes: {
      executor: 'constant-arrival-rate',
      rate: 1000,
      timeUnit: '1s',
      duration: '5m',
      preAllocatedVUs: 100,
      maxVUs: 300,
      exec: 'mixedWriteScenario',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<2000'],
    errors: ['rate<0.01'],
    inbox_latency: ['p(95)<200'],
    pipeline_latency: ['p(95)<300'],
    contacts_latency: ['p(95)<300'],
  },
};

const headers = {
  'Content-Type': 'application/json',
  'Cookie': `access_token=${AUTH_TOKEN}`,
};

export function inboxScenario() {
  group('inbox', () => {
    const start = Date.now();
    const res = http.get(`${BASE_URL}/api/messaging/inbox?limit=50`, { headers });
    inboxLatency.add(Date.now() - start);
    const success = check(res, {
      'inbox status 200': (r) => r.status === 200,
      'inbox has data': (r) => r.json('data') !== undefined,
    });
    errorRate.add(!success);
  });
}

export function pipelineBoardScenario() {
  group('pipeline_board', () => {
    const start = Date.now();
    const res = http.get(`${BASE_URL}/api/pipeline`, { headers });
    pipelineLatency.add(Date.now() - start);
    const success = check(res, {
      'pipeline status 200': (r) => r.status === 200,
    });
    errorRate.add(!success);
  });
}

export function contactSearchScenario() {
  group('contact_search', () => {
    const start = Date.now();
    const res = http.get(`${BASE_URL}/api/crm/contacts?limit=50&search=test`, { headers });
    contactsLatency.add(Date.now() - start);
    const success = check(res, {
      'contacts status 200': (r) => r.status === 200,
    });
    errorRate.add(!success);
  });
}

export function campaignSendScenario() {
  group('campaign_send', () => {
    const res = http.get(`${BASE_URL}/api/campaigns`, { headers });
    const success = check(res, {
      'campaigns status 200': (r) => r.status === 200,
    });
    errorRate.add(!success);
  });
}

export function mixedWriteScenario() {
  group('mixed_write', () => {
    const payload = JSON.stringify({
      firstName: `LoadTest_${Date.now()}`,
      lastName: 'User',
      email: `loadtest_${Date.now()}@test.com`,
    });
    const res = http.post(`${BASE_URL}/api/crm/contacts`, payload, { headers });
    const success = check(res, {
      'create contact status 201': (r) => r.status === 201,
    });
    errorRate.add(!success);
  });
}
