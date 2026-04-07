# AI CRM SaaS - Enterprise Architecture

> **Event-driven, Microservices-based, AI-first CRM Platform**

## Архитектура (v2 — active)

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

### Общие библиотеки (shared-v2/)

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

### Локальная разработка (Docker Compose)

```bash
npm install
make dev
# или
docker compose -f docker-compose.v2.yml up -d

# Фронтенд: http://localhost:5173
# API Gateway: http://localhost:8000
# RabbitMQ UI: http://localhost:15673
```

Подробнее: [docs/operations/GETTING_STARTED.md](docs/operations/GETTING_STARTED.md)

### Тестирование

```bash
bash scripts/test-services.sh
bash scripts/test-api.sh
```

### Продакшн (Kubernetes)

```bash
kubectl apply -f k8s/
```

Подробнее: [docs/operations/DEPLOYMENT.md](docs/operations/DEPLOYMENT.md)

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
├── services-v2/             # Микросервисы v2 (12 сервисов, Fastify)
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
├── shared-v2/               # Общие библиотеки v2
│   ├── types/               # TypeScript типы
│   ├── events/              # Event definitions
│   ├── logger/              # Структурированное логирование
│   ├── cache/               # Redis кеш
│   ├── queue/               # RabbitMQ клиент
│   ├── service-framework/   # Fastify фреймворк сервисов
│   └── telegram/            # Telegram GramJS обёртка
├── services/                # [Legacy v1] Микросервисы (14 сервисов, Express)
├── shared/                  # [Legacy v1] Общие библиотеки
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
├── docker-compose.v2.yml    # Docker Compose v2 (active)
├── docker-compose.yml       # Docker Compose v1 (legacy)
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
