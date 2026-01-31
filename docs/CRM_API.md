# CRM API — компании, контакты, сделки

**Сервис:** crm-service  
**Обновлено:** 2025-01-21

Все запросы к CRM проходят через API Gateway с заголовками `x-user-id` и `x-organization-id` (после аутентификации).

---

## Компании (Companies)

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/crm/companies` | Список с пагинацией. Query: `page`, `limit`, `search` (по name/industry), `industry` (точное совпадение) |
| GET | `/api/crm/companies/:id` | Детали компании. 404 если не найдена или не своей организации |
| POST | `/api/crm/companies` | Создание. Body: `name` (обяз.), `industry`, `size` (1-10 \| 11-50 \| …), `description`, `goals`, `policies` |
| PUT | `/api/crm/companies/:id` | Обновление (частичное). Те же поля, все опциональны |
| DELETE | `/api/crm/companies/:id` | Удаление. 409 если у компании есть сделки; контакты отвязываются от компании |

**Ответ списка (GET list):** `{ items: [...], pagination: { page, limit, total, totalPages } }`

---

## Контакты (Contacts)

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/crm/contacts` | Список с пагинацией. Query: `page`, `limit`, `search` (имя, email, phone, display_name), `companyId` |
| GET | `/api/crm/contacts/:id` | Детали контакта (включая `companyName`). 404 если не найден |
| POST | `/api/crm/contacts` | Создание. Body: `firstName` (обяз.), `lastName`, `email`, `phone`, `telegramId`, `companyId`, `consentFlags` |
| PUT / PATCH | `/api/crm/contacts/:id` | Обновление (частичное). Поля: `firstName`, `lastName`, `email`, `phone`, `telegramId`, `companyId`, `displayName`, `username`, `consentFlags` |
| DELETE | `/api/crm/contacts/:id` | Удаление. У сделок поле `contact_id` обнуляется |

**Ответ списка:** `{ items: [...], pagination: { page, limit, total, totalPages } }`. В каждом элементе есть `companyName` при наличии компании.

---

## Сделки (Deals) и воронка

Сделка связывает **компанию** (обязательно), опционально **контакт**, **воронку** (pipeline) и **стадию** (stage). Попадание контакта/компании в воронку = создание сделки с указанием `pipelineId`; `stageId` можно не передавать — тогда подставится **первая стадия** воронки (по `order_index`).

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/crm/deals` | Список с пагинацией. Query: `page`, `limit`, `search` (по title), `companyId`, `contactId`, `pipelineId`, `stageId`, `ownerId` |
| GET | `/api/crm/deals/:id` | Детали сделки (включая `companyName`, `pipelineName`, `stageName`, `stageOrder`). 404 если не найдена |
| POST | `/api/crm/deals` | Создание. Body: `companyId` (обяз.), `contactId` (опц.), `pipelineId` (обяз.), `stageId` (опц. — если нет, берётся первая стадия воронки), `title` (обяз.), `value`, `currency` (3 символа) |
| PUT | `/api/crm/deals/:id` | Обновление (частичное). Поля: `title`, `value`, `currency`, `contactId`, `ownerId` |
| PATCH | `/api/crm/deals/:id/stage` | Перемещение по стадии. Body: `stageId` (обяз.), `reason` (опц.). Стадия должна принадлежать той же воронке |
| DELETE | `/api/crm/deals/:id` | Удаление сделки и записей в `stage_history` |

**Валидация при создании/обновлении сделки:**
- `companyId`, `contactId`, `pipelineId`, `stageId` должны принадлежать организации пользователя.
- `stageId` должен относиться к указанной воронке (`pipelineId`).
- Если воронка без стадий — POST вернёт 400: «Pipeline has no stages. Create at least one stage first.»

**Ответ списка сделок:** `{ items: [...], pagination: { page, limit, total, totalPages } }`. В каждом элементе: `companyName`, `pipelineName`, `stageName`, `stageOrder`.

---

## Ошибки

Формат ответа об ошибке: `{ error: string, code?: string }`.

| Код HTTP | code | Описание |
|----------|------|----------|
| 400 | VALIDATION | Невалидные данные (Zod) или бизнес-правило (стадия не из воронки, сущность не найдена в организации) |
| 404 | NOT_FOUND | Компания / контакт / сделка не найдена или не принадлежит организации |
| 409 | CONFLICT | Нельзя удалить компанию, у которой есть сделки |
| 500 | INTERNAL_ERROR | Внутренняя ошибка сервера |

---

## События (RabbitMQ)

При изменениях CRM-сервис публикует события (если RabbitMQ подключён):

- `company.created`, `company.updated`
- `contact.created`, `contact.updated`
- `deal.created`, `deal.updated`, `deal.stage.changed`

Их могут использовать Analytics, Automation, WebSocket и другие сервисы.
