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
- При `message.received` / `message.sent` — рассылка в `bd-account:{bdAccountId}` и в `bd-account:{bdAccountId}:chat:{channelId}` событием `new-message` (для real-time в открытом чате).
- При `message.deleted` и `message.edited` — рассылка в `bd-account:{bdAccountId}` (событие `event`), чтобы страница Messaging обновляла список сообщений (удаление/редактирование в реальном времени).
- При `bd_account.telegram_update` — рассылка в `bd-account:{bdAccountId}` (событие `event`) для typing, user_status, read_inbox, read_channel_inbox, read_outbox, read_channel_outbox, draft, message_id_confirmed, dialog_pinned, pinned_dialogs, notify_settings, user_name, user_phone, chat_participant_add/delete, scheduled_message, delete_scheduled_messages, message_poll, message_poll_vote, config, dc_options, lang_pack, theme, phone_call, callback_query, channel_too_long.

---

## Frontend

### BD Accounts (/dashboard/bd-accounts)

- После успешного verify-code переход на шаг **select-chats**: загружаются диалоги (GET dialogs), отображаются с чекбоксами.
- Кнопки: «Пропустить» (закрыть без синхронизации), «Сохранить и синхронизировать» — POST sync-chats, POST sync-start, подписка на комнату `bd-account:{id}` для событий sync; показывается прогресс-бар, по завершении модалка закрывается.

### Messaging (/dashboard/messaging)

- Чаты загружаются через GET /api/messaging/chats с `bdAccountId` выбранного аккаунта (только чаты из БД для выбранных sync чатов).
- История сообщений — только из БД (GET /api/messaging/messages).
- Подписка на `bd-account:{selectedAccountId}`; при событии `new-message` — добавление сообщения в список и при необходимости звук уведомления (`/notification.mp3`).
- При событии `event` с типом `message.deleted` — удаление сообщения из списка в открытом чате; при `message.edited` — обновление текста сообщения в списке.
- При событии `bd_account.telegram_update`: **typing** — показ «Печатает...» в шапке открытого чата (сброс через 6 сек); **user_status** — сохранение в `userStatusByUserId` (status + expires); в личных чатах отображается индикатор «онлайн» (зелёная точка) в списке чатов и в шапке чата, при UserStatusOffline с expires — «был(а) недавно»; **read_inbox** / **read_channel_inbox** — сброс счётчика непрочитанных у чата; **read_outbox** / **read_channel_outbox** — сохранение maxId по чату, исходящие сообщения с telegram_message_id ≤ maxId отображаются с галочками «прочитано» (двойная галочка); **draft** — подстановка черновика в поле ввода при открытии чата и при приходе черновика для текущего чата; **dialog_pinned** — добавление/удаление чата в локальный список закреплённых (`pinnedChannelIds`); **pinned_dialogs** — обновление порядка закреплённых чатов из Telegram (`order`); **user_name** / **user_phone** — сохранение в `contactDisplayOverrides` и отображение актуального имени/телефона в списке чатов и в шапке через `getChatNameWithOverrides`; **chat_participant_add** / **chat_participant_delete** — перезапрос списка чатов (`fetchChats`); **channel_too_long** — показ баннера «История чата устарела» с кнопкой «Обновить историю» (вызов `loadOlderMessages`); баннер сбрасывается при смене аккаунта. Остальные updateKind (message_id_confirmed, notify_settings, scheduled_message, delete_scheduled_messages, message_poll, message_poll_vote, config, dc_options, lang_pack, theme, phone_call, callback_query) обрабатываются на фронте как no-op (не падают, но UI не меняют).
- **Сохранение черновика в Telegram**: при вводе текста в поле сообщения с debounce 1,5 с вызывается **POST /api/bd-accounts/:id/draft** (body: `channelId`, `text`, `replyToMsgId?`); после успешной отправки сообщения черновик очищается тем же API с `text: ''`.

---

## События (shared/events)

- Добавлены: `BD_ACCOUNT_SYNC_STARTED`, `BD_ACCOUNT_SYNC_PROGRESS`, `BD_ACCOUNT_SYNC_COMPLETED`, `BD_ACCOUNT_SYNC_FAILED`, `BD_ACCOUNT_TELEGRAM_UPDATE` (тип `bd_account.telegram_update`). Для последнего используется тип `TelegramUpdateKind`: typing, user_status, read_inbox, read_channel_inbox, read_outbox, read_channel_outbox, draft, message_id_confirmed, dialog_pinned, pinned_dialogs, notify_settings, user_name, user_phone, chat_participant_add/delete, scheduled_message, delete_scheduled_messages, message_poll, message_poll_vote, config, dc_options, lang_pack, theme, phone_call, callback_query, channel_too_long. Поля data зависят от updateKind (channelId, userId, status, expires, maxId, draftText, telegramMessageId, randomId, pinned, order, firstName, lastName, usernames, phone, inviterId, version, messageIds, pollId, poll, results, pts, queryId, phoneCallId, notifySettings и др.).
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
- Обрабатываемые типы апдейтов (Telegram API → GramJS → наш сервис):
  1. **UpdateShortMessage / UpdateShortChatMessage** — «короткий» формат (личные и групповые сообщения), часто приходят первыми.
  2. **UpdateNewMessage / UpdateNewChannelMessage** — полный объект `Message` (личные чаты, группы, каналы).
  3. **NewMessage({ incoming: true / false })** — высокоуровневый event GramJS для входящих и исходящих (с другого устройства) сообщений.
  4. **UpdateDeleteMessages** — удаление сообщений в личных чатах/группах → удаляем из БД, публикуем `message.deleted` → фронт убирает из списка.
  5. **UpdateDeleteChannelMessages** — удаление в каналах/супергруппах → то же.
  6. **EditedMessage** — редактирование сообщения → обновляем в БД, публикуем `message.edited` → фронт обновляет текст в списке.
  7. **UpdateUserTyping** — пользователь печатает в личке (user_id = собеседник) → публикуем `bd_account.telegram_update` с `updateKind: 'typing'` → фронт показывает «Печатает...» в шапке чата (сброс через 6 сек по спецификации Telegram).
  8. **UpdateChatUserTyping** — пользователь печатает в группе/канале → то же.
  9. **UpdateUserStatus** — онлайн/офлайн пользователя → публикуем `updateKind: 'user_status'` → фронт сохраняет в `userStatusByUserId` (для будущего отображения в списке чатов).
  10. **UpdateReadHistoryInbox** — прочитано в личке/группе (peer + max_id) → публикуем `updateKind: 'read_inbox'` → фронт сбрасывает счётчик непрочитанных у этого чата.
  11. **UpdateReadChannelInbox** — прочитано в канале/супергруппе → `updateKind: 'read_channel_inbox'` → то же.
  12. **UpdateDraftMessage** — черновик в чате → публикуем `updateKind: 'draft'` с `draftText` → фронт подставляет черновик в поле ввода при открытии чата и при приходе черновика для текущего чата.
  13. **UpdateMessageID** — подтверждение отправки (random_id → id) → `updateKind: 'message_id_confirmed'` (telegramMessageId, randomId).
  14. **UpdateReadHistoryOutbox / UpdateReadChannelOutbox** — прочитано исходящие на другой стороне → `read_outbox` / `read_channel_outbox` (channelId, maxId) → фронт хранит readOutboxMaxIdByChannel и отображает двойную галочку у исходящих с id ≤ maxId.
  15. **UpdateDialogPinned / UpdatePinnedDialogs** — закрепление диалогов → `dialog_pinned` / `pinned_dialogs`.
  16. **UpdateNotifySettings** — настройки уведомлений → `notify_settings`.
  17. **UpdateUserName / UpdateUserPhone** — имя/телефон пользователя → `user_name` / `user_phone`.
  18. **UpdateChatParticipantAdd/Delete** — участники группы → `chat_participant_add` / `chat_participant_delete`.
  19. **UpdateNewScheduledMessage / UpdateDeleteScheduledMessages** — отложенные сообщения → `scheduled_message` / `delete_scheduled_messages`.
  20. **UpdateMessagePoll / UpdateMessagePollVote** — опросы → `message_poll` / `message_poll_vote`.
  21. Служебные: **UpdateConfig, UpdateDcOptions, UpdateLangPack, UpdateTheme, UpdatePhoneCall, UpdateBotCallbackQuery, UpdateChannelTooLong** → соответствующие updateKind без детального payload (при необходимости фронт может перезапросить данные).

- Все presence-апдейты (7–12) и часть прочих (13–14, 15 для чатов из sync, 19–21 для разрешённых чатов) публикуются с учётом **sync list** где применимо; user_status не привязан к чату. Событие `BD_ACCOUNT_TELEGRAM_UPDATE` рассылается WebSocket в комнату `bd-account:{bdAccountId}`.

- В **addEventHandler** второй аргумент обязан быть экземпляром **EventBuilder** (например `new Raw({ func: ... })` или `new NewMessage({})`). Передача обычного объекта `{ func: () => true }` ломает цикл обработки апдейтов в gram.js (нет методов `resolve`/`build`/`filter`).

- Чтобы Telegram не переставал слать апдейты, нужна периодическая «активность»: в сервисе каждые **2 минуты** вызывается **updates.GetState()** для каждого подключённого аккаунта (keepalive в `startUpdateKeepalive`). Без этого возможны таймауты в update loop (Error: TIMEOUT) и прекращение доставки апдейтов.

### Если сообщения не приходят

1. **Чат не в списке синхронизации**  
   Сообщения обрабатываются только для чатов из **bd_account_sync_chats**. В логах будет: `Chat not in sync list (add chat to sync in UI), skipping message, accountId=..., chatId=...`. Нужно добавить этот чат в sync в UI (шаг выбора чатов после подключения аккаунта).

2. **Апдейты не доходят до сервера**  
   В логах не должно быть строк `Raw update: ...` при отправке сообщения с другого аккаунта. Возможные причины:
   - Один и тот же аккаунт залогинен в приложении и, например, в Telegram Desktop — Telegram может слать апдейты только на одно устройство; после действий в Desktop приём в gram.js может прекратиться (известная особенность). Рекомендация для прода: использовать аккаунт в CRM по возможности только через наше приложение или учитывать мультиустройство.
   - Соединение «засыпает» — keepalive (GetState раз в 2 минуты) должен это предотвращать.

3. **Проверка по логам**  
   - Появление `Raw update: UpdateShortMessage` или `Raw update: UpdateNewMessage` при отправке сообщения на подключённый аккаунт — апдейты доходят, дальше смотреть фильтр по sync list и обработчики.
   - Отсутствие любых `Raw update` при отправке — проблема доставки апдейтов (сессия/мультиустройство/сеть).

---

## Дополнительные эндпоинты BD Accounts

- **POST /api/bd-accounts/:id/draft** — сохранение черновика в Telegram (messages.SaveDraft). Body: `{ channelId, text?, replyToMsgId? }`. Пустой `text` очищает черновик. Разрешён только для чатов из `bd_account_sync_chats` (иначе 403). Вызывается с фронта с debounce при вводе и при отправке сообщения (очистка).

---

## Что пока не сделано

1. **message_id_confirmed**  
   Событие публикуется с бэкенда; на фронте не используется (отправка идёт через API, id приходит в ответе). Можно добавить сопоставление по `randomId` при отправке с клиента с temp id.

2. **notify_settings**  
   Апдейт публикуется; на фронте не отображаются и не редактируются настройки уведомлений по чату.

3. **channel_too_long на бэкенде**  
   На фронте при получении показывается баннер и вызывается `loadOlderMessages`. На бэкенде вызов `updates.getChannelDifference` для канала не реализован — при необходимости можно догружать пропущенные обновления на сервере.

4. **Отложенные сообщения (scheduled)**  
   Апдейты `scheduled_message` и `delete_scheduled_messages` приходят и публикуются; в UI нет раздела «Отложенные» и нет отправки с отложенной датой.

5. **Опросы (polls)**  
   Апдейты `message_poll` и `message_poll_vote` приходят и публикуются; отображение опросов в сообщениях и голосование в UI не реализованы.

6. **Звонки и callback-кнопки**  
   Апдейты `phone_call` и `callback_query` публикуются без обработки (информационно или для будущей интеграции).
