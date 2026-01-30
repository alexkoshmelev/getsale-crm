# Флоу Telegram: подключение, синхронизация, сообщения

## Обзор

1. **Подключение аккаунта** — пользователь подключает новый Telegram-аккаунт (send-code → verify-code).
2. **Выбор чатов** — после успешной верификации открывается шаг выбора чатов/папок для синхронизации. Только выбранные чаты отображаются на фронте и загружаются в БД.
3. **Начальная синхронизация** — после сохранения выбранных чатов запускается фоновый sync: история сообщений выбранных чатов скачивается из Telegram API с учётом rate limits (задержки, FLOOD_WAIT). Прогресс передаётся через WebSocket (прогресс-бар на фронте).
4. **Загрузка с фронта** — при открытии страницы сообщений чаты и история загружаются **только из БД** (не из Telegram API).
5. **Real-time в открытом чате** — когда пользователь в окне конкретного чата, новые входящие сообщения приходят через WebSocket: сервис ловит событие от Telegram, проверяет, что чат в списке разрешённых (sync_chats), сохраняет в БД, публикует событие в RabbitMQ → WebSocket рассылает в комнату `bd-account:{id}:chat:{channelId}`; фронт подписан на эту комнату, отображает сообщение и при необходимости воспроизводит звук уведомления.

---

## База данных

- **bd_account_sync_chats** — выбранные для синхронизации чаты по аккаунту (`bd_account_id`, `telegram_chat_id`, `title`, `peer_type`). Только эти чаты синхронизируются и показываются.
- **bd_accounts** — добавлены поля: `sync_status`, `sync_error`, `sync_progress_total`, `sync_progress_done`, `sync_started_at`, `sync_completed_at`.
- Миграция: `migrations/migrations/20250128000001_bd_account_sync_chats.ts`.

---

## Backend

### BD Accounts Service

- **GET /api/bd-accounts/:id/sync-chats** — список выбранных чатов.
- **POST /api/bd-accounts/:id/sync-chats** — сохранить выбранные чаты (body: `{ chats: [{ id, name, isUser, isGroup, isChannel }] }`).
- **POST /api/bd-accounts/:id/sync-start** — запустить начальную синхронизацию (фоново; прогресс через WebSocket).
- **GET /api/bd-accounts/:id/sync-status** — статус синхронизации.

В **TelegramManager**:

- **syncHistory(accountId, organizationId, onProgress?)** — для каждого чата из `bd_account_sync_chats` запрашивает историю через `Api.messages.GetHistory` с задержками и обработкой FLOOD_WAIT, сохраняет сообщения в `messages`, публикует события sync started/progress/completed/failed.
- **handleNewMessage** — перед сохранением проверяет `isChatAllowedForAccount(accountId, chatId)` по `bd_account_sync_chats`; только разрешённые чаты сохраняются в БД и публикуют событие с `channelId` для WebSocket.

### Messaging Service

- **GET /api/messaging/chats?channel=telegram&bdAccountId=...** — список чатов только из БД, при указании `bdAccountId` — только чаты, входящие в `bd_account_sync_chats` для этого аккаунта.
- Сообщения загружаются только из БД (GET /api/messaging/messages по channel/channelId).

### WebSocket Service

- Подписка на события: `bd_account.sync.started`, `bd_account.sync.progress`, `bd_account.sync.completed`, `bd_account.sync.failed` — рассылка в комнату `bd-account:{bdAccountId}`.
- При `message.received` — рассылка в `bd-account:{bdAccountId}` и в `bd-account:{bdAccountId}:chat:{channelId}` событием `new-message` (для real-time в открытом чате).

---

## Frontend

### BD Accounts (/dashboard/bd-accounts)

- После успешного verify-code переход на шаг **select-chats**: загружаются диалоги (GET dialogs), отображаются с чекбоксами.
- Кнопки: «Пропустить» (закрыть без синхронизации), «Сохранить и синхронизировать» — POST sync-chats, POST sync-start, подписка на комнату `bd-account:{id}` для событий sync; показывается прогресс-бар, по завершении модалка закрывается.

### Messaging (/dashboard/messaging)

- Чаты загружаются через GET /api/messaging/chats с `bdAccountId` выбранного аккаунта (только чаты из БД для выбранных sync чатов).
- История сообщений — только из БД (GET /api/messaging/messages).
- Подписка на `bd-account:{selectedAccountId}` и на `bd-account:{selectedAccountId}:chat:{selectedChat.channel_id}`; при событии `new-message` — добавление сообщения в список и при необходимости звук уведомления (`/notification.mp3`).

---

## События (shared/events)

- Добавлены: `BD_ACCOUNT_SYNC_STARTED`, `BD_ACCOUNT_SYNC_PROGRESS`, `BD_ACCOUNT_SYNC_COMPLETED`, `BD_ACCOUNT_SYNC_FAILED`.
- В `MessageReceivedEvent.data` добавлено поле `channelId` для таргетирования WebSocket-комнат.

---

## Запуск миграции

Из корня или из папки migrations (если knex установлен глобально или через npx):

```bash
cd migrations && npx knex migrate:latest
```

Или через скрипт проекта, если он настроен на запуск миграций.

---

## Звук уведомления

Фронт воспроизводит `/notification.mp3` при новом сообщении в открытом чате. Файл нужно положить в `frontend/public/notification.mp3` (или отключить вызов при его отсутствии).

---

## Входящие сообщения (gram.js): практики и отладка

### Как это работает

- **User API (MTProto)** — мы подключаемся как пользователь (не бот). Telegram шлёт апдейты на активную сессию по тому же соединению.
- Обрабатываются три типа апдейтов:
  1. **UpdateShortMessage / UpdateShortChatMessage** — «короткий» формат (личные и групповые сообщения), часто приходят первыми.
  2. **UpdateNewMessage / UpdateNewChannelMessage** — полный объект `Message` (личные чаты, группы, каналы).
  3. **NewMessage({ incoming: true })** — высокоуровневый event gram.js для входящих сообщений (дублирует обработку для надёжности).

- В **addEventHandler** второй аргумент обязан быть экземпляром **EventBuilder** (например `new Raw({ func: ... })` или `new NewMessage({})`). Передача обычного объекта `{ func: () => true }` ломает цикл обработки апдейтов в gram.js (нет методов `resolve`/`build`/`filter`).

- Чтобы Telegram не переставал слать апдейты, нужна периодическая «активность»: в сервисе каждые 10 минут вызывается **updates.GetState()** для каждого подключённого аккаунта (keepalive).

### Если сообщения не приходят

1. **Чат не в списке синхронизации**  
   Сообщения обрабатываются только для чатов из **bd_account_sync_chats**. В логах будет: `Chat not in sync list (add chat to sync in UI), skipping message, accountId=..., chatId=...`. Нужно добавить этот чат в sync в UI (шаг выбора чатов после подключения аккаунта).

2. **Апдейты не доходят до сервера**  
   В логах не должно быть строк `Raw update: ...` при отправке сообщения с другого аккаунта. Возможные причины:
   - Один и тот же аккаунт залогинен в приложении и, например, в Telegram Desktop — Telegram может слать апдейты только на одно устройство; после действий в Desktop приём в gram.js может прекратиться (известная особенность). Рекомендация для прода: использовать аккаунт в CRM по возможности только через наше приложение или учитывать мультиустройство.
   - Соединение «засыпает» — keepalive (GetState раз в 10 мин) должен это предотвращать.

3. **Проверка по логам**  
   - Появление `Raw update: UpdateShortMessage` или `Raw update: UpdateNewMessage` при отправке сообщения на подключённый аккаунт — апдейты доходят, дальше смотреть фильтр по sync list и обработчики.
   - Отсутствие любых `Raw update` при отправке — проблема доставки апдейтов (сессия/мультиустройство/сеть).
