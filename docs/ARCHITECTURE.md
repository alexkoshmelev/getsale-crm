# Архитектура AI CRM SaaS

## Обзор

Система построена на принципах микросервисной архитектуры с event-driven подходом для обеспечения масштабируемости, отказоустойчивости и гибкости.

## Компоненты

### Микросервисы

1. **API Gateway** - Единая точка входа, маршрутизация, аутентификация, rate limiting
2. **Auth Service** - Управление пользователями, организациями, JWT, MFA, OAuth
3. **User Service** - Управление профилями, подписки, биллинг (Stripe), команды
4. **BD Accounts Service** - Управление BD аккаунтами (Telegram GramJS), подключение, покупка/аренда
5. **CRM Service** - Управление контактами, компаниями, сделками
6. **Pipeline Service** - Управление воронкой продаж, стадиями, история переходов
7. **Messaging Service** - Unified messaging (Telegram GramJS, Email, LinkedIn, Twitter)
8. **Automation Service** - Автоматизация переходов по стадиям, триггеры, правила
9. **Analytics Service** - Метрики конверсии, аналитика воронки, отчеты по командам
10. **Team Service** - Управление командами, распределение клиентов, права доступа
11. **WebSocket Service** - Real-time обновления через WebSocket
12. **AI Service** - Генерация AI drafts, предложения
13. **Campaign Service** - Cold outreach campaigns (TODO)

### Инфраструктура

- **PostgreSQL** - Основная БД для всех сервисов (пользователи, клиенты, сделки, команды)
- **MongoDB** - Документное хранилище для сообщений и логов
- **Redis** - Кеш, сессии, pub/sub для WebSocket, rate limiting
- **RabbitMQ** - Message queue для event-driven коммуникации
- **Elasticsearch** - Поиск и логирование
- **Prometheus** - Метрики
- **Grafana** - Визуализация метрик
- **Jaeger** - Distributed tracing

## Event-Driven Architecture

Все сервисы общаются через события в RabbitMQ:

### Основные события:

**User & Auth:**
- `user.created`, `user.updated`, `user.logged_in`
- `subscription.created`, `subscription.updated`, `subscription.cancelled`

**BD Accounts:**
- `bd_account.connected`, `bd_account.disconnected`, `bd_account.purchased`
- `bidi.assigned`, `bidi.unassigned`

**CRM & Pipeline:**
- `contact.created`, `contact.updated`
- `deal.created`, `deal.updated`, `deal.stage.changed`, `deal.closed`
- `stage.created`, `stage.updated`

**Messaging:**
- `message.received`, `message.sent`, `message.read`

**Automation:**
- `automation.rule.created`, `automation.rule.triggered`
- `trigger.executed`

**Team:**
- `team.created`, `team.member.added`, `team.member.removed`

**AI:**
- `ai.draft.generated`, `ai.draft.approved`, `ai.draft.rejected`, `ai.draft.sent`

**Analytics:**
- `metric.recorded`

### Паттерны:

1. **Event Sourcing** - Все важные действия сохраняются как события
2. **CQRS** - Разделение чтения и записи (опционально)
3. **Saga Pattern** - Для распределенных транзакций

## Масштабирование

### Горизонтальное масштабирование:

- Все сервисы stateless (кроме БД)
- WebSocket использует Redis adapter для горизонтального масштабирования
- API Gateway с load balancing
- RabbitMQ с кластеризацией (опционально)

### Вертикальное масштабирование:

- Ресурсы настраиваются через Kubernetes limits/requests
- Автомасштабирование через HPA (Horizontal Pod Autoscaler)

## Безопасность

1. **Multi-tenant isolation** - На уровне БД через `organization_id`
2. **JWT authentication** - С refresh tokens
3. **RBAC** - Role-based access control
4. **Rate limiting** - На уровне API Gateway
5. **Secrets management** - Kubernetes Secrets (в продакшене использовать Vault/Sealed Secrets)

## Мониторинг

### Метрики:

- Prometheus собирает метрики со всех сервисов
- Grafana дашборды для визуализации
- Custom metrics для бизнес-логики

### Логирование:

- Centralized logging (ELK stack или Loki)
- Structured logging (JSON)
- Log levels: ERROR, WARN, INFO, DEBUG

### Трейсинг:

- Jaeger для distributed tracing
- Correlation IDs для отслеживания запросов

## Развертывание

### Локальная разработка:

```bash
docker-compose up -d
```

### Продакшн (Kubernetes):

```bash
kubectl apply -f k8s/
```

## Best Practices

1. **Idempotency** - Все операции идемпотентны
2. **Retry logic** - С exponential backoff
3. **Circuit breaker** - Для внешних зависимостей
4. **Health checks** - Liveness и readiness probes
5. **Graceful shutdown** - Корректное завершение работы
6. **Feature flags** - Для постепенного rollout
7. **Database migrations** - Версионирование схемы БД

