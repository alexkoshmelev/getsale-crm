import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import {
  BASE_URL,
  THRESHOLDS_MIXED,
  MIXED_VU_TARGETS_BASE,
  MIXED_VU_TARGETS_HIGH,
  mixedRampStages,
} from './config.js';

const LOAD_LEVEL = (__ENV.LOAD_LEVEL || '').toLowerCase();
const vuTargets =
  LOAD_LEVEL === 'high' ? MIXED_VU_TARGETS_HIGH : MIXED_VU_TARGETS_BASE;
const POOL_SIZE = parseInt(__ENV.USER_POOL_SIZE || (LOAD_LEVEL === 'high' ? '150' : '50'), 10);

import {
  authHeaders, randomString, createUserPool, REFRESH_COOKIE,
} from './helpers.js';

const scenarioErrors = new Counter('scenario_errors');
const crmReadTrend = new Trend('mixed_crm_read');
const crmWriteTrend = new Trend('mixed_crm_write');
const msgTrend = new Trend('mixed_messaging');
const pipeTrend = new Trend('mixed_pipeline');
const adminTrend = new Trend('mixed_admin');
const authTrend = new Trend('mixed_auth');

export const options = {
  scenarios: {
    crm_users: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: mixedRampStages(vuTargets.crm_users),
      exec: 'crmScenario',
      tags: { scenario: 'crm' },
    },
    messaging_users: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: mixedRampStages(vuTargets.messaging_users),
      exec: 'messagingScenario',
      tags: { scenario: 'messaging' },
    },
    pipeline_users: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: mixedRampStages(vuTargets.pipeline_users),
      exec: 'pipelineScenario',
      tags: { scenario: 'pipeline' },
    },
    admin_users: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: mixedRampStages(vuTargets.admin_users),
      exec: 'adminScenario',
      tags: { scenario: 'admin' },
    },
    auth_flow: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: mixedRampStages(vuTargets.auth_flow),
      exec: 'authScenario',
      tags: { scenario: 'auth' },
    },
  },
  thresholds: {
    ...THRESHOLDS_MIXED,
    mixed_crm_read: ['p(95)<200'],
    mixed_crm_write: ['p(95)<500'],
    mixed_messaging: ['p(95)<200'],
    mixed_pipeline: ['p(95)<200'],
    mixed_admin: ['p(95)<300'],
    mixed_auth: ['p(95)<300'],
  },
};

export function setup() {
  console.log(`Creating user pool: ${POOL_SIZE} users via auth-service direct...`);
  const users = createUserPool(POOL_SIZE);
  if (users.length === 0) throw new Error('Setup failed: could not create any test users');
  console.log(`User pool ready: ${users.length} users created`);

  const stageNames = ['New', 'Contacted', 'Qualified', 'Proposal', 'Won'];

  for (let u = 0; u < users.length; u++) {
    const headers = authHeaders(users[u].accessToken);

    const pipeRes = http.post(
      `${BASE_URL}/api/pipeline`,
      JSON.stringify({ name: `Pipeline ${randomString(4)}`, isDefault: true }),
      { headers, tags: { name: 'setup_pipeline' } },
    );

    if (pipeRes.status === 201) {
      const pipelineId = pipeRes.json('id');
      users[u].pipelineId = pipelineId;
      users[u].stageIds = [];

      for (let i = 0; i < stageNames.length; i++) {
        const stageRes = http.post(
          `${BASE_URL}/api/pipeline/stages`,
          JSON.stringify({ pipelineId, name: stageNames[i], orderIndex: i }),
          { headers, tags: { name: 'setup_stage' } },
        );
        if (stageRes.status === 201) {
          users[u].stageIds.push(stageRes.json('id'));
        }
      }
    } else {
      users[u].pipelineId = null;
      users[u].stageIds = [];
    }
  }

  console.log(`Setup complete: ${users.length} users, each with pipeline + stages`);
  return { users };
}

function pickUser(data) {
  return data.users[(__VU - 1) % data.users.length];
}

// --- CRM Scenario (40% of users) ---

export function crmScenario(data) {
  const user = pickUser(data);
  const headers = authHeaders(user.accessToken);

  group('CRM - list contacts', () => {
    const page = Math.floor(Math.random() * 5) + 1;
    const res = http.get(`${BASE_URL}/api/crm/contacts?page=${page}&limit=50`, {
      headers,
      tags: { name: 'crm_list_contacts' },
    });
    check(res, { 'contacts 200': (r) => r.status === 200 });
    crmReadTrend.add(res.timings.duration);
  });

  sleep(0.5);

  group('CRM - list companies', () => {
    const res = http.get(`${BASE_URL}/api/crm/companies?page=1&limit=50`, {
      headers,
      tags: { name: 'crm_list_companies' },
    });
    check(res, { 'companies 200': (r) => r.status === 200 });
    crmReadTrend.add(res.timings.duration);
  });

  sleep(0.5);

  group('CRM - list deals', () => {
    const res = http.get(`${BASE_URL}/api/crm/deals?page=1&limit=50`, {
      headers,
      tags: { name: 'crm_list_deals' },
    });
    check(res, { 'deals 200': (r) => r.status === 200 });
    crmReadTrend.add(res.timings.duration);
  });

  sleep(0.3);

  group('CRM - create contact', () => {
    const payload = JSON.stringify({
      firstName: `Mix${randomString(4)}`,
      lastName: `Test${randomString(4)}`,
      email: `${randomString(8)}@mixed.local`,
    });

    const res = http.post(`${BASE_URL}/api/crm/contacts`, payload, {
      headers,
      tags: { name: 'crm_create_contact' },
    });

    const ok = check(res, { 'create contact 201': (r) => r.status === 201 });
    crmWriteTrend.add(res.timings.duration);

    if (ok) {
      const contactId = res.json('id');
      sleep(0.3);

      const updateRes = http.put(
        `${BASE_URL}/api/crm/contacts/${contactId}`,
        JSON.stringify({ firstName: `Updated${randomString(3)}` }),
        { headers, tags: { name: 'crm_update_contact' } },
      );
      check(updateRes, { 'update contact 200': (r) => r.status === 200 });
      crmWriteTrend.add(updateRes.timings.duration);
    } else {
      scenarioErrors.add(1);
    }
  });

  sleep(1 + Math.random());
}

// --- Messaging Scenario (30% of users) ---

export function messagingScenario(data) {
  const user = pickUser(data);
  const headers = authHeaders(user.accessToken);
  let conversationId = null;

  group('MSG - inbox', () => {
    const res = http.get(`${BASE_URL}/api/messaging/inbox?offset=0&limit=50`, {
      headers,
      tags: { name: 'msg_inbox' },
    });
    check(res, { 'inbox 200': (r) => r.status === 200 });
    msgTrend.add(res.timings.duration);

    if (res.status === 200) {
      const body = res.json();
      if (Array.isArray(body) && body.length > 0) {
        conversationId = body[0].conversationId;
      }
    }
  });

  sleep(Math.random() * 2 + 1);

  group('MSG - inbox count', () => {
    const res = http.get(`${BASE_URL}/api/messaging/inbox/count`, {
      headers,
      tags: { name: 'msg_inbox_count' },
    });
    check(res, { 'inbox count 200': (r) => r.status === 200 });
    msgTrend.add(res.timings.duration);
  });

  sleep(Math.random() + 1);

  if (conversationId) {
    group('MSG - conversation messages', () => {
      const res = http.get(
        `${BASE_URL}/api/messaging/conversations/${conversationId}/messages?limit=50`,
        { headers, tags: { name: 'msg_messages' } },
      );
      check(res, { 'messages 200': (r) => r.status === 200 });
      msgTrend.add(res.timings.duration);
    });

    sleep(Math.random() * 2 + 1);

    group('MSG - mark read', () => {
      const res = http.post(
        `${BASE_URL}/api/messaging/conversations/${conversationId}/read`,
        null,
        { headers, tags: { name: 'msg_mark_read' } },
      );
      check(res, { 'mark read 204': (r) => r.status === 204 });
      msgTrend.add(res.timings.duration);
    });
  }

  sleep(Math.random() * 2 + 1);
}

// --- Pipeline Scenario (15% of users) ---

export function pipelineScenario(data) {
  const user = pickUser(data);
  const headers = authHeaders(user.accessToken);
  const pipelineId = user.pipelineId;
  const stageIds = user.stageIds || [];

  group('PIPE - list pipelines', () => {
    const res = http.get(`${BASE_URL}/api/pipeline`, {
      headers,
      tags: { name: 'pipe_list' },
    });
    check(res, { 'pipelines 200': (r) => r.status === 200 });
    pipeTrend.add(res.timings.duration);
  });

  sleep(0.5);

  group('PIPE - list stages', () => {
    const url = pipelineId
      ? `${BASE_URL}/api/pipeline/stages?pipelineId=${pipelineId}`
      : `${BASE_URL}/api/pipeline/stages`;
    const res = http.get(url, {
      headers,
      tags: { name: 'pipe_stages' },
    });
    check(res, { 'stages 200': (r) => r.status === 200 });
    pipeTrend.add(res.timings.duration);
  });

  sleep(0.5);

  if (pipelineId) {
    group('PIPE - list leads', () => {
      const res = http.get(`${BASE_URL}/api/pipeline/leads?pipelineId=${pipelineId}&page=1&limit=100`, {
        headers,
        tags: { name: 'pipe_leads' },
      });
      check(res, { 'leads 200': (r) => r.status === 200 });
      pipeTrend.add(res.timings.duration);
    });

    sleep(0.5);

    if (stageIds.length > 0) {
      let leadId = null;

      // Create lead requires a contactId — create a contact first
      const contactPayload = JSON.stringify({
        firstName: `Lead${randomString(3)}`,
        lastName: `Test${randomString(3)}`,
        email: `${randomString(8)}@pipe.local`,
      });
      const contactRes = http.post(`${BASE_URL}/api/crm/contacts`, contactPayload, {
        headers,
        tags: { name: 'pipe_create_contact' },
      });

      if (contactRes.status === 201) {
        const contactId = contactRes.json('id');

        group('PIPE - create lead', () => {
          const payload = JSON.stringify({
            contactId,
            pipelineId,
            stageId: stageIds[0],
          });

          const res = http.post(`${BASE_URL}/api/pipeline/leads`, payload, {
            headers,
            tags: { name: 'pipe_create_lead' },
          });

          const ok = check(res, { 'create lead 201': (r) => r.status === 201 });
          pipeTrend.add(res.timings.duration);

          if (ok) {
            leadId = res.json('id');
          }
        });

        if (leadId && stageIds.length > 1) {
          sleep(0.5);

          group('PIPE - move lead', () => {
            const nextIdx = Math.floor(Math.random() * (stageIds.length - 1)) + 1;
            const res = http.patch(
              `${BASE_URL}/api/pipeline/leads/${leadId}/stage`,
              JSON.stringify({ stageId: stageIds[nextIdx] }),
              { headers, tags: { name: 'pipe_move_lead' } },
            );
            check(res, { 'move lead 200': (r) => r.status === 200 });
            pipeTrend.add(res.timings.duration);
          });
        }
      }
    }
  }

  sleep(1 + Math.random());
}

// --- Admin Scenario (10% of users) ---

export function adminScenario(data) {
  const user = pickUser(data);
  const headers = authHeaders(user.accessToken);

  group('ADMIN - analytics summary', () => {
    const res = http.get(`${BASE_URL}/api/analytics/summary?period=month`, {
      headers,
      tags: { name: 'admin_summary' },
    });
    check(res, { 'summary 200': (r) => r.status === 200 });
    adminTrend.add(res.timings.duration);
  });

  sleep(1);

  group('ADMIN - team performance', () => {
    const res = http.get(`${BASE_URL}/api/analytics/team-performance?period=month`, {
      headers,
      tags: { name: 'admin_team_perf' },
    });
    check(res, { 'team perf 200': (r) => r.status === 200 });
    adminTrend.add(res.timings.duration);
  });

  sleep(1);

  group('ADMIN - pipeline value', () => {
    const res = http.get(`${BASE_URL}/api/analytics/pipeline-value`, {
      headers,
      tags: { name: 'admin_pipe_value' },
    });
    check(res, { 'pipeline value 200': (r) => r.status === 200 });
    adminTrend.add(res.timings.duration);
  });

  sleep(0.5);

  group('ADMIN - conversion funnel', () => {
    const res = http.get(`${BASE_URL}/api/crm/analytics/conversion`, {
      headers,
      tags: { name: 'admin_conversion' },
    });
    check(res, { 'conversion 200': (r) => r.status === 200 });
    adminTrend.add(res.timings.duration);
  });

  sleep(0.5);

  group('ADMIN - daily messages', () => {
    const res = http.get(`${BASE_URL}/api/analytics/messages/daily?days=30`, {
      headers,
      tags: { name: 'admin_daily_msgs' },
    });
    check(res, { 'daily msgs 200': (r) => r.status === 200 });
    adminTrend.add(res.timings.duration);
  });

  sleep(0.5);

  group('ADMIN - team members', () => {
    const res = http.get(`${BASE_URL}/api/team/members`, {
      headers,
      tags: { name: 'admin_team_members' },
    });
    check(res, { 'team members 200': (r) => r.status === 200 });
    adminTrend.add(res.timings.duration);
  });

  sleep(2 + Math.random() * 2);
}

// --- Auth Flow Scenario (5% of users) ---
// Tests me + refresh using pool users (signup/signin tested via setup).

export function authScenario(data) {
  const user = pickUser(data);
  const headers = authHeaders(user.accessToken);

  group('AUTH - get me', () => {
    const res = http.get(`${BASE_URL}/api/auth/me`, {
      headers,
      tags: { name: 'auth_me' },
    });
    check(res, { 'me 200': (r) => r.status === 200 });
    authTrend.add(res.timings.duration);
  });

  sleep(1);

  group('AUTH - refresh', () => {
    const jar = http.cookieJar();
    jar.set(BASE_URL, REFRESH_COOKIE, user.refreshToken);
    const res = http.post(`${BASE_URL}/api/auth/refresh`, null, {
      tags: { name: 'auth_refresh' },
    });
    check(res, { 'refresh 200': (r) => r.status === 200 });
    authTrend.add(res.timings.duration);
  });

  sleep(2 + Math.random() * 2);
}
