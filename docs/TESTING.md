# Тестирование

Сценарии проверки и чек-листы. Запуск окружения — см. [GETTING_STARTED.md](GETTING_STARTED.md).

---

## Скрипты

```bash
# Health checks всех сервисов
bash scripts/test-services.sh

# Базовое тестирование API (при наличии)
bash scripts/test-api.sh

# События RabbitMQ (при наличии)
bash scripts/test-events.sh

# E2E (stage3)
npm run stage3-e2e
```

---

## Чек-лист по этапам

### Инфраструктура

- [ ] `docker-compose up -d`, все сервисы Up
- [ ] `bash scripts/test-services.sh` — все ✅
- [ ] API Gateway: `curl http://localhost:8000/health`
- [ ] Сервисы: `/health` на портах (auth 3001, crm 3002, messaging 3003, websocket 3004, ai 3005, user 3006, bd-accounts 3007, pipeline 3008, automation 3009, analytics 3010, team 3011, campaign 3012)

### Auth

- [ ] POST `/api/auth/signup` — возвращает accessToken, refreshToken
- [ ] POST `/api/auth/signin` — возвращает accessToken
- [ ] POST `/api/auth/verify` с токеном — информация о пользователе
- [ ] POST `/api/auth/refresh` с refreshToken — новый accessToken

### CRM

- [ ] GET/POST `/api/crm/companies` (с Bearer)
- [ ] GET/POST `/api/crm/contacts`
- [ ] GET/POST `/api/crm/deals`; PATCH `/api/crm/deals/:id/stage`

### Pipeline

- [ ] GET/POST `/api/pipeline`; GET/POST `/api/pipeline/stages`
- [ ] GET/POST/PATCH/DELETE по лидам (при наличии)

### Messaging и BD Accounts

- [ ] GET `/api/messaging/chats`, GET `/api/messaging/messages` (пагинация)
- [ ] GET `/api/bd-accounts`, POST `/api/bd-accounts/connect` (при настройке Telegram)

### WebSocket

- [ ] Открыть frontend, DevTools → Network → WS: соединение к ws://localhost:3004
- [ ] В двух окнах: в одном создать контакт/сделку — во втором приходит обновление

### Frontend

- [ ] http://localhost:3000 — страница входа
- [ ] Регистрация → редирект на `/dashboard`
- [ ] CRM, Pipeline, Messaging, BD Accounts, Analytics, Team, Settings — страницы открываются

---

## E2E-сценарий (ручная проверка)

1. Регистрация через UI
2. Создание компании и контакта (CRM)
3. Создание воронки и стадий (Pipeline)
4. Создание сделки, смена стадии
5. Подключение Telegram (BD Accounts), выбор чатов
6. Отправка сообщения в чате (Messaging)
7. Проверка аналитики и команды

Приоритеты доработки тестов — в [STATE_AND_ROADMAP.md](STATE_AND_ROADMAP.md).
