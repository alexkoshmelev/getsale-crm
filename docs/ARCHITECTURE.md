# Архитектура CRM

## Обзор

Система построена на микросервисной архитектуре с event-driven подходом. Единая реляционная БД (PostgreSQL); сообщения и бизнес-данные хранятся в PostgreSQL. Стек приведён в соответствие с фактической реализацией.

## Инфраструктура (фактический стек)

- **PostgreSQL** — основная БД для всех сервисов: пользователи, организации, CRM, воронки, лиды, сообщения, чаты, кампании, команды, автоматизация. Схема и миграции: Knex ([MIGRATIONS.md](MIGRATIONS.md)).
- **Redis** — кеш, сессии, pub/sub для WebSocket, rate limiting (API Gateway, AI rate limit).
- **RabbitMQ** — очереди событий для event-driven коммуникации между сервисами.
- **Prometheus** — метрики (prom-client, endpoint `/metrics` на сервисах).
- **Grafana / Jaeger** — визуализация метрик и distributed tracing (конфигурация окружения).

MongoDB и Elasticsearch в текущей реализации **не используются**.

## Микросервисы

| Сервис | Назначение |
|--------|------------|
| **API Gateway** | Единая точка входа, JWT, rate limiting, проксирование на бэкенды |
| **Auth Service** | Регистрация, вход, JWT (access + refresh), организации, MFA/OAuth — TODO |
| **User Service** | Профили, подписки (Stripe), команды |
| **BD Accounts Service** | BD/Telegram аккаунты (GramJS): подключение, синхронизация чатов, отправка |
| **CRM Service** | Компании, контакты, сделки, заметки, напоминания |
| **Pipeline Service** | Воронки, стадии, лиды, история переходов (stage_history) |
| **Messaging Service** | Чаты, сообщения, conversations, lead-context, отправка через BD Accounts |
| **Automation Service** | Правила автоматизации, триггеры (в т.ч. lead.stage.changed → создание сделки) |
| **Analytics Service** | Метрики конверсии, аналитика воронки, отчёты по командам |
| **Team Service** | Команды, участники, назначения клиентов |
| **WebSocket Service** | Real-time обновления (Socket.io, Redis adapter) |
| **AI Service** | Summarize, analyze, генерация черновиков (OpenAI) |
| **Campaign Service** | Cold outreach: кампании, последовательности, участники |

Детальное описание API — в [CRM_API.md](CRM_API.md) и в коде маршрутов `services/<name>/src/routes/`.

## Event-Driven архитектура

Сервисы обмениваются событиями через RabbitMQ. Примеры событий:

- **User & Auth:** `user.created`, `user.updated`, `subscription.created`
- **BD Accounts:** `bd_account.connected`, `bd_account.disconnected`
- **CRM & Pipeline:** `contact.created`, `contact.updated`, `deal.created`, `deal.stage.changed`, `lead.stage.changed`
- **Messaging:** `message.received`, `message.sent`
- **Automation:** `automation.rule.triggered`
- **AI:** `ai.draft.generated`, `ai.draft.approved`

Используются: публикация доменных событий, consumer’ы с идемпотентной обработкой (например создание сделки по lead_id с 409 при дубле). Correlation ID прокидывается для трассировки.

## Масштабирование

- Сервисы stateless; состояние в PostgreSQL и Redis.
- WebSocket: Redis adapter для горизонтального масштабирования.
- API Gateway: единая точка входа; в проде — load balancing.
- Пул БД: в коде ограничен (рекомендация PgBouncer в проде). См. [FULL_SYSTEM_AUDIT_2026.md](FULL_SYSTEM_AUDIT_2026.md) по рискам роста.

## Безопасность

- Изоляция по `organization_id` во всех доменных таблицах.
- JWT (access + refresh), проверка на API Gateway и в сервисах.
- RBAC: роли (owner, admin, supervisor, bidi, viewer), `role_permissions` для ресурсов (в т.ч. messaging, bd_accounts).
- Rate limiting на API Gateway (Redis).
- Секреты: переменные окружения; в проде — Kubernetes Secrets / Vault по необходимости.

## Владение таблицами (Data / table ownership)

При общей БД важно явно зафиксировать, какой сервис **пишет** в какие таблицы, чтобы избежать конфликтов миграций и дублирования логики.

| Таблица / область | Владелец (запись) | Читают |
|-------------------|-------------------|--------|
| **contacts** | CRM Service | Campaign Service (только чтение: фильтры аудитории, пикер контактов) |
| **contact_telegram_sources** | CRM Service | Campaign Service (только чтение: фильтры по ключевому слову и группе) |

- **CRM Service** создаёт и обновляет контакты; импорт из Telegram-группы (`POST /api/crm/contacts/import-from-telegram-group`) — в зоне ответственности CRM: вызов bd-accounts (participants), upsert контактов, запись в `contact_telegram_sources`.
- **Campaign Service** не создаёт контакты и не пишет в `contact_telegram_sources`; использует эти таблицы только для выборки аудитории (ключевые слова, группы, пикер контактов).
- Карточка контакта с полем «Участник групп» (`telegramGroups`) отдаётся CRM Service (GET `/api/crm/contacts/:id`).

## Contact Discovery

Модуль поиска и импорта контактов из Telegram-групп и каналов. Поиск — **глобальный** (по всему Telegram, не только «мои» чаты). Два способа добавления чатов: **поиск по ключевым словам** (с фильтром тип: группы / каналы / оба) и **по ссылкам** (t.me/…, @username, инвайты; по инвайту аккаунт вступает в чат). Участники импортируются в CRM; опции: исключить админов, выйти из чата после импорта. Эндпоинты: bd-accounts — GET `/:id/search-groups` (query `q`, `type`, `limit`, **`maxPages`**), GET `/:id/chats/:chatId/participants` (`excludeAdmins`), POST `/:id/chats/:chatId/leave`, POST `/:id/resolve-chats` (body `{ inputs }`), POST `/:id/parse/resolve` (body `{ sources }` — resolve с типом источника и linked chat); CRM — `POST /api/crm/parse/*` (resolve/start/progress/result, прокси на bd-accounts где нужно); AI — POST `/api/ai/generate-search-queries` (body `{ topic }` → `{ queries }`). См. [CRM_API.md](CRM_API.md), [PLAN_TELEGRAM_PARSE_FLOW.md](PLAN_TELEGRAM_PARSE_FLOW.md) и UI «Contact discovery».

## Наблюдаемость

- **Логи:** @getsale/logger, структурированные логи, correlation ID в запросах.
- **Метрики:** Prometheus, `/metrics`, нормализация путей; при необходимости — кастомные метрики в сервисах.
- **Health:** `/health` на gateway и сервисах (проверка БД, RabbitMQ где применимо).
- Алерты и DLQ — в плане развития (см. STATE_AND_ROADMAP, STAGES).

## Развёртывание

- **Локальная разработка:** `docker-compose up -d` ([GETTING_STARTED.md](GETTING_STARTED.md)).
- **Продакшен:** манифесты в `k8s/`; `kubectl apply -f k8s/`.

## Best practices

- Идемпотентность критичных операций (сделка по lead_id, automation_executions).
- Транзакции (BEGIN/COMMIT/ROLLBACK) для многозначных операций в сервисах.
- Миграции БД через Knex, без ручного изменения схемы в проде.
- Retry/circuit breaker для внешних вызовов — в приоритете доработок (см. STATE_AND_ROADMAP).
