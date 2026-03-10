# Project Audit Report: Full Project + New Feature (Contact Discovery)

**Date:** 2026-03-08  
**Scope:** Full project (services/, frontend/app, migrations) + new feature (Telegram group search, participant parsing, contact_telegram_sources, filters in campaigns, contact card groups)  
**Audited by:** senior-reviewer + security-auditor + reviewer

---

## Executive Summary

**Overall Health Score:** 0.0/10

The score is heavily impacted by the number of Critical and High findings. Addressing Critical items first will allow the score to reflect actual improvements.

| Severity | Architecture | Security | Code Quality | Total |
|----------|-------------|----------|--------------|-------|
| Critical | 2 | 1 | 4 | **7** |
| High | 3 | 4 | 6 | **13** |
| Medium | 3 | 5 | 6 | **14** |
| Low | 2 | 3 | 4 | **9** |

**Recommendation:** Fix 7 Critical issues before next release (internal auth, swallowed errors, validation gaps, duplicate imports). Then address High: rate limits, error leakage, body limits, TelegramManager split, frontend API usage, validation consistency.

---

## Critical Issues (fix immediately)

### Architecture

- **[A1] Shared database with no table ownership** — All services share one PostgreSQL; multiple writers for `contacts` (crm + campaign). Document ownership or centralize contact creation (e.g. crm only; campaign calls crm or reads only).
- **[A2] God class: TelegramManager** — `services/bd-accounts-service/src/telegram-manager.ts` (~3 980 lines). Split by responsibility (connection, sync, message handler, persistence).

### Security

- **[S1] Backend services accept unauthenticated requests when INTERNAL_AUTH_SECRET is unset** — `shared/service-core/src/middleware.ts`. When unset, internalAuth() does not enforce secret; forged `x-user-id` / `x-organization-id` can impersonate. **Action:** Always set INTERNAL_AUTH_SECRET in every environment; ensure backends are not directly exposed.

### Code Quality

- **[Q1] Swallowed errors** — RabbitMQ `publishEvent` failures caught with empty `catch (_) {}` in campaign-service (campaigns.ts, execution.ts). Publish failures are invisible. Log and/or retry.
- **[Q2] Zod validation gaps** — Campaign POST/PATCH use manual checks; `targetAudience`, `schedule`, `leadCreationSettings` not validated by schema. Add Zod schemas.
- **[Q3] Contact import body unvalidated** — CRM POST `/import` and campaign from-csv read body without Zod; malformed/oversized payloads not rejected. Add schema validation.
- **[Q4] Duplicate Logger import** — `services/bd-accounts-service/src/telegram-manager.ts`: Logger imported twice; remove duplicate.

---

## High Priority Issues (fix soon)

### Architecture

- [A3] Campaign-service writes to contacts (from-csv); duplicates crm contact creation. Centralize or document.
- [A4] No repository layer; direct `pool.query` in routes everywhere. Introduce thin repositories.
- [A5] Business logic inside route handlers; no application/domain layer. Extract use cases.

### Security

- [S2] No rate limiting on signin/signup — auth-service; add per-IP limits (e.g. 5–10 failed signin per 15 min).
- [S3] Gateway proxy exposes backend error messages (`err.message`) to clients — api-gateway onError. Return generic message only; log details server-side.
- [S4] Messaging service forwards backend error text to client — messages.ts. Map to generic user message.
- [S5] Large request bodies not limited — CRM import, campaign from-csv, bd-accounts sync-chats. Enforce max body size and max rows/array size.

### Code Quality

- [Q5] TelegramManager god class (same as A2).
- [Q6] Long handler: `setupEventHandlers` ~300+ lines; high complexity.
- [Q7] Extensive `any` usage across gateway, bd-accounts, messaging, campaign. Strengthen types.
- [Q8] CRM page ~914 lines; exceeds 300-line guideline. Split into subcomponents/hooks.
- [Q9] CRM page calls `apiClient.get` directly instead of via `lib/api/crm`. Use API layer.
- [Q10] Contact update uses manual safeParse instead of `validate()` middleware; inconsistent.

---

## Medium Priority Issues (plan for next sprint)

Architecture: [A6] Cross-service HTTP without formal contracts; [A7] API gateway single point of growth; [A8] Messaging-service reads/writes multiple domains.  
Security: [S6] WebSocket CORS fallback to `*`; [S7] dangerouslySetInnerHTML in layout (static script); [S8] Contact import/CSV lack schema validation; [S9] group-sources/contacts params not validated; [S10] Default DB credentials in dev.  
Code Quality: [Q11] Long route handlers (campaigns list, participants stats); [Q12] Repeated "account not found" pattern in sync; [Q13] Conversations row typing with `any`; [Q14] Large inline loop in sync-chats; [Q15] Test coverage gaps (crm, bd-accounts, campaign execution); [Q16] Error handling in catch blocks (err?.message without narrowing).

---

## Low Priority / Suggestions

Architecture: [A9] Inconsistent error handling for ServiceHttpClient; [A10] Frontend structure OK; when adding "Contact discovery", use clear area (e.g. dashboard/discovery/).  
Security: [S11] Auth cookie options (httpOnly, secure, sameSite); [S12] Logging of sensitive data; [S13] Security headers (CSP, X-Frame-Options, HSTS).  
Code Quality: [Q17] Magic numbers (audience limit, picker limit); [Q18] Missing JSDoc; [Q19] @ts-nocheck in telegram-manager; [Q20] ContactDetail could live in components/crm/ContactDetail.tsx.

---

## New Feature: Contact Discovery (Consolidated Assessment)

**Feature:** Telegram group search + participant parsing; table `contact_telegram_sources`; separate UI section; filters in campaigns (keyword, group); contact card shows "groups".

### Architecture (from senior-reviewer)

- **Table ownership:** Treat **crm-service** as owner of `contact_telegram_sources`. crm-service does all writes and contact-card read; campaign-service only reads for audience filters. Same DB — no new DB.
- **Import-from-group:** Prefer **crm-service** for `POST import-from-group` (e.g. `/api/crm/contacts/import-from-telegram-group`). It calls bd-accounts (search-groups, participants), upserts contacts, writes `contact_telegram_sources`. Campaign-service only reads for filters. If kept in campaign-service, document as second "audience import" writer and align validation/events with crm.
- **bd-accounts:** GET search-groups and GET participants stay in bd-accounts; add timeouts and size limits. No need for bd-accounts to know about contacts or contact_telegram_sources.
- **Campaign filters:** Implement in campaign-service by extending audience query with join/filter on `contact_telegram_sources`. Add indexes on `(organization_id, telegram_chat_id)` and `(organization_id, search_keyword)`.
- **Contact card:** crm-service GET /api/crm/contacts/:id returns `telegramGroups` from `contact_telegram_sources`.
- **New coupling:** If import is in crm-service, crm will call bd-accounts (first time). Use ServiceHttpClient and document.

### Security (from security-auditor)

- **search-groups / participants:** Validate query params (bdAccountId UUID, telegramChatId string max length). Enforce org scoping (bd_account belongs to user org). Consider per-org rate limits for expensive Telegram operations.
- **POST import-from-group:** Validate body with Zod (bdAccountId, telegramChatId, optional searchKeyword); enforce max body size; require bd_account ownership by org; cap contacts per request (e.g. 5k–10k).
- **contact_telegram_sources:** Chat titles/keywords can be PII. Document purpose and legal basis; scope access by organization_id; include in data deletion procedures.
- **Contact card groups:** Return only org-scoped data from contact_telegram_sources.
- **Telegram API:** Credentials from env only (good). Add app-side rate limits/quotas for search and participants to avoid abuse and Telegram restrictions.

### Code Quality (from reviewer)

- **Migration:** Use naming `YYYYMMDDHHMMSS_contact_telegram_sources.ts`; export up/down; follow existing patterns; prefer new table + FK.
- **New endpoints:** Zod for all new bodies and query params; AppError for consistent errors; reuse "account not found" / org-scoped helpers.
- **Frontend:** New API functions in lib/api (crm, campaigns, bd-accounts); no direct apiClient in components. Reuse or extract ContactDetail for contact card block. Define response types for contact+telegramGroups and filter payloads.
- **import-from-group handler:** Extract core logic (fetch → map → upsert) into a dedicated function; keep route thin. Add unit test for core logic and at least one route/integration test.
- **Test coverage:** Plan tests for migration, search/participants, import-from-group, campaign filters, GET contact with telegramGroups.

---

## Priority Matrix

| ID | Issue | Severity | Effort | Priority |
|----|-------|----------|--------|----------|
| S1 | INTERNAL_AUTH_SECRET unset | Critical | Low | P0 — now |
| Q1 | Swallowed event publish errors | Critical | Low | P0 — now |
| Q2 | Campaign body validation | Critical | Medium | P0 — now |
| Q3 | Contact import validation | Critical | Medium | P0 — now |
| Q4 | Duplicate Logger import | Critical | Low | P0 — now |
| A1 | Shared DB / contact ownership | Critical | High | P1 — document first |
| A2 / Q5 | TelegramManager god class | Critical / High | High | P1 — split incrementally |
| S2 | Auth rate limiting | High | Medium | P1 — sprint |
| S3, S4 | Error message leakage | High | Low | P1 — sprint |
| S5 | Body/size limits | High | Medium | P1 — sprint |
| Q9 | apiClient in CRM page | High | Low | P1 — sprint |
| Q10 | Contact update validation | High | Low | P1 — sprint |

---

## Next Steps

1. **Immediate (before next release):** Fix S1 (set and enforce INTERNAL_AUTH_SECRET), Q1 (log/retry event publish), Q2/Q3 (Zod for campaign and import), Q4 (remove duplicate import). Optionally document A1 (table ownership) without code change.
2. **This sprint:** S2, S3, S4, S5; Q9, Q10; consider starting A2 (split TelegramManager) or A3 (centralize contact creation).
3. **Next sprint:** Medium findings (validation, CORS, tests, long handlers).
4. **New feature:** When implementing, follow New Feature section above: crm-service owns contact_telegram_sources and import-from-group; Zod and org scoping on all new endpoints; frontend via API layer; tests for new paths.

Use `/refactor [file]` for structural issues. Use `/implement` or planner + worker for security and validation fixes.

---

## Remediation applied (2026-03-08)

### Phase 1 — Critical (done)

- **S1:** `internalAuth()` in `shared/service-core/src/middleware.ts` now returns 503 when `INTERNAL_AUTH_SECRET` is not set, so backends never run in "trust any headers" mode. **Required:** set `INTERNAL_AUTH_SECRET` in `.env` for every backend and the API gateway (same value).
- **Q1:** RabbitMQ `publishEvent` failures in campaign-service (`execution.ts`, `campaigns.ts`) are now logged with `log.warn` (message, campaignId, error).
- **Q2:** Campaign POST/PATCH and from-csv use Zod: `CampaignCreateSchema`, `CampaignPatchSchema`, `FromCsvBodySchema` in `services/campaign-service/src/validation.ts`; `validate()` middleware applied.
- **Q3:** CRM POST `/import` uses `ContactImportSchema` (Zod) with `content` max 5M chars; `validate(ContactImportSchema)` applied.
- **Q4:** Duplicate `Logger` import removed from `services/bd-accounts-service/src/telegram-manager.ts`.

### Phase 2 — High (done)

- **S2:** Auth rate limiting: signin 10 attempts per IP per 15 min, signup 5 per IP per hour (`services/auth-service/src/routes/auth.ts`). Returns 429 when exceeded.
- **S3:** API gateway proxy `onError` no longer sends `details: err.message`; response is `{ error: 'Service unavailable' }`. Details logged server-side.
- **S4:** Messaging-service send/delete error responses no longer forward backend error text; generic messages "Failed to send message" / "Failed to delete message in Telegram".
- **S5:** Body/size: service-core already has `express.json({ limit: '5mb' })`. CSV import limited by Zod (5M chars). `sync-chats` limited to 2000 chats per request in bd-accounts-service.
- **Q9:** CRM page loads contact/company detail via `fetchContact(detailId)` and `fetchCompany(detailId)` from `@/lib/api/crm`; direct `apiClient` usage removed.
- **Q10:** Contact PUT/PATCH use `validate(ContactUpdateSchema)` middleware; handler reads validated `req.body` (no manual safeParse).

### Remaining (not done this pass)

- **Architecture:** A1 (document table ownership), A2/A3 (TelegramManager split, centralize contact creation).
- **Medium/Low:** S6–S10, Q11–Q20; see report above.
- **New feature (Contact Discovery):** implement per plan; follow "New Feature" section (crm-service owner, Zod, org scoping, tests).
