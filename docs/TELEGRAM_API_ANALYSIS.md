# Анализ обращений к Telegram API (bd-accounts-service)

## Цель
Снизить количество запросов к серверам Telegram за счёт кэширования, хранения данных у себя и отдачи из БД по умолчанию — чтобы избежать flood wait и ускорять UI.

---

## 1. Сводная таблица вызовов

| API / метод | Где вызывается | Частота | Нагрузка | Оптимизация |
|-------------|----------------|---------|----------|-------------|
| **messages.GetDialogs** (iterDialogs/getDialogs) | getDialogsAll, getDialogs | При открытии списка диалогов, refresh, sync | Высокая (много пагинаций) | ✅ dialogs-by-folders из БД по умолчанию; GET /dialogs из БД; refresh только по кнопке |
| **messages.GetDialogFilters** | getDialogFilters, getDialogFilterRaw, getDialogFilterPeerIds | GET /folders, refresh=1, refreshChatsFromFolders (на каждый кастомный фильтр) | Средняя (лёгкий запрос, но дублируется) | ✅ Кэш в TelegramManager (TTL 90s); GET /folders из БД по умолчанию |
| **messages.GetHistory** | syncHistoryForChat, fetchOlderMessagesFromTelegram, начальный sync | При скролле вверх, при новом чате, после коннекта | Высокая при активной подгрузке | Частично: только нужные чаты; лимиты и пагинация уже есть |
| **getEntity / getInputEntity** | tryAddChatFromSelectedFolders, downloadMedia, deleteMessage, sendMessage, syncHistory | На новое сообщение (добавление чата), отправка, удаление, подгрузка истории | Низкая | ✅ tryAddChatFromSelectedFolders уже без GetDialogs (только getEntity) |
| **users.GetFullUser / photos.GetUserPhotos** | saveAccountProfile, downloadAccountProfilePhoto | После логина, при запросе аватара аккаунта | Низкая | Возможна отдача аватара из кэша/файла (отдельная задача) |
| **updates.GetState** | Keepalive по таймеру | Каждые 2 мин на аккаунт | Низкая, необходима | Без изменений |
| **UpdateDialogFilter** | pushFoldersToTelegram | По кнопке «Синхронизировать папки в Telegram» | Редко | Без изменений |
| **sendMessage / sendFile** | Отправка сообщений пользователем | По действию пользователя | Низкая | Без изменений |
| **getMessages + downloadMedia** | Скачивание вложений | При открытии медиа в чате | По запросу | Возможен кэш медиа (отдельная задача) |

---

## 2. Точки входа (HTTP → Telegram)

| Endpoint | Текущее поведение | После оптимизации |
|----------|-------------------|-------------------|
| GET `/api/bd-accounts/:id/dialogs` | Всегда getDialogs → GetDialogs (limit 100) | По умолчанию: из `bd_account_sync_chats` (формат как у getDialogs). `?refresh=1` — Telegram. |
| GET `/api/bd-accounts/:id/folders` | Всегда getDialogFilters → GetDialogFilters | По умолчанию: из `bd_account_sync_folders` + дефолт «Все чаты». `?refresh=1` — Telegram. |
| GET `/api/bd-accounts/:id/dialogs-by-folders` | Уже: по умолчанию из БД, `?refresh=1` — Telegram | Без изменений. |
| POST `.../sync-folders-refresh` | refreshChatsFromFolders: GetDialogFilters + GetDialogs 0 + 1 + GetDialogFilterPeerIds на каждую папку | GetDialogFilters один раз (кэш в TM); GetDialogs только здесь и по кнопке. |
| GET `/api/bd-accounts` | Только БД | Без изменений. |

---

## 3. Внутренние вызовы (без HTTP)

| Контекст | Вызовы | Комментарий |
|----------|--------|-------------|
| Новое сообщение (UpdateNewMessage) | tryAddChatFromSelectedFolders → getEntity (если чат не в sync_chats) | GetDialogs убран, остаётся один getEntity. |
| После connect | saveAccountProfile (getMe, GetFullUser, GetUserPhotos), syncHistory (GetHistory по каждому чату из sync_chats) | Необходимо для первичного заполнения; syncHistory можно не трогать. |
| Подгрузка старых сообщений (мессенджер) | fetchOlderMessagesFromTelegram → GetHistory | Нужно по запросу пользователя; лимиты уже есть. |
| Keepalive | GetState каждые 2 мин | Оставляем как есть. |

---

## 4. Реализованные оптимизации

1. **dialogs-by-folders** — по умолчанию из БД, `?refresh=1` для Telegram. ✅
2. **tryAddChatFromSelectedFolders** — добавление чата через getEntity, без GetDialogs. ✅
3. **POST sync-folders** — не вызывать refreshChatsFromFolders при сохранении папок. ✅
4. **Кэш GetDialogFilters** в TelegramManager (на аккаунт, TTL 90 с) — один запрос на несколько вызовов getDialogFilters / getDialogFilterRaw / getDialogFilterPeerIds. ✅
5. **GET /folders** — по умолчанию из БД (`bd_account_sync_folders`), `?refresh=1` — Telegram. ✅
6. **GET /dialogs** — по умолчанию из БД (`bd_account_sync_chats` в формате диалогов), `?refresh=1` — Telegram. ✅

---

## 5. Рекомендации по использованию на фронте

- Не вызывать `?refresh=1` при каждом открытии экрана; только по явной кнопке «Обновить с Telegram».
- Список аккаунтов и списки чатов/папок — из БД; при первом подключении аккаунта данные появятся после sync или после одного ручного refresh.
