# Начало работы

Единое руководство: быстрый старт и пошаговая проверка платформы.

---

## Быстрый старт (5 минут)

### 1. Клонировать и установить

Используйте **Node.js 24+** и **npm 10+** (как в CI и Docker): см. [`.nvmrc`](../../.nvmrc) и `engines` в [`package.json`](../../package.json).

```bash
git clone <repository>
cd getsale-crm
npm install
```

### 2. Запустить инфраструктуру

```bash
make dev
# или
docker-compose up -d
```

Подождите 30–60 секунд для инициализации.

### 3. Проверить статус

```bash
docker-compose ps
bash scripts/test-services.sh
```

Ожидаемый результат: все сервисы показывают ✅.

### 4. Открыть приложение

- **Frontend**: http://localhost:3000 (при локальном `npm run dev` в `frontend/`). В Docker может быть маппинг на порт 5173 — см. `frontend/README.md`.
- **API Gateway**: http://localhost:8000
- **RabbitMQ Management**: http://localhost:15672 (getsale/getsale_dev)
- **Prometheus**: http://localhost:9090
- **Jaeger**: http://localhost:16686

### 5. Создать первого пользователя

Откройте frontend (http://localhost:3000 или 5173 в зависимости от способа запуска) и зарегистрируйтесь через UI или API:

```bash
curl -X POST http://localhost:8000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@example.com",
    "password": "password123",
    "organizationName": "My Company"
  }'
```

---

## Пошаговая проверка

### Этап 1: Базовая проверка

- Запуск: `docker-compose up -d`, затем `bash scripts/test-services.sh`
- При ошибках: `docker-compose logs -f <service-name>`, при необходимости `docker-compose build --no-cache`

### Этап 2: Auth

- **API:** `POST /api/auth/signup`, затем `POST /api/auth/verify` с токеном
- **UI:** открыть frontend → «Зарегистрироваться» → редирект на `/dashboard`

### Этап 3: Данные (CRM, воронка)

- **Компания:** через UI `/dashboard/crm` или `POST /api/crm/companies`
- **Контакт:** вкладка «Контакты» или `POST /api/crm/contacts`
- **Воронка и стадии:** `POST /api/pipeline`, затем `POST /api/pipeline/stages` (см. примеры в [TESTING.md](TESTING.md) при необходимости)

### Этап 4: Event-Driven

- RabbitMQ: http://localhost:15672 → Exchanges → events. Создать контакт — проверить событие `contact.created`
- При наличии: `bash scripts/test-events.sh`

### Этап 5: WebSocket

- DevTools → Network → WS: активное соединение к `ws://localhost:3004`
- Два окна: в одном создать контакт, в другом — обновление в реальном времени

### Этап 6: E2E-сценарий

Регистрация → компания → контакт → сделка → воронка `/dashboard/pipeline` → смена стадии → аналитика `/dashboard/analytics` → команда `/dashboard/team`.

---

## Решение проблем

| Проблема | Действия |
|----------|----------|
| Сервис не запускается | `docker-compose logs <service-name>`, `docker-compose build --no-cache <service-name>`, `docker-compose up -d <service-name>` |
| Ошибка подключения к БД | `docker-compose ps postgres`, `docker-compose exec postgres psql -U postgres -d postgres -c "SELECT 1;"` |
| Frontend не работает | Проверить порт 3000 (или 5173 в Docker): `lsof -i :3000`. Локально: `cd frontend && npm install && npm run dev` |
| WebSocket не подключается | `docker-compose ps websocket-service`, `docker-compose logs websocket-service`. Проверить `NEXT_PUBLIC_WS_URL=ws://localhost:3004` |
| Зависимости | `docker-compose build --no-cache`; при необходимости переустановка пакетов в контейнере |

Подключение к БД вручную: `docker-compose exec postgres psql -U postgres -d postgres`  
Redis: `docker-compose exec redis redis-cli`  
Очереди RabbitMQ: http://localhost:15672 или `docker-compose exec rabbitmq rabbitmqctl list_queues`

---

## Чеклист готовности

- [ ] Все сервисы запущены и проходят health checks
- [ ] Регистрация и вход работают
- [ ] Создание компаний и контактов
- [ ] Воронка отображается на `/dashboard/pipeline`
- [ ] События в RabbitMQ
- [ ] WebSocket подключен
- [ ] Нет критических ошибок в консоли

---

## Дальнейшие шаги

Состояние продукта и приоритеты задач — в [ROADMAP.md](../ROADMAP.md).  
Рекомендации по тестам и сценариям — в [TESTING.md](TESTING.md).
