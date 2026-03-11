# Project Audit Report — GetSale CRM

**Date:** 2026-03-11  
**Scope:** Full project (services/, shared/, frontend/, migrations/) — focus on critical ~20–30%  
**Audited by:** senior-reviewer + security-auditor + reviewer

---

## Executive Summary

**Overall Health Score:** 2.0/10

| Severity | Architecture | Security | Code Quality | Total |
|----------|-------------|----------|--------------|-------|
| Critical | 2           | 0        | 0            | **2** |
| High     | 4           | 5        | 4            | **13** |
| Medium   | 5           | 4        | 8            | **17** |
| Low      | 4           | 4        | 6            | **14** |

**Recommendation:** Fix the 2 critical issues (admin route 404, analytics closed/won stage mismatch) before next release. Then address high-priority security and architecture items (internal auth policy, gateway error leak, auth rate limits, gateway structure).

---

## Integration Analysis (текущее состояние)

Обзор интеграций между сервисами: HTTP, события, шлюз, БД и конфигурация.

### 1. Карта сервисов и портов

| Сервис            | Порт | БД (pg) | Redis | RabbitMQ | Вызывает по HTTP |
|-------------------|------|---------|-------|----------|-------------------|
| api-gateway       | 8000 | нет     | да    | нет      | все бэкенды (прокси) |
| auth-service      | 3001 | да      | да    | да       | pipeline-service (internal) |
| crm-service       | 3002 | да      | опц.  | да       | bd-accounts, campaign |
| messaging-service | 3003 | да      | да    | да       | bd-accounts, ai |
| websocket-service | 3004 | нет     | да    | да       | auth (verify token) |
| ai-service        | 3005 | нет     | да    | да       | — |
| user-service      | 3006 | да      | да    | да       | — |
| bd-accounts-service | 3007 | да    | да    | да       | — |
| pipeline-service  | 3008 | да      | да    | да       | — |
| automation-service| 3009 | да      | да    | да       | crm, pipeline |
| analytics-service | 3010 | да      | да    | да       | — |
| team-service      | 3011 | да      | да    | да       | — |
| campaign-service  | 3012 | да      | да    | да       | pipeline, messaging |
| activity-service  | 3013 | да      | нет   | да       | — |

### 2. HTTP: сервис → сервис (ServiceHttpClient)

- **Единый клиент:** `shared/service-core` — `ServiceHttpClient` с retry, timeout, заголовком `X-Internal-Auth`, опционально `RequestContext` (user/org/role/correlationId).
- **Контракты internal API:** явно задан только pipeline: `POST /internal/pipeline/default-for-org` (auth → pipeline при создании организации). Остальные вызовы (crm → bd-accounts, crm → campaign, messaging → bd-accounts/ai, automation → crm/pipeline, campaign → pipeline/messaging) идут на публичные пути бэкендов; форматы запросов/ответов не вынесены в общий контракт (типы только по месту).
- **Передача контекста:** `RequestContext` в service-core есть, но при вызовах из сервисов (auth → pipeline, crm → campaign/bd-accounts и т.д.) почти нигде не передаётся — бэкенды получают пользователя только от шлюза через заголовки. Для internal-вызовов (создание pipeline при signup) контекст не обязателен; для сквозного аудита/трассировки его стоит начать пробрасывать.
- **Ошибки:** 4xx от бэкенда пробрасываются как `ServiceCallError` без retry; 5xx — с retry. Логирование и повтор — в `ServiceHttpClient`. Обработка на стороне вызывающего сервиса местами разная (например, messaging attachLead при событии — только log.error без retry/повтора).

**Рекомендации:**  
- Зафиксировать внутренние пути и форматы (хотя бы в одном месте: docs или shared types).  
- По возможности пробрасывать `context` при вызовах от имени пользователя.  
- Для событийной обработки (attachLead и аналоги) определить политику: retry/DLQ или явный “best effort + лог”.

**Выполнено (оркестрация):** контракты — **docs/INTERNAL_API.md**; передача **RequestContext** в service-to-service (get/post/patch); идемпотентность attachLead зафиксирована, возврат rowCount; политика обработчиков событий — **docs/EVENT_HANDLER_POLICY.md**.

### 3. События (RabbitMQ)

- **Обмен:** один topic exchange `events`, роутинг по `EventType` (например `deal.created`, `lead.created.from.campaign`).
- **Публикуют:** auth (user.created), crm (company/contact/deal, discovery), pipeline (stage, lead), messaging, bd-accounts (sync, telegram updates), campaign, team, ai (drafts), automation (rules).
- **Подписчики:**  
  - campaign → deal.stage.changed, lead.created, …  
  - messaging → lead.created.from.campaign (attachLead)  
  - automation → lead.sla.breach, deal.sla.breach  
  - analytics, activity, ai — подписки на часть событий для агрегации/лент.
- **Надёжность:** persistent messages, один exchange; очереди по имени сервиса (например `messaging-service`). Retry в RabbitMQClient (MAX_RETRIES=3, DLQ). Обработчики не всегда идемпотентны — при повторной доставке возможны дубли (например повторный attachLead), если нет уникального ключа в БД.
- **Согласованность:** события публикуются после коммита транзакции (auth signup, crm deals и т.д.), порядок только в рамках одной очереди; между очередями порядок не гарантируется.

**Рекомендации:**  
- Для критичных обработчиков (attachLead, создание сущностей по событиям) — идемпотентность по ключу (leadId+conversationId и т.п.) или явная проверка “уже обработано”.  
- Документировать, какие типы событий кто потребляет и в каком формате (уже частично есть в `@getsale/events`).

### 4. API Gateway → бэкенды

- **Прокси:** все запросы к `/api/*` идут через gateway; к бэкендам — http-proxy-middleware. Для авторизованных путей добавляются `X-Internal-Auth`, `X-User-Id`, `X-Organization-Id`, `X-User-Role`, `Authorization`, `x-correlation-id`. Health/events — без user.
- **SSE:** один поток `/api/events/stream`; подписка на Redis-канал `events:{userId}`; лимит соединений на пользователя (SSE_MAX_CONNECTIONS_PER_USER). События в Redis пишут bd-accounts (sync progress) и crm (discovery и др.); gateway только подписывается и отдаёт клиенту.
- **Ошибки:** при 5xx от бэкенда прокси возвращает 500 и “Service unavailable” (утечка внутренних деталей по результатам прошлого аудита исправлена).

### 5. Общая БД (Postgres)

- Одна БД (через pgbouncer в Docker); сервисы разделены по **схеме/таблицам**: auth (users, organizations, refresh_tokens, …), crm (companies, contacts, deals, …), pipeline (pipelines, stages, leads), messaging (conversations, messages), bd-accounts, campaign, automation, analytics, activity, team и т.д.
- Кросс-сервисные ссылки: например `leads`, `deals` привязаны к `organization_id`, `pipeline_id`, `stage_id`; messaging/conversations к контактам и т.д. Транзакции только внутри одного сервиса; распределённых транзакций нет.
- Риски: изменение схемы одной области (например pipeline/stages) может затронуть crm, analytics, auth (default pipeline). Миграции общие в `migrations/` — нужна дисциплина по порядку и обратной совместимости.

### 6. Конфигурация URL (Docker vs код)

- **api-gateway:** в `docker-compose.yml` заданы все `*_SERVICE_URL` (auth, crm, messaging, …) — корректно.
- **auth-service:** в `docker-compose.yml` **не задан** `PIPELINE_SERVICE_URL`. В коде дефолт `http://localhost:3008`. В Docker при запросе к pipeline это будет localhost внутри контейнера auth — **неверно**, вызов создания default pipeline при signup не дойдёт до pipeline-service.
- **Остальные сервисы:** у campaign, automation в compose заданы PIPELINE_SERVICE_URL, MESSAGING_SERVICE_URL, CRM_SERVICE_URL где нужно. У crm, messaging дефолты в коде уже с именами сервисов (`http://bd-accounts-service:3007` и т.д.) — в Docker работают. messaging явно задаёт AI_SERVICE_URL и BD_ACCOUNTS_SERVICE_URL в compose — OK.

**Критично:** добавить для **auth-service** в `docker-compose.yml` переменную `PIPELINE_SERVICE_URL=http://pipeline-service:3008`, иначе в Docker создание организации без дефолтного пайплайна.  
→ **Исправлено:** в `docker-compose.yml` для auth-service добавлена переменная `PIPELINE_SERVICE_URL=http://pipeline-service:3008`.

### 7. Итог по интеграциям

| Аспект              | Оценка | Комментарий |
|---------------------|--------|-------------|
| HTTP internal auth  | ✅     | X-Internal-Auth обязателен при заданном INTERNAL_AUTH_SECRET |
| Контракты internal  | ⚠️     | Только pipeline/internal описаны явно; остальное по факту кода |
| Контекст (user/org) | ⚠️     | От шлюза передаётся; при service-to-service почти не используется |
| События             | ✅     | Единый exchange, типы в @getsale/events, retry/DLQ есть |
| Идемпотентность     | ⚠️     | Не везде (например attachLead) |
| URL в Docker        | ❌     | auth-service без PIPELINE_SERVICE_URL |
| Shared DB           | ✅     | Одна БД, границы по таблицам; миграции общие |

---

## Critical Issues (fix immediately)

### [A1] Admin route has no handler — all requests 404
**Category:** Architecture  
**Location:** `services/api-gateway/src/index.ts` — `/api/admin` mounted with auth and rate limit only; no router or proxy.  
**Impact:** Admin features are unusable; every `/api/admin/*` request returns 404.  
**Fix:** Mount an admin router or proxy to a backend, or remove the route if not used.

### [A2] Analytics "closed/won" stage filter never matches default pipeline
**Category:** Architecture  
**Location:** `services/analytics-service/src/routes/analytics.ts` (e.g. lines 51, 195) — filter uses `name = 'closed' OR name = 'won'`. Default pipeline uses stage names `"Closed Won"` and `"Closed Lost"`.  
**Impact:** Summary and team-performance endpoints return zero for revenue-in-period and leads-closed for orgs using default stages.  
**Fix:** Align filter with actual stage names (e.g. `name IN ('Closed Won', 'Closed Lost')`) or use a shared constant; document the contract.

---

## High Priority Issues (fix soon)

### Architecture
- **[A3]** API Gateway god module — Split into modules (auth, proxies, SSE, rate-limit).
- **[A4]** Auth-service rate limiting not horizontally scalable — Use Redis.
- **[A5]** Duplicate and divergent `canPermission` — Unify to single source of truth.
- **[A6]** API Gateway does not use shared logger — Add `@getsale/logger`.

### Security
- **[S1]** Admin route has no handler — same as A1.
- **[S2]** Internal auth accepts user headers without X-Internal-Auth secret — Require valid `X-Internal-Auth`.
- **[S3]** Dependency vulnerabilities — Run `npm audit fix`; upgrade deps.
- **[S4]** Auth rate limits in-memory — Use Redis.
- **[S5]** API Gateway 500 can leak internal error message — Return generic message; log server-side only.

### Code Quality
- **[Q1]** Heavy use of `any` in bd-accounts-service — Introduce proper types.
- **[Q2]** Swallowed errors in empty catch blocks — Add logging or feedback.
- **[Q3]** Frontend components far over 300-line guideline — Split bd-accounts/page, pipeline/page.
- **[Q4]** Very long backend modules — Extract from sync.ts, conversations.ts, telegram-manager.ts.

---

## Medium Priority Issues (plan for next sprint)

Architecture: [A7]–[A11]. Security: [S6]–[S9]. Code Quality: [Q5]–[Q12].  
(See full report in `.cursor/workspace/audits/` if saved there, or in this file’s extended version.)

---

## Low Priority / Suggestions

Architecture: [A12]–[A15]. Security: [S10]–[S13]. Code Quality: [Q13]–[Q18].

---

## Priority Matrix

| ID | Issue | Severity | Effort | Priority |
|----|-------|----------|--------|----------|
| A1 | Admin route has no handler | Critical | Low | P0 — now |
| A2 | Analytics closed/won stage name mismatch | Critical | Low | P0 — now |
| S5 | Gateway 500 leaks error message | High | Low | P1 — sprint |
| S2 | Internal auth accepts headers without secret | High | Medium | P1 — sprint |
| S3 | Dependency vulnerabilities | High | Low–Medium | P1 — sprint |
| A4/S4 | Auth rate limits in-memory | High | Medium | P1 — sprint |
| A5 | Duplicate canPermission | High | Medium | P1 — sprint |
| A6 | Gateway no logger | High | Low | P1 — sprint |

---

## Next Steps

1. **Immediate:** Fix [A1] (admin route), [A2] (analytics stage filter).
2. **This sprint:** [S5], [S3], [A4/S4], [A5], [A6], [S2].
3. **Next sprint:** [A3], [Q2], [Q3/Q4], plus medium items.
4. **Backlog:** Low-priority items.

Use `/refactor [file]` for structural issues. Use `/implement [fix]` for security/feature fixes.

---

## Remediation Applied (2026-03-11)

**Critical:** [A1] Admin route — added placeholder router returning 501 until admin backend exists. [A2] Analytics — stage filter aligned to `Closed Won` / `Closed Lost`.

**High:** [S5] Gateway 500 — generic "Authentication failed" response; full error logged server-side. [S2] Internal auth — service-core now requires valid `X-Internal-Auth`; user headers alone no longer accepted. [S3] Dependencies — `npm audit fix` + nodemailer upgraded to ^8.0.2; 0 vulnerabilities. [A4/S4] Auth rate limits — moved to Redis via `RedisClient.incr()`; shared/utils extended with `incr()`. [A5] canPermission — unified in service-core (owner + admin except transfer_ownership); auth-service organization routes use service-core. [A6] Gateway — added `@getsale/logger`, all console.* replaced with structured log.

**Code quality (partial):** [Q2] Empty catch in discovery-loop and bd-accounts ensureFoldersFromSyncChats — added logging. [S6] Signup/signin — email format validation (regex). [S7] Pipeline leads — LIMIT/OFFSET use query parameters.

**Done in follow-up:** [A3] API Gateway split into modules: `config.ts`, `types.ts`, `cors.ts`, `auth.ts`, `rate-limit.ts`, `proxy-helpers.ts`, `proxies.ts`, `sse.ts`; `index.ts` now only wires middleware and routes (~95 lines).

**Follow-up (this session):** [Q1] bd-accounts helpers + accounts route: added `FolderRow`, `TelegramDialogLike`, replaced `any`/`err: any` with typed interfaces and `unknown`; [Q5] added `getAccountOr404()` in helpers, used in accounts GET /:id; [Q2] parse.ts SSE keepalive/close catch now log; RightWorkspacePanel sessionStorage catch log; layout theme catch commented; [S9] service-core: in production, startup fails if INTERNAL_AUTH_SECRET is unset or equals `dev_internal_auth_secret`.

**Latest (Q5 + Q2):** [Q5] `getAccountOr404` used in **media** (3 handlers), **auth** (2), **messaging** (8 handlers); [Q2] frontend: events-stream-context (3 catches), bd-accounts page, discovery page, pipeline page — all now log with `console.warn`. Media/auth/messaging: removed duplicate account fetch + 404; media catch `error: any` → `unknown`.

**Q6 (done):** [Q6] DRY conversation_id in messaging-service — added `getLeadConversationOrThrow(pool, conversationId, organizationId, columns)` in `conversations.ts`; create-shared-chat, mark-shared-chat, mark-won, mark-lost now use it (validation + fetch in one place).

**Deferred/backlog:** [Q1] remaining bd-accounts (sync, telegram-manager). [Q3/Q4] Splitting long files. Low-priority items.

---

### Remediation — Critical (architecture/security audit run)

**Date:** 2026-03-11 (same day, second pass — critical from architecture/security audit).

| Issue | Fix |
|-------|-----|
| **Signup no transaction (A1, S2)** | All signup DB operations (org, user, pipeline, stages, team, members) wrapped in a single `pool.connect()` + `BEGIN`/`COMMIT`/`ROLLBACK` in `services/auth-service/src/routes/auth.ts`. Refresh token and event publish remain after commit. |
| **RBAC fail-open (S1, A6)** | In `shared/service-core/src/middleware.ts` and `services/auth-service/src/helpers.ts`, on DB error in `canPermission` now return `false` (deny) instead of allowing owner/admin. |
| **API gateway no graceful shutdown (A2, S8)** | `services/api-gateway/src/index.ts`: on SIGTERM/SIGINT call `server.close()`, then `closeSseConnections()`, then `redis.disconnect()`, then exit. `services/api-gateway/src/sse.ts`: added `closeSseConnections()` to end all SSE responses and quit Redis subscriber. |
| **Auth writes to pipeline tables (A3)** | Pipeline ownership moved to pipeline-service. Added `services/pipeline-service/src/routes/internal.ts`: POST `/internal/pipeline/default-for-org` (body `{ organizationId }`) creates default pipeline + stages in a transaction; idempotent if default already exists. Auth-service signup (new-org branch) no longer inserts into `pipelines`/`stages`; after commit it calls pipeline-service internal endpoint via `ServiceHttpClient`. Auth index creates `pipelineClient` and passes to auth router. Env: `PIPELINE_SERVICE_URL` (default `http://localhost:3008`). |
| **ServiceHttpClient no context (A5, S4)** | `shared/service-core/src/http-client.ts`: added optional `RequestContext` (`userId`, `organizationId`, `userRole`, `correlationId`) to request options; when set, adds headers `x-user-id`, `x-organization-id`, `x-user-role`, `x-correlation-id` to outgoing requests. Exported `RequestContext` from service-core. Callers can pass `context` in `request()`, `get()`, `post()`, etc. |

**Verification:** `npm run typecheck` and `npm test` (60 tests) pass after all changes.

---

### Remediation — High priority (Stage 2)

| Issue | Fix |
|-------|-----|
| **S3 — Logout does not revoke refresh tokens** | In `auth-service/src/routes/auth.ts`, POST `/logout` now reads the refresh token from the cookie before clearing it, hashes it, and runs `DELETE FROM refresh_tokens WHERE token = $1 OR token = $2` (hash and raw) so the token is invalidated. |
| **S5 — Signup/organization input not bounded** | In `auth-service`: signup uses `ORG_NAME_MAX_LEN` (200) and `ORG_SLUG_MAX_LEN` (100); `organizationName` is trimmed and sliced; slug is sliced before insert. In `organization.ts` PATCH: `name` and `slug` validated with the same limits; 400 with a clear message if exceeded; slug normalized and length-checked. |
| **A7 — Redis not closed on shutdown (auth + crm)** | In `service-core`: `ServiceConfig` has optional `onShutdown?: () => void \| Promise<void>`, called during graceful shutdown after server close and before pool/rabbitmq. In `auth-service` and `crm-service`: Redis is created before `createServiceApp`, and `onShutdown: () => redis.disconnect()` (crm: only if redis is not null) is passed so Redis is closed on SIGTERM/SIGINT. |
| **S6 — Transfer ownership not transactional** | In `auth-service/src/routes/organization.ts`, POST `/organization/transfer-ownership`: the four UPDATEs (organization_members x2, users x2) are run inside a single transaction (`pool.connect()`, `BEGIN`, updates, `COMMIT`, `ROLLBACK` on error, `client.release()` in `finally`). |

**Verification:** `npm run typecheck` and `npm test` (60 tests) pass. `shared/service-core` must be built before typecheck in auth/crm so `ServiceConfig.onShutdown` is present in emitted types.

---

### Remediation — Medium priority (Stage 3)

| Issue | Fix |
|-------|-----|
| **S9 — Invite accept not transactional** | In `auth-service/src/routes/invites.ts`, POST `/:token/accept`: all DB work (check existing member, INSERT organization_members) runs inside a single transaction (`pool.connect()`, `BEGIN` / `COMMIT` / `ROLLBACK`, `client.release()` in `finally`). |
| **Q5 — Event publish errors swallowed** | In `auth-service/src/routes/auth.ts`, signup’s `rabbitmq.publishEvent(event)` now logs on failure: `.catch((err) => log.warn({ message: 'Failed to publish USER_CREATED', error: ... }))`. |
| **Q12 — auditLog failures ignored** | In `auth-service/src/helpers.ts`, `auditLog` accepts optional `log?: Logger` in params; on catch it calls `params.log?.warn({ message: 'Audit log write failed', action, error })`. Organization routes pass `log` into `auditLog`. |
| **Q7 — DRY rate-limit helpers** | In `auth-service/src/routes/auth.ts`, replaced `checkSigninRateLimit`, `checkSignupRateLimit`, `checkRefreshRateLimit` with a single `checkRateLimit(redis, { keyPrefix, clientId, limit, windowMs, message })`; signup, signin, and refresh use it with the appropriate options. |
| **Q9 — DRY email/password validation** | Added `validateEmailAndPassword(body, { requirePasswordLength?: boolean })`; returns `{ email, password }` or throws. Signup uses it with `requirePasswordLength: true`, signin with `requirePasswordLength: false`. |
| **Q10 — DRY cookie + JSON response** | Added `setAuthCookiesAndRespond(res, accessToken, refreshToken, user)`; signup and signin use it instead of repeating cookie and `res.json({ user })`. Refresh still sets only access cookie (no shared helper). |

**Verification:** `npm run typecheck` and `npm test` (60 tests) pass.

---

### Remediation — Medium/Low (Stage 4)

| Issue | Fix |
|-------|-----|
| **Q11 — Signup flow under-documented** | In `auth-service/src/routes/auth.ts`: added comments for the invite path (“user joins an existing organization…”) and the new-org path (“create organization, user (owner), default team + members…; default pipeline is created later via pipeline-service”). |
| **Q8 — DRY pagination in crm** | In `crm-service/src/helpers.ts`: added `parsePageLimit(query, defaultLimit?, maxLimit?)` (returns `page`, `limit`, `offset`) and `buildPagedResponse(items, total, page, limit)` (returns `{ items, pagination }`). Companies, contacts, and deals list routes now use these helpers instead of duplicating parsing and response shape. |
| **Q15 — Magic number refresh token expiry** | In `auth-service/src/cookies.ts`: added `REFRESH_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000`. In `auth.ts`: import and use `REFRESH_EXPIRY_MS` for all refresh-token `expires_at` and TTL logic (signup, signin, refresh). |
| **Q14 — Ambiguous `d` for request body** | In `crm-service/src/routes/deals.ts` and `contacts.ts`: replaced `const d = req.body` with `const payload = req.body as Record<string, unknown>` and used `payload.*` in UPDATE logic. |

**Verification:** `npm run typecheck` and `npm test` (60 tests) pass.

---

### Remediation — Medium/Low (Stage 5)

| Issue | Fix |
|-------|-----|
| **Q13 — Heavy `any` in discovery-loop** | In `crm-service/src/discovery-loop.ts`: added `DiscoveryTaskRow`, `DiscoveryTaskParams`, `DiscoveryTaskResults`, `ParseWorkItem`, `ParticipantRow`, `ParticipantsResponse`; replaced `client: any` with `PoolClient`, `task: any` with `DiscoveryTaskRow`; replaced all `err: any` with `err: unknown` and narrowed with `err instanceof Error`; typed params/results and API responses. |
| **S10 — SSE no per-user connection limit** | In `api-gateway`: `sseClients` is now `Map<string, Set<Response>>` (per channel). Before adding a connection, if `set.size >= SSE_MAX_CONNECTIONS_PER_USER` (default 3, env `SSE_MAX_CONNECTIONS_PER_USER`) return 429. On Redis message, write to all responses in the set. On close, remove from set and unsubscribe only when set is empty. |
| **S11 — Rate limit read-then-write** | In `api-gateway/src/rate-limit.ts`: replaced GET + SET with a single `redis.incr(key, 60)`; limit check is `count > limit`. Atomic and correct under concurrency. |

**Verification:** `npm run typecheck` and `npm test` (60 tests) pass.

---

### Remediation — Low (Stage 6)

| Issue | Fix |
|-------|-----|
| **S12 — Token accepted in request body** | In `auth-service/src/routes/auth.ts`: `/verify` no longer reads token from `req.body?.token` (only cookie and Authorization header). `/refresh` no longer reads from `req.body?.refreshToken` (only cookie). Reduces risk of tokens being logged or captured via body. |
| **S13 — User enumeration on signup** | On duplicate email (23505), response message changed from "Email already exists" to "Registration failed. If you already have an account, try signing in." (still 409 CONFLICT). Avoids confirming that an email is registered. |
| **Q17 — Limit parsing inconsistency** | In `shared/service-core/src/query-utils.ts`: added `parseLimit(query, defaultVal, max)` and exported from service-core. Auth `organization.ts` uses `parseLimit(req.query, 100, 500)` for audit-logs. CRM `parsePageLimit` in `crm-service/src/helpers.ts` now uses `parseLimit(query, defaultLimit, maxLimit)` for the limit value so org and crm share the same parsing logic. |

**Verification:** `npm run typecheck` and `npm test` (60 tests) pass.

---

### Remediation — Q16: Tests for auth and deals

| Issue | Fix |
|-------|-----|
| **Q16 — Missing tests for auth and deals** | **Auth:** Added `services/auth-service/src/routes/auth.test.ts`: validation (400 for missing/invalid email, short password), successful signup with mocked pool/redis (200 + cookies), signin 400, /me 401, /verify 400, /refresh 400, /logout 204. Uses `vitest.setup.ts` for `JWT_SECRET`/`JWT_REFRESH_SECRET` so auth helpers load. **Deals:** Added `services/crm-service/src/routes/deals.test.ts`: GET list (paginated), GET :id (200/404), POST create (201 with pipeline/company, 400 for missing pipelineId/title), PUT :id (200/404), PATCH :id/stage (200/404). Mock counters for `dealCreatedTotal`/`dealStageChangedTotal`. |

**Verification:** `npm run typecheck` and `npm test` (80 tests) pass.

---

### Extended tests (post-Q16)

| Change | Description |
|--------|-------------|
| **Auth signin success + errors** | In `auth.test.ts`: added test "returns 200 and sets auth cookies on successful signin" (mocked user with bcrypt hash); "returns 401 when user not found"; "returns 401 when password is wrong". |
| **Deals extra scenarios** | In `deals.test.ts`: "returns 400 when pipeline not found"; "returns 400 when pipeline has no stages"; "creates a deal with contactId only (resolves company from contact)"; DELETE /:id — "deletes a deal" (204) and "returns 404 when deal not found". |

**Verification:** `npm run typecheck` and `npm test` (88 tests) pass.

---

### Extended tests — auth token + deals from lead

| Change | Description |
|--------|-------------|
| **Auth: /me, /verify, /refresh with valid token** | In `auth.test.ts`: GET /me — "returns 200 with user when valid access token in cookie" and "when valid Bearer token in Authorization header" (using `signAccessToken` from helpers); POST /verify — "returns 200 with user when valid token provided"; POST /refresh — "returns 200 and new access token when valid refresh cookie sent" (mocked refresh_tokens + users, cookie `refresh_token`). |
| **Test app: cookie-parser** | In `shared/test-utils`: added `cookieParser?: boolean` to `TestAppOptions` and `cookie-parser` dependency; when `cookieParser: true`, `createTestApp` uses `cookieParser()` so auth tests can send cookies. Auth tests use `createTestApp(..., { cookieParser: true })`. |
| **Deals: create from lead** | In `deals.test.ts`: "creates a deal from lead (leadId)" — mocks lead lookup, no existing deal, Converted stage, company from contact, getFirstStageId, then transaction (BEGIN, INSERT deal, UPDATE leads, INSERT stage_history, COMMIT); expects 201, `leadId` in body, and `deal.created` event. |

**Verification:** `npm run typecheck` and `npm test` (93 tests) pass.
