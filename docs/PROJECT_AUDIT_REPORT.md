# Полный аудит документации и кода проекта

**Дата:** 2026-02 (обновлено 2026-03)  
**Область:** документация (§3–§15, PHASE 2.x), messaging-service, campaign-service, bd-accounts-service, migrations, frontend.  
**Цель:** выявить устаревшую документацию, расхождения между сервисами, технический долг и архитектурные риски. Код не изменялся — только анализ.

**Связанный отчёт:** [FULL_SYSTEM_AUDIT_2026.md](FULL_SYSTEM_AUDIT_2026.md) — полный системный аудит (архитектура, фронт/UX, AI, масштабируемость, governance, конкуренты, вердикт). Ключевые выводы: зрелость 5.5–6/10; критичные риски — общая БД без контрактов, отсутствие retry/circuit breaker при вызовах AI и bd-accounts, рост таблицы messages без партиционирования, отсутствие алертов и DLQ; приоритет — Reliability (retry/circuit breaker, алерты, DLQ), затем Scale и AI expansion. В марте 2026 выполнена очистка документации (единый источник — STATE_AND_ROADMAP, объединённые ARCHITECTURE, GETTING_STARTED, TESTING, STAGES, MESSAGING_ARCHITECTURE, CAMPAIGNS).

---

## 1. Архитектурная карта проекта

### 1.1 Сервисы (релевантные этапу 7)

| Сервис | Порт | Назначение |
|--------|------|------------|
| **api-gateway** | — | Проксирует `/api/messaging` → messaging-service, `/api/campaigns` → campaign-service, `/api/bd-accounts` → bd-accounts-service. Аутентификация, rate limit. |
| **messaging-service** | 3003 | Чаты, сообщения, conversations, lead-context, new-leads, create-shared-chat, mark-won, mark-lost. Единая точка создания conversation (ensureConversation). |
| **campaign-service** | 3012 | Кампании, участники, последовательности, статистика воронки (total_sent, total_read, total_replied, shared, won, revenue). Запуск/пауза, отправка по расписанию. |
| **bd-accounts-service** | 3007 | Telegram-клиенты, синхронизация чатов, **create-shared-chat** (CreateChannel + InviteToChannel). Вызывается messaging-service по HTTP. |
| **pipeline-service** | 3008 | Воронки, стадии, лиды, PATCH stage, lead_activity_log при смене стадии. |

### 1.2 Зависимости между сервисами

```
api-gateway
  ├── messaging-service  (GET/POST /api/messaging/*)
  ├── campaign-service  (GET/POST /api/campaigns/*)
  └── bd-accounts-service (GET/POST /api/bd-accounts/*)

messaging-service
  └── bd-accounts-service (POST /api/bd-accounts/:id/create-shared-chat) — только при создании общего чата

campaign-service
  └── (читает/пишет общую БД: conversations, campaign_*, messages)
```

- **Общая БД:** messaging-service, campaign-service, pipeline-service, bd-accounts-service используют один и тот же PostgreSQL (один DATABASE_URL в docker-compose). Таблицы `conversations`, `messages`, `campaigns`, `campaign_participants`, `campaign_sends`, `leads`, `lead_activity_log` доступны и messaging, и campaign.
- **Cross-service вызов:** только messaging → bd-accounts (create-shared-chat). Остальное — через общую БД.

### 1.3 Основные доменные сущности

| Сущность | Описание |
|----------|----------|
| **Conversation** | Один бизнес-диалог (org, bd_account_id, channel, channel_id). Поля: lead_id, campaign_id, became_lead_at, first_manager_reply_at, shared_chat_created_at, shared_chat_channel_id, won_at, revenue_amount, lost_at, loss_reason. |
| **Lead** | Состояние conversation в воронке (pipeline_id, stage_id, contact_id). |
| **Campaign** | Рассылка (participants, sequences, templates, campaign_sends). |
| **Message** | Сообщение в канале (в т.ч. системные [System] для shared/won/lost). |

### 1.4 Ключевые таблицы (миграции)

| Таблица | Миграция | Назначение |
|---------|----------|------------|
| conversations | 20250615000001 + 20250623000001 (first_manager_reply_at) + 20250624000001 (shared_chat_created_at) + 20250626000001 (shared_chat_channel_id) + 20250627000001 (won_at, revenue_amount, lost_at, loss_reason) | Состояние диалога, воронка, revenue. |
| lead_activity_log | 20250615000002 | Таймлайн лида (lead_created, stage_changed, deal_created, campaign_reply_received). |
| campaign_participants, campaign_sends | 20250217000001 (+ последующие) | Участники кампании и факты отправки. |
| messages | initial + 20250128100000 (telegram), 20250222000001 (reactions) | Сообщения + системные события. |
| organization_settings | 20250625000001 | Настройки shared_chat (titleTemplate, extraUsernames). |

### 1.5 Основные API endpoints (этап 7)

**messaging-service:**
- GET `/api/messaging/chats` — список чатов (conversation_id, lead_id, lead_stage_name, lead_pipeline_name).
- GET `/api/messaging/new-leads` — новые лиды (first_manager_reply_at IS NULL).
- GET `/api/messaging/conversations/:id/lead-context` — полный контракт Lead Panel (включая won_at, lost_at, shared_chat_channel_id).
- POST `/api/messaging/send` — отправка, проставление first_manager_reply_at.
- POST `/api/messaging/create-shared-chat` — создание группы в TG, запись shared_chat_channel_id, системное сообщение.
- POST `/api/messaging/mark-shared-chat` — legacy, только флаг shared_chat_created_at.
- POST `/api/messaging/mark-won` — won_at, revenue_amount, системное сообщение.
- POST `/api/messaging/mark-lost` — lost_at, loss_reason, системное сообщение.

**campaign-service:**
- GET `/api/campaigns` — список с mini-KPI (total_sent, total_read, total_replied, total_converted_to_shared_chat, total_won, total_revenue).
- GET `/api/campaigns/:id/stats` — воронка + конверсии + total_won, total_lost, total_revenue, win_rate, avg_time_to_shared_hours, avg_time_to_won_hours.
- GET `/api/campaigns/:id/participants` — таблица лидов (status_phase, sent_at, replied_at, shared_chat_created_at, filter=all|replied|not_replied|shared).

**bd-accounts-service:**
- POST `/api/bd-accounts/:id/create-shared-chat` — CreateChannel + InviteToChannel, возврат channelId, title.

---

## 2. Документация — актуальность

*Источник: ранее STAGE_7; сводка этапов — [STAGES.md](STAGES.md).*

| Раздел | Статус | Комментарий |
|--------|--------|-------------|
| §1 Продуктовая логика | ✅ Полностью | Совпадает с кодом: Contact, Conversation, Lead. |
| §2 Зачем Conversation | ✅ Полностью | Описание согласовано с реализацией. |
| §3 Структура страницы Messaging | ✅ Полностью | Sidebar (Новые лиды + аккаунты), Chat List, Chat Window + Lead Panel. Реализовано. |
| §3.1 Sidebar | ✅ Полностью | «Новые лиды» сверху, закреплена; правила из §11в. |
| §3.2 Chat List | ✅ Полностью | Бейдж Lead/Contact, Stage+Pipeline под именем. Контракт §11а соблюдён. |
| §3.3 Chat Window | ✅ Полностью | Чат + collapsible Lead Panel. |
| §3.4 Lead Panel | ✅ Полностью | 4 блока по §11б; контракт один ответ lead-context. |
| §4 Campaign → Messaging | ⚠ Частично | «Открыть диалог» и переход с bdAccountId+open= есть; авто-раскрытие Lead Panel при переходе реализовано. Редактирование таблицы контактов перед запуском — отдельно в UI кампании. |
| §5 Критерии появления лида | ✅ Полностью | Reply + auto_create_lead и вручную; lead_activity_log, attachLead. |
| §6 Что удалить из старого UI | ⚠ Частично | Часть упрощений сделана; явный список «что удалить» не проверялся по каждому пункту. |
| §7 Conversation — границы | ✅ Полностью | В Conversation не добавлены unread_count, assignment, tags, SLA, owner_id, priority. Добавлены только поля по PHASE 2.5–2.7 (shared, won, lost). |
| §8 UI — dumb, Backend — smart | ✅ Полностью | Фронт не вычисляет Lead/is_new; данные приходят с API. |
| §9 Приоритет действий | ✅ Полностью | Lead Panel компактный, чат в центре. |
| §10 Зафиксированные UX-решения | ✅ Полностью | Панель справа, авто-открытие только из Campaign, состояние по conversation_id. |
| §11а PHASE 2.1 Chat List | ✅ Полностью | Контракт и реализация совпадают. |
| §11б PHASE 2.2 Lead Panel | ✅ Полностью | Единый контракт lead-context, 4 блока, PATCH stage. |
| §11в PHASE 2.3 Новые лиды | ✅ Полностью | first_manager_reply_at, GET new-leads, сортировка became_lead_at DESC, удаление из списка после send. |
| §11г PHASE 2.5 Campaign UX | ✅ Полностью | Метрики, конверсии, KPI, воронка, таблица лидов, фильтры, кнопка «Создать общий чат», мини-KPI в списке кампаний. |
| §11д PHASE 2.6 Shared Chat Intelligence | ✅ Полностью | shared_chat_channel_id, 409 при повторном создании, «Открыть в Telegram», системное сообщение, avg_time_to_shared_hours. |
| §11е PHASE 2.7 Won + Revenue | ✅ Полностью | won_at, revenue_amount, lost_at, loss_reason; mark-won/mark-lost; кнопки и модалки в Lead Panel; системные сообщения; метрики и воронка до Won. |
| §12 Переломная точка | ✅ Полностью | Текст актуален. |
| §13 Backend (кратко) | ✅ Полностью | Перечень полей conversations и lead_activity_log совпадает с миграциями и кодом. |
| §14 UX-принципы | ✅ Полностью | Соответствует реализации. |
| §15 Чеклист реализации | ❌ Устарел | В документе PHASE 2.4, 2.5, 2.6, 2.7 помечены как не выполненные ([ ]). Фактически реализованы: deep-link и авто-раскрытие панели (2.4), метрики и shared (2.5), shared_chat_channel_id и контроль (2.6), won/lost и revenue (2.7). Чеклист нужно обновить: отметить 2.4–2.7 как выполненные. |

---

## 3. Реализация по PHASE

| PHASE | Описание | Статус в коде | Расхождение с доком |
|-------|----------|----------------|----------------------|
| 2.1 | Chat List: бейдж Lead/Contact, Stage+Pipeline | ✅ Реализовано | Нет. |
| 2.2 | Lead Panel: 4 блока, единый lead-context, PATCH stage | ✅ Реализовано | Нет. |
| 2.3 | Папка «Новые лиды», first_manager_reply_at, GET new-leads | ✅ Реализовано | Нет. |
| 2.4 | Campaign → Messaging deep-link, авто-раскрытие Lead Panel | ✅ Реализовано | Док §15 помечен как не сделан — обновить. |
| 2.5 | Campaign UX: метрики, воронка, таблица лидов, shared_chat_created_at | ✅ Реализовано | Док §15 помечен как не сделан — обновить. |
| 2.6 | shared_chat_channel_id, 409, «Открыть в Telegram», системное сообщение, avg_time_to_shared | ✅ Реализовано | Док §15 помечен как не сделан — обновить. |
| 2.7 | Won/Lost, revenue, mark-won/mark-lost, метрики, воронка до Won | ✅ Реализовано | Док §15 помечен как не сделан — обновить. |

---

## 4. Расхождения между сервисами и с документацией

### 4.1 Поля в БД vs документация

- **conversations:** Документ §13 перечисляет все актуальные поля. Миграции совпадают. Расхождений нет.

### 4.2 API-контракты

- **lead-context:** Документ не перечисляет явно все поля ответа. В коде возвращаются: conversation_id, lead_id, contact_name, contact_telegram_id, contact_username, bd_account_id, channel_id, pipeline, stage, stages, campaign, became_lead_at, shared_chat_created_at, shared_chat_channel_id, won_at, revenue_amount, lost_at, loss_reason, shared_chat_settings, timeline. Контракт фактически расширен по сравнению с минимальным описанием в §11б — расхождений по типам нет, поля добавлены по PHASE 2.5–2.7.

- **create-shared-chat:** Ответ: conversation_id, shared_chat_created_at, shared_chat_channel_id, channel_id, title. В доке явно не описан — ок.

- **mark-won:** body `conversation_id`, `revenue_amount?`. Док: «revenue_amount?» — совпадает. В коде при отсутствии суммы в БД пишется NULL — ок.

### 4.3 Логика метрик (campaign-service)

- **total_sent:** по доку = количество conversation_id, куда отправлено первое outbound. В коде: COUNT(DISTINCT cp.id) по campaign_sends для campaign — т.е. участники, которым отправлено хотя бы одно сообщение. Для этапа «первое outbound» это эквивалент (один участник = один «conversation» по bd_account_id+channel_id). Совпадает.

- **total_read:** первое сообщение кампании status = 'read'. В коде: first_sends + JOIN messages WHERE status = 'read'. Совпадает.

- **total_converted_to_shared_chat:** conversations с campaign_id и shared_chat_created_at IS NOT NULL. Совпадает.

- **avg_time_to_shared_hours / avg_time_to_won_hours:** по conversation, LATERAL first_sent_at из campaign_sends. Совпадает с описанием в доке.

### 4.4 Типы lead_activity_log

- Документ §13: типы lead_created, stage_changed, deal_created, campaign_reply_received. В коде: campaign-service пишет campaign_reply_received и lead_created; pipeline-service пишет в lead_activity_log при смене стадии и создании сделки. Lead-context timeline запрашивает только lead_created, stage_changed, deal_created — campaign_reply_received в таймлайн не показывается (в §11б указано «Только 3 типа»). Расхождений нет.

### 4.5 Валюта и системные сообщения

- В коде mark-won системное сообщение: «Сумма: X €» — валюта жёстко €. Документ не фиксирует мультивалютность — на текущий момент расхождения нет.

---

## 5. Технический долг

### 5.1 Отсутствие транзакций (messaging-service)

- **create-shared-chat:** последовательно: UPDATE conversations (shared_chat_created_at, shared_chat_channel_id), INSERT системного сообщения в messages. При падении после UPDATE и до INSERT состояние conversation уже «shared», но системного сообщения в истории нет. Рекомендация: обернуть в транзакцию.

- **mark-won / mark-lost:** аналогично — UPDATE conversations и INSERT системного сообщения без транзакции. Рекомендация: одна транзакция на каждый эндпоинт.

### 5.2 Проверки прав (RBAC)

- **mark-won, mark-lost, create-shared-chat, mark-shared-chat:** не вызывают canPermission. Удаление чата и удаление сообщения — проверяют messaging chat.delete / message.delete. Решение о том, кто может закрывать сделку или отмечать lost, не зафиксировано в коде (фактически любой аутентифицированный пользователь организации). Рекомендация: зафиксировать в доке политику и при необходимости добавить проверку прав для mark-won/mark-lost/create-shared-chat.

### 5.3 Валидация и границы

- **mark-won:** revenue_amount парсится, проверяется >= 0 и NaN. Верхняя граница не ограничена (очень большие числа возможны). Для numeric(12,2) переполнения не будет, но явный лимит в API не описан.

- **mark-lost:** reason обрезается до 2000 символов в коде; в БД text — ок.

- **create-shared-chat:** title до 255 символов; extra usernames из body или settings. Валидация присутствует.

### 5.4 Дублирование и «магические» строки

- Строки типов событий: 'lead_created', 'stage_changed', 'deal_created', 'shared_chat_created', 'deal_won', 'deal_lost' — в коде строки, константы не вынесены в общий модуль. Риск опечаток при расширении.

- Фильтры участников кампании: 'all' | 'replied' | 'not_replied' | 'shared' — дублируются в campaign-service и frontend. Рекомендация: общие константы или enum на фронте и в бэкенде.

### 5.5 Индексы

- **conversations:** есть индексы по organization_id, bd_account_id, contact_id, lead_id, campaign_id, last_viewed_at; частичный по (campaign_id) WHERE shared_chat_created_at IS NOT NULL. Отдельного индекса по (organization_id, lead_id, first_manager_reply_at) для GET new-leads нет — запрос фильтрует по organization_id и first_manager_reply_at IS NULL и lead_id IS NOT NULL. При росте данных может понадобиться составной индекс под new-leads.

### 5.6 Возможные race conditions

- **mark-won / mark-lost:** проверка «уже won/lost» делается SELECT, затем UPDATE. Между ними другой запрос может выполнить mark-won. Защита — только 409 при повторном вызове; строгой блокировки строки нет. Для редких двойных кликов приемлемо; для строгой консистентности можно использовать SELECT ... FOR UPDATE в транзакции.

---

## 6. Архитектурные риски

### 6.1 Масштабирование

- **Одна БД на несколько сервисов:** messaging и campaign пишут в одну БД. Рост нагрузки по кампаниям и сообщениям ложится на один PostgreSQL. Резерв: пулы соединений, мониторинг, при необходимости — чтение реплик для отчётов.

- **Статистика кампаний:** total_sent, total_read, total_replied, total_won, total_revenue считаются по запросу (GROUP BY / подзапросы). При большом числе участников и отправок запросы к stats и списку кампаний могут стать тяжёлыми. Документ допускает materialized view «позже» — это логичный следующий шаг.

### 6.2 Telegram API и bd-accounts

- **create-shared-chat:** один HTTP-вызов messaging → bd-accounts. При недоступности bd-accounts создание «общего чата» не выполнится; conversation при этом не помечается shared (создание вызывается до UPDATE). Таймаут и повтор при сбое не описаны — при долгом ответе Telegram возможны таймауты прокси.

### 6.3 N+1 и тяжёлые запросы

- **GET /api/campaigns:** несколько параллельных запросов (sent, replied, shared, read, won, revenue) по списку id кампаний — N+1 нет, батч. При большом числе кампаний — 6+ запросов за один раз — приемлемо.

- **GET /api/campaigns/:id/participants:** один запрос с JOIN и LATERAL для first_sent_at и first message read. Для больших списков участников запрос может быть тяжёлым; пагинация есть (limit 50).

### 6.4 Cross-service coupling

- Жёсткая связь только messaging → bd-accounts (create-shared-chat). Остальное — общая схема БД. Изменение схемы conversations (например, новые поля) требует согласованного деплоя messaging и campaign. Риск средний при дисциплине миграций.

---

## 7. Что удалить / не трогать

- **Устаревшие разделы документации:** нет явно устаревших глав; требуется только обновить §15 (чеклист).

- **Deprecated поля:** в коде нет помеченных deprecated полей в conversations. mark-shared-chat остаётся как legacy (только флаг без создания чата) — документировано.

- **Неиспользуемые эндпоинты:** все перечисленные в разделе 1.5 endpoints используются фронтом или внутренними вызовами.

- **Старые миграции:** все нужны для текущей схемы; откат миграций не рекомендуется без отдельного плана.

---

## 8. Что обязательно доделать (конкретные задачи)

| Приоритет | Задача | Где |
|-----------|--------|-----|
| P1 | Обновить §15 чеклист: отметить PHASE 2.4, 2.5, 2.6, 2.7 как выполненные | docs/STAGES.md (ЭТАП 7) |
| P1 | Обернуть в транзакцию: UPDATE conversations + INSERT system message в create-shared-chat, mark-won, mark-lost | messaging-service |
| P2 | Решить и при необходимости добавить RBAC для mark-won, mark-lost, create-shared-chat (или явно зафиксировать «любой пользователь организации») | messaging-service + doc |
| P2 | Добавить составной индекс для GET new-leads при росте данных: (organization_id, lead_id) WHERE first_manager_reply_at IS NULL или аналог | migrations |
| P2 | Вынести константы типов событий/фильтров (lead_created, deal_won, filter replied/shared и т.д.) в общий модуль или конфиг | shared + messaging + campaign |
| P3 | Ограничить revenue_amount сверху в API (например макс. 999_999_999.99) и описать в контракте | messaging-service |

---

## 9. Рекомендации по приоритетам

- **P1 (критично для консистентности и актуальности):**
  - Обновить чеклист §15.
  - Ввести транзакции для create-shared-chat, mark-won, mark-lost (UPDATE + INSERT в одной транзакции).

- **P2 (важно для безопасности и масштаба):**
  - RBAC или явная документация политики доступа для Won/Lost/Shared.
  - Индекс под new-leads при необходимости.
  - Общие константы для типов событий и фильтров.

- **P3 (улучшения):**
  - Ограничение и описание revenue_amount в API.
  - Планирование materialized view для campaign stats при росте данных.

---

## 10. Топ-10 самых критичных проблем (по риску)

| # | Проблема | Риск | Рекомендуемый порядок исправления |
|---|----------|------|-----------------------------------|
| 1 | Чеклист §15 не отражает реализацию PHASE 2.4–2.7 | Путаница при онбординге и планировании | 1 — обновить документ |
| 2 | ~~Нет транзакции в create-shared-chat~~ | ~~При сбое после UPDATE нет системного сообщения~~ | ✅ Закрыто: транзакция введена (стабилизационный спринт) |
| 3 | ~~Нет транзакции в mark-won~~ | ~~Несогласованное состояние~~ | ✅ Закрыто: транзакция введена |
| 4 | ~~Нет транзакции в mark-lost~~ | ~~Аналогично~~ | ✅ Закрыто: транзакция введена |
| 5 | Нет проверки прав на mark-won / mark-lost / create-shared-chat | Любой пользователь организации может закрывать сделки и создавать общие чаты | 5 — зафиксировать политику в доке и при необходимости добавить canPermission |
| 6 | Одна БД на messaging + campaign при росте нагрузки | Узкое место и единая точка отказа | 6 — мониторинг, при росте — реплики или отдельная аналитика |
| 7 | Статистика кампаний считается по запросу без materialized view | При большом числе участников/кампаний возможны медленные ответы | 7 — при необходимости ввести materialized view для stats |
| 8 | GET new-leads без специализированного индекса | При большом числе conversations запрос может замедлиться | 8 — при росте добавить индекс под new-leads |
| 9 | Магические строки типов событий и фильтров | Опечатки и расхождения между сервисами и фронтом | 9 — вынести в константы/enum |
| 10 | Нет явного лимита на revenue_amount в API | Теоретически возможны некорректные значения без бизнес-валидации | 10 — ограничить и описать в контракте |

---

## 11. Повторный аудит после PHASE 2.8 (Stability & Integrity Layer)

**Дата:** после стабилизационного спринта и PHASE 2.8.

### 11.1 Что сделано

| Задача | Статус | Где |
|--------|--------|-----|
| CHECK-ограничения в `conversations` | ✅ | Миграция `20250628000001_conversations_integrity_checks.ts`: won/lost взаимоисключающие; revenue только при won_at IS NOT NULL. |
| Официальные события Conversation | ✅ | §18 в STAGE_7; константы `ConversationSystemEvent` в @getsale/types; использование в messaging-service при INSERT системных сообщений. |
| Доменные константы | ✅ | @getsale/types: `ConversationSystemEvent`, `LeadActivityLogType`, `CampaignParticipantFilter`. Использование в messaging (lead-context, events), campaign (participants filter). |
| Execution logging | ✅ | campaign-service: GET stats при >2 с — warn с campaignId, durationMs, participantsTotal. messaging-service: create-shared-chat при вызове bd-accounts >5 с — warn; при 409 по create-shared-chat, mark-shared-chat, mark-won, mark-lost — warn с endpoint и conversationId. |
| Документирование профилирования | ✅ | §19 в STAGE_7: что логируется; как выполнять EXPLAIN ANALYZE по подзапросам stats; напоминание про индексы и materialized view при росте. |
| Чеклист §15 | ✅ | PHASE 2.4–2.7, 2.8, 2.9, 2.10 отмечены выполненными; документация соответствует коду. |
| **Транзакции (PHASE 2.10)** | ✅ | create-shared-chat, mark-won, mark-lost: одна транзакция (BEGIN → UPDATE conversations + INSERT messages → COMMIT; ROLLBACK при ошибке). Код: messaging-service, pool.connect() + client.query('BEGIN'/'COMMIT'/'ROLLBACK'). |
| RBAC решение | ✅ | §16: явно зафиксирована политика **flat trust** — все пользователи организации доверенные; в коде нет canPermission для mark_won/mark_lost/create_shared_chat по решению. |
| Заморозка Conversation v1 | ✅ | §17 + напоминание в §21. |

### 11.2 Что не сделано (и не входило в PHASE 2.8)

- Materialized view для campaign stats — отложено до реального роста нагрузки.
- Индекс под GET new-leads — добавить при росте числа conversations (см. первоначальный аудит).
- Явный верхний лимит `revenue_amount` в API — остаётся P3.
- Pipeline-service и campaign-service пока не переведены на `LeadActivityLogType` при INSERT в lead_activity_log (строковые литералы остаются; константы доступны в types при желании унифицировать).

### 11.3 Что можно улучшить дальше

- **Метрики 409:** при необходимости вынести счётчики 409 в метрики (Prometheus/OpenTelemetry) для дашбордов.
- **Единый логгер:** заменить `console.warn` на структурированный логгер (например shared/logger) с полями service, endpoint, durationMs, conflictReason.
- **EXPLAIN в CI/dev:** при наличии тестовых данных с большими кампаниями — периодически прогонять EXPLAIN ANALYZE по ключевым запросам stats и фиксировать в артефактах.
- **Campaign Comparison Table:** после закрепления PHASE 2.8 логичный следующий шаг — минималистичная таблица сравнения кампаний по метрикам (см. стратегический разбор).

---

**Итог (актуализировано):** Документация приведена в соответствие с реализацией (§15, §18, §19, §21). PHASE 2.1–2.10 реализованы. **Транзакции** в lifecycle-эндпоинтах обеспечены (Data Consistency Hardening). **RBAC** зафиксирован как flat trust (§16). **Conversation v1** объявлен замороженным (§17). Инварианты защищены на уровне БД (CHECK); события формализованы; константы вынесены; операционное логирование и Observability (2.9) включены. Рекомендуется далее: интеграционный тест на атомарность mark-won/create-shared-chat при появлении тестовой инфраструктуры. Оставшиеся пункты (индекс new-leads, лимит revenue, materialized view) — по приоритетам при росте нагрузки.
