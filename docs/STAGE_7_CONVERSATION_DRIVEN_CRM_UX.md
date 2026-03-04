# ЭТАП 7 — Conversation-Driven CRM UX (редизайн)

**Цель:** Messaging-first SaaS CRM. Чат = центр управления продажами. Минималистичный интерфейс, без backfill, чистая БД.

**Ограничения:** Никакого backfill. Никаких лишних input'ов и дублирующих сущностей. Убрать старый перегруженный UI.

---

## 1. Продуктовая логика (зафиксировано)

| Сущность | Определение |
|----------|-------------|
| **Контакт** | Любой Telegram-контакт (храним в `contacts`). |
| **Conversation** | Создаётся при **первом сообщении**. Один диалог = один бизнес-контекст (чат + CRM-состояние). Не дублирует Telegram chat — тонкий слой: `lead_id`, `campaign_id`, `became_lead_at`, `last_viewed_at`. |
| **Лид** | Появляется: (1) **вручную** — «Добавить в воронку»; (2) **автоматически** — reply в campaign + `auto_create_lead = true`. |

**Правило отображения:**
- У conversation есть `lead_id` → **Лид** (бейдж Lead, стадия, pipeline).
- Нет `lead_id` → **Контакт** (бейдж Contact).

**Conversation — центр UX.** Telegram chat = транспорт; Conversation = слой бизнес-смыслов (воронка, сделка, кампания, события).

---

## 2. Зачем Conversation, если есть Telegram chat

- **Telegram chat** — технический контейнер сообщений, не знает про CRM, кампании, pipeline.
- **Conversation** добавляет к чату: `lead_id`, `campaign_id`, `became_lead_at`, CRM-статус, бизнес-события, воронку, сделку.
- Без Conversation пришлось бы каждый раз считать всё через JOIN messages + leads + campaigns — медленно и хрупко. Один диалог = одна строка.
- Conversation **не дублирует** Telegram chat: ссылается на `channel_id`, не копирует сообщения, не хранит Telegram-логику.

---

## 3. Структура страницы Messaging (редизайн)

```
------------------------------------------------
| Sidebar (Folders) | Chat List   | Chat Window |
|                   |             | + Lead Card |
------------------------------------------------
```

### 3.1 Sidebar (левая колонка)

- **Сверху, закреплённая папка:**
  - **Новые лиды**
- **Дальше:** список Telegram-аккаунтов и их папок (как сейчас, без дублирования логики).

**Правила папки «Новые лиды»:** см. **§11в** (зафиксированные UX-решения). Кратко: «новый лид» = лид, на которого менеджер ещё не ответил (`first_manager_reply_at IS NULL`). Сортировка: `became_lead_at DESC`. Папка всегда первая, закреплена.

### 3.2 Chat List (список диалогов)

Каждый элемент:
- Аватар
- Имя контакта
- Последнее сообщение
- Время

**Бейдж:**
- **Lead** (если есть `lead_id`)
- **Contact** (если нет)

Если Lead — дополнительно показывать:
- Stage name
- Pipeline name

### 3.3 Chat Window

- Обычный чат (сообщения, ввод, отправка).
- Если `conversation.lead_id != null` → справа **Collapsible Lead Panel**.

### 3.4 Правая панель Lead Panel (минимальная)

Жёсткая рамка и состав блоков — **§11б**. Кратко:
- **Header:** имя контакта (крупнее), бейдж Lead, кнопка закрытия. Без иконок и quick-actions.
- **Pipeline + Stage:** название pipeline; dropdown стадии (PATCH при смене, без optimistic).
- **Source:** Campaign (если есть), became_lead_at. Статично.
- **Timeline:** только события `lead_created`, `stage_changed`, `deal_created`; макс. 10 записей.

Состояние панели по conversation_id; открытие только при `lead_id != null`; из Campaign — авто-раскрытие. Единый API-контракт, без отдельной подгрузки lead.

---

## 4. Связь Campaign → Messaging

На странице **конкретной кампании**, в списке участников:

- Если участник стал лидом:
  - Показывать: **Lead** badge, **Stage**.
  - Кнопка: **«Открыть диалог»**.
- При клике:
  - Переход в Messaging.
  - Открыть нужный conversation.
  - Авто-раскрыть Lead Panel.

**Перед запуском кампании:** обязательно дать возможность **редактировать таблицу контактов** для рассылки: удалить лишних участников, добавить новых. Это отдельный шаг в flow создания/запуска кампании (например, экран «Аудитория» с возможностью удалять строки и добавлять контакты до старта).

---

## 5. Критерии появления лида

1. **Reply в campaign** + `auto_create_lead = true` → создать lead, привязать к conversation, проставить `campaign_id`, записать `lead_activity_log`.
2. **Вручную:** кнопка «Добавить в воронку» в Messaging → создать lead, привязать к conversation.

При создании лида:
- Создать запись в `leads`.
- Обновить `conversation.lead_id`, `conversation.campaign_id`, `conversation.became_lead_at`.
- Записать в `lead_activity_log` (например `lead_created`, `campaign_reply_received`).

---

## 6. Что удалить из старого UI

- Дублирующиеся фильтры
- Сложные поисковые формы
- Избыточные поля в карточке
- Ручной ввод campaign_id
- Лишние статусы вне pipeline
- Вкладки, не относящиеся к messaging

**Цель:** интерфейс как у modern SaaS — минимум визуального шума.

---

## 7. Conversation — границы (не усложнять)

**Сейчас храним — нормально, тонкий слой:** organization_id, bd_account_id, channel, channel_id, contact_id, lead_id, campaign_id, became_lead_at, last_viewed_at.

**Не добавлять в Conversation:** unread_count, assignment, tags, SLA, owner_id, priority. Иначе превращается в «супер-сущность». Остаётся: **1 строка = 1 бизнес-диалог.**

**Папка «Новые лиды» и первая стадия:** сегодня «новый лид» = lead в первой стадии pipeline (по order_index). При нескольких pipeline с разными первыми стадиями логика может стать неявной. В будущем рассмотреть явный флаг `stage.is_entry_stage = true` — не блокер, но упростит эволюцию.

---

## 8. Принципы UI перед редизайном

**UI — dumb. Backend — smart.**

- Не дублировать на фронте логику определения Lead / is_new.
- Не считать на клиенте производные состояния (кто лид, «новый» или нет).
- Не делать JOIN-подобную сборку данных на клиенте — всё приходит с API готовыми полями (lead_id, lead_stage_name, lead_pipeline_name и т.д.).
- Не хранить локальные derived state вместо серверных. Один источник правды — backend.

Иначе фронт снова перегрузит продукт и создаст хрупкость.

---

## 9. Приоритет действий в чате

**Primary action:** написать сообщение.  
**Secondary:** сменить стадию.  
**Tertiary:** создать сделку.

Отсюда:
- **Lead Panel** — компактный, не перекрывает чат, не «кричит».
- **Чат — центр. CRM — контекст.** Если сделать наоборот (CRM на первом плане) — продукт станет тяжёлой CRM, а не messaging-first.

---

## 10. Зафиксированные UX-решения (перед редизайном)

| Вопрос | Решение | Обоснование |
|--------|---------|-------------|
| Lead Panel — **справа** или **drawer**? | **Правая колонка** (фиксированная) | Drawer = вторичность; правая колонка = стабильный контекст. Чат в центре не двигается. Messaging-first. |
| **Авто-открытие** панели при открытии чата? | **Только при deep-link из Campaign** | При обычном клике по чату — не открывать. Иначе менеджер начнёт воспринимать панель как навязчивую. |
| Можно ли панель **скрыть навсегда**? | **Нет** | Глобальное отключение = потеря CRM-контекста. Панель можно закрывать по чату, но не отключать навсегда. |
| **Сохранение состояния** (открыт/закрыт)? | **По conversation** | Открыл у «Иван Петров» → переключился → вернулся → панель открыта. У других чатов — как было. Предсказуемость. |

Эти решения зафиксированы. Редизайн делать в порядке фаз ниже; **первая задача — только PHASE 2.1 (Chat List)**.

---

## 11. ЭТАП REDESIGN — порядок и фазы

Редизайн делать **по этапам, не всё сразу.** Порядок:

| Фаза | Содержание | Смысл |
|------|------------|--------|
| **PHASE 2.1** | **Chat List:** бейдж Lead / Contact, отображение Stage + Pipeline. Никаких фильтров. Чистый список. | Сразу даёт ощущение «CRM inside messaging». **Первая задача для реализации.** |
| **PHASE 2.2** | **Lead Panel (минимальная):** имя, Pipeline, Stage dropdown, Campaign source, became_lead_at, Timeline (3 события). Без украшений. | Правая колонка, компактно. |
| **PHASE 2.3** | **Папка «Новые лиды»:** закреплённая папка сверху, индикатор количества, сортировка по became_lead_at. Endpoint уже есть. | Inbox Zero для новых лидов. |
| **PHASE 2.4** | **Campaign → Messaging deep-link:** кнопка «Открыть диалог», передача conversation_id (или bdAccountId + open), авто-раскрытие Lead Panel только при этом переходе. | Мгновенный переход из кампании в чат. |

**Сейчас нельзя (сломает messaging-first):**
- Добавлять новые фильтры в список чатов
- Делать глобальный search по чатам
- Расширять карточку лида (заметки, теги, assignment, SLA)
- Добавлять assignment / SLA в Lead Panel

---

### 11а. PHASE 2.1 — Контракт поведения (Chat List)

**Перед написанием кода контракт зафиксирован.** Cursor/фронт не изобретает лишнее.

#### Цель PHASE 2.1 (чётко)

- Мгновенно видно, кто **Lead**, а кто **Contact**.
- Если Lead — видно **Pipeline + Stage**.
- Ничего лишнего. UX чище, чем сейчас.

**Без:** фильтров, поиска, дополнительных вкладок, сложной логики.

---

#### 5 решений (зафиксированы)

| # | Вопрос | Решение |
|---|--------|---------|
| 1 | **Где показывать бейдж Lead?** | Маленький badge **справа от имени**. Не цветной, не кричащий. Пример: Lead (визуально чуть выделен) / Contact. Lead — более заметный. |
| 2 | **Где показывать Stage + Pipeline?** | Только если `lead_id != null`. Формат: строка 1 — **Pipeline Name**, строка 2 — **Stage Name**. Мелкий серый текст **под именем**. Не отдельный блок, не жирный, без иконок. Это контекст, не фокус. |
| 3 | **Сортировка списка?** | Оставляем как есть (по `last_message_at`). Никакой новой логики. |
| 4 | **Визуально отделять лидов (секции)?** | **Нет.** Не делать секции «Лиды» / «Контакты». Папка «Новые лиды» будет в PHASE 2.3. Сейчас — только бейдж. |
| 5 | **Null-значения?** | `lead_id = null` → не показывать Stage/Pipeline. `lead_stage_name` null → не рендерить строку. `lead_pipeline_name` null → не рендерить. Без заглушек типа «—» или «Без стадии». |

---

#### Минимальный контракт для фронта

**Фронт получает из API (на каждый элемент списка чатов):**

- `conversation_id`
- Имя контакта (например `name` или собирается из first_name/last_name/display_name — как отдаёт API)
- Превью последнего сообщения (`last_message`)
- Время последнего сообщения (`last_message_at`)
- `lead_id`
- `lead_stage_name`
- `lead_pipeline_name`

**Фронт:**
- ничего не вычисляет (Lead/Contact и Stage/Pipeline только из этих полей);
- не ведёт derived state;
- не проверяет бизнес-логику;
- **только отображает.**

*(Если в API поля называются иначе — маппить один раз при чтении ответа, дальше использовать контрактные имена в компоненте.)*

---

#### Что удалить из текущего UI перед добавлением нового

- Лишние input'ы в области списка чатов.
- Старые CRM-индикаторы (если дублируют смысл Lead/Stage).
- Лишние иконки в строке чата.
- Старые статусы, не относящиеся к pipeline/stage.
- Дубли stage-информации в другом виде.

**Иначе получится слой поверх старого.** Сначала упростить, потом добавить бейдж + Stage/Pipeline.

---

#### Визуальный вид одного элемента списка

**Если Lead (`lead_id` не null):**

```
[Avatar]  Иван Петров                    [Lead]
          Sales Pipeline
          Negotiation
          Последнее сообщение...
```

**Если Contact (`lead_id` null):**

```
[Avatar]  Алексей
          Последнее сообщение...
```

Максимально чисто. Бейдж — маленький, справа от имени. Stage/Pipeline — мелкий серый текст под именем, две строки (pipeline, затем stage). Без заглушек при null.

---

### 11б. PHASE 2.2 — Контракт поведения (Lead Panel)

**Перед написанием кода контракт зафиксирован.** Lead Panel — контекст, не центр. Чат остаётся главным.

#### Главный принцип

- **Lead Panel = контекст.** Не центр. Не отдельный модуль. Не мини-CRM.
- Чат остаётся главным. Панель только дополняет.

---

#### Структура панели (жёстко минимальная)

Панель справа, фиксированная колонка. Только 4 блока.

| Блок | Содержимое | Правила |
|------|------------|--------|
| **1 — Header** | Имя контакта (крупнее), маленький бейдж Lead, кнопка закрытия панели | Никаких иконок, никаких quick-actions. |
| **2 — Pipeline + Stage** | Строка: **Pipeline Name**. Строка: **[ Dropdown Stage ]**. | При смене стадии: `PATCH /lead/{id}/stage`. UI обновляет `stage_name` после ответа. Никакого optimistic update. |
| **3 — Source** | Статично: **Campaign:** [campaign_name]. Строка: **became_lead_at** (формат: 12 Feb 2026, 14:32). | Если `campaign_id == null` → блок Source не показывать (или не показывать только строку Campaign). |
| **4 — Timeline** | Список событий. | Только 3 типа: `lead_created`, `stage_changed`, `deal_created`. Формат строки: «12 Feb 14:32 — Lead created» / «Stage changed to Negotiation» / «Deal created». Максимум 10 записей. |

---

#### Поведение панели

- Открывается **только если** `lead_id != null`. Если контакт (нет лида) — панель скрыта.
- При переходе **из Campaign** (deep-link) — панель открыта автоматически.
- Состояние (открыта/закрыта) запоминается **по conversation_id** (например в URL или в состоянии по ключу conversation).

---

#### Технический контракт (обязательно)

**Запрещено на фронте:**

- Загружать lead отдельно через другой endpoint и «склеивать» с conversation на клиенте.
- Делать JOIN на клиенте из нескольких ответов API.
- Дублировать бизнес-логику (кто лид, откуда стадия и т.д.).

**Разрешено:**

- Получать всё нужное для Lead Panel **единым контрактом**: либо `GET /conversation/{id}`, либо `GET /lead/{id}` — один ответ содержит всё для отображения панели (имя, pipeline_id, pipeline_name, stage_id, stage_name, campaign_id, campaign_name, became_lead_at, список стадий pipeline для dropdown, последние события таймлайна).
- Stage dropdown: **кэшировать** список стадий pipeline при первом открытии панели (или при первом открытии данного pipeline), не дергать API при каждом открытии чата.

**Итог:** один источник правды на один экран. Бэкенд отдаёт готовый контракт для Lead Panel; фронт только рисует и шлёт PATCH при смене стадии.

---

#### Визуальный минимум

- Header: имя крупнее, бейдж Lead (как в Chat List — маленький, не кричащий), одна кнопка — закрыть панель.
- Pipeline + Stage: текст pipeline name; под ним один dropdown со стадиями текущего pipeline; при выборе — PATCH, затем обновить отображаемое имя стадии из ответа.
- Source: две строки текста (Campaign + дата), без лишних подписей кроме «Campaign:» и формата даты.
- Timeline: вертикальный список до 10 строк, каждая — дата/время + короткий текст события. Без иконок по типам на этом этапе (или одна нейтральная иконка на все — по решению фронта, но минимально).

---

### 11в. PHASE 2.3 — Контракт поведения (папка «Новые лиды»)

**Перед реализацией зафиксированы 3 критичных UX-решения.** Inbox-логика, не CRM-стадия.

#### 1. Что такое «Новый лид»?

**Неверно:** привязывать «новый» к первой стадии pipeline (если менеджер вернёт лида в первую стадию — он снова станет «новым», логическая дыра).

**Верно:**

- **Новый лид** = `became_lead_at != null` **AND** `first_manager_reply_at IS NULL`.
- То есть: пока менеджер не отправил ни одного исходящего сообщения в этом диалоге — лид считается новым.
- Messaging-first: «новый» = ещё не обработан из inbox.

#### 2. Когда лид исчезает из папки?

- **Исчезает сразу после первого исходящего сообщения менеджера** в этом conversation.
- Не при смене стадии (стадия — CRM-логика; «новый» — inbox-логика).
- Backend при сохранении исходящего сообщения выставляет `first_manager_reply_at = COALESCE(first_manager_reply_at, NOW())` по conversation.

#### 3. Сортировка

- Только **`became_lead_at DESC`**. Не `last_message_at`.
- Папка = очередь на обработку новых входящих лидов.

---

#### Внешний вид папки

- В левом сайдбаре: **«Новые лиды» (N)** — всегда первой, без вложенности, без фильтров.

---

#### 4 UX-детали для фронта (обязательно)

**1. Размещение в сайдбаре**

- **Новые лиды (N)** — самая первая строка/блок в панели чатов (над аккаунтами/папками Telegram).
- Визуально отделить **тонкой горизонтальной линией** от Telegram-папок.
- Иконка — простая (Inbox или Dot). Без вложенности. Всегда сверху.
- Это **системная папка**, не папка Telegram.

**2. Счётчик (N)**

- N = количество элементов в списке new-leads.
- **Обновляется без manual refresh:**
  - После успешного **POST /send** — если отправка была в conversation из new-leads, **удалить этот conversation из локального state** new-leads (не ждать повторный GET).
  - При открытии/переключении на секцию «Новые лиды» — запросить GET /new-leads и положить в state (кэш).
- Цель: живой UX, лид исчезает из папки сразу после ответа.

**3. Поведение при клике**

- При клике на **«Новые лиды»:** основной список чатов **заменяется** на список из GET new-leads. Без фильтров, без сортировки по last_message; только порядок по became_lead_at DESC.
- При переключении на папку Telegram — снова показывается обычный список чатов (папки + чаты).
- **Не смешивать:** если открыт режим «Новые лиды», показывается **только** этот список. Один и тот же чат не дублируется в двух местах.

**4. Пустая папка**

- Если список new-leads пуст — показать **empty state:** «Нет новых лидов» / «Все лиды обработаны 🎉» (лаконично, позитивно).

---

#### Backend-контракт (обязательно)

- **GET /api/messaging/new-leads** возвращает conversations, где:
  - `lead_id IS NOT NULL`
  - `first_manager_reply_at IS NULL`
  - сортировка `became_lead_at DESC`
- **Фронт не вычисляет** «is_new» и не строит логику на `stage_id`. Всё отдаёт endpoint.

---

### 11г. PHASE 2.5 — Campaign UX Upgrade (операционный и аналитический центр)

**Цель:** Campaign = мини-воронка: видно отправлено / прочитано / ответили / перешли в общий чат и конверсии по этапам. Не хранить агрегаты в campaign — считать через GROUP BY (позже можно materialized view).

#### 1. Метрики кампании (обязательно)

| Метрика | Поле | Определение |
|--------|------|-------------|
| **Отправлено** | total_sent | Количество conversation_id, куда отправлено первое outbound в рамках campaign (через campaign_sends → conversation). |
| **Прочитано** | total_read | Conversation_id, где первое сообщение кампании имеет status = 'read' (или read_at != null, если есть). |
| **Ответил** | total_replied | Conversation_id, где есть входящее сообщение после первого outbound (или campaign_participants.status = 'replied'). |
| **Общий чат** | total_converted_to_shared_chat | Conversation с shared_chat_created_at != null и campaign_id = campaign. |

#### 2. Конверсии (в UI — числа и проценты)

- **Read Rate** = total_read / total_sent (округление до 1 знака).
- **Reply Rate** = total_replied / total_read.
- **Conversion Rate (Shared)** = total_converted_to_shared_chat / total_replied.

#### 3. Backend

- **conversations:** добавить `shared_chat_created_at` (timestamp nullable). Индекс по (campaign_id, shared_chat_created_at).
- **POST /api/messaging/mark-shared-chat** — body: `{ conversation_id }`. Проставляет shared_chat_created_at = NOW(). Только по явному действию менеджера.
- **Метрики кампании:** GET campaign stats (или отдельный endpoint) возвращает total_sent, total_read, total_replied, total_converted_to_shared_chat и конверсии (read_rate, reply_rate, conversion_rate). Считать через GROUP BY / подзапросы, не хранить в campaign.

#### 4. UI: Campaign Details Page

- **A) KPI-блок** — горизонтальные карточки: Отправлено | Прочитано | Ответил | Общий чат. В каждой: большое число, под ним маленький процент, подпись. Минимализм.
- **B) Воронка** — горизонтальная: Sent → Read → Replied → Shared Chat, с цифрами под шагами. Простая flex-сетка, без тяжёлых библиотек.
- **C) Таблица лидов кампании** — колонки: Контакт, Статус (Sent / Read / Replied / Shared), Стадия Pipeline, Дата отправки, Дата ответа, кнопка «Открыть диалог». Статус = наивысший достигнутый этап. Фильтры: Все | Только ответили | Только без ответа | Только shared.

#### 5. Кнопка «Создать общий чат» (Lead Panel)

- Показывать в Lead Panel, когда: есть campaign (conversation от кампании), есть ответ, shared_chat_created_at IS NULL.
- По клику: POST mark-shared-chat. Backend проставляет shared_chat_created_at. UI обновляет состояние (и при необходимости стадию pipeline в «Hot»/«Deal» — опционально).
- **Нельзя:** редактировать shared_chat_created_at вручную, удалять shared-статус, считать shared без явного действия.

#### 6. Campaign List Page

- В строке кампании — мини-KPI: Sent | Read | Reply | Shared в компактном виде (сравнение без захода внутрь).

#### 7. UX-правила

- Shared = только осознанное действие менеджера. Не автоматика.

#### 8. PHASE 2.6 — Shared Chat Intelligence + Control Layer (§11д)

- **conversations:** сохранять `shared_chat_channel_id` (bigint nullable) — Telegram channel ID созданной супергруппы. Без этого нельзя открыть группу из CRM и анализировать.
- **create-shared-chat:** после CreateChannel сохранять `shared_chat_channel_id` в conversation; возвращать 409 если `shared_chat_created_at` уже не null (нельзя создать два shared-чата).
- **mark-shared-chat (legacy):** возвращать 409 если shared уже создан.
- **Lead Panel после создания:** убрать кнопку «Создать», показать «✅ Общий чат создан» и «🔗 Открыть в Telegram» — ссылка `https://t.me/c/{internal_channel_id}` (или username, если публичная).
- **Метрика Time to Shared:** в campaign stats добавить `avg_time_to_shared_hours` = AVG(shared_chat_created_at - first_outbound_at) в часах (1 знак). first_outbound_at = MIN(campaign_sends.sent_at) по conversation.
- **Системное событие в диалоге:** при создании общего чата добавлять в историю 1-1 сообщение: `[System] Общий чат создан: <title>`. Для прозрачности и будущего AI-анализа.

#### 9. PHASE 2.7 — Won + Revenue (§11е)

- **conversations:** добавить `won_at`, `revenue_amount` (numeric 12,2), `lost_at`, `loss_reason` (text). Оба исхода (Won/Lost) для аналитики.
- **Lead Panel:** при `shared_chat_created_at != null` и `won_at IS NULL` и `lost_at IS NULL` — две кнопки: «Закрыть сделку (Won)» и «Отметить как потеряно (Lost)». После Won/Lost — показывать статус и сумму/причину.
- **POST /api/messaging/mark-won:** body `{ conversation_id, revenue_amount? }`. Устанавливает won_at = NOW(), revenue_amount. 409 если уже won/lost. Системное сообщение: `[System] Сделка закрыта. Сумма: X €`.
- **POST /api/messaging/mark-lost:** body `{ conversation_id, reason? }`. Устанавливает lost_at = NOW(), loss_reason. 409 если уже won/lost. Системное сообщение: `[System] Сделка потеряна. Причина: ...`.
- **Campaign stats:** total_won, total_lost, total_revenue, win_rate = total_won / total_replied, revenue_per_sent, revenue_per_reply, avg_revenue_per_won, avg_time_to_won_hours.
- **Воронка:** Sent → Read → Replied → Shared → Won; Lost — отдельно. Won и Lost необратимы, с подтверждением и логированием.

---

## 12. Переломная точка

Если Messaging UX получится **чистым** — продукт станет понятным, messaging-first.  
Если нет — всё превратится в перегруженную CRM.  
Архитектура и Conversation уже правильные; дальше всё решит UX.

---

## 13. Backend (кратко)

- **Таблица `conversations`:** id, organization_id, bd_account_id, channel, channel_id, contact_id, lead_id, campaign_id, became_lead_at, first_manager_reply_at, shared_chat_created_at, shared_chat_channel_id, **won_at**, **revenue_amount** (numeric 12,2), **lost_at**, **loss_reason** (PHASE 2.7), last_viewed_at, created_at, updated_at. UNIQUE(organization_id, bd_account_id, channel, channel_id). Создание — только при первом сообщении (ensureConversation в messaging/bd-accounts).
- **Таблица `lead_activity_log`:** id, lead_id, type, metadata, created_at, correlation_id. Типы: lead_created, stage_changed, deal_created, campaign_reply_received (и при необходимости sla_breach).
- **API:** список чатов возвращает conversation_id, lead_id, lead_stage_name, lead_pipeline_name, campaign_id, became_lead_at; **GET new-leads** — фильтр по lead_id и first_manager_reply_at IS NULL, сортировка became_lead_at DESC (§11в). GET lead activity для таймлайна.
- **Событие** LEAD_CREATED_FROM_CAMPAIGN при создании лида из кампании; messaging подписывается и обновляет conversation (attachLead).
- **Backfill не делаем.** БД чистая, только новые миграции.

---

## 14. UX-принципы (общие)

- **Conversation** — центральный объект. Lead — состояние conversation.
- Всё открывается за **1 клик**. Никаких переходов по 5 страницам.
- Campaign → Chat переход **мгновенный**.
- Не более **3 уровней вложенности**.

---

## 15. Чеклист реализации

**Backend (готово):**
- [x] Миграции: `conversations` (в т.ч. `last_viewed_at`), `lead_activity_log`.
- [x] ensureConversation, attachLead, API чатов с lead/stage/campaign, GET new-leads, PATCH conversation view, GET lead activity.
- [x] Campaign: reply + auto_create_lead → lead, lead_activity_log, LEAD_CREATED_FROM_CAMPAIGN.
- [x] Pipeline: запись в lead_activity_log при смене стадии.
- [x] **PHASE 2.2 backend:** GET `/api/messaging/conversations/:id/lead-context` (всё для Lead Panel в одном ответе); PATCH `/api/pipeline/leads/:id/stage` (body: `{ stage_id }`, response: `{ stage: { id, name } }`). Узкий контракт, без лишних полей.
- [x] **PHASE 2.3 backend (§11в):** миграция `first_manager_reply_at` в conversations; GET new-leads фильтрует по `lead_id IS NOT NULL` и `first_manager_reply_at IS NULL`, сортировка `became_lead_at DESC`; при POST /api/messaging/send проставляется `first_manager_reply_at = COALESCE(..., NOW())`.

**UX-решения (зафиксированы):**
- [x] §10: панель справа; авто-открытие только из Campaign; скрыть навсегда — нет; состояние по conversation.

**Редизайн (по фазам):**
- [x] **PHASE 2.1 — Chat List:** бейдж Lead / Contact, Stage + Pipeline в списке. Чистый список, без поиска и фильтров по типу. **Контракт поведения:** §11а. *Реализовано: интерфейс Chat расширен (conversation_id, lead_id, lead_stage_name, lead_pipeline_name); маппинг из API в обоих путях загрузки чатов; строка списка — имя + бейдж справа, при lead_id — две строки серым (pipeline, stage), превью последнего сообщения; убраны поиск и переключатель Все/Личные/Группы в области списка чатов.*
- [x] **PHASE 2.2 — Lead Panel:** имя, pipeline, stage dropdown, campaign source, became_lead_at, timeline (3 типа событий, макс. 10). Правая колонка, минимально. **Контракт поведения:** §11б. *Реализовано:* GET lead-context при открытии панели; PATCH lead stage без optimistic; 4 блока (Header, Pipeline+Stage, Source, Timeline); состояние open/close по conversation_id; при переходе с `?open=channelId` для лида панель открывается автоматически; кнопка «Лид» в шапке чата открывает панель, если она закрыта.
- [x] **PHASE 2.3 — Папка «Новые лиды»:** закреплённая сверху «Новые лиды (N)», без вложенности. **Контракт поведения:** §11в + 4 UX-детали. *Реализовано:* backend — first_manager_reply_at, GET new-leads, проставление при send; фронт — системная папка с иконкой Inbox и счётчиком N сверху сайдбара (визуально отделена линией), activeSidebarSection new-leads | telegram, при клике список заменяется на new-leads (became_lead_at DESC), после send лид удаляется из локального state без reload, empty state «Нет новых лидов» / «Все лиды обработаны 🎉». Клик по папке Telegram возвращает обычный список.
- [x] **PHASE 2.4 — Campaign deep-link:** «Открыть диалог» в таблице участников кампании ведёт на `/dashboard/messaging?bdAccountId=...&open=channelId`; при открытии чата с лидом Lead Panel авто-раскрывается. Реализовано в CampaignParticipantsTable и messaging page (urlOpenChannelId + leadPanelOpenByConvId).
- [x] **PHASE 2.5 — Campaign UX Upgrade (§11г):** метрики total_sent / total_read / total_replied / total_converted_to_shared_chat и конверсии; shared_chat_created_at + POST mark-shared-chat; Campaign Details — KPI, воронка, таблица лидов с фильтрами; Campaign List — мини-KPI в строке; Lead Panel — кнопка «Создать общий чат». Реализовано.
- [x] **PHASE 2.6 — Shared Chat Intelligence (§11д):** shared_chat_channel_id в conversations; create-shared-chat сохраняет channel_id, 409 при повторном создании; mark-shared-chat возвращает 409 если уже создан; Lead Panel после создания — «Общий чат создан» + ссылка «Открыть в Telegram»; системное сообщение в диалоге «[System] Общий чат создан: <title>»; avg_time_to_shared_hours в campaign stats. Реализовано.
- [x] **PHASE 2.7 — Won + Revenue (§11е):** won_at, revenue_amount, lost_at, loss_reason в conversations; POST mark-won / mark-lost; Lead Panel — кнопки «Закрыть сделку» и «Отметить как потеряно», модалки с суммой/причиной; системные сообщения в диалоге; campaign stats: total_won, total_lost, total_revenue, win_rate, avg_time_to_won; воронка до Won, Lost отдельно. Реализовано.
- [x] Campaign UI: Lead badge, Stage, «Открыть диалог» в таблице участников; ссылка на messaging с авто-раскрытием Lead Panel. Редактирование таблицы контактов перед запуском — в flow кампании (аудитория).
- [ ] Удалить из старого UI: дублирующиеся фильтры, избыточные поля, лишние вкладки (по мере рефакторинга; не блокер).
- [x] **PHASE 2.8 — Stability & Integrity:** CHECK-ограничения в БД (won/lost взаимоисключающие, revenue только при won); официальные события Conversation (§18); доменные константы в @getsale/types; execution logging (stats >2s, create-shared-chat external >5s, 409); документирование профилирования (§19).
- [x] **PHASE 2.9 — Observability & Reliability (§20):** Correlation ID в api-gateway (генерация, прокидывание, ответ); чтение и fallback в messaging, campaign, bd-accounts, pipeline; структурированный логгер @getsale/logger и замена console.warn в ключевых местах; Prometheus /metrics (duration, total, 409, shared_chat_created, deals_won, external_call); GET /ready в messaging, campaign, bd-accounts.
- [x] **PHASE 2.10 — Data Consistency + Governance (§21):** Транзакции в create-shared-chat, mark-won, mark-lost (BEGIN → UPDATE conversations + INSERT system message → COMMIT; ROLLBACK при ошибке). RBAC-политика зафиксирована (§16, flat trust). Conversation v1 объявлен замороженным (§17). Рекомендуется далее: unit/integration-тест на атомарность mark-won / create-shared-chat при появлении тестовой инфраструктуры.
- [x] **AI Workspace — Right Workspace Panel + Conversation Intelligence (§22):** Универсальная правая панель с табами AI Assistant и Lead Card (rail, persisted tab, lazy AI content); миграция conversation_ai_insights; обогащение чатов (account_name, chat_title в GET /chats); POST /api/messaging/conversations/:id/ai/analysis и /ai/summary; ai-service POST /api/ai/conversations/analyze (structured JSON); кнопки Generate Analysis (только для лида) и Summarize Chat (scope: last_7_days / full / since_sync); вставка draft_message в поле ввода.

---

## 16. Решение по RBAC — зафиксированная политика

**Архитектурное решение:** CRM работает в модели **flat trust** в рамках организации: любой аутентифицированный пользователь организации может выполнять lifecycle-действия без проверки роли:
- «Создать общий чат» (create-shared-chat, mark-shared-chat)
- «Закрыть сделку (Won)» (mark-won)
- «Отметить как потеряно (Lost)» (mark-lost)

**Обоснование:** На момент PHASE 2.1–2.9 это сознательная продуктовая политика: все пользователи организации считаются доверенными в рамках доступа к CRM. В коде **нет** вызова `canPermission` для этих эндпоинтов — это не забывчивость, а отражение выбранной модели.

**При смене политики:** Ввести проверку через `canPermission(pool, user.role, 'messaging', 'conversation.mark_won' | 'conversation.mark_lost' | 'conversation.create_shared_chat')` и записи в `role_permissions`. Любое ужесточение — отдельное продуктовое решение с обновлением этого раздела и кода.

---

## 17. Заморозка схемы Conversation v1

**Объявление:** Модель **Conversation** считается стабильной версией **v1** после завершения PHASE 2.1–2.7.

**Текущий набор полей (не расширять без обсуждения):**
- Идентификация: id, organization_id, bd_account_id, channel, channel_id, contact_id
- Воронка/лид: lead_id, campaign_id, became_lead_at, first_manager_reply_at
- Shared: shared_chat_created_at, shared_chat_channel_id
- Исход сделки: won_at, revenue_amount, lost_at, loss_reason
- UX: last_viewed_at, created_at, updated_at

**Правило:** Добавление новых полей в таблицу `conversations` допускается только после архитектурного/продуктового решения (отдельная задача, обновление §13 и миграция). Не превращать Conversation в «мусорку» полей (unread_count, assignment, tags, SLA, owner_id, priority и т.п. — по §7 не добавляем).

---

## 18. PHASE 2.8 — Официальные события Conversation (Event Consistency Policy)

Системные сообщения в диалоге (таблица `messages`) при lifecycle-действиях записываются с единым форматом `metadata`:

| Действие | metadata.event | Описание |
|----------|----------------|----------|
| Создан общий чат | `shared_chat_created` | После успешного create-shared-chat. В metadata также: title. |
| Сделка закрыта (Won) | `deal_won` | После mark-won. В metadata также: revenue_amount. |
| Сделка потеряна (Lost) | `deal_lost` | После mark-lost. В metadata также: reason. |

Константы в коде: `@getsale/types` — `ConversationSystemEvent.SHARED_CHAT_CREATED`, `DEAL_WON`, `DEAL_LOST`. Использовать их при INSERT системных сообщений. Это обеспечивает единый событийный слой для будущих webhook-ов, аналитики и автоматизации.

---

## 19. PHASE 2.8 — Operational monitoring и профилирование Campaign Stats

**Логирование (включено):**
- **GET /api/campaigns/:id/stats:** при времени ответа > 2 с логируется предупреждение с `campaignId`, `durationMs`, `participantsTotal`.
- **POST /api/messaging/create-shared-chat:** при вызове bd-accounts > 5 с логируется предупреждение с `durationMs`, `conversationId`.
- **409 Conflict:** при возврате 409 по create-shared-chat, mark-shared-chat, mark-won, mark-lost логируется предупреждение с именем endpoint и `conversationId` (для анализа повторных попыток).

**Профилирование stats при росте участников:**
- На 1k / 5k / 10k участников рекомендуется замерить время выполнения GET /api/campaigns/:id/stats (логи дают `durationMs`).
- В dev для тяжёлых кампаний выполнить в psql по одному из подзапросов stats:
  `EXPLAIN (ANALYZE, BUFFERS) SELECT ...` (подставить запрос из campaign-service: totalReadRes, avgTimeToSharedRes и т.д.).
- Убедиться, что используются индексы по `campaign_id`, `conversations(campaign_id, shared_chat_created_at)`. При деградации — рассмотреть materialized view для агрегатов (отдельное решение).

---

## 20. PHASE 2.9 — Observability & Reliability Layer

**Цель:** если что-то сломается — узнавать за минуты, а не часы. Correlation ID + структурированные логи + метрики.

### 20.1 Correlation ID

- **api-gateway:** генерирует `x-correlation-id` (UUID v4), если заголовок не передан; прокидывает во все downstream-сервисы в `onProxyReq`; добавляет в ответ в `onProxyRes` и в `/health`.
- **messaging-service, campaign-service, bd-accounts-service, pipeline-service:** читают `x-correlation-id` из запроса; при отсутствии — fallback (собственный UUID); кладут в `req.correlationId`; используют во всех структурированных логах (`correlation_id`).
- **messaging → bd-accounts:** при вызове `create-shared-chat` передаёт текущий `x-correlation-id` в заголовке запроса к bd-accounts.

### 20.2 Структурированный логгер

- Используется `@getsale/logger` (createLogger(serviceName)); формат JSON: `timestamp`, `service`, `level`, `message`, `correlation_id`, `endpoint`, `event`, и др.
- В messaging-service все предупреждения по 409 и медленным вызовам переведены на `log.warn({ message, correlation_id, endpoint, event, ... })`; ошибки — на `log.error({ message, correlation_id, error })`.
- В campaign-service медленный stats — `log.warn({ message, correlation_id, endpoint, durationMs, participantsTotal, event: 'slow_stats' })`.

### 20.3 Метрики Prometheus

- **messaging-service:** `GET /metrics` — `http_request_duration_seconds`, `http_requests_total`, `conflicts_409_total` (по endpoint), `shared_chat_created_total`, `deals_won_total`, `external_call_duration_seconds` (target: bd-accounts).
- **campaign-service:** `GET /metrics` — `http_request_duration_seconds`, `http_requests_total`.
- pipeline-service, crm-service, automation-service уже имели `/metrics` и счётчики по своим доменам.

### 20.4 Health и Ready

- **GET /health** — процесс жив (есть во всех сервисах).
- **GET /ready** — готовность к работе: в messaging, campaign, bd-accounts, pipeline — проверка БД (`SELECT 1`); в pipeline дополнительно проверка RabbitMQ. При недоступности БД — 503.

### 20.5 Дальнейшие шаги (P3)

- OpenTelemetry / distributed tracing (Jaeger, Tempo).
- Alerting по error rate и latency.
- DB slow query logging, pg_stat_statements, мониторинг connection pool.

---

## 21. PHASE 2.10 — Data Consistency Hardening (обязательно)

**Цель:** Исключить event inconsistency: при сбое между UPDATE conversations и INSERT системного сообщения не должно оставаться «сделка закрыта без записи в чате».

**Реализация (выполнено):** Во всех трёх lifecycle-эндпоинтах используется одна транзакция:

| Эндпоинт | Операции в транзакции | Rollback при ошибке |
|----------|------------------------|----------------------|
| POST /api/messaging/create-shared-chat | UPDATE conversations (shared_chat_created_at, shared_chat_channel_id) + INSERT messages (system) | Да |
| POST /api/messaging/mark-won | UPDATE conversations (won_at, revenue_amount) + INSERT messages (system) | Да |
| POST /api/messaging/mark-lost | UPDATE conversations (lost_at, loss_reason) + INSERT messages (system) | Да |

**Паттерн в коде:** `const client = await pool.connect(); try { await client.query('BEGIN'); ... await client.query('COMMIT'); } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { client.release(); }`. Вызов bd-accounts в create-shared-chat выполняется **до** транзакции (откатить внешний API нельзя); транзакция охватывает только запись в БД.

**Governance:** См. §16 (RBAC — flat trust), §17 (Conversation v1 locked). Рекомендуется при появлении тестовой инфраструктуры добавить интеграционный тест: вызов mark-won при принудительном сбое после UPDATE и до INSERT не должен оставлять запись в conversations без системного сообщения (проверка атомарности).

---

## 22. AI Workspace — Right Workspace Panel и Conversation Intelligence

**Цель:** Универсальная правая панель (Telegram-like) с табами AI Assistant и Lead Card; слой AI-аналитики по диалогам с персистентным хранением; обогащение чатов при sync.

### 22.1 Right Workspace Panel

- **Архитектура:** Одна панель `RightWorkspacePanel` с табами `ai_assistant` | `lead_card`. В свёрнутом состоянии — вертикальный rail с кнопками 🤖 AI и 👤 Lead. При клике панель открывается, кнопки становятся табами сверху; одновременно активен один таб.
- **Состояние:** `isOpen`, `activeTab`; активный таб сохраняется в `sessionStorage` (`messaging_right_panel_tab`), при обновлении страницы восстанавливается.
- **Условия:** Без выбранного чата кнопки disabled; Lead Card доступен только для чата-лида. Контент AI Assistant — lazy-loaded (dynamic import).
- **Реализация:** Компонент `RightWorkspacePanel`; контент Lead Card — прежние блоки Lead Panel (Header, Pipeline+Stage, Source+Shared/Won/Lost, Timeline). Контент AI — `AIAssistantTabContent` (Generate Analysis, Summarize, вставка черновика в поле ввода).

### 22.2 Обогащение чатов при sync

- При отдаче списка чатов (GET /api/messaging/chats) в ответ добавлены поля: `account_name` (из bd_accounts: display_name / username / phone / telegram_id), `chat_title` (из bd_account_sync_chats.title для групп).
- В UI в качестве основного отображения используется CRM-friendly имя (display_name, first_name+last_name, username); `telegram_id` не показывается как основной идентификатор.

### 22.3 Таблица conversation_ai_insights

- **Назначение:** Хранение результатов AI-анализа/саммари/черновиков по диалогу (история генераций, модель, тип).
- **Поля:** id, conversation_id (FK), account_id (FK bd_accounts), type (`analysis` | `summary` | `draft`), payload_json (структурированный результат, без полного промпта), model_version, generated_from_message_id (nullable), created_at.
- **Миграция:** `20250629000001_conversation_ai_insights.ts`.

### 22.4 AI Analysis

- **Условие:** Выбран аккаунт, выбран чат, чат — лид. Кнопка «Generate Analysis» в табе AI Assistant.
- **Backend:** POST /api/messaging/conversations/:id/ai/analysis — загрузка последних N сообщений (лимит контекста), вызов ai-service POST /api/ai/conversations/analyze, сохранение результата в conversation_ai_insights (type=analysis), возврат структурированного JSON.
- **Structured output:** chat_meta, project_summary, fundraising_status, stage, last_activity, risk_zone, recommendations[], draft_message. Черновик можно вставить в поле ввода (editable, не отправляется автоматически, label «Generated by AI»).

### 22.5 Chat Summarizer

- Кнопка «Summarize Chat» с опциями: Last 7 days, Full chat, Since last sync. Результат сохраняется в conversation_ai_insights (type=summary). Backend: POST /api/messaging/conversations/:id/ai/summary (body: scope).

### 22.6 AI best practices (зафиксировано)

- Не вызывать AI при автоматическом открытии чата; только по явному действию пользователя.
- Ограничение контекста (последние 100–200 сообщений); при необходимости — internal summary + последние 20.
- Не хранить полный промпт в БД; в payload_json — только результат.
- Не блокировать UI: loading state при генерации.
- Архитектура допускает добавление новых AI-инструментов (расширяемые типы в conversation_ai_insights).
