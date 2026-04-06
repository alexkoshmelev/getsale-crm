# AI CRM SaaS - Enterprise Architecture

> **Event-driven, Microservices-based, AI-first CRM Platform**

## Архитектура

### Микросервисы

1. **api-gateway** - Единая точка входа, маршрутизация, rate limiting
2. **auth-service** - Identity & Access Management (JWT, 2FA, RBAC, OAuth)
3. **user-service** - Управление профилями, подписки, биллинг (Stripe)
4. **bd-accounts-service** - Управление BD аккаунтами (Telegram GramJS), подключение, синхронизация
5. **crm-service** - CRM Core (Contacts, Companies, Deals), Contact Discovery
6. **pipeline-service** - Управление воронкой продаж, стадиями, лиды
7. **messaging-service** - Unified messaging (Telegram GramJS)
8. **automation-service** - Автоматизация переходов, триггеры, правила
9. **analytics-service** - Метрики конверсии, аналитика воронки, отчеты
10. **team-service** - Управление командами, распределение клиентов, права доступа
11. **websocket-service** - Real-time WebSocket соединения
12. **ai-service** - AI Agents System (Draft generation, summarize, campaign rephrase)
13. **campaign-service** - Cold Outreach Engine (кампании, шаблоны, sequences, участники)
14. **activity-service** - Лента активности организации

### Инфраструктура

- **RabbitMQ** - Message Queue для event-driven коммуникации
- **Redis** - Кеш и session storage
- **PostgreSQL** - Основная БД
- **Prometheus + Grafana** - Мониторинг

## Быстрый старт

### Локальная разработка (Docker Compose)

```bash
npm install
make dev
# или
docker-compose up -d

# Фронтенд: http://localhost:5173
# API Gateway: http://localhost:8000
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
├── services/                # Микросервисы (14 сервисов)
│   ├── api-gateway/        # API Gateway
│   ├── auth-service/       # Identity & Access Management
│   ├── user-service/       # Профили, подписки
│   ├── bd-accounts-service/# Telegram (GramJS)
│   ├── crm-service/       # CRM Core + Contact Discovery
│   ├── pipeline-service/  # Воронки, лиды
│   ├── messaging-service/ # Чаты, сообщения
│   ├── automation-service/# Автоматизация
│   ├── analytics-service/ # Аналитика
│   ├── team-service/      # Команды
│   ├── websocket-service/ # Real-time WebSocket
│   ├── ai-service/        # AI Agents & Drafts
│   ├── campaign-service/  # Cold Outreach
│   └── activity-service/  # Лента активности
├── frontend/               # Next.js App Router
├── shared/                 # Общие библиотеки
│   ├── types/             # TypeScript типы
│   ├── events/            # Event definitions
│   ├── logger/            # Структурированное логирование
│   ├── utils/             # Утилиты (RabbitMQ, Redis)
│   └── service-core/     # Общее ядро сервисов
├── migrations/             # Knex миграции БД
├── infrastructure/         # Prometheus конфигурация
├── k8s/                   # Kubernetes манифесты
├── docker/                # Docker конфигурации
├── load-tests/            # k6 нагрузочные тесты
├── docs/                  # Документация
│   ├── architecture/     # Архитектура и дизайн
│   ├── api/              # API контракты
│   ├── domain/           # Бизнес-флоу
│   ├── product/          # Продуктовая стратегия
│   ├── operations/       # Развёртывание и инфра
│   ├── runbooks/         # Операционные runbooks
│   └── adr/              # Architecture Decision Records
├── docker-compose.yml     # Docker Compose для разработки
└── Makefile              # Команды для разработки
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
