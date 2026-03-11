# Internal Service-to-Service API Contracts

Документ описывает HTTP-вызовы между микросервисами (ServiceHttpClient). Все вызовы требуют заголовка `X-Internal-Auth` (INTERNAL_AUTH_SECRET). Для вызовов от имени пользователя бэкенды ожидают заголовки `X-User-Id`, `X-Organization-Id`, опционально `X-User-Role`, `x-correlation-id` (gateway передаёт их при проксировании; при service-to-service контекст нужно передавать явно).

---

## 1. Auth Service → Pipeline Service

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/internal/pipeline/default-for-org` | Создание дефолтного пайплайна при регистрации организации. Idempotent: при уже существующем default возвращает 200 и существующий pipeline. |

**Request body:**
```json
{ "organizationId": "uuid" }
```

**Response:** `201` + `{ id, organization_id, name, ... }` или `200` + существующий pipeline.

**Caller:** `auth-service` (signup, new org).

---

## 2. CRM Service → BD Accounts Service

| Метод | Путь | Описание |
|-------|------|----------|
| GET | `/api/bd-accounts/:bdAccountId/search-groups?q=...` | Поиск групп (Telegram). |
| GET | `/api/bd-accounts/:bdAccountId/chats/:chatId/participants?limit=&offset=&excludeAdmins=` | Список участников чата. |
| GET | `/api/bd-accounts/:bdAccountId/chats/:chatId/active-participants?...` | Активные участники. |
| POST | `/api/bd-accounts/:bdAccountId/chats/:chatId/leave` | Выход из чата (body `{}`). |
| POST | `/api/bd-accounts/:bdAccountId/parse/resolve` | Парсинг источников. Body: `{ sources }`. |

**Headers:** при вызове от пользователя передавать `x-organization-id` (и при необходимости `x-user-id`).

**Callers:** `crm-service` (discovery-loop, parse, contacts import).

---

## 3. CRM Service → Campaign Service

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/campaigns/:campaignId/participants-bulk` | Добавление контактов в кампанию участниками. |
| POST | `/api/campaigns` | Создание кампании (из discovery task). Body: `{ name }` + auth headers. |

**Request (participants-bulk):**
```json
{ "contactIds": ["uuid", ...], "bdAccountId": "uuid" }
```

**Headers:** `x-organization-id` (обязательно при вызове из crm).

**Callers:** `crm-service` (discovery-loop, discovery-tasks).

---

## 4. Messaging Service → BD Accounts Service

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/bd-accounts/:bdAccountId/chats/:chatId/load-older-history` | Подгрузка старой истории. Body `{}`. |
| POST | `/api/bd-accounts/:bdAccountId/create-shared-chat` | Создание общего чата с лидом. |
| POST | `/api/bd-accounts/:bdAccountId/delete-message` | Удаление сообщения. |
| POST | `/api/bd-accounts/:bdAccountId/messages/:telegramMessageId/reaction` | Реакция на сообщение. Body: `{ chatId, reaction }`. |

**Create-shared-chat body:** `{ title, lead_telegram_user_id, extra_usernames? }`.

**Callers:** `messaging-service` (conversations, messages). Передавать `x-user-id`, `x-organization-id`, `x-correlation-id` где есть контекст запроса.

---

## 5. Messaging Service → AI Service

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/ai/conversations/analyze` | Анализ диалога. Body: `{ messages }`. |
| POST | `/api/ai/chat/summarize` | Суммаризация. Body: `{ messages }`. |

**Callers:** `messaging-service` (conversations: lead-context, summarize).

---

## 6. Campaign Service → Pipeline Service

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/pipeline/leads` | Создание лида. |

**Request body:**
```json
{
  "contactId": "uuid",
  "pipelineId": "uuid",
  "stageId": "uuid"
}
```

**Response:** `201` + `{ id, ... }`.

**Caller:** `campaign-service` (helpers: создание лида при конвертации/ответе).

---

## 7. Campaign Service → Messaging Service

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/messaging/send` | Отправка сообщения контакту. |

**Request body (пример):**
```json
{
  "contactId": "uuid",
  "channel": "telegram",
  "content": "string",
  ...
}
```

**Caller:** `campaign-service` (campaign-loop).

---

## 8. Automation Service → CRM Service

| Метод | Путь | Описание |
|-------|------|----------|
| POST | `/api/crm/deals` | Создание сделки (из лида). Body: `{ leadId, pipelineId, contactId?, title }`. |
| PATCH | `/api/crm/deals/:dealId/stage` | Смена стадии сделки. Body: `{ stageId }` + headers `X-User-Id`, `X-Organization-Id`. |

**Caller:** `automation-service` (event-handlers: SLA breach, rule actions).

---

## 9. Automation Service → Pipeline Service

| Метод | Путь | Описание |
|-------|------|----------|
| PUT | `/api/pipeline/clients/:clientId/stage` | Смена стадии лида по contactId (clientId). По контакту находится лид (при наличии `pipelineId` в body — в указанном пайплайне, иначе — последний обновлённый). Обязателен контекст: `organizationId`, `userId`. |

**Request body:**
```json
{ "stageId": "uuid", "pipelineId": "uuid (optional)" }
```

**Response:** `200` + `{ stage: { id, name } }`. `404` если лид для контакта не найден.

**Caller:** `automation-service` (event-handlers: move lead stage). Передаёт `context: { organizationId, userId }` и при наличии в событии — `pipelineId` в body.

---

## Рекомендации

1. **Контекст:** при любом вызове от имени пользователя передавать `context: { userId, organizationId, userRole?, correlationId? }` в `ServiceHttpClient.request()` (см. shared/service-core RequestContext).
2. **Идемпотентность:** обработчики событий (например attachLead по `lead.created.from.campaign`) должны быть идемпотентны по ключу (conversationId + leadId); при повторной доставке — no-op или проверка "уже обработано".
3. **Ошибки:** 4xx не ретраятся; 5xx — ретраи в ServiceHttpClient. При обработке событий определить политику: критичные действия — retry/DLQ; некритичные — log и пропуск.
