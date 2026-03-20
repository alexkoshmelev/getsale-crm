# AI CRM SaaS - Enterprise Architecture

> **Event-driven, Microservices-based, AI-first CRM Platform**

## 🏗️ Архитектура

### Микросервисы

1. **api-gateway** - Единая точка входа, маршрутизация, rate limiting
2. **auth-service** - Identity & Access Management (JWT, MFA, RBAC, OAuth)
3. **user-service** - Управление профилями, подписки, биллинг (Stripe), команды
4. **bd-accounts-service** - Управление BD аккаунтами (Telegram GramJS), подключение, покупка
5. **crm-service** - CRM Core (Contacts, Companies, Deals)
6. **pipeline-service** - Управление воронкой продаж, стадиями, история переходов
7. **messaging-service** - Unified messaging (Telegram GramJS, Email, LinkedIn, Twitter)
8. **automation-service** - Автоматизация переходов, триггеры, правила
9. **analytics-service** - Метрики конверсии, аналитика воронки, отчеты
10. **team-service** - Управление командами, распределение клиентов, права доступа
11. **websocket-service** - Real-time WebSocket соединения
12. **ai-service** - AI Agents System (Draft generation, suggestions)
13. **campaign-service** - Cold Outreach Engine (базовый CRUD, кампании, шаблоны, sequences, участники, start/pause)

### Инфраструктура

- **RabbitMQ** - Message Queue для event-driven коммуникации
- **Redis** - Кеш и session storage
- **PostgreSQL** - Основная БД (по сервису или shared)
- **MongoDB** - Документное хранилище (опционально для analytics)
- **Elasticsearch** - Поиск и логирование
- **Prometheus + Grafana** - Мониторинг
- **Kong/nginx** - API Gateway (опционально)

## 🚀 Быстрый старт

### Локальная разработка (Docker Compose)

```bash
# Установить зависимости
npm install

# Запустить все сервисы (включая фронтенд)
make dev
# или
docker-compose up -d

# Просмотр логов
make dev-logs

# Фронтенд будет доступен на http://localhost:5173
# API Gateway на http://localhost:8000
```

Подробнее: [QUICKSTART.md](QUICKSTART.md)

### Тестирование

```bash
# Проверить health checks всех сервисов
bash scripts/test-services.sh

# Протестировать базовые API endpoints
bash scripts/test-api.sh
```

### Продакшн (Kubernetes)

```bash
# Применить все манифесты
kubectl apply -f k8s/

# Или использовать Makefile
make k8s-apply
```

Подробнее: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

## 📚 Документация

### Основная документация
- [Contributing](CONTRIBUTING.md) — PR, ADR (`docs/adr/`)
- [Индекс документации](docs/INDEX.md) — целевая / as-is / миграция, API, runbooks
- [Архитектура системы](docs/ARCHITECTURE.md) - Общая архитектура
- [Целевая архитектура SaaS CRM](docs/TARGET_SAAS_CRM_ARCHITECTURE.md) — целевая модель, границы сервисов, надёжность
- [Текущее состояние (as-is)](docs/CURRENT_SYSTEM_AS_IS.md) — фактическая реализация, дубли, SRP
- [План перехода к целевой архитектуре](docs/MIGRATION_TO_TARGET_ARCHITECTURE.md) — фазы A–E и критерии готовности
- [BD CRM Архитектура](docs/BD_CRM_ARCHITECTURE.md) - Детальная архитектура согласно промпту
- [Анализ текущего состояния](docs/CURRENT_STATE_ANALYSIS.md) - Детальный анализ всех доменов
- [План к продакшену](docs/PRODUCTION_ROADMAP.md) - Пошаговый план до продакшена
- [План действий](docs/ACTION_PLAN.md) - Конкретные задачи и шаги

### Тестирование и разработка
- [План тестирования](docs/TESTING_PLAN.md) - Чеклист для тестирования
- [Пошаговое тестирование](docs/STEP_BY_STEP_TESTING.md) - Детальное руководство по тестированию
- [План разработки](docs/DEVELOPMENT_ROADMAP.md) - Roadmap разработки
- [Следующие шаги](docs/NEXT_STEPS.md) - Приоритетные задачи

### Развертывание
- [Развертывание](docs/DEPLOYMENT.md) - Руководство по развертыванию
- [Быстрый старт](QUICKSTART.md) - Быстрый старт для разработчиков
- [Frontend README](frontend/README.md) - Документация фронтенда

## 🧪 Тестирование

```bash
# Проверить health checks
bash scripts/test-services.sh

# Протестировать API
bash scripts/test-api.sh

# Протестировать события
bash scripts/test-events.sh
```

## 📁 Структура проекта

```
getsale-crm/
├── services/              # Микросервисы
│   ├── api-gateway/      # API Gateway (маршрутизация, auth, rate limiting)
│   ├── auth-service/     # Identity & Access Management
│   ├── crm-service/      # CRM Core (Contacts, Companies, Deals)
│   ├── messaging-service/# Unified Messaging (Telegram, Email)
│   ├── websocket-service/# Real-time WebSocket
│   └── ai-service/       # AI Agents & Drafts
├── infrastructure/        # Docker, K8s конфигурации
│   ├── prometheus/       # Prometheus конфигурация
│   └── grafana/          # Grafana provisioning
├── k8s/                  # Kubernetes манифесты
│   ├── namespace.yaml
│   ├── postgres.yaml
│   ├── redis.yaml
│   ├── rabbitmq.yaml
│   └── *.yaml            # Манифесты сервисов
├── shared/               # Общие библиотеки
│   ├── types/           # TypeScript типы
│   ├── events/          # Event definitions
│   └── utils/           # Утилиты (RabbitMQ, Redis)
├── docs/                # Документация
│   ├── ARCHITECTURE.md  # Архитектура системы
│   └── DEPLOYMENT.md    # Руководство по развертыванию
├── docker-compose.yml    # Docker Compose для разработки
├── Makefile             # Команды для разработки
└── QUICKSTART.md        # Быстрый старт
```

## 🔄 Event-Driven Architecture

Все сервисы общаются через события в RabbitMQ:

- `user.created`
- `message.received`
- `deal.stage.changed`
- `ai.draft.generated`
- и т.д.

## 🔐 Безопасность

- JWT с refresh tokens
- Multi-tenant isolation на уровне БД
- RBAC на уровне API Gateway
- Audit logs для всех действий
- MFA (TOTP)

## 📊 Мониторинг

- Prometheus метрики из всех сервисов
- Grafana дашборды
- Centralized logging (ELK stack)
- Distributed tracing (Jaeger)

## 🧪 Тестирование

- Unit tests в каждом сервисе
- Integration tests с Testcontainers
- E2E tests для критических путей

