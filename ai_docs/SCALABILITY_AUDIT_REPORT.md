# GetSale CRM — Scalability Audit Report

**Date:** 2026-04-03
**Target:** 10,000 RPS
**Current state:** Docker Compose, single server, already experiencing campaign loop instability and DB lock contention

---

## Health Score: 28 / 100

| Category | Score | Weight | Notes |
|----------|-------|--------|-------|
| Campaign Loop | 1/10 | 20% | Single-process, blocking, overlapping ticks |
| Database | 4/10 | 15% | PgBouncer present but missing indexes, N+1, unbounded queries |
| Event Processing | 3/10 | 15% | No publisher confirms, hardcoded prefetch, silent error swallowing |
| API Gateway | 3/10 | 10% | Single process SPOF, no keepAlive, debug logging in prod |
| Inter-Service HTTP | 4/10 | 10% | Circuit breaker exists but retry amplification, deep call chains |
| Redis | 5/10 | 5% | Good foundation but keys() O(N), no caching strategy |
| WebSocket | 5/10 | 5% | Redis adapter present, but duplicate emits, low pool |
| Frontend | 4/10 | 5% | No SWR/cache, full inbox fetch, broad Zustand subs |
| Logging/Observability | 5/10 | 5% | Prometheus metrics present but sync writes, double listeners |
| Infrastructure | 2/10 | 10% | Single server, no horizontal scaling, no LB |

---

## Findings by Severity

### CRITICAL (5 findings)

---

#### C1. Campaign Loop — Overlapping `setInterval` Ticks

**File:** `services/campaign-service/src/campaign-loop.ts:57-59`

```typescript
export function startCampaignLoop(deps: CampaignLoopDeps): void {
  processCampaignSends(deps).catch(...);
  setInterval(() => processCampaignSends(deps), CAMPAIGN_SEND_INTERVAL_MS);
}
```

**Problem:** `setInterval` fires every 60s regardless of whether the previous `processCampaignSends` has completed. With `simulateHumanBehavior` sleeping 3-12s per participant and HTTP calls timing out at 150s, a single batch of 20 participants can take 4-10 minutes. This causes:
- Multiple overlapping runs competing for the same DB pool (max: 20)
- Connection pool exhaustion
- Race conditions on `campaign_participants` rows (partially mitigated by `SKIP LOCKED`)
- Unpredictable send behavior — the root cause of campaign instability

**Impact at 10k RPS:** Campaign loop is independent of HTTP RPS, but overlapping ticks will exhaust the DB pool, affecting HTTP handlers on the same service.

**Recommendation:** Replace `setInterval` with recursive `setTimeout`:
```typescript
async function loop(deps: CampaignLoopDeps): Promise<void> {
  try {
    await processCampaignSends(deps);
  } catch (err) {
    deps.log.error({ message: 'Campaign send error', error: String(err) });
  }
  setTimeout(() => loop(deps), CAMPAIGN_SEND_INTERVAL_MS);
}
```

**Effort:** S (1 hour)

---

#### C2. Campaign Loop — Sequential Single-Process Architecture

**File:** `services/campaign-service/src/campaign-loop.ts:637-804`

**Problem:** All campaign sends are processed in a single Node.js process, sequentially, one participant at a time. `processParticipant` does per-participant:
1. 1-3 DB queries (contact, bd_account schedule, etc.)
2. `simulateHumanBehavior` — 3-12 seconds of `setTimeout` sleep + HTTP to bd-accounts
3. HTTP to messaging-service (up to 150s timeout)
4. Optional HTTP to ai-service (65s timeout)
5. 1-3 more DB queries (advance step, record send)

With BATCH_SIZE=20 and minimum 3s per participant, one batch takes 60-240+ seconds.

**Impact at 10k RPS:** Cannot scale campaign throughput horizontally. Even with `SKIP LOCKED`, one instance maxes at ~20 sends per 60s tick = 0.33 sends/sec.

**Recommendation:**
1. Extract campaign send work into RabbitMQ job queue with dedicated workers
2. Campaign loop only dequeues participants and publishes to `campaign-send-jobs` queue
3. Multiple worker processes consume from the queue with configurable concurrency
4. Use Redis distributed lock for dequeue to prevent overlap

**Effort:** L (2-3 weeks)

---

#### C3. Campaign Loop — `getSentTodayByAccount` Full Table Scan

**File:** `services/campaign-service/src/helpers.ts:325-343`

```typescript
export async function getSentTodayByAccount(pool: Pool, orgId?: string): Promise<Map<string, number>> {
  const query = `SELECT cp.bd_account_id, COUNT(*)::int AS cnt
     FROM campaign_sends cs
     JOIN campaign_participants cp ON cp.id = cs.campaign_participant_id
     JOIN campaigns c ON c.id = cp.campaign_id
     WHERE cs.sent_at::date = $1::date AND cs.status = 'sent'
     GROUP BY cp.bd_account_id`;
```

**Problem:** Called at the start of every `processCampaignSends` tick (every 60s). It performs a 3-table JOIN with `GROUP BY` across ALL campaign_sends for today. As campaign_sends grows, this query gets progressively slower. The `sent_at::date = $1::date` cast prevents index usage.

**Impact at 10k RPS:** As data grows, this becomes a multi-second query that holds a pool connection and delays the entire campaign loop.

**Recommendation:**
1. Add index: `CREATE INDEX idx_campaign_sends_sent_date_status ON campaign_sends (sent_at, status) WHERE status = 'sent'`
2. Cache result in Redis with 60s TTL (matches tick interval)
3. Rewrite condition as `cs.sent_at >= $1 AND cs.sent_at < $2` instead of `::date` cast

**Effort:** S (2-3 hours)

---

#### C4. API Gateway — Single Process, No Horizontal Scaling

**File:** `services/api-gateway/src/index.ts`

**Problem:** The entire API Gateway is a single Express process using `http-proxy-middleware`. At 10,000 RPS:
- Single Node.js event loop becomes the bottleneck
- No connection pooling to upstream services (no HTTP Agent with `keepAlive`)
- `server.headersTimeout = 330_000` (5.5 min) means slow requests tie up connections
- No load balancer in front (Traefik routes to one container)

**Impact at 10k RPS:** Single process can handle ~2,000-5,000 simple proxy req/s depending on payload. At 10k RPS it will saturate the event loop.

**Recommendation:**
1. Add `http.Agent({ keepAlive: true, maxSockets: 128 })` per upstream service
2. Run multiple gateway instances behind Traefik/Nginx load balancer
3. Consider replacing http-proxy-middleware with fastify-http-proxy or Nginx reverse proxy for better performance
4. Split long-running BD-accounts proxy into a separate gateway route with its own timeout

**Effort:** M (1 week for keepAlive + multi-instance; L for full replacement)

---

#### C5. Single Server Deployment — No Horizontal Scaling

**File:** `docker-compose.server.yml`

**Problem:** All 14 services + PostgreSQL + Redis + RabbitMQ + PgBouncer run on a single server. There is no:
- Container orchestration (K8s, Docker Swarm)
- Auto-scaling
- Dedicated database server
- CDN for static assets
- Read replicas for heavy read queries

**Impact at 10k RPS:** Impossible to reach 10k RPS on a single machine. CPU, memory, and I/O are shared by all services. One misbehaving service (e.g., campaign loop with heavy DB queries) degrades all others.

**Recommendation:**
1. **Phase 1:** Separate infrastructure (PostgreSQL, Redis, RabbitMQ) to dedicated managed services (DigitalOcean Managed DB, Managed Redis)
2. **Phase 2:** Move to K8s (DigitalOcean DOKS) or Docker Swarm with horizontal pod autoscaling
3. **Phase 3:** Add PostgreSQL read replicas for analytics/reporting queries
4. Add CDN (Cloudflare/CloudFront) in front of frontend

**Effort:** XL (4-8 weeks)

---

### HIGH (12 findings)

---

#### H1. Missing Index for Campaign Worker Global Dequeue

**File:** `services/campaign-service/src/campaign-loop.ts:128-139`

```sql
SELECT ... FROM campaign_participants cp
JOIN campaigns c ON c.id = cp.campaign_id
JOIN bd_accounts ba ON ba.id = cp.bd_account_id
WHERE c.status = $1 AND cp.status IN ('pending', 'sent')
  AND cp.next_send_at IS NOT NULL AND cp.next_send_at <= NOW()
ORDER BY cp.next_send_at ASC, cp.enqueue_order ASC
LIMIT 1 FOR UPDATE OF cp SKIP LOCKED
```

The existing `idx_campaign_participants_status` starts with `campaign_id` — useless for this global dequeue pattern.

**Recommendation:** `CREATE INDEX CONCURRENTLY idx_cp_due_global ON campaign_participants (next_send_at, enqueue_order) WHERE status IN ('pending', 'sent') AND next_send_at IS NOT NULL;`

**Effort:** S

---

#### H2. N+1 Queries in Campaign Event Handlers

**File:** `services/campaign-service/src/event-handlers.ts:215-234`

For each matching participant on `MESSAGE_RECEIVED`:
```typescript
for (const p of participantsRes.rows) {
  const sentCheck = await pool.query(`SELECT 1 FROM campaign_sends WHERE ...`, [p.id]);
  const stepsRes = await pool.query(`SELECT ... FROM campaign_sequences WHERE campaign_id = $1`, [p.campaign_id]);
```

Plus per-participant: campaign query, user query, stages query, conversations query (lines 273-303). One inbound message can trigger 5-10 sequential DB queries per matching participant.

**Recommendation:** Batch participant queries. Pre-load campaign metadata and steps in a single query with `IN (...)` before iterating.

**Effort:** M

---

#### H3. RabbitMQ — No Publisher Confirms, Fire-and-Forget

**File:** `shared/utils/src/rabbitmq.ts:93-97`

```typescript
this.publishChannel.publish(exchange, routingKey, Buffer.from(message), {
  persistent: true,
  messageId: event.id,
});
```

Publish is not awaited and has no confirmation. Under broker/network issues, messages are silently lost.

**Recommendation:** Enable publisher confirms with `channel.confirmSelect()` and await `waitForConfirms()` for critical events.

**Effort:** M

---

#### H4. RabbitMQ — Retry sendToQueue Not Awaited

**File:** `shared/utils/src/rabbitmq.ts:166-173`

```typescript
pub.sendToQueue(queue, msg.content, { ... }); // NOT awaited
cons.ack(msg);
```

Retry publish is fire-and-forget while the original message is immediately acked. Under channel pressure, retries can be dropped.

**Recommendation:** `await pub.sendToQueue(...)` before `cons.ack(msg)`.

**Effort:** S

---

#### H5. Automation Service — Silent Error Swallowing

**File:** `services/automation-service/src/event-handlers.ts:140-142`

```typescript
} catch (error) {
  deps.log.error({ message: 'Error processing automation event', error: String(error) });
}
```

Errors in the main automation handler are caught and logged, but the message is still acked by RabbitMQ (the outer `subscribeToEvents` sees success). Failed automations are silently lost with no DLQ/retry.

**Recommendation:** Re-throw the error so RabbitMQ's retry/DLQ mechanism kicks in.

**Effort:** S

---

#### H6. SLA Cron — No Organization Filter on `time_elapsed`

**File:** `services/automation-service/src/sla-cron.ts:193-197`

```sql
SELECT d.* FROM deals d WHERE d.stage_id = $1 AND d.created_at < $2
```

No `organization_id` filter — scans deals across ALL organizations. Combined with sequential `executeRule` per deal, this becomes a publish storm and DB load spike every hour.

**Recommendation:** Add `AND d.organization_id = $2` using the rule's `organization_id`.

**Effort:** S

---

#### H7. `MESSAGE_RECEIVED` Fan-Out — 4+ Consumers, Each with Heavy Work

**Event:** `MESSAGE_RECEIVED` is consumed by:
1. **campaign-service** — N+1 SQL per participant + optional AI call + pipeline HTTP
2. **automation-service** — full rules scan + sequential executeRule with HTTP
3. **ai-service** — may trigger OpenAI/OpenRouter calls
4. **websocket-service** — multi-room emit

One message → 4 parallel heavy processing pipelines. Under high message volume, this multiplies DB/HTTP load by 4x.

**Recommendation:**
1. Add concurrency limits (semaphore) for AI/HTTP calls in event handlers
2. Consider debouncing/batching message processing per contact
3. Tune prefetch per consumer based on handler weight

**Effort:** L

---

#### H8. Unbounded List Endpoints (No Pagination)

Multiple endpoints return unbounded result sets:

| Service | Endpoint | File |
|---------|----------|------|
| messaging | GET /inbox | `services/messaging-service/src/routes/messages-list.ts` |
| messaging | new-leads | `services/messaging-service/src/routes/conversations.ts` |
| crm | notes per entity | `services/crm-service/src/routes/notes.ts` |
| crm | reminders per entity | `services/crm-service/src/routes/reminders.ts` |
| team | GET /members | `services/team-service/src/routes/members.ts` |
| team | GET /shared clients | `services/team-service/src/routes/clients.ts` |
| automation | GET /rules | `services/automation-service/src/routes/rules.ts` |
| pipeline | GET /pipelines | `services/pipeline-service/src/routes/pipelines.ts` |
| campaign | group-sources | `services/campaign-service/src/routes/campaigns.ts` |

**Recommendation:** Add `LIMIT`/`OFFSET` or cursor-based pagination to all list endpoints. Default limit: 50, max: 200.

**Effort:** M

---

#### H9. Heavy Aggregation Queries Without Caching

| Service | Query | File |
|---------|-------|------|
| campaign | List: per-row scalar COUNT subqueries | `services/campaign-service/src/routes/campaigns.ts:97-143` |
| campaign | Stats: many COUNT/JOIN/LATERAL/AVG | `services/campaign-service/src/routes/participants.ts:26-91` |
| bd-accounts | List: LEFT JOIN LATERAL COUNT on messages per sync chat | `services/bd-accounts-service/src/routes/accounts.ts:157-169` |
| analytics | Summary/conversion: multi-CTE window + joins | `services/analytics-service/src/routes/analytics.ts:81-180` |

**Recommendation:**
1. Cache campaign stats in Redis (per campaign, 60s TTL)
2. Pre-aggregate bd-account unread counts via event-driven counter
3. Cache analytics results with 5-minute TTL per org
4. Replace per-row scalar subqueries with JOINed aggregation

**Effort:** M per endpoint

---

#### H10. Gateway Proxy — Debug Logging in Production

**File:** `services/api-gateway/src/proxies.ts:31,111`

```typescript
logLevel: 'debug',
```

`http-proxy-middleware` with `logLevel: 'debug'` on auth and bd-accounts proxies generates verbose I/O on every request in production.

**Recommendation:** Set `logLevel: 'warn'` or remove for production. Use environment-based configuration.

**Effort:** S

---

#### H11. Gateway — Timeout Mismatch

**File:** `services/api-gateway/src/proxies.ts:87` vs `services/api-gateway/src/index.ts:99-101`

Campaign proxy has 30s timeout, but `server.headersTimeout = 330_000`. bd-accounts proxy has 300s timeout. There is no consistent timeout strategy.

**Recommendation:** Align timeouts per route category:
- Fast reads: 10s proxy timeout
- Standard mutations: 30s
- Long operations (bd-accounts sync, campaign start): 300s
- Document timeout strategy

**Effort:** S

---

#### H12. Discovery Loop — Same Overlapping `setInterval` Issue

**File:** `services/crm-service/src/discovery-loop.ts:176-180`

```typescript
setInterval(() => {
  processNextTasks(deps).catch(...);
}, 5000);
```

Same overlapping issue as C1. `processNextTasks` does HTTP to bd-accounts (Telegram API), which can take minutes.

**Recommendation:** Replace with recursive `setTimeout` (same pattern as C1 fix).

**Effort:** S

---

### MEDIUM (14 findings)

---

#### M1. RabbitMQ `prefetch(10)` Hardcoded

**File:** `shared/utils/src/rabbitmq.ts:144`

At most 10 unacked messages in-flight per consumer. With slow AI/HTTP handlers, this severely limits throughput.

**Recommendation:** Make prefetch configurable per subscription via options parameter. Default 10 for light handlers, 1-3 for heavy AI handlers.

**Effort:** S

---

#### M2. Fire-and-Forget Auto-Responder Without Backpressure

**File:** `services/campaign-service/src/event-handlers.ts:151-166`

```typescript
void runAutoResponderIfEligible({...}, event).catch(...);
```

Unbounded concurrent AI+HTTP calls. Under burst inbound messages, this can overload ai-service and messaging-service.

**Recommendation:** Add a concurrency semaphore (e.g., `p-limit` with max 5 concurrent auto-responder runs).

**Effort:** S

---

#### M3. `addContactToDynamicCampaigns` — Per-Campaign N+1 SQL

**File:** `services/campaign-service/src/event-handlers.ts:344-432`

Loads ALL active campaigns, then for each matching campaign does 3-5 additional DB queries (bd_account, sync_chats, max enqueue_order, schedule).

**Recommendation:** Restructure as a single query with JOINs or batch the matching campaigns.

**Effort:** M

---

#### M4. Redis `keys(pattern)` — O(N) Command

**File:** `shared/utils/src/redis.ts:96-98`

```typescript
async keys(pattern: string): Promise<string[]> {
  return this.client.keys(pattern);
}
```

`KEYS` scans the entire keyspace. With many keys, this blocks Redis for other clients.

**Recommendation:** Replace with `SCAN` iterator pattern.

**Effort:** S

---

#### M5. Rate Limiter — Fixed Window, 2 Round-Trips

**File:** `services/api-gateway/src/rate-limit.ts` + `shared/utils/src/redis.ts:60-66`

Fixed-window allows burst at window boundaries. `INCR` + `EXPIRE` = 2 Redis commands.

**Recommendation:** Use Lua script for atomic `INCR + EXPIRE` in one round-trip. Consider sliding window for smoother rate limiting.

**Effort:** S

---

#### M6. Permission Cache — Fragmented Per Router

**File:** `shared/service-core/src/middleware.ts:109-141`

Each `canPermission(pool)` call creates a new in-memory `Map`. Different routers in the same service have separate caches.

**Recommendation:** Create permission checker once per service and share across routers. Consider moving to Redis for cross-instance consistency.

**Effort:** S

---

#### M7. WebSocket — Duplicate `new-message` Emit

**File:** `services/websocket-service/src/event-broadcaster.ts:97-106`

```typescript
emitEvent(io, chatRoom, 'new-message', { message: data, timestamp: event.timestamp });
emitEvent(io, `bd-account:${data.bdAccountId}`, 'new-message', { message: data, timestamp: event.timestamp });
```

Clients subscribed to the BD account room receive `new-message` twice (once from chat room, once from account room).

**Recommendation:** Only emit to the most specific room. Frontend subscribes to `bd-account:X:chat:Y` for chat messages and `bd-account:X` for account-level events only.

**Effort:** S

---

#### M8. WebSocket — Pool `max: 4`

**File:** `services/websocket-service/src/index.ts:19`

Room ownership checks hit PostgreSQL on each subscribe. Burst of connections can queue on 4 connections.

**Recommendation:** Increase to 8-16 or cache room ownership in Redis.

**Effort:** S

---

#### M9. Frontend — No SWR/TanStack Query, Raw Axios

**File:** `frontend/lib/api/client.ts`

All API calls are raw axios with no request deduplication, caching, or background revalidation. Every page navigation repeats all data fetches.

**Recommendation:** Adopt TanStack Query (React Query) for:
- Automatic request deduplication
- Stale-while-revalidate caching
- Background refetch
- Optimistic updates

**Effort:** L (gradual migration)

---

#### M10. Frontend Dashboard — Full Inbox Fetch for Count

**File:** `frontend/lib/api/dashboard.ts:36,63`

```typescript
apiClient.get<unknown[]>('/api/messaging/inbox')
// ...
messages: Array.isArray(messagesRes.data) ? messagesRes.data.length : 0,
```

Fetches ALL inbox messages just to count them. With many messages, this transfers large JSON payloads.

**Recommendation:** Add server-side `GET /api/messaging/inbox/count` endpoint or use pagination `total`.

**Effort:** S

---

#### M11. Frontend — O(n) Chat List Sort on Every WS Message

**File:** `frontend/app/dashboard/messaging/hooks/useMessagingWebSocket.ts:77-93`

Every incoming WebSocket message triggers a full `.map()` + `.sort()` of the entire chat list.

**Recommendation:** Use binary insertion or maintain a sorted structure. For large chat lists (500+), this matters.

**Effort:** M

---

#### M12. Frontend — Broad Zustand Subscriptions

**File:** `frontend/app/dashboard/messaging/hooks/useMessagingState.ts`

`useMessagingState()` subscribes to 4 entire Zustand stores without selectors. Any field change in any store re-renders all consumers.

**Recommendation:** Use individual store selectors as documented in the file's own comment.

**Effort:** M

---

#### M13. Inter-Service HTTP — Dead Debug Code

**File:** `shared/service-core/src/http-client.ts:289-308`

```typescript
fetch('http://127.0.0.1:7616/ingest/...', { ... }).catch(() => {});
```

Debug fetch to localhost on every timeout. Generates unnecessary network traffic and error noise in production.

**Recommendation:** Remove or guard with `NODE_ENV !== 'production'`.

**Effort:** S

---

#### M14. SLA Cron — Sequential Publish Storm

**File:** `services/automation-service/src/sla-cron.ts:87-115`

```typescript
for (const lead of leadRows.rows) {
  await rabbitmq.publishEvent(event as Event);
}
```

Sequential `await` per lead/deal. Large organizations with many breaching leads generate a burst of publishes that can take minutes.

**Recommendation:** Batch publishes or use `Promise.all` with concurrency limit.

**Effort:** S

---

### LOW (6 findings)

---

#### L1. Synchronous Logger Writes

**File:** `shared/logger/src/index.ts:26-37`

`process.stdout.write` is synchronous and can cause backpressure at high log volume.

**Recommendation:** Consider async logging (pino with async transport) for production.

**Effort:** M

---

#### L2. Double `finish` Listeners Per Request

**File:** `shared/service-core/src/service-app.ts:132-147`

Both `requestLogger` and metrics middleware attach `res.on('finish')` listeners. Overhead is small but unnecessary.

**Recommendation:** Combine into a single `finish` handler.

**Effort:** S

---

#### L3. Health Check DB Queries

**File:** `shared/service-core/src/service-app.ts:186-196`

`/health` runs `SELECT 1` on every probe (every 10s per service). With 12 services, that's ~72 DB queries/minute just for health checks.

**Recommendation:** Cache health check result for 5s or use PgBouncer's `SHOW STATS` instead.

**Effort:** S

---

#### L4. Frontend — Static Recharts Import

**File:** `frontend/app/dashboard/campaigns/[id]/page.tsx:29-42`

Recharts is imported statically, adding ~200KB to the campaign detail page bundle.

**Recommendation:** Use `dynamic(() => import('recharts'), { ssr: false })` or lazy load chart components.

**Effort:** S

---

#### L5. Frontend — Unbounded Contacts Store

**File:** `frontend/lib/stores/contacts-store.ts:41-60`

`byId` map grows with every page visited (merge without cleanup). For power users browsing many contacts, memory grows without bound.

**Recommendation:** Implement LRU eviction or reset on page change.

**Effort:** S

---

#### L6. PgBouncer Pool Size vs Service Count

**File:** `docker-compose.server.yml:91`

`DEFAULT_POOL_SIZE: 30` but 12 services × `max: 8` connections = 96 potential connections. With horizontal scaling (multiple replicas), this becomes a hard bottleneck.

**Recommendation:** Increase `DEFAULT_POOL_SIZE` proportionally when adding replicas. Monitor with `SHOW POOLS`.

**Effort:** S

---

## Architecture Diagram — Current State

```
                    ┌─────────────┐
                    │   Traefik   │
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼──────┐ ┌──▼───┐ ┌─────▼──────┐
        │ API Gateway │ │ WS   │ │  Frontend  │
        │  (1 inst)   │ │(1 i) │ │  (1 inst)  │
        └──────┬──────┘ └──┬───┘ └────────────┘
               │           │
    ┌──────────┼───────────┼──────────────────┐
    │          │           │    12 services    │
    │  ┌───┐ ┌┴──┐ ┌───┐ ┌┴──┐ ┌───┐ ┌───┐  │
    │  │ A │ │ C │ │ M │ │BD │ │ P │ │...│  │
    │  └─┬─┘ └─┬─┘ └─┬─┘ └─┬─┘ └─┬─┘ └─┬─┘  │
    │    │     │     │     │     │     │      │
    │    └──┬──┴──┬──┴──┬──┴──┬──┴──┬──┘      │
    │       │     │     │     │               │
    │  ┌────▼─┐ ┌─▼──┐ ┌▼────────┐           │
    │  │PgBnc │ │Redis│ │RabbitMQ │           │
    │  └──┬───┘ └────┘ └─────────┘           │
    │  ┌──▼──────┐                            │
    │  │PostgreSQL│                            │
    │  └─────────┘                            │
    │         SINGLE SERVER                    │
    └──────────────────────────────────────────┘
```

## Priority Roadmap

### Phase 1 — Stabilize (Week 1-2) — Fix what's breaking now

| # | Finding | Effort | Impact |
|---|---------|--------|--------|
| 1 | C1: Replace `setInterval` with recursive `setTimeout` in campaign loop | S | Eliminates overlapping ticks |
| 2 | H12: Same fix for discovery loop | S | Prevents overlap |
| 3 | C3: Cache `getSentTodayByAccount` in Redis, fix date cast | S | Reduces DB load per tick |
| 4 | H1: Add partial index for campaign worker dequeue | S | Faster `SKIP LOCKED` query |
| 5 | H4: Await retry `sendToQueue` in RabbitMQ | S | Prevents message loss |
| 6 | H5: Re-throw errors in automation event handler | S | Enables DLQ for failures |
| 7 | H6: Add `organization_id` filter to SLA cron | S | Prevents global scan |
| 8 | H10: Remove debug `logLevel` from gateway proxies | S | Reduces prod I/O |
| 9 | M13: Remove dead debug fetch in http-client | S | Cleaner error handling |

### Phase 2 — Optimize (Week 3-6) — Handle 1,000+ RPS

| # | Finding | Effort | Impact |
|---|---------|--------|--------|
| 1 | C4: Add HTTP keepAlive Agent to gateway proxies | M | Connection reuse |
| 2 | H8: Add pagination to all unbounded list endpoints | M | Prevents large payloads |
| 3 | H9: Add Redis caching to heavy aggregation endpoints | M | Reduces DB load |
| 4 | H2: Batch N+1 queries in campaign event handlers | M | Reduces DB round-trips |
| 5 | M1: Make RabbitMQ prefetch configurable | S | Better throughput tuning |
| 6 | M2: Add concurrency limit to auto-responder | S | Prevents overload |
| 7 | M5: Atomic rate limit with Lua script | S | Fewer Redis round-trips |
| 8 | M4: Replace `keys()` with SCAN | S | Prevents Redis blocking |
| 9 | H11: Align gateway timeouts per route category | S | Predictable behavior |
| 10 | M7: Fix duplicate WS emit | S | Less client/network waste |

### Phase 3 — Scale (Week 7-12) — Reach 10,000 RPS

| # | Finding | Effort | Impact |
|---|---------|--------|--------|
| 1 | C5: Migrate infra to managed services | XL | Enables horizontal scaling |
| 2 | C2: Extract campaign sends to RabbitMQ workers | L | Parallel campaign processing |
| 3 | C4: Multiple gateway instances behind LB | M | Eliminates gateway SPOF |
| 4 | H3: Enable RabbitMQ publisher confirms | M | Reliable event delivery |
| 5 | H7: Add concurrency controls to MESSAGE_RECEIVED handlers | L | Prevents cascade overload |
| 6 | M9: Adopt TanStack Query in frontend | L | Reduces API load via caching |
| 7 | L1: Switch to async logging (pino) | M | Event loop relief |

### Phase 4 — Production-Grade (Week 13+)

- K8s with HPA (Horizontal Pod Autoscaling)
- PostgreSQL read replicas for analytics
- CDN for frontend static assets
- Distributed tracing (OpenTelemetry)
- Load testing with k6/Artillery (target: 10k RPS)
- Circuit breaker per-endpoint granularity
- Event sourcing for campaign state

---

## Summary

The system has a **solid foundation** — microservice architecture, event-driven communication, PgBouncer, Redis caching infrastructure, Prometheus metrics, circuit breakers, and correlation IDs. However, it was **designed for tens of users and hundreds of RPS**, not thousands.

The **three blocking issues** for reaching 10,000 RPS are:
1. **Campaign loop single-process architecture** (C1, C2) — the root cause of current instability
2. **API Gateway as a single process without connection reuse** (C4) — the HTTP bottleneck
3. **Single-server deployment** (C5) — the infrastructure ceiling

Phase 1 fixes (all S effort) will **immediately stabilize** the campaign loop and eliminate the current production issues. Phases 2-3 progressively unlock higher throughput. Phase 4 reaches the 10,000 RPS target with proper infrastructure.
