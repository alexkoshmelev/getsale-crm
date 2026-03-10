# План: умный флоу парсинга Telegram (усиленная версия)

## Цель

Переработка поиска и парсинга Telegram: стабильный поиск с пагинацией и обработкой лимитов, умный resolve с определением типа источника, выбор стратегии парсинга по типу, прогресс в реальном времени (SSE). Реализация в текущем стеке Node.js + GramJS.

---

## Ключевые усиления (по результатам экспертного анализа)

| Направление | Что делаем | Результат |
|-------------|------------|-----------|
| **Поиск** | Пагинация SearchGlobal (`next_rate`, `offset_peer`, `offset_id`), обработка `search_flood` (backoff), несколько страниц на один запрос пользователя | Больше групп/каналов в выдаче, меньше «поиск не работает» |
| **Resolve** | GetFullChannel/GetFullChat → тип (channel/public_group/private_group/comment_group), `linked_chat_id`, `canGetMembers`, `canGetMessages` | Автовыбор стратегии парсинга, понятные карточки |
| **Парсинг** | Разные стратегии по типу; ротация аккаунтов при FloodWait | Больше контактов с каналов и закрытых групп |
| **Прогресс** | SSE по taskId: этап, %, скорость, ETA; пауза/стоп | Доверие к продукту, меньше отмен |
| **UX** | Один пошаговый флоу: ссылки → проверка → карточки → настройки → запуск → прогресс → результат | Проще онбординг и повторное использование |

---

## Этап 1: Поиск — пагинация и устойчивость

### 1.1 Bd-Accounts: доработка searchGroupsByKeyword

**Файл:** `services/bd-accounts-service/src/telegram-manager.ts`

- **Пагинация:** после первого вызова `messages.SearchGlobal` проверять тип ответа:
  - Если `messages.messagesSlice` — брать `next_rate`, `offset_peer`, `offset_id` из ответа и повторять запрос, пока есть следующая страница или не набрали `limit` уникальных чатов.
  - Собирать уникальные чаты по `peer` из сообщений (как сейчас), дедупликация по chatId.
- **search_flood:** если в ответе есть флаг `search_flood` (или ошибка FLOOD), делать паузу (например 5–10 сек), затем один повтор; при повторном флаге — возвращать уже собранные результаты и логировать предупреждение.
- **Лимит страниц:** не более N итераций (например 5–10) на один запрос, чтобы не уходить в бесконечный цикл и не триггерить лимиты.
- Опционально: параметр `maxResults` (например 200/500), чтобы не тянуть лишние страницы.

Итог: один поисковый запрос пользователя даёт в разы больше групп/каналов при наличии результатов в Telegram.

---

## Этап 2: Backend — расширенный Resolve и типы источников

### 2.1 Bd-Accounts: полный resolve (ResolvedSource)

**Файл:** `services/bd-accounts-service/src/telegram-manager.ts`

- После получения сущности по ссылке/username вызывать **channels.GetFullChannel** (для Channel) или **messages.GetFullChat** (для Chat), чтобы получить:
  - `participants_count` / `members_count`;
  - для канала — `full_chat.linked_chat_id` (группа обсуждения).
- Тип возврата **ResolvedSource**:
  - `type`: `'channel' | 'public_group' | 'private_group' | 'comment_group' | 'unknown'`;
  - правила: Channel + broadcast → channel; Channel + megagroup + username → public_group; Channel + megagroup без username → private_group; при resolve по linked_chat можно помечать comment_group;
  - `canGetMembers`, `canGetMessages` — по правам и типу сущности.
- Поля: `input`, `type`, `title`, `username?`, `chatId`, `membersCount?`, `linkedChatId?`, `canGetMembers`, `canGetMessages`.

**Файл:** `services/bd-accounts-service/src/routes/sync.ts`

- Эндпоинт **POST** `/:id/parse/resolve` (или расширить `resolve-chats`) с телом `{ sources: string[] }`, ответ `{ results: ResolvedSource[] }` (в т.ч. объекты с `error` для неуспешных).

### 2.2 CRM: эндпоинты parse и прогресс

**Файлы:** `services/crm-service/src/routes/discovery-tasks.ts`, новый `services/crm-service/src/routes/parse.ts`

- **POST /api/crm/parse/resolve** — принимает `{ sources: string[] }`, опционально `bdAccountId`; вызывает bd-accounts resolve; возвращает `{ results: ResolvedSource[] }`.
- **POST /api/crm/parse/start** — тело: `sources: ResolvedSource[]`, `settings: ParseSettings`, `accountIds: string[]`, `listName: string`; создаёт задачу в `contact_discovery_tasks` с `type: 'parse'`, `status: 'running'`; возврат `{ taskId }`.
- **GET /api/crm/parse/progress/:taskId** (SSE) — проверка по `organization_id`; стрим из Redis канала `parse:progress:{taskId}` или периодическая отправка из БД; формат `ParseProgressEvent` (stage, stageLabel, percent, found, estimated, speed, etaSeconds, error).
- **POST /api/crm/parse/pause/:taskId**, **POST /api/crm/parse/stop/:taskId** — обновление статуса; воркер при следующей итерации учитывает pause/stop.
- **GET /api/crm/parse/result/:taskId** — итог: количество участников, разбивка по источникам; опционально список контактов; для CSV — отдельный endpoint или query `?format=csv`.

Типы и Zod-схемы в `services/crm-service/src/validation.ts`.

---

## Этап 3: Умная стратегия парсинга и ротация аккаунтов

### 3.1 Bd-Accounts: методы под стратегии

**Файл:** `services/bd-accounts-service/src/telegram-manager.ts`

- **getChannelParticipants** — уже есть; при необходимости доработать пагинацию до `maxMembers` из настроек.
- **getActiveParticipants** — уже есть (история сообщений).
- **Новые/оформленные методы:**
  - **getCommentGroupParticipants(accountId, channelId, linkedChatId, options)** — посты канала (limit), для каждого поста — комментарии в linked-чате (`messages.getReplies` / итерация), уникальные авторы.
  - **getParticipantsByReactionsOrViews(accountId, channelId, options)** — для канала без группы обсуждения: посты + при возможности реакции/авторы постов (getMessageReactionsList или аналог в GramJS), с учётом лимитов API.

**Ротация и FloodWait:**

- В telegram-manager при вызове методов парсинга: при получении FloodWait (или аналога в GramJS) — `await sleep(min(e.value, 60))`, повтор; при наличии нескольких аккаунтов в контексте задачи — передавать список `accountIds`, при FloodWait пробовать следующий аккаунт (логика может быть в discovery-loop при вызове bd-accounts с массивом аккаунтов).
- В discovery-loop при вызове bd-accounts для парсинга передавать `accountIds`; bd-accounts по очереди пробует аккаунты при ошибке «временная блокировка» (если реализация в bd-accounts) или discovery-loop сам переключает аккаунт при повторной попытке.

### 3.2 Discovery loop: выбор стратегии по типу источника

**Файл:** `services/crm-service/src/discovery-loop.ts`

- В `processParseTask` читать из `params` полные `ResolvedSource` (если есть).
- Для каждого источника по полю `type`:
  - **channel** + `linkedChatId` → bd-accounts `getCommentGroupParticipants(channelId, linkedChatId)`.
  - **channel** без linked → `getParticipantsByReactionsOrViews` или fallback на getActiveParticipants по каналу (авторы постов).
  - **public_group** → `getChannelParticipants` с пагинацией до `maxMembers` из settings.depth.
  - **private_group** / **comment_group** → `getActiveParticipants` с глубиной по settings (`maxMessages`).
- Настройки: `depth: 'fast' | 'standard' | 'deep'` → задать `maxMembers` / `maxMessages` (например 500/2000/5000 и 3/7/30 дней или эквивалент в количестве сообщений).
- После сбора — дедупликация по `telegram_id`; сохранение контактов и `contact_telegram_sources`; публикация прогресса в Redis `parse:progress:{taskId}`.

---

## Этап 4: Прогресс в реальном времени (SSE)

### 4.1 Публикация прогресса из discovery-loop

**Файл:** `services/crm-service/src/discovery-loop.ts`

- Передать в loop Redis-клиент (если ещё не передаётся).
- В процессе парсинга после каждой порции участников/сообщений: формировать `ParseProgressEvent` (stage, stageLabel, percent, found, estimated, speed, etaSeconds) и публиковать в Redis канал `parse:progress:{taskId}`.

### 4.2 SSE-эндпоинт в CRM

**Файл:** `services/crm-service/src/routes/parse.ts`

- **GET /api/crm/parse/progress/:taskId**: auth, проверка ownership задачи; заголовки SSE; отправить начальное состояние из БД; подписка на Redis `parse:progress:{taskId}`; на каждое сообщение — `data: ${JSON.stringify(event)}\n\n`; при закрытии соединения отписаться; keep-alive комментарии раз в ~30 сек; таймаут соединения например 2 часа.

### 4.3 API Gateway

- Проксировать `/api/crm/*` (в т.ч. `/api/crm/parse/*`) на crm-service без агрессивной буферизации и без короткого таймаута для SSE.

---

## Этап 5: Frontend — новый UI флоу

### 5.1 Компоненты

- **ParseSourceInput** — текстовое поле (многострочное или запятая/новая строка) для ссылок / @username / t.me/… / числовой chat_id; кнопка «Проверить и продолжить» → POST `/api/crm/parse/resolve`; показ ошибок по строкам.
- **SourceTypeCard** — карточка на каждый успешно разрешённый источник: иконка типа (канал / публичная группа / закрытая группа / группа комментариев), название, username, кол-во участников если есть.
- **ParseSettingsForm** — глубина (Быстро / Стандарт / Глубокий), мультиселект аккаунтов, чекбокс «Исключить администраторов», поле «Название списка для сохранения».
- **ParseProgressPanel** — подписка на SSE GET `/api/crm/parse/progress/:taskId`: этап, прогресс-бар, found/estimated, speed, ETA; кнопки «Приостановить», «Остановить и сохранить».
- **ParseResultSummary** — по завершении: итог по участникам, разбивка по источникам; кнопки «Скачать CSV», «Добавить в рассылку», «Запустить ещё раз».

Размещение: `frontend/components/parsing/` (или подкомпоненты в `frontend/app/dashboard/discovery/`).

### 5.2 Страница Discovery

**Файл:** `frontend/app/dashboard/discovery/page.tsx`

- Пошаговый флоу парсинга:
  1. Источники: ParseSourceInput → после resolve список SourceTypeCard.
  2. Настройки: ParseSettingsForm.
  3. Запуск: POST `/api/crm/parse/start` → taskId.
  4. Прогресс: ParseProgressPanel с SSE по taskId.
  5. Результат: ParseResultSummary по GET `/api/crm/parse/result/:taskId`.
- Вкладки «Задания», «Новый поиск», «Новый парсинг» — оставить; «Новый парсинг» перевести на новый пошаговый флоу; из результатов поиска — кнопка «Собрать аудиторию» с подстановкой найденных чатов в источники.
- API: расширить `frontend/lib/api/discovery.ts` — resolve (parse), start, progress (EventSource для SSE), pause, stop, result, export CSV.

### 5.3 Локализация и UX

- Строки в `frontend/locales/ru.json` и `frontend/locales/en.json`.
- Без технических терминов (MTProto, FloodWait, iter_participants); только понятные формулировки.

---

## Этап 6: Дополнительно

- **Дедупликация:** один пользователь (telegram_id) из нескольких источников в одной задаче — один контакт в CRM.
- **Сохранение списка:** привязка к `listName` в params задачи; при экспорте в рассылку подставлять имя.
- **Экспорт CSV:** GET `/api/crm/parse/result/:taskId/export?format=csv` с полями: user_id, username, first_name, last_name, phone (если есть), source.
- **Ошибки по источникам:** если один источник недоступен — пропустить, записать в results ошибку по нему, не ронять всю задачу.

---

## Порядок реализации (кратко)

1. **Поиск:** пагинация SearchGlobal + обработка search_flood в telegram-manager.
2. **Bd-accounts:** расширенный resolve (GetFullChannel/GetFullChat, ResolvedSource); при необходимости методы комментариев/реакций.
3. **CRM:** типы и валидация; эндпоинты resolve/start/pause/stop/result; Redis для прогресса.
4. **Discovery loop:** стратегия по типу источника; публикация прогресса в Redis; ротация аккаунтов при ошибках.
5. **CRM:** SSE endpoint progress/:taskId.
6. **Gateway:** маршрутизация /api/crm/parse (если ещё не проксируется).
7. **Frontend:** компоненты ParseSourceInput, SourceTypeCard, ParseSettingsForm, ParseProgressPanel, ParseResultSummary; интеграция в Discovery и API с SSE.

---

## Опционально позже (Phase 2)

- **Python-воркер (Telethon):** вынос тяжёлого парсинга в отдельный сервис при упоре в лимиты или стабильность GramJS; очередь заданий, запись контактов через API CRM, прогресс в Redis.
- **Накопленные списки:** сущность «список рассылки» по названию, сегменты аудиторий.
- **Каталоги:** интеграции с внешними каталогами каналов/групп при появлении партнёров или API.
