# Текущее состояние системы (as-is): код и документация

| Поле | Значение |
|------|----------|
| **Версия** | 2.15 |
| **Дата** | 2026-03-20 |
| **Связанные документы** | [TARGET_SAAS_CRM_ARCHITECTURE.md](TARGET_SAAS_CRM_ARCHITECTURE.md) (цель), [MIGRATION_TO_TARGET_ARCHITECTURE.md](MIGRATION_TO_TARGET_ARCHITECTURE.md) (переход) |
| **Опора** | [ARCHITECTURE.md](ARCHITECTURE.md), [STATE_AND_ROADMAP.md](STATE_AND_ROADMAP.md), [INTERNAL_API.md](INTERNAL_API.md), [ai_docs/develop/audits/2026-03-18-full-system-audit.md](../ai_docs/develop/audits/2026-03-18-full-system-audit.md) |

Документ фиксирует **фактическую** картину на момент аудита: стек, сервисы, потоки, границы данных, дублирование и нарушения разделения ответственности. Выборка по коду репрезентативна (не каждая строка каждого файла).

---

## 1. Стек и топология

- **HTTP:** Express, общий bootstrap через `@getsale/service-core` (`createServiceApp`: пул PostgreSQL, RabbitMQ, метрики, health/ready, internal auth, graceful shutdown).
- **Данные:** одна PostgreSQL для всех сервисов; миграции Knex в `migrations/`. В рантайме сервисы используют `pg` Pool напрямую (`pool.query` / клиент в транзакциях).
- **Кеш и real-time:** Redis (сессии, rate limit, adapter для Socket.io).
- **События:** RabbitMQ, доменные типы в `@getsale/events`.
- **Вход:** API Gateway (JWT, заголовки `X-User-Id`, `X-Organization-Id`, `X-Internal-Auth` к бэкендам).
- **Фронтенд:** Next.js App Router (`frontend/app`), Zustand, axios `apiClient`, Tailwind.

Подробная таблица сервисов совпадает с [ARCHITECTURE.md](ARCHITECTURE.md) (Gateway, Auth, User, BD Accounts, CRM, Pipeline, Messaging, Automation, Analytics, Team, WebSocket, AI, Campaign, Activity).

---

## 2. Сервисы: ответственность и типовые паттерны кода

| Сервис | Роль | Паттерн в коде |
|--------|------|----------------|
| **api-gateway** | Прокси, rate limit, JWT | `proxies.ts`, заголовки к downstream |
| **auth-service** | Регистрация, JWT, организации | `validation.ts` (Zod: `Au*` — auth, org, workspace, invite param, 2FA; `AU_ORG_*_MAX_LEN`); маршруты + вызов pipeline internal для дефолтной воронки |
| **user-service** | Профиль, Stripe | `validation.ts` (Zod: `Us*` — профиль, upgrade подписки); HTTP + webhooks |
| **bd-accounts-service** | GramJS, синк чатов, отправка в TG | `validation.ts`, фасад `telegram/index.ts`, `telegram/chat-sync*.ts`, `telegram/telegram-invoke-flood.ts`, `telegram/chat-sync-comment-participants.ts`, `routes/sync.ts` + `sync-routes-*.ts`, `message-db.ts`, `event-handlers.ts`; `ServiceHttpClient` → messaging (**+ `metricsRegistry`**); поиск + **GetParticipants / GetHistory / GetFullChat** с FloodWait-retry; **`GET .../comment-participants`** (авторы комментариев к постам канала) |
| **crm-service** | CRM CRUD, discovery/parse задачи | `validation.ts` (Zod: contact discovery — `DiscoveryTaskCreateSchema` discriminatedUnion `search` \| `parse`, `DiscoverySearchParamsSchema` / `DiscoveryParseTaskParamsSchema` с опциональным **`accountIds`** 1–10; parse flow `ParseResolveSchema` / `ParseStartSchema`); `helpers.ts` реэкспортирует `parsePageLimit` / `buildPagedResponse` из `@getsale/service-core`; `ServiceHttpClient` → bd-accounts / campaign (**+ `metricsRegistry`**); `discovery-loop.ts` — ротация `accountIds` при **429/502/503**; parse **`channel` + `linkedChatId`** → bd-accounts **`comment-participants`**; `pushParseProgress` → Redis **`parse:progress:{taskId}`**; **`parse.ts`** SSE — подписка на Redis + опрос БД |
| **pipeline-service** | Воронки, лиды | `validation.ts` (Zod: `Pl*` — pipelines, stages, lead create); internal default pipeline; события |
| **messaging-service** | Чаты, сообщения, internal API для BD | `validation.ts` (Zod: send, shared-chat, deals, internal); `routes/chats.ts` (HTTP), `bd-sync-chats-fetch.ts`, `chats-stats-and-pins-queries.ts`, `chats-list-helpers.ts`, `messages-send.ts`, `internal.ts`; `ServiceHttpClient` → bd-accounts, → AI (**65s**, `MESSAGING_AI_HTTP_TIMEOUT_MS`) — **+ `metricsRegistry`** |
| **campaign-service** | Кампании, воркер отправок | `campaign-loop.ts`, `validation.ts`, `ServiceHttpClient` → pipeline / messaging / bd-accounts / AI (**+ `metricsRegistry`**) |
| **automation-service** | Правила, SLA | События + `ServiceHttpClient` → CRM / pipeline (**15s**, `AUTOMATION_*_HTTP_TIMEOUT_MS`, **`metricsRegistry`**) |
| **ai-service** | Summarize, drafts, campaign rephrase | `validation.ts` (Zod: `Ai*` — draft generate, search queries, campaign rephrase); rate limiter; OpenAI/OpenRouter |
| **websocket-service** | Доставка событий в UI | Redis bridge, JWT на сокете |
| **team-service** | Участники, инвайты, назначения | `validation.ts` (**`Tm*`** схемы); роуты members / invites / clients |
| **analytics-service** | Дашборды, метрики | `validation.ts` (**`An*`**); query Zod на summary и BD-аналитике |
| **activity-service** | Лента активности орг. | `validation.ts` (**`Ac*`**); список с `validate(..., 'query')` |

**Общее ядро:** `asyncHandler`, `validate(Zod)`, `AppError`, опционально `withOrgContext` для установки `app.current_org_id` в сессии БД, `ServiceHttpClient` с retry/circuit breaker для межсервисных вызовов.

---

## 3. Границы данных и риски (факт)

Документ [TABLE_OWNERSHIP_A1.md](../ai_docs/develop/TABLE_OWNERSHIP_A1.md) описывает миграцию владения: messaging — владелец `messages`/`conversations`; bd-accounts — `bd_accounts` и `bd_account_sync_*`; большая часть записи сообщений из BD идёт через internal API messaging.

**Что остаётся спорным / гибридным:**

1. **Fallback при удалении BD-аккаунта.** В `bd-accounts-service` при удалении аккаунта сначала вызывается `POST /internal/messages/orphan-by-bd-account`; при ошибке выполняется локальный `UPDATE messages SET bd_account_id = NULL` — см. `services/bd-accounts-service/src/routes/accounts.ts`. Это осознанный fallback при недоступности messaging, но формально BD снова пишет в `messages`. Каждый такой случай учитывается метрикой `bd_accounts_messaging_orphan_fallback_total` на `/metrics` bd-accounts (алерт `BdAccountsMessagingOrphanFallback`, runbook [RUNBOOK_ORPHAN_MESSAGES.md](RUNBOOK_ORPHAN_MESSAGES.md)).

2. **Прямые UPDATE/INSERT/DELETE в слое Telegram (A3 bypass).** В **`telegram/message-db.ts`** при отсутствии `messagingClient` в `MessageDb` — fallback SQL; в штатном **`index.ts`** клиент всегда передаётся. Наблюдаемость bypass: **`bd_accounts_message_db_sql_bypass_total`**, лог `message_db_sql_bypass`, алерт **`BdAccountsMessageDbSqlBypass`** (см. [DEPLOYMENT.md](DEPLOYMENT.md), [TABLE_OWNERSHIP_A1.md](../ai_docs/develop/TABLE_OWNERSHIP_A1.md) §A3). При наличии клиента — только internal API messaging. Хендлеры — **`telegram/event-handlers.ts`**: create/edit/delete через `MessageDb`. Устаревший **`src/telegram-manager.ts`** **удалён**.

3. **Чтение `bd_account_sync_chats` из messaging.** По состоянию на 2026-03-20 **снято**: список чатов и поиск идут через internal API bd-accounts; в messaging остаётся только подстановка JSON в SQL (`json_to_recordset`). Прямых `SELECT`/`JOIN` к `bd_account_sync_chats` в `messaging-service` нет.

4. **Двунаправленный HTTP.** Messaging вызывает BD (send, shared chat, history); BD вызывает Messaging (ensure, create message, edit/delete by telegram). Это нормально операционно, но требует жёстких контрактов и наблюдаемости (см. [INTERNAL_API.md](INTERNAL_API.md)).

---

## 4. Дублирование и размытие ответственности: бэкенд

### 4.1 Пагинация и формат ответов

- **`parsePageLimit`** и **`buildPagedResponse`** — канон в **`@getsale/service-core`** (`shared/service-core/src/query-utils.ts`, реэкспорт из входа пакета). **crm-service** реэкспортирует их из `helpers.ts` для обратной совместимости импортов в роутерах CRM.
- **Уже на общем слое (C1):** списки в **pipeline** (`GET .../leads`), **messaging** (`messages-list`), **campaign** (список кампаний и участники — `parsePageLimit`; тело ответа списка кампаний расширено `summary`, поэтому не всегда через `buildPagedResponse`), **CRM** (contacts, companies, deals и т.д.).
- **Точечный локальный расчёт** остаётся там, где контракт ответа не `{ data, total, page, limit }` или нужен узкий лимит без page — например **messaging** `chats.ts` (лимит для поиска через `Math.min`/`parseInt`), плюс везде, где используют только **`parseLimit`** / **`parseOffset`** для не-page API.

### 4.2 Валидация

- Явный файл `validation.ts` есть у **crm-service**, **campaign-service**, **automation-service**, **`bd-accounts-service`**, **`messaging-service`**, **`pipeline-service`**, **`user-service`**, **`auth-service`**, **`ai-service`**, **team-service**, **analytics-service**, **activity-service**. **api-gateway** — исключение (прокси), см. `.cursor/rules/backend-standards.mdc`.

### 4.3 Крупные модули (нарушение SRP)

- `services/bd-accounts-service/src/telegram/chat-sync.ts` — композиция HTTP-фасада + **`tryAddChatFromSelectedFolders`** (SQL, `ContactManager`); диалоги/фильтры/push папок — `chat-sync-dialogs.ts`; leave / revoke-delete — `chat-sync-channel-actions.ts`; create shared megagroup — `chat-sync-shared-chat.ts`; поиски — `chat-sync-search.ts`; участники — `chat-sync-participants.ts`; resolve — `chat-sync-resolve.ts`.
- `services/bd-accounts-service/src/routes/sync.ts` — только монтаж роутера; обработчики — `sync-routes-dialogs-read.ts`, `sync-routes-folders-write.ts`, `sync-routes-chats-sync.ts`, `sync-routes-discovery.ts` (C3).
- `services/campaign-service/src/routes/campaigns.ts` — толстый роутер с бизнес-логикой.
- **Роуты как «контроллер + репозиторий»:** повсеместно SQL и оркестрация в одном handler без выделенного слоя данных.

### 4.4 Логирование при старте

- Часть сервисов логирует падение через `log.error`, часть — через `console.error` в `main().catch` (неединообразие стандарта «не использовать console»).

### 4.5 Модуль отправки сообщений

- Логика `POST .../send` в `services/messaging-service/src/routes/messages-send.ts` (схема тела — `MsgSendMessageSchema` в `validation.ts`), подключение из `messages.ts` через `registerSendRoutes`.

---

## 5. Дублирование и слои: фронтенд

- **BD-отображение:** канон — `frontend/lib/bd-account-display.ts`; страницы re-export через локальные `utils.ts` / `messaging/utils.ts`.
- **Тип `BDAccount`:** канон — `frontend/lib/types/bd-account.ts`; приложения re-export из `messaging/types` и `bd-accounts/types`.
- **Аватар аккаунта:** реализация — `components/bd-accounts/BdAccountAvatar.tsx`; `components/messaging/BDAccountAvatar.tsx` — алиас; `AccountAvatar` в bd-accounts — ещё один алиас.
- **Паттерн аватаров чатов** повторяется (messaging `ChatAvatar`, pipeline `LeadAvatar` и т.д.).
- **Правило vs практика:** в `.cursor/rules/frontend-standards.mdc` вызовы через `lib/api/<domain>.ts`; пути **BD-аккаунтов** сведены в `frontend/lib/api/bd-accounts.ts` (включая discovery-обёртки и медиа URL). Для остальных доменов возможны прямые `apiClient` в страницах/хуках — см. grep по репозиторию при ревью.
- **Contact discovery:** `app/dashboard/discovery/page.tsx` — поиск с мультивыбором BD (до 10), в API `params.accountIds` или `bdAccountId`; пошаговый parse уже использовал мультивыбор в `ParseSettingsForm`.
- **Формы:** в зависимостях нет react-hook-form/zod на уровне проекта; валидация часто императивная в обработчиках submit.

---

## 6. Документация: покрытие и рассинхрон

- **Сильные стороны:** `docs/` содержит архитектуру, флоу Telegram, кампаний, парсинга, outreach best practices, internal API; `ai_docs/develop/audits/` — серия полных аудитов с remediation.
- **Вход для разработчика:** [docs/INDEX.md](INDEX.md) + ссылки в корневом [README.md](../README.md) (целевая / as-is / миграция).
- **ADR:** канон **`docs/adr/`** ([README](adr/README.md)), процесс — [CONTRIBUTING.md](../CONTRIBUTING.md); `ai_docs/` — вспомогательные материалы, не дубль полного текста ADR.

---

## 7. Поведенческие особенности домена (зафиксированные в доках)

- **Кампании:** при старте в участники попадают только контакты с непустым `telegram_id`; сценарий «127 в аудитории → 0 участников» описан в [CAMPAIGN_FLOW_AND_LOGS.md](CAMPAIGN_FLOW_AND_LOGS.md).
- **Sync list:** входящие апдейты из TG отбрасываются, если чата нет в `bd_account_sync_chats`; исходящая отправка кампании и ручная отправка могут добавлять чат в sync после успеха — там же.

---

## 8. Краткая сводка проблем

| Категория | Проявление |
|-----------|------------|
| **Границы данных** | Fallback orphan в BD при недоступности messaging; прямой SQL в `message-db` без `messagingClient` |
| **DRY** | Остаточная копипаста пагинации в отдельных роутерах |
| **SRP** | Толстые роутеры campaign/messaging; крупные `chat-sync.ts` / `sync.ts` в bd-accounts |
| **Консистентность стандартов** | `validation.ts` не везде; `console.error` vs logger |
| **Доки** | Разброс `docs` vs `ai_docs` (ADR канонизирован в `docs/adr/`) |

Следующий шаг — [MIGRATION_TO_TARGET_ARCHITECTURE.md](MIGRATION_TO_TARGET_ARCHITECTURE.md).

---

## Примечание к версии 1.6 (2026-03-20)

C3: в [`chat-sync-search.ts`](../services/bd-accounts-service/src/telegram/chat-sync-search.ts) — SearchGlobal + SearchPosts (`searchPublicChannelsByKeyword`). Дальше: `searchByContacts`, resolve/участники — [MIGRATION_TO_TARGET_ARCHITECTURE.md](MIGRATION_TO_TARGET_ARCHITECTURE.md).
