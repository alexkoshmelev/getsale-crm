# Internal Service-to-Service API Contracts

Документ описывает HTTP-вызовы между микросервисами (ServiceHttpClient). Все вызовы требуют заголовка `X-Internal-Auth` (INTERNAL_AUTH_SECRET). Для вызовов от имени пользователя бэкенды ожидают заголовки `X-User-Id`, `X-Organization-Id`, опционально `X-User-Role`, `x-correlation-id` (gateway передаёт их при проксировании; при service-to-service контекст нужно передавать явно).

**Важно:** Бэкенды не должны быть доступны из интернета. Доступ только через API Gateway или из внутренней сети. См. [DEPLOYMENT.md](DEPLOYMENT.md) — раздел «Безопасность: gateway и бэкенды».

**Инвентаризация HTTP-клиентов:** какой сервис куда ходит, `baseUrl` из env, локальные таймауты и `retries` — [SERVICE_HTTP_CLIENT_INVENTORY.md](SERVICE_HTTP_CLIENT_INVENTORY.md) (grep `new ServiceHttpClient`: только bd-accounts, messaging, crm, campaign, automation; analytics / activity / team / websocket — без этого клиента).

---

## Internal-only endpoints (service-to-service)

Эндпоинты ниже не проксируются через API Gateway; вызовы только между сервисами с заголовком `X-Internal-Auth` (INTERNAL_AUTH_SECRET). Контекст организации передаётся в `X-Organization-Id`.

| Сервис | Метод | Путь | Описание |
|--------|-------|------|----------|
| **pipeline-service** | POST | `/internal/pipeline/default-for-org` | Создание дефолтного пайплайна для организации. Body не используется; organizationId только из заголовка `X-Organization-Id`. |
| **messaging-service** | POST | `/internal/conversations/ensure` | Создание/обновление conversation. Body: organizationId, bdAccountId, channel, channelId и др. |
| **messaging-service** | POST | `/internal/messages` | Создание/upsert сообщения (по bd_account_id, channel_id, telegram_message_id). |
| **messaging-service** | PATCH | `/internal/messages/edit-by-telegram` | Редактирование сообщения по (bdAccountId, channelId, telegramMessageId, content, …). Заголовок `X-Organization-Id` обязателен (S4). |
| **messaging-service** | POST | `/internal/messages/delete-by-telegram` | Удаление сообщений по (bdAccountId, channelId?, telegramMessageIds[]). Заголовок `X-Organization-Id` обязателен (S4). |
| **messaging-service** | POST | `/internal/messages/orphan-by-bd-account` | S2/A1: обнуление `bd_account_id` у сообщений при удалении аккаунта. Body: `{ bdAccountId }`. Заголовок `X-Organization-Id` обязателен. Вызывается bd-accounts перед удалением аккаунта. Fallback при недоступности messaging: [RUNBOOK_ORPHAN_MESSAGES.md](RUNBOOK_ORPHAN_MESSAGES.md). |
| **bd-accounts-service** | GET | `/internal/sync-chats?bdAccountId=...` | Список чатов синхронизации для аккаунта. Заголовок `X-Organization-Id` обязателен. Возврат: `{ chats: [{ telegram_chat_id, title, peer_type, history_exhausted, folder_id, folder_ids }] }`. |
| **bd-accounts-service** | GET | `/internal/search-sync-chats?q=&limit=` | Поиск по синхронизированным чатам организации (title, контакт из последнего сообщения). Заголовок `X-Organization-Id` обязателен. Возврат: `{ items: [{ channel, channel_id, bd_account_id, name }] }`. Используется messaging-service для GET `/api/messaging/search` (A1). |

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
| GET | `/api/bd-accounts/:bdAccountId/search-groups?q=&type=&limit=&maxPages=` | Поиск групп/каналов (Telegram). Query: `q` (≥2 символа), `type`=`groups`\|`channels`\|`all`, `limit` (1–100, по умолчанию 50), **`maxPages`** (1–15, по умолчанию 10) — сколько страниц SearchGlobal / SearchPosts запрашивать при пагинации. |
| GET | `/api/bd-accounts/:bdAccountId/chats/:chatId/participants?limit=&offset=&excludeAdmins=` | Список участников чата. |
| GET | `/api/bd-accounts/:bdAccountId/chats/:chatId/active-participants?...` | Активные участники. |
| GET | `/api/bd-accounts/:bdAccountId/chats/:channelId/comment-participants?linkedChatId=&postLimit=&maxRepliesPerPost=&excludeAdmins=` | Уникальные авторы **комментариев** под недавними постами канала (GetHistory + GetReplies). Query: **`linkedChatId`** (обязательный, id группы обсуждения), `postLimit` 5–100, `maxRepliesPerPost` 20–500, `excludeAdmins`. Используется CRM parse для `type=channel` + `linkedChatId` ([`discovery-loop.ts`](../services/crm-service/src/discovery-loop.ts)). |
| GET | `/api/bd-accounts/:bdAccountId/chats/:chatId/reaction-participants?depth=` | Участники, внесшие **реакции** на недавние сообщения канала (best-effort: GetHistory + при наличии — **`messages.getMessagesViews`** с `increment=false` для уточнения счётчиков + **`GetMessageReactionsList`** в GramJS; иначе пустой список). Сообщения с реакциями **сортируются по числу просмотров** (убывание), затем берётся ограниченное число постов — списка «кто просмотрел» у клиента MTProto **нет**, только счётчики ([`messages.getMessagesViews`](https://core.telegram.org/method/messages.getMessagesViews)). Query: **`depth`** — глубина истории в сообщениях, 20–200 (CRM передаёт из настроек parse). Используется CRM parse при **`channelEngagement: 'reactions'`** для канала без `linkedChatId` ([`chat-sync-reaction-users.ts`](../services/bd-accounts-service/src/telegram/chat-sync-reaction-users.ts)). |
| POST | `/api/bd-accounts/:bdAccountId/chats/:chatId/leave` | Выход из чата (body `{}`). |
| POST | `/api/bd-accounts/:bdAccountId/parse/resolve` | Расширенный resolve для парсинга. Body: `{ sources: string[] }` (лимит длины массива как у `resolve-chats`). Ответ `{ results }`: успех — объекты **ResolvedSource** (`input`, `type`, `title`, `username?`, `chatId`, `membersCount?`, `linkedChatId?`, `canGetMembers`, `canGetMessages`); ошибка по строке — тот же каркас с `error` и пустыми полями. Реализация: [`chat-sync-resolve.ts`](../services/bd-accounts-service/src/telegram/chat-sync-resolve.ts). |

**CRM (прокси):** `POST /api/crm/parse/resolve` с телом `{ sources, bdAccountId }` вызывает этот путь от имени органа ([`parse.ts`](../services/crm-service/src/routes/parse.ts)). **`POST /api/crm/parse/start`** — на верхнем уровне тела (рядом с `sources`, `accountIds`, `settings`) опционально **`channelEngagement`**: `default` \| `reactions` ([`ParseStartSchema`](../services/crm-service/src/validation.ts)); при `reactions` для источника `type=channel` без `linkedChatId` воркер выбирает стратегию **`reaction_users`** и дергает `reaction-participants` выше. SSE прогресса дополняется полями **`etaSeconds`**, **`speed`** (оценка по `parseStartedAtMs` и счётчикам чатов) — см. [`parse-progress-utils.ts`](../services/crm-service/src/parse-progress-utils.ts).

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

**Таймаут HTTP-клиента:** по умолчанию **65s** (как у campaign-service → AI для длинных ответов модели); ретраи и circuit breaker — из `interServiceHttpDefaults` / `SERVICE_HTTP_*`. Переопределение: **`MESSAGING_AI_HTTP_TIMEOUT_MS`** (мс, не ниже 5000). См. [DEPLOYMENT.md](DEPLOYMENT.md).

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

**Таймаут HTTP-клиента:** по умолчанию **15s**; ретраи и circuit breaker — `interServiceHttpDefaults` / `SERVICE_HTTP_*`. Переопределение: **`AUTOMATION_CRM_HTTP_TIMEOUT_MS`** (мс, не ниже 3000). См. [DEPLOYMENT.md](DEPLOYMENT.md).

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

**Таймаут HTTP-клиента:** по умолчанию **15s**; **`AUTOMATION_PIPELINE_HTTP_TIMEOUT_MS`** (мс, не ниже 3000). См. [DEPLOYMENT.md](DEPLOYMENT.md).

---

## Рекомендации

1. **Контекст:** при любом вызове от имени пользователя передавать `context: { userId, organizationId, userRole?, correlationId? }` в `ServiceHttpClient.request()` (см. shared/service-core RequestContext).
2. **Идемпотентность:** обработчики событий (например attachLead по `lead.created.from.campaign`) должны быть идемпотентны по ключу (conversationId + leadId); при повторной доставке — no-op или проверка "уже обработано".
3. **Ошибки:** 4xx не ретраятся; 5xx — ретраи в ServiceHttpClient. При обработке событий определить политику: критичные действия — retry/DLQ; некритичные — log и пропуск.
