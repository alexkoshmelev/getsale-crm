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

**Файлы:** `chat-sync-search.ts` — SearchGlobal, SearchPosts, contacts.Search, GetAdminedPublicChannels; `chat-sync-resolve.ts` — resolve + GetFullChannel/GetFullChat; `chat-sync-participants.ts` — списки участников / активные из истории; `chat-sync-dialogs.ts` — getDialogs / папки (для контекста синка UI); оркестрация в `telegram/chat-sync.ts`; фасад в `telegram/index.ts`.

- **Пагинация:** после первого вызова `messages.SearchGlobal` проверять тип ответа:
  - Если `messages.messagesSlice` — брать `next_rate`, `offset_peer`, `offset_id` из ответа и повторять запрос, пока есть следующая страница или не набрали `limit` уникальных чатов.
  - Собирать уникальные чаты по `peer` из сообщений (как сейчас), дедупликация по chatId.
- **search_flood:** если в ответе есть флаг `search_flood` (или ошибка FLOOD), делать паузу (например 5–10 сек), затем один повтор; при повторном флаге — возвращать уже собранные результаты и логировать предупреждение.
- **Лимит страниц:** не более N итераций (например 5–10) на один запрос, чтобы не уходить в бесконечный цикл и не триггерить лимиты.
- Опционально: параметр `maxResults` (например 200/500), чтобы не тянуть лишние страницы.

Итог: один поисковый запрос пользователя даёт в разы больше групп/каналов при наличии результатов в Telegram.

#### Статус реализации (код)

| Пункт плана | Состояние |
|-------------|-----------|
| Пагинация `messages.messagesSlice` + `next_rate` / `offset_peer` / `offset_id`, дедуп по чатам, лимит итераций `maxPages` | **Сделано** в [`chat-sync-search.ts`](../services/bd-accounts-service/src/telegram/chat-sync-search.ts) (`searchGroupsByKeywordGlobal`, `searchPublicChannelsByKeywordGlobal`). |
| `search_flood`: пауза + один повтор, затем возврат накопленного | **Сделано** (тот же файл). |
| Параметр глубины пагинации с HTTP | **Сделано:** `GET /api/bd-accounts/:id/search-groups` — query **`maxPages`** (1–15, по умолчанию 10), передаётся в SearchGlobal (type=`groups`) и SearchPosts (type=`channels` / `all`). См. [`sync-routes-discovery.ts`](../services/bd-accounts-service/src/routes/sync-routes-discovery.ts). |
| Обработка исключения `FLOOD_WAIT` от `invoke` (не только флаг в ответе) | **Сделано:** [`telegram-invoke-flood.ts`](../services/bd-accounts-service/src/telegram/telegram-invoke-flood.ts) — сначала sleep на **секунды из ошибки** Telegram/GramJS (`getRetryAfterSeconds`), не выше **`TELEGRAM_FLOOD_WAIT_CAP_SECONDS`** (по умолчанию 600), затем **один** повтор; без ожидания повтор бесполезен. См. [DEPLOYMENT.md](DEPLOYMENT.md). Подключено к поиску ([`chat-sync-search.ts`](../services/bd-accounts-service/src/telegram/chat-sync-search.ts)), участникам/истории ([`chat-sync-participants.ts`](../services/bd-accounts-service/src/telegram/chat-sync-participants.ts)), комментариям/реакциям, **resolve** ([`chat-sync-resolve.ts`](../services/bd-accounts-service/src/telegram/chat-sync-resolve.ts)), **message-sync** (GetHistory), **message-sender** (typing/read/draft/forward), **shared-chat**, **leave**, **GetFullUser** в contact-manager, **ResolveUsername** ([`resolve-username.ts`](../services/bd-accounts-service/src/telegram/resolve-username.ts) с опциональным контекстом). **Хвост:** редкие пути (`reaction-handler`, диалоги/фильтры, `connection-manager` GetState и т.д.) — по метрикам. |
| Расширенный resolve, `POST .../parse/resolve`, CRM маршруты `parse/*` | **Этап 2** — см. §2 (таблица статуса). |
| Полный объём стратегий парсинга, SSE из Redis `parse:progress:*` | **Этапы 3–4** — см. таблицы в §2 и §3. |

---

## Этап 2: Backend — расширенный Resolve и типы источников

### 2.1 Bd-Accounts: полный resolve (ResolvedSource)

**Файлы:** `telegram/chat-sync-resolve.ts` (resolve + обогащение типа источника), `telegram/chat-sync.ts` (обёртки); см. также `routes/sync.ts`.

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

#### Статус реализации (этап 2)

| Пункт плана | Состояние |
|-------------|-----------|
| **2.1** GetFullChannel / GetFullChat, типы `ResolvedSource`, `POST /:id/parse/resolve` с `{ sources: string[] }`, ошибки по строкам | **Сделано:** [`chat-sync-resolve.ts`](../services/bd-accounts-service/src/telegram/chat-sync-resolve.ts) (`enrichResolvedSourceFromBasic`, `resolveSourceFromInputGlobal`), маршрут в [`sync-routes-discovery.ts`](../services/bd-accounts-service/src/routes/sync-routes-discovery.ts). |
| **2.2** CRM `POST /parse/resolve`, `/parse/start`, SSE progress, pause/stop, result | **Сделано:** [`parse.ts`](../services/crm-service/src/routes/parse.ts). **Уточнение:** SSE — подписка на Redis **`parse:progress:{taskId}`** + опрос БД ~2s (fallback / согласованность) + keep-alive; параллельно `pushParseProgress` шлёт в **`events:{userId}`** для WebSocket. |

#### Статус (этапы 3–4, кратко)

| Пункт | Состояние |
|-------|-----------|
| Выбор стратегии по `type` / `linkedChatId` в воркере | **Частично:** [`discovery-loop.ts`](../services/crm-service/src/discovery-loop.ts) — **`channel` + `linkedChatId`** → **`comment_replies`** → `comment-participants`; **`channel`** без linked + **`channelEngagement: 'reactions'`** → **`reaction_users`** → `reaction-participants` ([`chat-sync-reaction-users.ts`](../services/bd-accounts-service/src/telegram/chat-sync-reaction-users.ts), best-effort GramJS). **Просмотры:** списка зрителей MTProto не даёт; **`getMessagesViews`** используется только для счётчиков и **приоритизации постов** перед сбором реакций. Отдельный «аудитория по просмотрам как по ID» — недоступен на клиентском API. |
| Ротация аккаунтов при лимитах / сбоях downstream | **Частично (CRM):** при **429 / 502 / 503** от bd-accounts discovery-loop переключается на следующий элемент `params.accountIds` (поиск и парсинг); список можно задать в **`POST /api/crm/discovery-tasks`** (`DiscoverySearchParamsSchema` / `DiscoveryParseTaskParamsSchema`, см. [CRM_API.md](CRM_API.md)). Первый успешный BD — для пагинации участников, `contact_telegram_sources` и campaign bulk; `POST .../leave` — ротация при тех же кодах. См. [`discovery-loop.ts`](../services/crm-service/src/discovery-loop.ts). **FLOOD_WAIT на `invoke`** — см. §1.1 (`telegramInvokeWithFloodRetry` по основным путям bd-accounts); смена BD при длительном FloodWait на стороне CRM — без изменений. |
| SSE строго из Redis `parse:progress:*`, speed/ETA | **Частично:** публикация в **`parse:progress:{taskId}`** + подписка в [`parse.ts`](../services/crm-service/src/routes/parse.ts); опрос БД сохранён. В payload прогресса — **`etaSeconds`**, **`speed`**, **`parseStartedAtMs`** ([`parse-progress-utils.ts`](../services/crm-service/src/parse-progress-utils.ts), merge в SSE и в `pushParseProgress`). |

---

## B4: оставшийся порядок работ (кратко, для спринт-планирования)

Уже в коде: этапы 1–2, часть этапа 3 (`getParseWorkList`, ротация `accountIds` при 429/502/503 в CRM), поиск с пагинацией + `search_flood` + **FLOOD_WAIT на `invoke`** в `chat-sync-search.ts` (см. §1.1). **`getCommentGroupParticipants`** — [`chat-sync-comment-participants.ts`](../services/bd-accounts-service/src/telegram/chat-sync-comment-participants.ts), маршрут `GET .../chats/:channelId/comment-participants`; для **`type === 'channel'`** + `linkedChatId` в parse-задаче CRM вызывается этот путь (авторы комментариев к постам, не полный список участников linked-группы). **Реакции (best-effort):** [`chat-sync-reaction-users.ts`](../services/bd-accounts-service/src/telegram/chat-sync-reaction-users.ts), `GET .../reaction-participants` — при **`channelEngagement: 'reactions'`** и канале без linked chat; опционально **`getMessagesViews`** (`increment=false`) и выбор постов с наибольшим **views** перед `GetMessageReactionsList`. Общий **`telegramInvokeWithFloodRetry`** — [`telegram-invoke-flood.ts`](../services/bd-accounts-service/src/telegram/telegram-invoke-flood.ts), подключён к поиску, **GetParticipants / GetHistory / GetFullChat** в [`chat-sync-participants.ts`](../services/bd-accounts-service/src/telegram/chat-sync-participants.ts). **Прогресс:** `pushParseProgress` публикует в **`parse:progress:{taskId}`**; CRM **`GET .../parse/progress`** подписывается на Redis (дублирующее соединение) **и** опрашивает БД; в событиях — **ETA/speed** (см. §«статус этапы 3–4»).

Рекомендуемая последовательность дальше:

1. **Bd-accounts:** по метрикам добить редкие `invoke` без обёртки (см. §1.1 хвост); при появлении новых TL-методов для аудитории каналов — пересмотреть стратегии.
2. **CRM:** для **`comment_group`** / смешанных сценариев — уточнить эвристики vs отдельный метод.
3. **Прогресс:** при желании снизить частоту опроса БД, если Redis-стрим стабилен. **Фронт (частично):** Discovery → новый парсинг — **`channelEngagement`** (радио для каналов без linked chat), ETA/speed в [`ParseProgressPanel`](../frontend/components/parsing/ParseProgressPanel.tsx) из WebSocket `parse_progress` (те же поля, что в SSE).

---

## Этап 3: Умная стратегия парсинга и ротация аккаунтов

### 3.1 Bd-Accounts: методы под стратегии

**Файлы:** `services/bd-accounts-service/src/telegram/chat-sync.ts`, `chat-sync-search.ts` и связанные модули `telegram/*`.

- **getChannelParticipants** — уже есть; при необходимости доработать пагинацию до `maxMembers` из настроек.
- **getActiveParticipants** — уже есть (история сообщений).
- **Новые/оформленные методы:**
  - **getCommentGroupParticipants(accountId, channelId, linkedChatId, options)** — посты канала (limit), для каждого поста — комментарии в linked-чате (`messages.getReplies` / итерация), уникальные авторы.
  - **getParticipantsByReactionsOrViews(accountId, channelId, options)** — для канала без группы обсуждения: посты + при возможности реакции/авторы постов (getMessageReactionsList или аналог в GramJS), с учётом лимитов API.

**Ротация и FloodWait:**

- В bd-accounts (`telegram/chat-sync.ts` и воркеры парсинга) при вызове методов парсинга: при получении FloodWait (или аналога в GramJS) — `await sleep(min(e.value, 60))`, повтор; при наличии нескольких аккаунтов в контексте задачи — передавать список `accountIds`, при FloodWait пробовать следующий аккаунт (логика может быть в discovery-loop при вызове bd-accounts с массивом аккаунтов).
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

1. **Поиск:** пагинация SearchGlobal + обработка search_flood в `telegram/chat-sync-search.ts` (доработки — тот же модуль).
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
