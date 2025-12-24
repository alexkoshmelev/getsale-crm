# Архитектура AI CRM SaaS

## Обзор

Система построена на принципах микросервисной архитектуры с event-driven подходом для обеспечения масштабируемости, отказоустойчивости и гибкости.

## Компоненты

### Микросервисы

1. **API Gateway** - Единая точка входа, маршрутизация, аутентификация, rate limiting
2. **Auth Service** - Управление пользователями, организациями, JWT, MFA
3. **CRM Service** - Управление контактами, компаниями, сделками
4. **Messaging Service** - Unified messaging (Telegram, Email)
5. **WebSocket Service** - Real-time обновления через WebSocket
6. **AI Service** - Генерация AI drafts, предложения
7. **Campaign Service** - Cold outreach campaigns (TODO)
8. **Pipeline Service** - Управление pipeline и стадиями (TODO)
9. **Trigger Service** - Automation engine (TODO)
10. **Analytics Service** - Аналитика и отчеты (TODO)
11. **Billing Service** - Биллинг и подписки (TODO)

### Инфраструктура

- **PostgreSQL** - Основная БД для всех сервисов
- **Redis** - Кеш, сессии, pub/sub для WebSocket
- **RabbitMQ** - Message queue для event-driven коммуникации
- **MongoDB** - Документное хранилище (опционально)
- **Elasticsearch** - Поиск и логирование
- **Prometheus** - Метрики
- **Grafana** - Визуализация метрик
- **Jaeger** - Distributed tracing

## Event-Driven Architecture

Все сервисы общаются через события в RabbitMQ:

### Основные события:

- `user.created` - Создан новый пользователь
- `message.received` - Получено сообщение
- `message.sent` - Отправлено сообщение
- `deal.stage.changed` - Изменена стадия сделки
- `ai.draft.generated` - Сгенерирован AI draft
- `ai.draft.approved` - Одобрен AI draft
- `contact.created` - Создан контакт
- `campaign.started` - Запущена кампания

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

