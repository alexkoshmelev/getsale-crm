import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { BASE_URL, THRESHOLDS } from './config.js';
import { authHeaders, randomString, setupTestUser } from './helpers.js';

const listDuration = new Trend('pipe_list_duration');
const mutateDuration = new Trend('pipe_mutate_duration');
const pipeErrors = new Counter('pipe_errors');

export const options = {
  stages: [
    { duration: '20s', target: 100 },
    { duration: '2m', target: 100 },
    { duration: '10s', target: 0 },
  ],
  thresholds: {
    ...THRESHOLDS,
    pipe_list_duration: ['p(95)<200'],
    pipe_mutate_duration: ['p(95)<500'],
  },
};

export function setup() {
  const user = setupTestUser();
  if (!user) throw new Error('Setup failed: could not create test user');

  const headers = authHeaders(user.accessToken);

  const pipeRes = http.post(
    `${BASE_URL}/api/pipeline`,
    JSON.stringify({ name: `LoadTest Pipeline ${randomString(4)}`, isDefault: true }),
    { headers, tags: { name: 'setup_pipeline' } },
  );

  let pipelineId = null;
  let stageIds = [];

  if (pipeRes.status === 201) {
    pipelineId = pipeRes.json('id');

    const stageNames = ['New', 'Contacted', 'Qualified', 'Proposal', 'Won'];
    for (let i = 0; i < stageNames.length; i++) {
      const stageRes = http.post(
        `${BASE_URL}/api/pipeline/stages`,
        JSON.stringify({ pipelineId, name: stageNames[i], orderIndex: i }),
        { headers, tags: { name: 'setup_stage' } },
      );
      if (stageRes.status === 201) {
        stageIds.push(stageRes.json('id'));
      }
    }
  }

  return { accessToken: user.accessToken, pipelineId, stageIds };
}

export default function (data) {
  const headers = authHeaders(data.accessToken);
  const { pipelineId, stageIds } = data;

  group('list pipelines', () => {
    const res = http.get(`${BASE_URL}/api/pipeline`, {
      headers,
      tags: { name: 'list_pipelines' },
    });

    check(res, {
      'list pipelines 200': (r) => r.status === 200,
    });

    listDuration.add(res.timings.duration);
  });

  sleep(0.5);

  group('list stages', () => {
    const url = pipelineId
      ? `${BASE_URL}/api/pipeline/stages?pipelineId=${pipelineId}`
      : `${BASE_URL}/api/pipeline/stages`;

    const res = http.get(url, {
      headers,
      tags: { name: 'list_stages' },
    });

    check(res, {
      'list stages 200': (r) => r.status === 200,
    });

    listDuration.add(res.timings.duration);
  });

  sleep(0.5);

  group('list leads', () => {
    const res = http.get(
      `${BASE_URL}/api/pipeline/leads?page=1&limit=100${pipelineId ? `&pipelineId=${pipelineId}` : ''}`,
      { headers, tags: { name: 'list_leads' } },
    );

    check(res, {
      'list leads 200': (r) => r.status === 200,
    });

    listDuration.add(res.timings.duration);
  });

  sleep(0.5);

  let leadId = null;

  if (stageIds.length > 0) {
    group('create lead', () => {
      const payload = JSON.stringify({
        stageId: stageIds[0],
        title: `Lead ${randomString(6)}`,
        value: Math.floor(Math.random() * 10000) + 500,
      });

      const res = http.post(`${BASE_URL}/api/pipeline/leads`, payload, {
        headers,
        tags: { name: 'create_lead' },
      });

      const ok = check(res, {
        'create lead 201': (r) => r.status === 201,
      });

      mutateDuration.add(res.timings.duration);

      if (ok) {
        leadId = res.json('id');
      } else {
        pipeErrors.add(1);
      }
    });

    sleep(0.5);

    if (leadId && stageIds.length > 1) {
      group('move lead to next stage', () => {
        const nextStageIdx = Math.min(
          Math.floor(Math.random() * (stageIds.length - 1)) + 1,
          stageIds.length - 1,
        );

        const payload = JSON.stringify({ stageId: stageIds[nextStageIdx] });

        const res = http.patch(
          `${BASE_URL}/api/pipeline/leads/${leadId}/stage`,
          payload,
          { headers, tags: { name: 'move_lead_stage' } },
        );

        check(res, {
          'move lead 200': (r) => r.status === 200,
        });

        mutateDuration.add(res.timings.duration);
      });
    }
  }

  sleep(1);
}
