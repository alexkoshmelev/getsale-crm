# Текущее состояние и дорожная карта

**Дата обновления:** 2026-03-20  
**Цель:** единая картина «что сделано / что нет» и приоритеты на следующий период.

> Шапка и блок **§1.10** синхронизированы с репозиторием и [MIGRATION_TO_TARGET_ARCHITECTURE.md](MIGRATION_TO_TARGET_ARCHITECTURE.md) (v3.0) / [CURRENT_SYSTEM_AS_IS.md](CURRENT_SYSTEM_AS_IS.md) (v2.15). Детальные аудиты — в [ai_docs/develop/audits/](../ai_docs/develop/audits/). Целевая модель: [TARGET_SAAS_CRM_ARCHITECTURE.md](TARGET_SAAS_CRM_ARCHITECTURE.md).

---

## 1. Что сделано (сводка)

### 1.1 Аутентификация и воркспейсы
- Регистрация, вход, JWT (access + refresh), смена пароля (если реализовано в auth-service).
- Мульти-воркспейс: `organization_members`, инвайт-ссылки (`organization_invite_links`), страница `/invite/[token]`, accept для нового и существующего пользователя.
- Переключатель воркспейса в сайдбаре, настройки воркспейса (owner/admin), передача владения.
- Роли: owner, admin, supervisor, bidi, viewer; смена ролей на странице Team; гранулярные права (`role_permissions`), аудит (`audit_logs`, вкладка в Настройках).

### 1.2 CRM
- Компании, контакты, сделки: полный CRUD, пагинация, поиск, валидация (Zod), централизованная обработка ошибок.
- Воронка: при создании сделки подставляется первая стадия; события deal.stage.changed.
- Контакты из Telegram: при синхронизации и при получении сообщений поля из TG (first_name, last_name, username) копируются в контакты (upsert).

### 1.3 Воронка (лиды)
- Таблица `leads`: контакт в воронке = лид; привязка к pipeline/stage, order_index.
- API: GET/POST/PATCH/DELETE по лидам; список по воронке с пагинацией и фильтром по стадии.
- **Управление воронками и стадиями:** PUT/DELETE воронок и стадий в API; UI — модалка «Управление воронками» (PipelineManageModal): список воронок (добавить/редактировать/удалить), для выбранной воронки — стадии (добавить/редактировать/удалить). При удалении стадии лиды переносятся в первую другую стадию.
- Страница «Воронка»: два режима — канбан на всю высоту (drag-and-drop карточек лидов) и список с пагинацией.
- Добавление контакта в воронку: из CRM (таблица контактов + модалка контакта) и из чата (меню в шапке чата) через модалку выбора воронки.

### 1.4 BD Accounts и Telegram
- Подключение аккаунта (QR, по номеру), синхронизация папок и чатов, выбор чатов при первом подключении.
- Отправка сообщений и файлов (в т.ч. фото/аудио), лимит 2 GB; ответ на сообщение (reply_to), удаление сообщения (в т.ч. в Telegram).
- Синхронизация с Telegram: сохранение reply_to при получении из TG; исходящие не считаются непрочитанными; отправленное сообщение сразу отображается (MESSAGE_SENT с channelId/content); вставка скриншота из буфера в поле ввода.
- Папки: из TG + созданные в CRM, иконки, порядок, «Синхр. с TG»; удаление пользовательской папки.
- Закреплённые чаты (user_chat_pins), синхронизация закреплённых при folders-refetch.
- Предупреждение о безопасности синхронизации: блок «Безопасная синхронизация» на шаге выбора чатов (BD Accounts), подсказка в модалке «Управление папками» и на странице «Сообщения» (короткий текст: в TG ничего не удаляется, в CRM видны только выбранные чаты).

### 1.5 Мессенджер (UI и поведение)
- Список чатов по папкам, непрочитанные по папкам/аккаунту, поиск, фильтр по типу (все/личные/группы).
- Сообщения: баблы в стиле Telegram, галочки, LinkifyText, превью ссылок (unfurl), MediaViewer, подгрузка истории вверх, виртуальный список при >200, черновики (localStorage), ответ на сообщение (reply), реакции (БД + отправка в TG).
- ПКМ: чат (Pin, в папку, удалить), аккаунт (настройки), сообщение (реакция, удалить). Кэш blob (LRU) для аватарок и медиа.
- AI-панель: саммаризация чата (POST /api/ai/chat/summarize).

### 1.6 Команда и настройки
- Team: участники, роли, инвайты по email и по ссылке, список/отзыв ссылок и ожидающих приглашений.
- Настройки: профиль, вкладка «Рабочее пространство» (owner/admin), передача владения, журнал аудита (owner/admin), тема, язык, уведомления.

### 1.7 RBAC в Messaging и BD Accounts
- **API Gateway:** передача заголовка `X-User-Role` в messaging-service и bd-accounts-service.
- **role_permissions:** добавлены ресурсы `messaging` и `bd_accounts` (owner/admin — полный доступ `*`).
- **Messaging:** удаление сообщения (DELETE message) и открепление чата (DELETE pinned-chats) требуют прав `messaging.message.delete` и `messaging.chat.delete`.
- **BD Accounts:** удаление чата из списка (DELETE chat), отключение/включение аккаунта, удаление аккаунта — проверка владельца или прав `bd_accounts.chat.delete` / `bd_accounts.settings`.

### 1.8 Онбординг и пустые состояния
- **Пошаговый онбординг после первого входа:** модальное окно (OnboardingModal) при первом заходе в дашборд: 3 шага (компания → Telegram → сделка) с переключением «Назад»/«Далее», ссылками «Перейти в CRM/BD Accounts/Воронку», кнопками «Начать» и «Позже». Состояние «просмотрено» в localStorage (`getsale-onboarding-dismissed`).
- **Empty states с CTA:** CRM (нет компаний/контактов/сделок — кнопки «Добавить»); Воронка (нет воронок/стадий — CTA в CRM, нет лидов — ссылка «Добавить контакты из CRM в воронку»); Мессенджер (нет чатов — CTA в BD Accounts + короткий текст о безопасности синхронизации); Аналитика (нет данных — CTA «Перейти в CRM» и «Открыть воронку»); Команда (нет участников — «Пригласить»).

### 1.9 Прочее
- Command palette (⌘K): поиск по компаниям, контактам, сделкам и чатам с переходом к карточке/чату.
- Rate limiting в API Gateway (Redis), WebSocket для событий и уведомлений, звук уведомлений (mute в шапке).

### 1.10 Архитектура и миграция к целевой модели (инкремент)

Детальный план и журнал: [MIGRATION_TO_TARGET_ARCHITECTURE.md](MIGRATION_TO_TARGET_ARCHITECTURE.md). Факт «как в коде»: [CURRENT_SYSTEM_AS_IS.md](CURRENT_SYSTEM_AS_IS.md).

- **Границы данных (A):** список/поиск чатов в messaging без прямого чтения `bd_account_sync_chats` — через internal bd-accounts (**A1**). Orphan сообщений при удалении BD — через messaging internal; при сбое API — fallback SQL + метрика + алерт + [RUNBOOK_ORPHAN_MESSAGES.md](RUNBOOK_ORPHAN_MESSAGES.md) (**A2**). Обходы записи в `messages` из bd-accounts задокументированы в [TABLE_OWNERSHIP_A1.md](../ai_docs/develop/TABLE_OWNERSHIP_A1.md); SQL в `message-db.ts` без HTTP-клиента messaging — метрика `bd_accounts_message_db_sql_bypass_total`, алерт `BdAccountsMessageDbSqlBypass`, [DEPLOYMENT.md](DEPLOYMENT.md) (**A3** наблюдаемость; опционально **`BD_ACCOUNTS_MESSAGE_DB_STRICT`** — запрет bypass; полное удаление SQL-пути — долгосрочный бэклог).
- **Надёжность (B):** общий слой межсервисного HTTP (`interServiceHttpDefaults` / `ServiceHttpClient`, retry + circuit breaker, env `SERVICE_HTTP_*`), DLQ-метрики и ряд правил Prometheus ([DEPLOYMENT.md](DEPLOYMENT.md)); кампании — валидация пустой аудитории, мин. интервал между отправками с одного BD (**B3**). **B1:** счётчики **`inter_service_http_*`** на пяти сервисах + алерты **`InterServiceHttpErrorShareElevated`**, **`InterServiceHttpCircuitReject`** ([DEPLOYMENT.md](DEPLOYMENT.md)); таймауты AI / automation как ранее; [SERVICE_HTTP_CLIENT_INVENTORY.md](SERVICE_HTTP_CLIENT_INVENTORY.md). **B4:** parse **channel + linkedChatId** — комментарии (`comment-participants`); канал без linked + **`channelEngagement: 'reactions'`** — `reaction-participants` (best-effort; просмотры — счётчики для приоритизации); **`telegramInvokeWithFloodRetry`** на основных GramJS-путях bd-accounts (resolve, sync, sender, shared-chat, leave, контакты — см. [PLAN_TELEGRAM_PARSE_FLOW.md](PLAN_TELEGRAM_PARSE_FLOW.md) §1.1); Redis **`parse:progress:{taskId}`** + **ETA/speed**.
- **Код (C):** **C1** — `parsePageLimit` / `buildPagedResponse` в `@getsale/service-core` (CRM, pipeline leads, messaging messages list, campaign list/participants и т.д.). **C2/C3** — частично: хелперы messaging, нарезка bd-accounts `chat-sync*` / `sync-routes-*`. **C4** — `validation.ts` также у **team** (`Tm*`), **analytics** (`An*`), **activity** (`Ac*`), плюс ранее перечисленные; **api-gateway** — исключение в [.cursor/rules/backend-standards.mdc](../.cursor/rules/backend-standards.mdc).
- **Фронт (D):** единый `lib/api/bd-accounts`, тип `BDAccount`, аватар; разбиение `useMessagingData` на loaders/effects (**D4** частично). Contact discovery: мультивыбор BD на поиске → `accountIds` в задаче; **парсинг** — `channelEngagement` + ETA/speed на шаге прогресса ([`ParseSettingsForm`](../frontend/components/parsing/ParseSettingsForm.tsx), [`ParseProgressPanel`](../frontend/components/parsing/ParseProgressPanel.tsx)); хвосты `apiClient` — точечный grep (см. as-is §5).
- **Доки (E):** INDEX/README, ADR, CONTRIBUTING; периодически сверять этот файл (**E1**).

---

## 2. Что не сделано или неполно

- **Auth:** восстановление пароля по email, верификация email, OAuth (Google/GitHub/Telegram), account lockout, детальный audit по входам. **2FA (TOTP + recovery codes)** — реализовано в auth-service (см. API и настройки профиля); при необходимости — доработка UX и политик.
- **CRM:** массовые операции (bulk delete/update), импорт/экспорт (CSV), мягкое удаление (soft delete) при необходимости.
- **Pipeline:** история переходов по стадии, валидация правил entry/exit, авто-переходы по правилам (управление воронками/стадиями PUT/DELETE + UI уже сделано).
- **Campaign Service:** реализован (CRUD, sequences, расписание, worker, аудитория из CRM/CSV/группы TG, часть лимитов и валидаций — см. [CAMPAIGNS.md](CAMPAIGNS.md), [MIGRATION_TO_TARGET_ARCHITECTURE.md](MIGRATION_TO_TARGET_ARCHITECTURE.md) **B3**). В бэклоге: дальнейший rate limit по каналу, AI-персонализация, рефакторинг толстого `campaigns.ts` (**C2/C3**).
- **AI:** автосоздание сделки/лида из чата (правила или AI по намерению), виджеты в карточке сделки (следующий шаг, вероятность закрытия).
- **Омниканал:** модель channels/conversations, единый timeline по контакту, каналы помимо Telegram.
- **Права:** при необходимости — расширение canPermission в CRM и других сервисах (messaging и bd-accounts уже используют role_permissions).
- **Инфра:** детальные rate limits по типу операции; расширение мониторинга (дашборды, покрытие всех критичных цепочек); E2E-тесты ключевых сценариев. **Частично уже есть:** метрики `/metrics`, правила в `infrastructure/prometheus/alert_rules.yml`, DLQ-счётчики и описание в [DEPLOYMENT.md](DEPLOYMENT.md).

### 2.1 Приоритизация продуктового бэклога (§2)

Перечень выше — не один спринт. Рекомендуемый порядок для **продукта** (после закрытия горящих техзадач релиза):

1. **Доверие и доступ:** восстановление пароля и верификация email (блокируют B2B-онбординг сильнее, чем OAuth).
2. **CRM operations:** массовые действия и импорт/экспорт CSV — снижают трение ежедневных операций.
3. **Воронка:** история стадий и правила переходов — качество аналитики и автоматизации.
4. **AI в сделке** и **кампании** (доработки из §2) — после стабильности данных CRM/воронки.
5. **Омниканал** — отдельная крупная инициатива (модель каналов + timeline).

Технический хвост **B4** (просмотры, FloodWait) и **A3** (полный отказ от SQL в MessageDb) ведутся по [PLAN_TELEGRAM_PARSE_FLOW.md](PLAN_TELEGRAM_PARSE_FLOW.md) и [MIGRATION_TO_TARGET_ARCHITECTURE.md](MIGRATION_TO_TARGET_ARCHITECTURE.md), не смешивая с пунктами 1–5 без явной приоритизации PM.

### Чеклист к продакшену (критичное)

- Полные CRUD (GET by id, PUT, DELETE) по CRM, Pipeline и остальным сервисам; пагинация и поиск.
- Валидация: Zod на бэкенде (центральный `validation.ts` в основных сервисах — см. [CURRENT_SYSTEM_AS_IS.md](CURRENT_SYSTEM_AS_IS.md) §4.2); на фронте — по мере внедрения React Hook Form + Zod; бизнес-правила (стадии воронки и т.д.).
- Централизованная обработка ошибок: AppError, единый формат ответа, логирование (уже частично в service-core).
- Безопасность: rate limiting (есть в gateway), Helmet, CORS, санитизация входных данных.
- Campaign Service: CRUD кампаний, шаблоны, sequences, интеграция с Messaging.
- Надёжность: retry/circuit breaker для вызовов AI и BD Accounts; алерты по метрикам и очередям; DLQ (см. [STAGES.md](STAGES.md), [FULL_SYSTEM_AUDIT_2026.md](FULL_SYSTEM_AUDIT_2026.md)).

### Приоритетные технические задачи (аудит 2026 + текущий план миграции)

База: [FULL_SYSTEM_AUDIT_2026.md](FULL_SYSTEM_AUDIT_2026.md), [MIGRATION_TO_TARGET_ARCHITECTURE.md](MIGRATION_TO_TARGET_ARCHITECTURE.md). Рекомендуемый порядок:

1. **Reliability (B1):** Алерты **`InterServiceHttpErrorShareElevated`** / **`InterServiceHttpCircuitReject`** заведены; при необходимости подстроить пороги и добавить latency-правила; ревью покрытия по эндпоинтам.
2. **Observability:** Расширить алерты (latency, error rate по HTTP-сервисам) при необходимости; DLQ-метрики и часть правил уже заведены — см. [DEPLOYMENT.md](DEPLOYMENT.md).
3. **Парсинг / discovery (B4):** по [PLAN_TELEGRAM_PARSE_FLOW.md](PLAN_TELEGRAM_PARSE_FLOW.md) — хвост редких `invoke` без FloodRetry; фронт — `channelEngagement` и ETA/speed на Discovery; при необходимости — fallback SSE-only без WebSocket.
4. **Scale:** Стратегия партиционирования/архивации `messages`; нагрузочные проверки на большом числе conversations.
5. **Контракты данных:** [TABLE_OWNERSHIP_A1.md](../ai_docs/develop/TABLE_OWNERSHIP_A1.md) и [INTERNAL_API.md](INTERNAL_API.md) — поддерживать в актуальном виде при изменениях.

### По результатам аудита 2026-03-18

Полный отчёт: [ai_docs/develop/audits/2026-03-18-full-system-audit.md](../ai_docs/develop/audits/2026-03-18-full-system-audit.md).

**Выполнено (ремедиация):**
- **A1/S2:** Orphan messages при удалении аккаунта: основной путь — `POST /internal/messages/orphan-by-bd-account` в messaging-service; при ошибке API bd-accounts выполняет локальный `UPDATE` (fallback) с метрикой `bd_accounts_messaging_orphan_fallback_total` и алертом — см. [RUNBOOK_ORPHAN_MESSAGES.md](RUNBOOK_ORPHAN_MESSAGES.md).
- **S1:** Internal API messaging: приоритет заголовка `X-Organization-Id` над body для ensure и POST /messages.
- **S3:** В DEPLOYMENT.md добавлена рекомендация задавать INTERNAL_AUTH_SECRET в dev/staging.
- **S4:** Edit/delete-by-telegram требуют `X-Organization-Id` и проверяют `organization_id` в WHERE; bd-accounts MessageDb и event-handlers передают organizationId в контексте.
- **S5:** В production ответ валидации internal — «Validation failed» без деталей Zod.
- **A4:** GET /chats и GET /search в messaging обёрнуты в `withOrgContext`; internal ensure и POST /messages — в withOrgContext.
- **Doc:** INTERNAL_API.md дополнен эндпоинтом orphan-by-bd-account и требованием X-Organization-Id для edit/delete-by-telegram.
- **Q1 (баг):** В GET /chats внутри withOrgContext ранние выходы (channel!==telegram, !chats?.length) теперь возвращают `[]` из callback, а не вызывают res.json([]), чтобы избежать двойной отправки ответа.
- **Q2:** В bd-accounts модулях `telegram/*` во всех пустых catch добавлено логирование (log.debug): disconnect, регистрация Raw/Short/NewMessage, typing/status/read handlers, contact insert, wrap (other handlers). *(Исторически часть работ относилась к удалённому legacy `telegram-manager.ts`.)*
- **A5, Q1 (рефактор):** В messaging-service создан chats-list-helpers.ts (getSyncListQuery, getDefaultChatsQuery, normalizeChatRows, runSyncListQuery, runDefaultChatsQuery); GET /chats использует эти хелперы.
- **Общий чат в списке:** После создания общего чата с лидом чат сразу появляется в списке чатов аккаунта: в bd-accounts-service после createSharedChat выполняется INSERT в bd_account_sync_chats (peer_type=chat); при выборе аккаунта список тянется из sync-chats.

**Осталось:**
- **P0 (закрыто):** GET /chats без bdAccountId и GET /search — internal bd-accounts; журнал **A1** в [MIGRATION_TO_TARGET_ARCHITECTURE.md](MIGRATION_TO_TARGET_ARCHITECTURE.md).
- **P1:** Дальнейшее разбиение `chats.ts` при росте; сократить `any`, вынести filterToApiMessages в bd-accounts Telegram (Q3–Q4).
- **P2:** Слой репозитория / query-модули (**C2**); остатки god-модулей bd-accounts (**C3**); CSP и theme script (S15, S16); DRY API layer и типы на фронте (Q5–Q10) — **пагинация частично закрыта C1** (`parsePageLimit` в service-core, см. [CURRENT_SYSTEM_AS_IS.md](CURRENT_SYSTEM_AS_IS.md) §4.1).
- **Бэклог:** A7–A14, S6–S14, Q11–Q16; партиционирование messages; tracing; расширение тестов.

---

## 3. Рекомендуемые следующие шаги

### Ближайшие (по приоритету)

1. **Автосоздание сделки/лида из чата**  
   Правила (ключевые слова / первое сообщение) или AI; таблица правил, подписка на событие сообщения, вызов pipeline-service `POST .../leads`. См. контекст воронки и контактов из TG.

2. **Auth: email и соц. вход**  
   Восстановление пароля по email (SendGrid/Resend), верификация email, OAuth. **2FA (TOTP)** уже в auth-service — приоритизировать продуктовый UX и политики, если нужно.

3. **Надёжность и парсинг (техдолг архитектуры)**  
   **B1** — ревью breaker/retry на критичных цепочках; **B4** — этапы [PLAN_TELEGRAM_PARSE_FLOW.md](PLAN_TELEGRAM_PARSE_FLOW.md). Параллельно — **C2/C3** (толстый `campaigns.ts` и др.) по нагрузке команды.

4. **Campaign Service (развитие)**  
   Базовый сервис уже в продуктах; дальше — лимиты, AI-персонализация, рефакторинг роутеров — см. [CAMPAIGNS.md](CAMPAIGNS.md) и [MIGRATION_TO_TARGET_ARCHITECTURE.md](MIGRATION_TO_TARGET_ARCHITECTURE.md).

**Что делать дальше (рекомендация):**  
Продуктово — **автосоздание лида из чата** (если это ближайший релизный приоритет). Технически параллельно или следом — **B1/B4** и обновление **STATE_AND_ROADMAP** после каждого крупного шага (**E1**).

### Средний срок

- Unified Inbox: модель channels + conversations, единый timeline по контакту; затем подключение каналов помимо Telegram.
- Детальные rate limits (чтение vs отправка, по организации).
- Мониторинг: структурированные логи, метрики (Prometheus), дашборды и алерты.
- E2E-тесты: регистрация, вход, создание компании/контакта/сделки, подключение TG, отправка сообщения.

### Длинный срок

- Омниканал (WhatsApp, Email, Instagram DM и т.д.).
- Расширенная аналитика и отчёты, экспорт.
- Мобильное приложение или PWA.

---

## 4. Ссылки на документацию

| Документ | Назначение |
|----------|------------|
| [ARCHITECTURE.md](./ARCHITECTURE.md) | Стек, сервисы, события, безопасность. |
| [GETTING_STARTED.md](./GETTING_STARTED.md) | Запуск, порты, первый пользователь, решение проблем. |
| [TESTING.md](./TESTING.md) | Сценарии проверки и тестирования. |
| [STAGES.md](./STAGES.md) | Этапы разработки (Stage 1–7), цели и статус. |
| [MESSAGING_ARCHITECTURE.md](./MESSAGING_ARCHITECTURE.md) | Модель клиент/чат, папки, UX мессенджера. |
| [CAMPAIGNS.md](./CAMPAIGNS.md) | Кампании холодного охвата: цели и статус. |
| [MASTER_PLAN_MESSAGING_FIRST_CRM.md](./MASTER_PLAN_MESSAGING_FIRST_CRM.md) | Архитектурные решения и роли (сокращённый мастер-план). |
| [PROJECT_AUDIT_REPORT.md](./PROJECT_AUDIT_REPORT.md) | Аудит документации и кода. |
| [FULL_SYSTEM_AUDIT_2026.md](./FULL_SYSTEM_AUDIT_2026.md) | Полный системный аудит (архитектура, масштаб, AI, риски). |

**Единый источник правды по состоянию и приоритетам — этот файл (STATE_AND_ROADMAP).** После реализации задач обновлять разделы 1–3.
