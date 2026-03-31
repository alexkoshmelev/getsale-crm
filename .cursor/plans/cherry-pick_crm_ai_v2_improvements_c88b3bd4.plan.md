---
name: Cherry-pick crm_ai_v2 improvements
overview: Selectively adopt the best improvements from `crm_ai_v2` into `dev` -- focusing on connection reliability, flood tracking, health UI, keepalive hardening, and operating schedule shared utils. Skip marketplace, warming, billing, integrations, and other unrelated modules.
todos:
  - id: connection-manager-hardening
    content: "Harden ConnectionManager: 15s keepalive (env configurable), 3-strike escalation, connect coalescing, AUTH_KEY_DUPLICATED, runtime error reconnect scheduling"
    status: completed
  - id: flood-persist-module
    content: "Create bd-account-flood-persist.ts, refactor telegram-invoke-flood.ts: flood_reason, flood_last_at, deferRetry, defaultFloodPersistPool, clear on first success, retry tracking"
    status: completed
  - id: flood-migration
    content: Add migration for flood_reason TEXT and flood_last_at TIMESTAMPTZ columns on bd_accounts
    status: completed
  - id: message-sender-api-update
    content: Update message-sender.ts flood invoke calls to use { pool } object, add invite link resolution pre-send
    status: completed
  - id: operating-schedule-shared
    content: Move operating schedule types and utils to shared/utils/src/operating-schedule.ts, re-export from @getsale/utils, update campaign-service and auto-responder to use shared module
    status: completed
  - id: health-computation-lib
    content: Add frontend/lib/bd-account-health.ts with computeAccountHealth pure function (level, tiles, runtimeDeferred, hasErrorDetails)
    status: completed
  - id: flood-status-panel
    content: Add FloodStatusPanel.tsx component with live countdown, reason display, post-flood guidance (48h recently-cleared state)
    status: completed
  - id: health-card-component
    content: Add BdAccountHealthCard.tsx with 4-tile health card (connection, sync, proxy, flood), collapsible error details, FloodStatusPanel integration
    status: completed
  - id: health-summary-endpoint
    content: Add GET /api/bd-accounts/health-summary backend endpoint with aggregated counts (floods, limits, warming, campaigns, risk accounts)
    status: completed
  - id: health-dashboard-page
    content: Add AccountHealthDashboard.tsx component and /dashboard/bd-accounts/health page with stat cards and risk accounts list
    status: completed
  - id: update-account-detail-page
    content: Replace inline health block in bd-accounts/[id]/page.tsx with BdAccountHealthCard component, update BDAccount type with flood_reason/flood_last_at
    status: completed
isProject: false
---

# Cherry-pick Best Practices from crm_ai_v2

## Analysis Summary

`crm_ai_v2` diverged from the common ancestor `4b0153e` and has **395 files changed, +26k/-2k lines**. Most changes fall into: marketplace, warming, billing, integrations, discovery, organizational proxies, account analyzer -- none of which we need right now.

However, several improvements are directly relevant, battle-tested, and safe to adopt:

---

## What to adopt (prioritized)

### 1. Connection Manager Hardening

**Problem on `dev`:** keepalive runs every **5 minutes** (too infrequent for SOCKS5/firewall idle timeouts); single keepalive failure immediately triggers fatal auth check with no escalation; non-timeout runtime errors are silently logged; no connect coalescing for concurrent calls; `AUTH_KEY_DUPLICATED` not in fatal list.

`**crm_ai_v2` fixes:**

- Keepalive interval: **15 seconds** (configurable via `TELEGRAM_KEEPALIVE_INTERVAL_MS` env var) -- this beats firewall idle timeouts and SOCKS5 proxy keepalive
- **3-strike keepalive failure escalation** -- lets GramJS `autoReconnect` handle 1-2 transient blips before our app intervenes
- **Connect coalescing** via `connectingNow` Map -- prevents duplicate GramJS clients when concurrent requests hit `connectAccount`
- Non-timeout runtime errors now schedule a debounced reconnect (not silently ignored)
- `AUTH_KEY_DUPLICATED` added to fatal auth codes
- Pre-connect `is_active` check from DB

**Files:** [services/bd-accounts-service/src/telegram/connection-manager.ts](services/bd-accounts-service/src/telegram/connection-manager.ts)

### 2. Flood Tracking Improvements (bd-account-flood-persist.ts)

**Problem on `dev`:** flood persist/clear is inline in `telegram-invoke-flood.ts`; no `flood_reason` stored; no `deferRetry` mode; retry failure not tracked; on-success does not clear flood markers; all callers pass raw `Pool` (5th positional arg).

`**crm_ai_v2` fixes:**

- **New module** `bd-account-flood-persist.ts` with `recordBdAccountTelegramFlood` / `clearBdAccountTelegramFlood`
- Stores `**flood_reason`** (op + error message, capped 900 chars) and `**flood_last_at**` in addition to `flood_until` -- this enables the FloodStatusPanel to show *why* the flood happened
- `**deferRetry*`* mode: persist flood to DB and rethrow immediately (no in-process sleep) -- useful for discovery/long-running batch paths where blocking the worker is wasteful
- `**defaultFloodPersistPool**` pattern via `setTelegramFloodPersistPool()` so paths that don't thread `pool` explicitly (sync, search, participants) can still record floods
- On **first success**, `clearBdAccountTelegramFlood` is called (currently `dev` never clears on initial success, only after retry)
- On **retry failure**, records flood again with `${op}(retry)` suffix

**Files:**

- New: [services/bd-accounts-service/src/bd-account-flood-persist.ts](services/bd-accounts-service/src/bd-account-flood-persist.ts)
- Modified: [services/bd-accounts-service/src/telegram/telegram-invoke-flood.ts](services/bd-accounts-service/src/telegram/telegram-invoke-flood.ts)
- Modified: [services/bd-accounts-service/src/telegram/message-sender.ts](services/bd-accounts-service/src/telegram/message-sender.ts) -- pass `{ pool: this.pool }` object instead of raw pool

**DB migration:** Add columns `flood_reason TEXT`, `flood_last_at TIMESTAMPTZ` to `bd_accounts`. (Keep existing `flood_wait_until` and `flood_wait_seconds` for backward compatibility, but also add `flood_until` as the new canonical column used by `crm_ai_v2`. Alternatively, we can keep using `flood_wait_until` and add only the missing reason/last-at fields.)

### 3. Operating Schedule in shared/utils

**Problem on `dev`:** `isWithinScheduleAt`, `dateInTz`, schedule types live in [services/campaign-service/src/helpers.ts](services/campaign-service/src/helpers.ts) -- the campaign-service auto-responder module duplicates some of this logic, and `bd-accounts-service` has its own copy.

`**crm_ai_v2` fix:** A canonical `OperatingSchedule` type and utility functions in [shared/utils/src/operating-schedule.ts](shared/utils/src/operating-schedule.ts), exported from `@getsale/utils`:

- `OperatingSchedule` type
- `dateInTz(d, tz)` 
- `isWithinOperatingScheduleAt(d, schedule)`
- `isWithinOperatingSchedule(schedule)`
- `isWithinCampaignAndAccountScheduleAt(d, campaign, account)` -- intersection check
- `nextIntersectionSlot(from, campaign, account)` -- 15-min step search for next valid window

### 4. Frontend Health UI Components

**Problem on `dev`:** The account detail page has a basic inline health block. No dedicated components for reuse. No computed health level. No Flood Status Panel with post-flood guidance.

`**crm_ai_v2` improvements to adopt:**

- `**bd-account-health.ts`** -- pure function `computeAccountHealth(account)` returning `{ level: ok|attention|critical, tiles[], runtimeDeferred, hasErrorDetails }`. Axes: connection, sync, proxy, flood.
- `**BdAccountHealthCard.tsx**` -- 4-tile health card with color-coded variants (ok/warning/error/neutral), collapsible error details, flood panel integration, runtime-deferred CTA.
- `**FloodStatusPanel.tsx**` -- live countdown, reason display, post-flood guidance links (with doc URL from i18n). Shows "recently cleared" state for 48h after flood ends.
- **Health summary endpoint** `GET /api/bd-accounts/health-summary` -- aggregated counts (flood active, limits configured, warming running, campaign status, risk accounts).
- `**AccountHealthDashboard.tsx`** -- stat cards + risk accounts list for the `/health` page.

### 5. Message Sender: Invite Link Resolution

`**crm_ai_v2` adds:** Before sending, if `chatId` is an invite link, resolve it via `resolveChatFromInputGlobal` / `peerChatIdFromResolveBasic` from `chat-sync-resolve.ts`, with a 300ms delay after resolution. This prevents send failures when campaigns target channels/groups by invite link.

**Files:** [services/bd-accounts-service/src/telegram/message-sender.ts](services/bd-accounts-service/src/telegram/message-sender.ts)

---

## What NOT to adopt now

- Marketplace (accounts, proxies, skills, credits) -- 1000+ lines, separate feature
- Warming loop and playbook -- separate feature
- Account analyzer and profile scoring -- nice but separate feature
- Integration service (HubSpot, Notion, Pipedrive, webhooks, OAuth)
- Billing (NowPayments, Stripe unified, credits) -- separate feature
- Discovery contact labels, phone E164 utils -- useful but not urgent
- Organization proxies (`bd_organization_proxies`, `proxy-pool.ts`, `org-proxies.ts` routes) -- significant schema change, can be done separately
- `ai_responder_configs` table (separate from `bd_accounts` columns) -- our current inline `auto_responder`_* columns on `bd_accounts` work fine for now
- Account role/category/source system -- nice but separate feature
- BD accounts layout with tabs/subtabs -- optional UI chrome

---

## Migration Strategy

We need one new migration to add the missing columns:

```sql
ALTER TABLE bd_accounts
  ADD COLUMN IF NOT EXISTS flood_reason TEXT,
  ADD COLUMN IF NOT EXISTS flood_last_at TIMESTAMPTZ;
```

The existing columns (`flood_wait_until`, `flood_wait_seconds`, `timezone`, `working_hours_*`, `working_days`, `auto_responder_*`) stay unchanged. We use `flood_wait_until` as the canonical "until" field (not `flood_until` from `crm_ai_v2`), keeping the `flood-persist` module adapted to our schema.

---

## Telegram API Correctness Notes

Per GramJS docs and the Telegram API:

1. `**setTyping` TTL = ~5 seconds** -- our campaign loop's `TYPING_STATUS_TTL_MS = 5500` is correct. `crm_ai_v2` uses the same value. We should keep refreshing every ~5s for long messages.
2. `**floodSleepThreshold`** (GramJS default: 60s) -- GramJS auto-sleeps + retries floods below this threshold. Our `telegramInvokeWithFloodRetry` catches floods *after* GramJS gives up (i.e., when `seconds > floodSleepThreshold` or retries exhausted). The `crm_ai_v2` approach of recording flood reason and clearing on success is correct.
3. **Keepalive at 15s** aligns with beating SOCKS5 proxy idle timeouts (typically 60-120s). Our current 5-minute interval is too infrequent and explains proxy disconnection issues.
4. `**AUTH_KEY_DUPLICATED`** is a real Telegram error when the same session is used from two instances simultaneously -- correctly treated as fatal in `crm_ai_v2`.

