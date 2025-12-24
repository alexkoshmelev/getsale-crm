# AI CRM SaaS - Enterprise Architecture

> **Event-driven, Microservices-based, AI-first CRM Platform**

## 🏗️ Архитектура

### Микросервисы

1. **api-gateway** - Единая точка входа, маршрутизация, rate limiting
2. **auth-service** - Identity & Access Management (JWT, MFA, RBAC)
3. **organization-service** - Управление организациями и компаниями
4. **bidi-service** - Управление BiDi (внутренние/внешние/AI агенты)
5. **crm-service** - CRM Core (Contacts, Companies, Deals)
6. **pipeline-service** - Управление pipeline и стадиями
7. **messaging-service** - Unified messaging (Telegram, Email, Inbox)
8. **campaign-service** - Cold Outreach Engine (Campaigns, Sequences)
9. **trigger-service** - Trigger & Automation Engine
10. **ai-service** - AI Agents System (Draft generation, suggestions)
11. **analytics-service** - Analytics и отчеты
12. **billing-service** - Billing & Monetization
13. **notification-service** - Уведомления
14. **websocket-service** - Real-time WebSocket соединения

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

# Запустить все сервисы
make dev
# или
docker-compose up -d

# Просмотр логов
make dev-logs
```

Подробнее: [QUICKSTART.md](QUICKSTART.md)

### Продакшн (Kubernetes)

```bash
# Применить все манифесты
kubectl apply -f k8s/

# Или использовать Makefile
make k8s-apply
```

Подробнее: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

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

