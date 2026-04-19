# Владение таблицами и миграция A1

**Цель:** Один владелец на таблицу; остальные сервисы обращаются к данным только через API или события (без прямого доступа к чужим таблицам).

## Назначенное владение

| Таблицы | Владелец | Примечание |
|---------|----------|------------|
| `messages`, `conversations` | **messaging-service** | Единственный сервис, который пишет/читает эти таблицы. |
| `bd_accounts`, `bd_account_sync_*` | **bd-accounts-service** | Синк чатов, папок, аккаунты. |
| `pipelines`, `stages`, `pipeline_leads` | **pipeline-service** | Уже изолированы. |
| `organizations`, `users`, `refresh_tokens`, … | **auth-service** | Уже изолированы. |

## Текущие нарушения (до миграции)

- **bd-accounts-service** пишет в `messages` и `conversations` через **`telegram/message-db.ts`** и хендлеры **`telegram/event-handlers.ts`** (при наличии `messagingClient` — internal API messaging; иначе fallback SQL с метрикой **`bd_accounts_message_db_sql_bypass_total`**): создание, ensure conversation, удаление/правка по событиям Telegram.
- **messaging-service** пишет в `bd_account_sync_chats` в одном месте (messages.ts при отправке) и читает `bd_account_sync_chats` для списков чатов и истории.

## План миграции (этапы)

### Этап 1 (реализован)
- **Messaging** предоставляет внутренний API:
  - `POST /internal/conversations/ensure` — создание/обновление conversation.
  - `POST /internal/messages` — создание/upsert сообщения (по bd_account_id, channel_id, telegram_message_id); тело: organizationId, bdAccountId, contactId, channel, channelId, direction, status, unread, serialized, metadata, reactions?, our_reactions?.
- **bd-accounts** при сохранении входящего/исходящего сообщения вызывает этот API вместо прямой записи в БД. `MessageDb` принимает опциональный `messagingClient`; при его наличии `ensureConversation` и `saveMessageToDb` идут через HTTP к messaging-service. В bd-accounts index создаётся `ServiceHttpClient` к `MESSAGING_SERVICE_URL` и передаётся в `TelegramManager` → `MessageDb`. Удаление и редактирование сообщений по событиям Telegram по-прежнему выполняются в bd-accounts прямыми запросами к `messages` (этап 2).

### Этап 2 (реализован 2026-03-17)
- **Messaging** добавлены внутренние операции:
  - `PATCH /internal/messages/edit-by-telegram` — правка по (bdAccountId, channelId, telegramMessageId, content, telegram_entities?, telegram_media?).
  - `POST /internal/messages/delete-by-telegram` — удаление по (bdAccountId, channelId?, telegramMessageIds[]), возврат `{ deleted: [{ id, organization_id, channel_id, telegram_message_id }] }`.
- **bd-accounts** в `telegram/event-handlers.ts` удаление и редактирование переведены на `MessageDb.deleteByTelegram` и `MessageDb.editByTelegram` (при наличии messagingClient — вызов API messaging; иначе прямой запрос к БД). Активный путь: `telegram/index.ts` → EventHandlerSetup.

### Этап 3 (частично реализован 2026-03-17)
- **Messaging** перестал писать в `bd_account_sync_chats`: при отправке сообщения в Telegram блок INSERT в `bd_account_sync_chats` удалён; чаты добавляются только из UI синка (POST sync-chats в bd-accounts).
- **bd-accounts** внутренний endpoint для «добавить чат в синк» по запросу messaging — в бэклоге (не обязателен при текущем сценарии).

### Этап 4 (реализован 2026-03-17)
- **bd-accounts** добавлен внутренний роутер `routes/internal.ts`: `GET /internal/sync-chats?bdAccountId=...` с заголовком `X-Organization-Id`; возвращает `{ chats: [{ telegram_chat_id, title, peer_type, history_exhausted, folder_id, folder_ids }] }`. Роутер смонтирован по пути `/internal`.
- **Messaging** переведён на чтение данных о чатах через этот API:
  - `chats.ts`: при запросе списка чатов с `bdAccountId` — вызов bd-accounts `GET /internal/sync-chats`, затем сборка ответа по CTE `sync_list` из JSON (без чтения `bd_account_sync_chats`).
  - `messages-list-helpers.ts`: `getHistoryExhausted` и `enrichMessagesWithSenderNames` принимают опциональный `apiOptions: { bdAccountsClient, organizationId }`; при передаче — запрос к `GET /internal/sync-chats` и выбор нужного чата по `telegram_chat_id`. В `messages.ts` при наличии bdAccountId и organizationId в API передаётся этот контекст.

### Этап 4b (реализован 2026-03-20)
- **bd-accounts** `GET /internal/search-sync-chats?q=&limit=` — поиск по синхронизированным чатам организации (тот же контракт строк, что раньше строился в messaging через JOIN к `bd_account_sync_chats` и `messages`/`contacts`).
- **Messaging** больше не читает таблицу `bd_account_sync_chats`:
  - GET `/chats` без `bdAccountId`: distinct `bd_account_id` из `messages` (в `withOrgContext`), затем параллельные вызовы `GET /internal/sync-chats`, сборка JSON и JOIN в SQL через `json_to_recordset` (см. `chats-list-helpers.ts`).
  - GET `/search`: прокси на bd-accounts `GET /internal/search-sync-chats`.
  - `getHistoryExhausted` / `enrichMessagesWithSenderNames`: без fallback SELECT к sync-таблице; при отсутствии `apiOptions` — безопасные значения по умолчанию.

## Контракты внутреннего API

- Все внутренние вызовы защищены заголовком `X-Internal-Auth` (INTERNAL_AUTH_SECRET). Контекст организации/пользователя передаётся в заголовках `X-Organization-Id`, `X-User-Id` при необходимости.
- См. также [INTERNAL_API.md](../api/INTERNAL_API.md) и [DEPLOYMENT.md](../operations/DEPLOYMENT.md) (безопасность gateway и бэкендов).

## Сводка: что сделано / что осталось

| Этап | Статус | Примечание |
|------|--------|------------|
| 1 | ✅ | ensure + create message через internal API; bd-accounts MessageDb с messagingClient |
| 2 | ✅ | edit/delete через PATCH и POST internal; event-handlers используют MessageDb |
| 3 | ✅ | messaging не пишет в bd_account_sync_chats при отправке |
| 4 | ✅ | bd-accounts GET /internal/sync-chats + GET /internal/search-sync-chats; messaging не выполняет SELECT/JOIN к `bd_account_sync_chats` |

---

## A3 (2026-03-20): Whitelist прямых мутаций `messages` из bd-accounts-service

Владелец таблицы — **messaging-service**; любые новые пути записи в `messages` из bd-accounts должны идти через **internal HTTP** (или отдельный тикет на расширение whitelist).

| Место | Операция | Обоснование |
|--------|-----------|--------------|
| `routes/accounts.ts` | `UPDATE messages SET bd_account_id = NULL` | Только **fallback**, если недоступен `POST messaging /internal/messages/orphan-by-bd-account` (см. [ORPHAN_MESSAGES.md](../runbooks/ORPHAN_MESSAGES.md)). |
| `telegram/message-db.ts` | `INSERT` / `UPDATE` / `DELETE` сообщений и ensure `conversations` | **Bypass**, если `messagingClient` не передан в `MessageDb`: прямой SQL. В проде клиент задаётся в `index.ts` (`MESSAGING_SERVICE_URL`). Наблюдаемость: счётчик **`bd_accounts_message_db_sql_bypass_total{operation}`** (`ensure_conversation`, `save_message`, `delete_by_telegram`, `edit_by_telegram`), лог `message_db_sql_bypass`, алерт **`BdAccountsMessageDbSqlBypass`** в Prometheus. При наличии клиента — только `POST/PATCH` internal messaging. Опционально **`BD_ACCOUNTS_MESSAGE_DB_STRICT`** — bypass запрещён, операции падают с `MESSAGE_DB_STRICT_NO_CLIENT` ([DEPLOYMENT.md](../operations/DEPLOYMENT.md)). |
| *(архив)* | — | Файл `src/telegram-manager.ts` **удалён** (2026-03): дублировал фасад `telegram/*` и не импортировался. Удаления в TG обрабатываются в `event-handlers.ts` через `MessageDb.deleteByTelegram` → internal `POST .../delete-by-telegram` при настроенном клиенте. |

Проверка: `grep` по `INSERT INTO messages` / `UPDATE messages` в `services/bd-accounts-service` должен совпадать с таблицей выше или быть закрыт переносом в messaging.
