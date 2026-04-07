export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';

// Baseline HTTP thresholds (not mixed-load specific).
export const THRESHOLDS = {
  http_req_duration: ['p(95)<200', 'p(99)<500'],
  http_req_failed: ['rate<0.01'],
  // Stepping-stone toward validating 10k RPS sustained throughput.
  http_reqs: ['rate>100'],
};

export const THRESHOLDS_WRITE = {
  http_req_duration: ['p(95)<500', 'p(99)<1000'],
  http_req_failed: ['rate<0.01'],
};

// Mixed scenario: current bar is >1k RPS; long-term goal is ~10k RPS — tighten stages/thresholds as the stack improves.
export const THRESHOLDS_MIXED = {
  http_req_duration: ['p(95)<200', 'p(99)<500'],
  http_req_failed: ['rate<0.001'],
  http_reqs: ['rate>1000'],
};

// Intermediate gate on the path to ~10k RPS (use when the SUT is expected to sustain very high throughput).
export const THRESHOLDS_10K = {
  http_req_duration: ['p(95)<200', 'p(99)<500'],
  http_req_failed: ['rate<0.001'],
  http_reqs: ['rate>5000'],
};

/** Per-scenario steady-state VU targets (mixed-load default). Sum = 500 VUs. */
export const MIXED_VU_TARGETS_BASE = {
  crm_users: 200,
  messaging_users: 150,
  pipeline_users: 75,
  admin_users: 50,
  auth_flow: 25,
};

/**
 * High-load profile: 3× base VU counts → 1500 VUs aggregate (vs 500 default), for pushing RPS toward the ~10k goal.
 * Enable from CLI: `LOAD_LEVEL=high k6 run mixed-load.js`
 */
export const MIXED_VU_TARGETS_HIGH = {
  crm_users: 600,
  messaging_users: 450,
  pipeline_users: 225,
  admin_users: 150,
  auth_flow: 75,
};

/** Standard ramp: up, hold, down — use with a numeric `target` per scenario. */
export function mixedRampStages(target) {
  return [
    { duration: '1m', target },
    { duration: '5m', target },
    { duration: '30s', target: 0 },
  ];
}
