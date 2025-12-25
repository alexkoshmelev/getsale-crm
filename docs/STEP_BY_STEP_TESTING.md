# Пошаговое тестирование платформы

## Шаг 1: Проверка инфраструктуры ✅

```bash
# Запустить все сервисы
docker-compose up -d

# Проверить статус
docker-compose ps

# Проверить health checks
bash scripts/test-services.sh
```

**Ожидаемый результат:** Все сервисы показывают статус "Up" и health checks возвращают 200.

---

## Шаг 2: Тестирование Auth Flow

### 2.1 Регистрация

```bash
curl -X POST http://localhost:8000/api/auth/signup \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "test123456",
    "organizationName": "Test Company"
  }'
```

**Ожидаемый результат:** 
- Возвращается `accessToken` и `refreshToken`
- Создается пользователь в БД
- Публикуется событие `user.created`

### 2.2 Вход

```bash
curl -X POST http://localhost:8000/api/auth/signin \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "test123456"
  }'
```

**Ожидаемый результат:** Возвращается новый `accessToken`.

### 2.3 Проверка токена

```bash
TOKEN="your_access_token"
curl -X POST http://localhost:8000/api/auth/verify \
  -H "Content-Type: application/json" \
  -d "{\"token\": \"$TOKEN\"}"
```

**Ожидаемый результат:** Возвращается информация о пользователе.

---

## Шаг 3: Тестирование через Frontend

### 3.1 Открыть фронтенд

1. Открыть http://localhost:3000
2. Должна открыться страница входа

### 3.2 Регистрация через UI

1. Нажать "Зарегистрироваться"
2. Заполнить форму:
   - Название компании: "Test Company"
   - Email: "test@example.com"
   - Пароль: "test123456"
3. Нажать "Зарегистрироваться"

**Ожидаемый результат:** 
- Редирект на `/dashboard`
- Виден Dashboard с базовой статистикой

### 3.3 Проверка Dashboard

**Ожидаемый результат:**
- Видны карточки со статистикой (компании, контакты, сообщения, сделки)
- Все значения = 0 (для нового аккаунта)

---

## Шаг 4: Тестирование CRM

### 4.1 Создание компании

1. Перейти в `/dashboard/crm`
2. Нажать "Добавить"
3. Заполнить форму компании
4. Сохранить

**Ожидаемый результат:**
- Компания появляется в списке
- Можно увидеть в API: `GET /api/crm/companies`

### 4.2 Создание контакта

1. В разделе CRM перейти на вкладку "Контакты"
2. Создать контакт
3. Привязать к компании

**Ожидаемый результат:**
- Контакт появляется в списке
- Публикуется событие `contact.created`
- Можно увидеть в API: `GET /api/crm/contacts`

---

## Шаг 5: Тестирование Pipeline

### 5.1 Создание воронки

```bash
TOKEN="your_token"
curl -X POST http://localhost:8000/api/pipeline \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Sales Pipeline",
    "description": "Main sales pipeline",
    "isDefault": true
  }'
```

### 5.2 Создание стадий

```bash
PIPELINE_ID="pipeline_id_from_previous_step"
curl -X POST http://localhost:8000/api/pipeline/stages \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "pipelineId": "'"$PIPELINE_ID"'",
    "name": "Lead",
    "orderIndex": 1,
    "color": "#3B82F6"
  }'
```

Повторить для стадий: Qualified, Proposal, Negotiation, Closed

### 5.3 Просмотр Kanban

1. Перейти в `/dashboard/pipeline`
2. Должна отображаться Kanban доска со стадиями

**Ожидаемый результат:**
- Видны все созданные стадии
- Можно перетаскивать сделки (после реализации drag & drop)

---

## Шаг 6: Тестирование Messaging

### 6.1 Подключение Telegram аккаунта

```bash
curl -X POST http://localhost:8000/api/bd-accounts/connect \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "platform": "telegram",
    "phoneNumber": "+1234567890",
    "apiId": 12345,
    "apiHash": "your_api_hash",
    "phoneCode": "12345"
  }'
```

**Примечание:** Требуются реальные Telegram API credentials.

### 6.2 Просмотр сообщений

1. Перейти в `/dashboard/messaging`
2. Должен отображаться список чатов

**Ожидаемый результат:**
- Видны входящие сообщения (если есть)
- Можно открыть чат и отправить сообщение

---

## Шаг 7: Тестирование Automation

### 7.1 Создание правила автоматизации

```bash
curl -X POST http://localhost:8000/api/automation/rules \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Auto-move after response",
    "triggerType": "message.received",
    "triggerConfig": {},
    "conditions": [
      {
        "field": "is_first_response",
        "operator": "eq",
        "value": true
      }
    ],
    "actions": [
      {
        "type": "move_to_stage",
        "targetStageId": "qualified_stage_id"
      }
    ],
    "enabled": true
  }'
```

### 7.2 Тестирование правила

1. Получить сообщение от контакта
2. Проверить, что сделка автоматически переместилась в стадию "Qualified"

**Ожидаемый результат:**
- Публикуется событие `automation.rule.triggered`
- Сделка перемещается автоматически

---

## Шаг 8: Тестирование Analytics

### 8.1 Просмотр аналитики

1. Перейти в `/dashboard/analytics`
2. Должны отображаться метрики

**Ожидаемый результат:**
- Видны конверсии по стадиям
- Видна стоимость воронки
- Видна производительность команды

### 8.2 Экспорт данных

```bash
curl -X GET "http://localhost:8000/api/analytics/export?format=csv" \
  -H "Authorization: Bearer $TOKEN" \
  -o analytics-export.csv
```

**Ожидаемый результат:**
- Скачивается CSV файл с метриками

---

## Шаг 9: Тестирование WebSocket

### 9.1 Подключение через Frontend

1. Открыть DevTools → Network → WS
2. Должно быть активное WebSocket соединение

**Ожидаемый результат:**
- Видно WebSocket соединение к `ws://localhost:3004`
- Статус: Connected

### 9.2 Получение событий в реальном времени

1. В одном окне создать контакт
2. В другом окне должно прийти событие через WebSocket

**Ожидаемый результат:**
- Событие `contact.created` приходит в реальном времени
- UI обновляется автоматически

---

## Шаг 10: End-to-End сценарий

### Полный flow продажи

1. **Регистрация** → Создать аккаунт
2. **Создание компании** → Добавить компанию клиента
3. **Создание контакта** → Добавить контактное лицо
4. **Создание сделки** → Создать сделку в воронке
5. **Подключение Telegram** → Подключить BD аккаунт
6. **Получение сообщения** → Получить сообщение от контакта
7. **AI Draft** → Сгенерировать ответ через AI
8. **Отправка сообщения** → Отправить ответ
9. **Перемещение по стадии** → Переместить сделку в следующую стадию
10. **Автоматизация** → Проверить автоматическое перемещение
11. **Аналитика** → Просмотреть метрики

**Ожидаемый результат:**
- Все шаги выполняются без ошибок
- Данные сохраняются корректно
- События публикуются и обрабатываются
- UI обновляется в реальном времени

---

## Чеклист готовности

- [ ] Все сервисы запускаются
- [ ] Health checks работают
- [ ] Auth flow работает
- [ ] CRUD операции работают
- [ ] Event-driven коммуникация работает
- [ ] WebSocket работает
- [ ] Frontend отображает данные
- [ ] Real-time обновления работают
- [ ] Automation работает
- [ ] Analytics собирает данные

---

## Следующие шаги после тестирования

1. Исправить найденные баги
2. Добавить недостающий функционал
3. Улучшить UX
4. Добавить валидацию
5. Оптимизировать производительность
6. Добавить тесты

