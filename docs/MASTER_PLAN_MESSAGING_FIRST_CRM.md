# Master Plan: Messaging-First AI-CRM

**Роль:** Senior Product Architect + Lead Full-Stack Engineer  
**Цель:** Масштабируемая, мульти-воркспейсная, AI-усиленная CRM с Telegram-like UX.

---

## Часть 1. Архитектурные предложения

### 1.1 Multi-tenant и изоляция данных

**Текущее состояние:** Изоляция по `organization_id` во всех таблицах; один пользователь привязан к одной организации (`users.organization_id`).

**Предложение:**

- **Сохранить** изоляцию по `organization_id` как основу.
- **Добавить** слой мульти-воркспейса: пользователь может состоять в нескольких организациях. Для этого ввести таблицу **`organization_members`** (user_id, organization_id, role, invited_by, joined_at, status). Текущий «активный» workspace хранить в сессии/JWT (`active_organization_id`). При смене воркспейса — новый JWT или заголовок `X-Organization-Id` с проверкой членства на бэкенде.
- **Data-изоляция:** все запросы (CRM, messaging, BD accounts, team) фильтровать по `organization_id` из контекста запроса (из JWT или заголовка). Никогда не возвращать данные другой организации.

**Почему важно:** Масштаб B2B, несколько команд/брендов у одного пользователя, рост retention.

---

### 1.2 Роли и доступы

**Текущее состояние:** Роли в `users.role` и в shared/types (OWNER, ADMIN, SUPERVISOR, BIDI, VIEWER); в team-service используются owner, admin, member.

**Предложение:**

- **Унифицировать роли:** Owner, Admin, Manager, Agent, Viewer.
- **Owner:** полный доступ, передача владения, удаление воркспейса.
- **Admin:** участники, инвайты, настройки, интеграции; без удаления воркспейса.
- **Manager:** чаты, клиенты, сделки, отчёты; без управления участниками.
- **Agent:** чаты и назначенные клиенты/сделки.
- **Viewer:** только просмотр.
- **Гранулярные права (v2):** таблица `role_permissions` (role, resource, actions) или JSONB в роли для ресурсов: chats, clients, deals, integrations.

**Почему важно:** Соответствие ожиданиям enterprise, безопасность, делегирование.

---

### 1.3 Invite-links и мульти-воркспейс

**Предложение:**

- Таблица **`organization_invite_links`**: organization_id, token, role, expires_at, created_by. Публичная ссылка для присоединения к воркспейсу.
- **Незарегистрированный пользователь:** переход по ссылке → страница приглашения → Sign up → создание user + запись в organization_members с ролью из инвайта; активный workspace = эта организация.
- **Зарегистрированный пользователь:** переход по ссылке → страница «Присоединиться к [Workspace]» → Accept → INSERT в organization_members (без смены текущей org до переключения). После accept — показать переключатель воркспейсов или редирект в новый воркспейс.
- **Защита от дублей:** перед созданием инвайта/accept проверять (email или user_id, organization_id) в organization_members и в pending invitations.

**Почему важно:** Виральность, онбординг команд, «как в Slack/Notion».

---

### 1.4 Audit logs, rate limits, RBAC

- **Audit logs:** таблица `audit_logs` (organization_id, user_id, action, resource_type, resource_id, old_value, new_value, ip, created_at). Писать критические действия: удаление сущностей, смена ролей, экспорт данных, вход в систему.
- **Rate limits:** на API Gateway по user_id и по organization_id (разные лимиты для чтения и для отправки сообщений). Redis для счётчиков.
- **RBAC:** middleware на каждом сервисе: по роли из JWT/контекста разрешать или запрещать операцию. При мульти-воркспейсе — роль брать из organization_members для active_organization_id.

---

### 1.5 Event-driven, background jobs, caching

- **Event-driven:** сохранить RabbitMQ для message.received, deal.stage.changed, team.member.added и т.д. Добавить события: invite.accepted, workspace.switched.
- **Background jobs:** тяжёлые операции (синхронизация истории Telegram, экспорт отчётов, рассылки) выносить в очередь (Bull/BullMQ на Redis или отдельный worker). Не блокировать HTTP.
- **Caching:** Redis — сессии, rate limit, кэш тяжёлых ответов (список папок/диалогов по аккаунту) с TTL. На фронте — LRU-кэш blob URL для аватарок и медиа (избежать повторных запросов при скролле).

---

### 1.6 Unified Inbox (архитектура под омниканал)

- Абстракция **канал:** telegram, whatsapp, email, instagram_dm, web_chat. Таблица **`channels`** (organization_id, type, config JSONB, external_id).
- **Conversation/thread:** привязка к каналу и к contact (или к внешнему идентификатору). Один контакт — несколько conversations по разным каналам.
- **Единый timeline:** API «все сообщения по contact_id» с группировкой по каналу и сортировкой по времени. UI — одна лента по клиенту.
- Реализация по этапам: v1 — только Telegram (как сейчас); v2 — слой channels + conversations; затем подключение других каналов по одному.

---

### 1.7 AI-first CRM (архитектура)

- **В чатах:** API summarize (POST /api/ai/chat/summarize), extract intent, auto-create lead/deal по правилам или по AI. Хранение саммари в `ai_conversation_summaries` или в metadata.
- **Pipeline:** API suggestions по deal (следующий шаг, вероятность закрытия) на основе истории и контента чата. Виджет в карточке сделки.
- **Auto-tagging:** при message.received или периодически — вызов AI для тегов (тон, намерение); сохранение в contact tags или в metadata сообщений.

---

## Часть 2. Сводка требований → задачи

### 2.1 UX/UI изменения

| Требование | Задача | Приоритет | Статус |
|------------|--------|-----------|--------|
| Выключение звука уведомлений | Кнопка mute/unmute (в шапке/настройках), состояние в localStorage + store, проверка в WebSocket перед play | MVP | DONE |
| Стиль Telegram | Layout, отступы (msg-bubble-out/in в globals.css), цвета исх./вх., hover/active | MVP | DONE |
| Галочки прочтения | 1 галочка = sent, 2 = read; по status сообщения в БД (Check/CheckCheck) | MVP | DONE |
| Ссылки кликабельные | Парсинг URL в тексте, рендер как `<a>` (LinkifyText) | MVP | DONE |
| Фото/видео поверх интерфейса | Overlay/модал по клику (MediaViewer), не новая вкладка; min-height плейсхолдеры | MVP | DONE |
| Текст/аудио загружать сразу | Медиа и текст отображаются сразу при получении, без кнопки «Загрузить» | MVP | DONE |
| AI-панель по умолчанию открыта | При первом визите развёрнута (stored !== 'false'); ключ в localStorage при сворачивании | MVP | DONE |
| Скролл к последнему сообщению | scrollToBottom при смене чата + таймауты 150/450 ms; min-height для медиа | MVP | DONE |
| Подгрузка истории без фризов | Lazy load вверх, cooldown, restore scroll после prepend; при >200 сообщений — virtual list | MVP | DONE (подгрузка + двойной rAF; при >200 сообщений — react-virtuoso с firstItemIndex и startReached) |
| Инпут сообщения как в TG | Textarea с авто-увеличением высоты по мере ввода (min/max height) | MVP | DONE |
| Черновики сообщений | Сохранение в localStorage при уходе из чата; восстановление при открытии; очистка при отправке (GramJS saveDraft — опционально позже) | MVP | DONE |
| Панели: скрывашка и кнопки | Аккаунты: collapse рядом с заголовком, плюс рядом с поиском; Чаты: размер заголовка как у аккаунтов, шестерёнку заменить иконкой синхронизации (RefreshCw) | MVP | DONE |

### 2.2 Контекстные действия (ПКМ)

| Требование | Задача | Приоритет | Статус |
|------------|--------|-----------|--------|
| Над сообщением | Удалить, Реакция (лайк и т.д.) | MVP | DONE (Удалить — ПКМ; Реакция — ПКМ, выбор эмодзи, PATCH reaction, отображение под сообщением) |
| Над чатом | Закрепить, Удалить чат, Добавить в папку | MVP | DONE (ПКМ: Закрепить/Открепить, Добавить в папку, Удалить чат — убрать из списка CRM, только владелец; DELETE bd-accounts/:id/chats/:chatId) |
| Над аккаунтом | Настройки (переход в BD Accounts) | MVP | DONE (ПКМ по аккаунту → «Настройки аккаунта» → /dashboard/bd-accounts?accountId=…) |
| Компонент | Переиспользуемый ContextMenu (позиция по клику, подменю) | MVP | DONE (components/ui/ContextMenu.tsx: ContextMenu, ContextMenuSection, ContextMenuItem; используется для ПКМ чата, аккаунта, сообщения) |

### 2.3 Сообщения

| Требование | Задача | Приоритет | Статус |
|------------|--------|-----------|--------|
| Удаление | API DELETE message; вызов GramJS client.deleteMessages; фронт ПКМ → удалить, убрать из списка, подписка на message.deleted; бэкенд — UpdateDeleteMessages, UpdateDeleteChannelMessages, EditedMessage; bd-accounts POST delete-message, messaging-service DELETE /messages/:id | MVP | DONE |
| Реакции/лайки | Поле reactions + our_reactions в БД, PATCH API, отображение под сообщением, отправка в TG | v1 | DONE |
| Ответ на сообщение (reply) | Превью цитаты в бабле, скролл к сообщению по клику; reply_to_telegram_id при отправке | MVP | DONE |
| Загрузка фото/аудио/файлов | base64 в send (POST messaging/send и bd-accounts/:id/send); бэкенд — GramJS sendFile | MVP | DONE |
| Ограничение тяжёлых файлов | Проверка размера на бэке (2 GB), 413 + сообщение на фронте | MVP | DONE |

### 2.4 Папки и чаты

**Подробнее:** см. [MESSAGING_ARCHITECTURE.md](MESSAGING_ARCHITECTURE.md) (папки и чаты).

| Требование | Задача | Приоритет | Статус |
|------------|--------|-----------|--------|
| Папки из синхронизации + вручную | bd_account_sync_folders + is_user_created; схема и шаги в MESSAGING_ARCHITECTURE | MVP | DONE (миграция is_user_created, GET/POST возвращают) |
| Отображение папок в боковой панели | Вертикальная полоска как в Telegram + кнопка «Изменить» → диалог управления | MVP | DONE (вертикальная полоска, FolderManageModal, POST custom, PATCH order) |
| Добавить чат в папку | Контекстное меню «Добавить в папку» → список папок, PATCH chat folder | MVP | DONE (ПКМ по чату → Add to folder → папки + «Без папки», PATCH /api/bd-accounts/:id/chats/:chatId/folder) |
| Обратная синхронизация в TG | Кнопка «Синхр. с TG», POST push-to-telegram, папки 0/1 не трогаем | v1 | DONE |

### 2.5 Производительность

**Подробнее:** см. [MESSAGING_ARCHITECTURE.md](MESSAGING_ARCHITECTURE.md) (производительность). Варианты: LRU в памяти, Cache API; при необходимости — виртуальный список (react-virtuoso).

| Требование | Задача | Приоритет | Статус |
|------------|--------|-----------|--------|
| Кэш иконок/изображений | LRU по ключу (account/chat/media), revoke при evict; см. доку | MVP | DONE (lib/cache/blob-url-cache.ts, BDAccountAvatar, ChatAvatar, useMediaUrl) |
| Lazy loading истории | Подгрузка вверх; при >200 сообщений — virtual list по метрикам | MVP | DONE (react-virtuoso при >200 сообщений, firstItemIndex для prepend) |

### 2.6 Workspace

**Подробнее:** см. [MESSAGING_ARCHITECTURE.md](MESSAGING_ARCHITECTURE.md) (workspace). Состояния invited/accepted/declined, защита от дублей, переключатель активного workspace.

| Требование | Задача | Приоритет | Статус |
|------------|--------|-----------|--------|
| Инвайты: invited/accepted/declined | organization_invite_links; страница /invite/[token]; accept API | v1 | DONE (миграции; GET invite публично; /invite/[token] для гостя и залогиненного; accept → fetchWorkspaces + switchWorkspace; GET/DELETE invite-links; UI список/отзыв на Team) |
| Защита от дублей | Проверка email/user в org и в приглашениях | v1 | Частично (при accept проверка в organization_members) |
| Переключатель воркспейса | Список организаций, смена active → новый JWT; см. доку | v1 | DONE (GET /api/auth/workspaces, POST switch-workspace, dropdown в сайдбаре) |
| Мульти-воркспейс в БД | organization_members, миграция; accept = add member | v1 | DONE (миграция organization_members, заполнение из users) |

### 2.7 Telegram-like Messaging (свод)

| Элемент | Задача | Статус |
|---------|--------|--------|
| Список чатов + активный чат | Уже есть | OK |
| Message bubbles, hover/active | Стили доработать под TG | DONE (hover/active в globals.css) |
| Instant scroll | scrollToBottom + задержки после медиа | DONE (50/150/450 ms) |
| Lazy loading | Есть; оптимизация без фризов | DONE (Virtuoso при >200) |
| Unread counters | По папкам/чатам | DONE (бейджи на кнопках папок и «Все») |
| Pinned chats | Таблица user_chat_pins, API, секция «Закреплённые» | DONE |
| Мульти-аккаунты, индикатор | Группировка по аккаунту в сайдбаре | OK |
| Папки, порядок, источник | sync_folders + is_user_created, UI | DONE |

### 2.8 Multi-Workspace System (свод)

| Элемент | Задача | Статус |
|---------|--------|--------|
| Создание/управление воркспейсами | Настройки воркспейса, передача владения | DONE (GET/PATCH organization, только owner/admin; уникальность slug; POST transfer-ownership; вкладка «Рабочее пространство» + блок «Передать владение» для owner) |
| Invite-links | organization_invite_links, страница invite, accept для new/existing user | DONE (POST/GET/DELETE invite-links, UI на Team; /invite/[token]; signup с ?invite=; accept → switch workspace) |
| Роли Owner..Viewer | Унификация в БД и API; отображение и смена на Team | DONE (owner/admin/supervisor/bidi/viewer, миграция member→bidi; только owner/admin могут менять роли; dropdown на Team) |
| Granular permissions | role_permissions (миграция), canPermission, проверки в auth/team | DONE |
| Страница управления | Участники, роли, инвайты, отзыв | DONE (Team: участники, смена роли, инвайт по email и по ссылке, список/отзыв ссылок, список/отзыв ожидающих приглашений по email) |

### 2.9 Папки внутри CRM (единый диалог)

| Элемент | Задача | Статус |
|---------|--------|--------|
| Единый диалог управления | Модалка: список папок, drag&drop порядка, добавление папки (название ≤12, иконка) | DONE (FolderManageModal, POST custom, PATCH order, вертикальная полоска + Edit) |
| Иконки папок | Поле icon (emoji/ключ), выбор в UI | DONE (миграция icon в sync_folders, GET/POST/PATCH, выбор emoji в мессенджере и в диалоге папок) |
| Влияние на чаты/навигацию/фильтрацию | Уже: фильтр по папке, список чатов по folder_id | OK |

---

## Часть 3. Реализация и текущее состояние

**Порядок реализации, модели данных и актуальный статус задач** см. **[STATE_AND_ROADMAP.md](STATE_AND_ROADMAP.md)** (единый источник правды по состоянию и приоритетам) и **[STAGES.md](STAGES.md)** (этапы Stage 1–7).
