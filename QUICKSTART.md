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
# Запустить все сервисы в Docker (включая фронтенд)
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

# Логи конкретного сервиса
docker-compose logs -f api-gateway
```

### 4. Открыть приложение

- **Frontend**: http://localhost:3000
- **API Gateway**: http://localhost:8000
- **RabbitMQ Management**: http://localhost:15672 (getsale/getsale_dev)
- **Grafana**: http://localhost:3000 (admin/admin) - конфликт с фронтендом, измените порт
- **Prometheus**: http://localhost:9090
- **Jaeger**: http://localhost:16686

### 5. Создать первого пользователя

Откройте http://localhost:3000 и зарегистрируйтесь через UI, или используйте API:

```bash
curl -X POST http://localhost:8000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "password123",
    "organizationName": "My Company"
  }'
```

### 6. Тестирование

```bash
# Проверить health checks
bash scripts/test-services.sh

# Протестировать API
bash scripts/test-api.sh
```

## 📊 Доступ к сервисам

- **Frontend**: http://localhost:3000
- **API Gateway**: http://localhost:8000
- **RabbitMQ Management**: http://localhost:15672
  - Username: `getsale`
  - Password: `getsale_dev`
- **Grafana**: http://localhost:3000 (измените порт в docker-compose.yml)
- **Prometheus**: http://localhost:9090
- **Jaeger**: http://localhost:16686

## 🔧 Разработка

### Фронтенд

```bash
cd frontend
npm install
npm run dev
```

### Backend сервис

1. Отредактировать файл в `services/<service-name>/src/index.ts`
2. Изменения применятся автоматически (hot reload)

### Добавить новый сервис

1. Создать директорию `services/new-service/`
2. Добавить в `docker-compose.yml`
3. Перезапустить: `docker-compose up -d`

## 🧪 Тестирование

### Health Checks

```bash
# Все сервисы
bash scripts/test-services.sh

# Вручную
curl http://localhost:8000/health
curl http://localhost:3001/health
# и т.д.
```

### API Endpoints

```bash
# Базовое тестирование
bash scripts/test-api.sh

# Вручную
TOKEN="your_token"
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/crm/companies
```

## 🐛 Отладка

### Просмотр логов

```bash
# Все сервисы
docker-compose logs -f

# Конкретный сервис
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

### Проверить RabbitMQ

```bash
# Через веб-интерфейс: http://localhost:15672
# Или через CLI
docker-compose exec rabbitmq rabbitmqctl list_queues
```

## 📝 Следующие шаги

1. ✅ Все сервисы запущены
2. ⏳ Протестировать API endpoints
3. ⏳ Создать данные через UI
4. ⏳ Проверить event-driven коммуникацию
5. ⏳ Протестировать WebSocket
6. ⏳ Доработать недостающий функционал

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

### Фронтенд не запускается

```bash
# Проверить порт 3000
lsof -i :3000

# Запустить локально
cd frontend
npm install
npm run dev
```
