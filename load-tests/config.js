export const BASE_URL = __ENV.BASE_URL || 'http://localhost:8000';

export const THRESHOLDS = {
  http_req_duration: ['p(95)<200', 'p(99)<500'],
  http_req_failed: ['rate<0.01'],
  http_reqs: ['rate>100'],
};

export const THRESHOLDS_WRITE = {
  http_req_duration: ['p(95)<500', 'p(99)<1000'],
  http_req_failed: ['rate<0.01'],
};

export const THRESHOLDS_MIXED = {
  http_req_duration: ['p(95)<200', 'p(99)<500'],
  http_req_failed: ['rate<0.001'],
  http_reqs: ['rate>1000'],
};
