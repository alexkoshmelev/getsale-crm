# GetSale CRM - k6 Load Tests

Load testing suite for the backend API using [k6](https://k6.io/).

## Prerequisites

Install k6:

```bash
# macOS
brew install grafana/k6/k6

# Windows
choco install k6

# Docker
docker pull grafana/k6
```

## Test Scenarios

| Script | Description | VUs | Duration |
|---|---|---|---|
| `auth-flow.js` | Signup → signin → refresh → me → switch workspace | 100 | ~2.5 min |
| `crm-crud.js` | Contacts, companies, deals CRUD lifecycle | 200 | ~3.5 min |
| `messaging.js` | Inbox, conversations, send, mark read | 150 | ~3.5 min |
| `pipeline.js` | Pipelines, stages, leads, stage transitions | 100 | ~2.5 min |
| `mixed-load.js` | Realistic mixed workload (all scenarios combined) | 500 | ~6.5 min |

## Running Tests

### Individual tests

```bash
k6 run auth-flow.js
k6 run crm-crud.js
k6 run messaging.js
k6 run pipeline.js
```

### Mixed load (recommended)

```bash
k6 run mixed-load.js
```

### Custom base URL

```bash
k6 run -e BASE_URL=http://your-cluster:8000 mixed-load.js
```

### JSON output for analysis

```bash
k6 run --out json=results.json mixed-load.js
```

### Using npm scripts

```bash
cd load-tests
npm run test:auth
npm run test:crm
npm run test:messaging
npm run test:pipeline
npm run test:mixed
npm run test:all    # mixed-load with JSON output
```

## Target Metrics

| Metric | Threshold | Description |
|---|---|---|
| `http_req_duration` p95 | < 200ms | 95th percentile response time |
| `http_req_duration` p99 | < 500ms | 99th percentile response time |
| `http_req_failed` | < 0.1% | Error rate |
| `http_reqs` | > 1000/s | Total request throughput |

### Per-scenario thresholds (mixed-load)

| Metric | Threshold |
|---|---|
| `mixed_crm_read` p95 | < 200ms |
| `mixed_crm_write` p95 | < 500ms |
| `mixed_messaging` p95 | < 200ms |
| `mixed_pipeline` p95 | < 200ms |
| `mixed_admin` p95 | < 300ms |
| `mixed_auth` p95 | < 300ms |

## Interpreting Results

k6 prints a summary after each run. Key things to look for:

- **http_req_duration**: p95 and p99 values should stay under thresholds
- **http_req_failed**: Should be near 0%. High failure rates indicate server errors or rate limiting
- **http_reqs**: Total throughput. Higher is better for the same latency
- **iteration_duration**: End-to-end time for a complete user scenario
- **checks**: Percentage of assertions that passed. Should be close to 100%

### Common issues

- **High p99 but low p95**: Occasional slow requests, likely GC pauses or cold cache
- **Increasing latency over time**: Possible memory leak or connection pool exhaustion
- **Sudden error spikes**: Rate limiting, connection limits, or service crashes
- **Low throughput**: CPU-bound bottleneck, check database query performance

## Scaling for Higher RPS

To target 10,000+ RPS, increase VU counts proportionally:

```bash
k6 run --vus 2000 --duration 5m mixed-load.js
```

Or modify the `stages` in `mixed-load.js` to use higher VU targets.

## Docker Usage

```bash
docker run --rm -i \
  -e BASE_URL=http://host.docker.internal:8000 \
  -v $(pwd):/scripts \
  grafana/k6 run /scripts/mixed-load.js
```
