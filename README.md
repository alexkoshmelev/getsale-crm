# AI CRM SaaS - Enterprise Architecture

> **Event-driven, Microservices-based, AI-first CRM Platform**

## Архитектура (active stack)

### Микросервисы (12 сервисов)

1. **gateway** — Единая точка входа, маршрутизация, rate limiting, WebSocket proxy (port 8000)
2. **auth-service** — Identity & Access Management (JWT, 2FA, RBAC, OAuth) (port 4001)
3. **core-api** — CRM Core (Contacts, Companies, Deals), Pipeline, Teams, Activity (port 4002)
4. **messaging-api** — Unified messaging, чаты, сообщения (port 4003)
5. **telegram-session-manager** — Telegram GramJS, подключение, синхронизация (port 4005)
6. **campaign-orchestrator** — Cold Outreach Engine, кампании, шаблоны, sequences (port 4006)
7. **campaign-worker** — Воркер отправки кампаний (масштабируется горизонтально)
8. **automation-engine** — Автоматизация переходов, триггеры, правила (port 4007)
9. **notification-hub** — Real-time WebSocket соединения, уведомления (port 4008)
10. **user-service** — Профили, подписки, биллинг (Stripe, NowPayments) (port 4009)
11. **ai-service** — AI Agents System (Draft generation, summarize, campaign rephrase) (port 4010)
12. **analytics-worker** — Метрики конверсии, аналитика воронки (background worker)

### Общие библиотеки (shared/)

- **@getsale/types** — TypeScript типы
- **@getsale/events** — Event definitions
- **@getsale/logger** — Структурированное логирование
- **@getsale/cache** — Redis кеш
- **@getsale/queue** — RabbitMQ клиент
- **@getsale/service-framework** — Общий фреймворк сервисов (Fastify)
- **@getsale/telegram** — Telegram GramJS обёртка

### Инфраструктура

- **RabbitMQ** — Message Queue для event-driven коммуникации
- **Redis** — Кеш и session storage
- **PostgreSQL** — Основная БД
- **Prometheus + Grafana** — Мониторинг

## Быстрый старт

**Node.js:** версия **24+** (см. [`.nvmrc`](.nvmrc) и `engines` в [`package.json`](package.json)). Совпадает с CI и Docker-образами.

### Локальная разработка (Docker Compose)

```bash
npm install
docker compose -f docker-compose.yml up -d

# Фронтенд в Compose: http://localhost:5173 (маппинг на Next внутри контейнера)
# Локально без Docker: cd frontend && npm run dev → http://localhost:3000
# API Gateway: http://localhost:8000
# RabbitMQ UI: http://localhost:15673
```

Подробнее: [docs/operations/GETTING_STARTED.md](docs/operations/GETTING_STARTED.md)

### Тестирование

```bash
bash scripts/test-services.sh
bash scripts/test-api.sh
```

### Продакшн

Основной путь развёртывания описан в [docs/operations/DEPLOYMENT.md](docs/operations/DEPLOYMENT.md) (Docker на сервере, CI).

Манифесты в `k8s/` при необходимости:

```bash
kubectl apply -f k8s/
```

## Документация

- [Индекс документации](docs/INDEX.md) — полный каталог всей документации
- [Contributing](CONTRIBUTING.md) — PR, ADR (`docs/adr/`)
- [Архитектура системы](docs/architecture/ARCHITECTURE.md) — архитектура, принципы, границы сервисов
- [Дорожная карта](docs/ROADMAP.md) — приоритеты и бэклог
- [Развёртывание](docs/operations/DEPLOYMENT.md) — руководство по развёртыванию
- [Frontend](frontend/README.md) — документация фронтенда

## Структура проекта

```
getsale-crm/
├── services/             # Микросервисы (12 сервисов, Fastify)
│   ├── gateway/             # API Gateway + WS proxy
│   ├── auth-service/        # Identity & Access Management
│   ├── core-api/            # CRM + Pipeline + Teams + Activity
│   ├── messaging-api/       # Чаты, сообщения
│   ├── telegram-session-manager/ # Telegram (GramJS)
│   ├── campaign-orchestrator/# Cold Outreach
│   ├── campaign-worker/     # Воркер отправки
│   ├── automation-engine/   # Автоматизация
│   ├── notification-hub/    # Real-time WebSocket
│   ├── user-service/        # Профили, подписки
│   ├── ai-service/          # AI Agents & Drafts
│   └── analytics-worker/    # Аналитика (background)
├── shared/               # Общие библиотеки (@getsale/*)
│   ├── types/               # TypeScript типы
│   ├── events/              # Event definitions
│   ├── logger/              # Структурированное логирование
│   ├── cache/               # Redis кеш
│   ├── queue/               # RabbitMQ клиент
│   ├── service-framework/   # Fastify фреймворк сервисов
│   └── telegram/            # Telegram GramJS обёртка
├── frontend/                # Next.js App Router
├── migrations/              # Knex миграции БД
├── infrastructure/          # Prometheus конфигурация
├── k8s/                     # Kubernetes манифесты
├── docker/                  # Docker конфигурации
├── load-tests/              # k6 нагрузочные тесты
├── docs/                    # Документация
│   ├── architecture/        # Архитектура и дизайн
│   ├── api/                 # API контракты
│   ├── domain/              # Бизнес-флоу
│   ├── product/             # Продуктовая стратегия
│   ├── operations/          # Развёртывание и инфра
│   ├── runbooks/            # Операционные runbooks
│   └── adr/                 # Architecture Decision Records
├── docker-compose.yml    # Локальная разработка
├── docker-compose.server.yml  # Продакшн-сервер (Docker)
└── Makefile                 # Команды для разработки
```

## Event-Driven Architecture

Все сервисы общаются через события в RabbitMQ:

- `user.created`, `user.updated`
- `message.received`, `message.sent`
- `deal.stage.changed`, `lead.stage.changed`
- `ai.draft.generated`

## Безопасность

- JWT с refresh tokens
- Multi-tenant isolation на уровне БД (`organization_id`)
- RBAC на уровне API Gateway и сервисов
- Audit logs для всех действий
- 2FA (TOTP)

## Мониторинг

- Prometheus метрики из всех сервисов
- Grafana дашборды
- Межсервисные метрики и алерты (`inter_service_http_*`)
- DLQ метрики и алерты
