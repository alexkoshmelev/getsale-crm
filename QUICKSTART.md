# Быстрый старт

## 🚀 Локальная разработка за 5 минут

### 1. Клонировать и установить

```bash
git clone <repository>
cd getsale-crm
npm install
```

### 2. Запустить инфраструктуру

```bash
# Запустить все сервисы в Docker
make dev
# или
docker-compose up -d
```

### 3. Проверить статус

```bash
# Проверить, что все сервисы запущены
docker-compose ps

# Просмотр логов
make dev-logs
```

### 4. Создать первого пользователя

```bash
# Sign up через API
curl -X POST http://localhost:8000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "password123",
    "organizationName": "My Company"
  }'
```

### 5. Использовать API

```bash
# Получить access token из ответа signup
TOKEN="your_access_token"

# Создать компанию
curl -X POST http://localhost:8000/api/crm/companies \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Acme Corp",
    "industry": "Technology",
    "size": "50-100"
  }'
```

## 📊 Доступ к сервисам

- **API Gateway**: http://localhost:8000
- **RabbitMQ Management**: http://localhost:15672
  - Username: `getsale`
  - Password: `getsale_dev`
- **Grafana**: http://localhost:3000
  - Username: `admin`
  - Password: `admin`
- **Prometheus**: http://localhost:9090
- **Jaeger**: http://localhost:16686

## 🔧 Разработка сервиса

### Добавить новый endpoint

1. Отредактировать файл в `services/<service-name>/src/index.ts`
2. Изменения применятся автоматически (hot reload)

### Добавить новый сервис

1. Создать директорию `services/new-service/`
2. Добавить в `docker-compose.yml`:

```yaml
new-service:
  build:
    context: ./services/new-service
    dockerfile: Dockerfile.dev
  environment:
    - PORT=3006
  depends_on:
    - postgres
    - redis
    - rabbitmq
```

3. Перезапустить: `docker-compose up -d`

## 🧪 Тестирование

```bash
# Запустить все тесты
make test

# Проверить типы
make typecheck

# Линтинг
make lint
```

## 🐛 Отладка

### Просмотр логов конкретного сервиса

```bash
docker-compose logs -f api-gateway
docker-compose logs -f auth-service
```

### Подключиться к БД

```bash
docker-compose exec postgres psql -U getsale -d getsale_crm
```

### Подключиться к Redis

```bash
docker-compose exec redis redis-cli
```

### Подключиться к RabbitMQ

```bash
# Через веб-интерфейс: http://localhost:15672
# Или через CLI
docker-compose exec rabbitmq rabbitmqctl list_queues
```

## 📝 Следующие шаги

1. Настроить переменные окружения (`.env`)
2. Настроить Telegram бота (TELEGRAM_BOT_TOKEN)
3. Настроить OpenAI API (OPENAI_API_KEY)
4. Изучить архитектуру: `docs/ARCHITECTURE.md`
5. Развернуть в продакшн: `docs/DEPLOYMENT.md`

## ❓ Проблемы?

### Сервисы не запускаются

```bash
# Проверить порты
netstat -an | grep LISTEN

# Очистить и пересоздать
make dev-clean
make dev
```

### Ошибки подключения к БД

```bash
# Проверить статус PostgreSQL
docker-compose ps postgres

# Проверить логи
docker-compose logs postgres
```

### Проблемы с зависимостями

```bash
# Пересобрать образы
docker-compose build --no-cache

# Переустановить npm пакеты
docker-compose exec api-gateway npm install
```

