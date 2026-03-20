# CRM API — компании, контакты, сделки

**Сервис:** crm-service  
**Обновлено:** 2026-03-20

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
| GET | `/api/crm/contacts/:id` | Детали контакта (включая `companyName`, **`telegramGroups`** — список групп, в которых контакт найден при импорте). 404 если не найден |
| POST | `/api/crm/contacts` | Создание. Body: `firstName` (обяз.), `lastName`, `email`, `phone`, `telegramId`, `companyId`, `consentFlags` |
| POST | `/api/crm/contacts/import-from-telegram-group` | Импорт участников Telegram-группы как контактов. Body: `bdAccountId`, `telegramChatId` (обяз.), `telegramChatTitle`, `searchKeyword` (опц.), `excludeAdmins`, `leaveAfter`, `postDepth` (опц.). Требует настроенный bd-accounts client. Ответ: `{ contactIds, created, matched }`. 503 если discovery не настроен; 404 если BD-аккаунт не принадлежит организации. При `leaveAfter: true` после импорта вызывается выход из чата (bd-accounts). |
| PUT / PATCH | `/api/crm/contacts/:id` | Обновление (частичное). Поля: `firstName`, `lastName`, `email`, `phone`, `telegramId`, `companyId`, `displayName`, `username`, `consentFlags` |
| DELETE | `/api/crm/contacts/:id` | Удаление. У сделок поле `contact_id` обнуляется |

**Ответ списка:** `{ items: [...], pagination: { page, limit, total, totalPages } }`. В каждом элементе есть `companyName` при наличии компании.

---

## Сделки (Deals) и воронка

Сделка связывает **компанию** (опционально при создании из лида), опционально **контакт**, **воронку** (pipeline) и **стадию** (stage). Связь **Lead → Deal (1:1):** при создании сделки с `leadId` лид переводится в стадию **Converted**, публикуется `lead.converted`; в ответе сделки есть `leadId`.

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/crm/deals` | Список с пагинацией. Query: `page`, `limit`, `search` (по title), `companyId`, `contactId`, `pipelineId`, `stageId`, `ownerId`. В каждом элементе: `leadId` (если сделка создана из лида). |
| GET | `/api/crm/deals/:id` | Детали сделки (включая `companyName`, `pipelineName`, `stageName`, `stageOrder`, `leadId`). 404 если не найдена |
| POST | `/api/crm/deals` | Создание. Body: `companyId` (опц.), `contactId` (опц.), `pipelineId` (обяз. без leadId), `stageId` (опц.), **`leadId`** (опц.). При **leadId**: лид в организации, у лида нет сделки; `contact_id` и `pipeline_id` берутся из лида; лид переводится в стадию Converted; публикуются `deal.created` и `lead.converted`. Без leadId: как раньше. `title` (обяз.), `value`, `currency`. 409 если лид уже привязан к сделке. |
| PUT | `/api/crm/deals/:id` | Обновление (частичное). Поля: `title`, `value`, `currency`, `contactId`, `ownerId` |
| PATCH | `/api/crm/deals/:id/stage` | **Единственная точка смены стадии сделки.** Body: `stageId` (обяз.), `reason` (опц.), `autoMoved` (опц.). Обновляет `deals.stage_id`, дописывает `deals.history`, пишет в `stage_history`, публикует `deal.stage.changed`. Стадия должна принадлежать той же воронке. |
| DELETE | `/api/crm/deals/:id` | Удаление сделки и записей в `stage_history` |

**Валидация при создании/обновлении сделки:**
- `companyId`, `contactId`, `pipelineId`, `stageId` должны принадлежать организации пользователя.
- При **leadId**: лид должен быть в организации; `pipelineId`/`contactId` в body должны совпадать с лидом (или не передаваться — подставляются из лида); воронка лида должна содержать стадию **Converted**.
- `stageId` должен относиться к указанной воронке (`pipelineId`).
- Если воронка без стадий — POST вернёт 400: «Pipeline has no stages. Create at least one stage first.»

**Ответ списка/сделки:** в каждом элементе: `companyName`, `pipelineName`, `stageName`, `stageOrder`, **`leadId`** (если сделка создана из лида).

---

## Contact discovery (задачи)

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/crm/discovery-tasks` | Список задач организации. Query: `limit`, `offset`. |
| GET | `/api/crm/discovery-tasks/:id` | Детали задачи. |
| POST | `/api/crm/discovery-tasks` | Создание задачи. Body: `name`, `type` (`search` \| `parse`), **`params`** (см. ниже). |
| POST | `/api/crm/discovery-tasks/:id/action` | Body: `{ action: 'start' \| 'pause' \| 'stop' }`. |

**`params` для `type: 'search'`:** обязательно непустой **`queries`**: `string[]`. Нужен хотя бы один BD: **`bdAccountId`** (uuid) и/или **`accountIds`**: uuid[] (1–10). При нескольких аккаунтах discovery-loop может переключаться при **429/502/503** от bd-accounts (см. [PLAN_TELEGRAM_PARSE_FLOW.md](PLAN_TELEGRAM_PARSE_FLOW.md)). Опционально: `searchType` (`groups` \| `channels` \| `all`), `limitPerQuery` (1–100). В UI (**Contact discovery** → новый поиск) при выборе одного аккаунта уходит `bdAccountId`, при нескольких — **`accountIds`**.

**`params` для `type: 'parse'`:** нужен хотя бы один BD (`bdAccountId` и/или `accountIds` как выше). Нужны непустые **`chats`** (массив `{ chatId, title?, peerType? }`) **или** **`sources`** (объекты с полями в духе resolve: `chatId`, `linkedChatId`, `type`, `canGetMembers`, …). Опционально: `parseMode`, `postDepth`, `excludeAdmins`, `leaveAfter`, `campaignId`, `campaignName`, **`channelEngagement`** (`default` \| `reactions` — см. пошаговый `POST /api/crm/parse/start` и [INTERNAL_API.md](INTERNAL_API.md) §2).

Отдельный пошаговый флоу parse/resolve/start — в [INTERNAL_API.md](INTERNAL_API.md) и `POST /api/crm/parse/*`.

---

## Аналитика (Analytics)

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/crm/analytics/conversion` | Метрика конверсии Lead → Deal. Query: `pipelineId` (опц.). Ответ: `{ totalLeads, convertedLeads, conversionRate }`. conversionRate = convertedLeads / totalLeads (при totalLeads = 0 → 0). Baseline до ЭТАПА 2. |

---

## Ошибки

Формат ответа об ошибке: `{ error: string, code?: string }`.

| Код HTTP | code | Описание |
|----------|------|----------|
| 400 | VALIDATION | Невалидные данные (Zod) или бизнес-правило (стадия не из воронки, сущность не найдена в организации) |
| 404 | NOT_FOUND | Компания / контакт / сделка не найдена или не принадлежит организации |
| 409 | CONFLICT | Нельзя удалить компанию, у которой есть сделки; лид уже привязан к сделке (при POST с leadId) |
| 500 | INTERNAL_ERROR | Внутренняя ошибка сервера |

---

## События (RabbitMQ)

При изменениях CRM-сервис публикует события (если RabbitMQ подключён):

- `company.created`, `company.updated`
- `contact.created`, `contact.updated`
- `deal.created`, `deal.updated`, `deal.stage.changed`
- **`lead.converted`** (при создании сделки с leadId: data: leadId, dealId, pipelineId, convertedAt)

Их могут использовать Analytics, Automation, WebSocket и другие сервисы.

---

## Примечание по Telegram (BD Accounts)

Для Telegram-подключений в bd-accounts используется только **SOCKS5 proxy**.  
HTTP/HTTPS proxy для auth/connect потоков не поддерживается.
