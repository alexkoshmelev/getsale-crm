# Кампании холодного аутрича (Campaign Service)

**Цель:** массовые рассылки с поддержкой sequences, шаблонов и расписания. AI-фичи — заглушки с возможностью полноценной реализации позже.

---

## 0. Упрощённый флоу (UX)

Пользователь настраивает кампанию в 4 шага:

1. **Откуда брать контакты** — один из трёх источников: **база CRM** (фильтры + выбор контактов), **файл (CSV)** или **группа в Telegram** (участники чата/канала).
2. **Кто рассылает** — один BD-аккаунт (кто отправляет сообщения). Мультивыбор BD в одной кампании — в бэклоге.
3. **Последовательность (sequence)** — шаги рассылки: сообщения, шаблоны, тайминги (задержка / сразу после ответа), условия (например, не слать следующий шаг, если контакт ответил).
4. **Управление кампанией** — Запустить, Приостановить, Продолжить, Остановить (полная остановка, статус → completed).

Лишние поля убраны из основного флоу; «Создание лида в CRM» и расширенные фильтры вынесены в блок «Дополнительно».

---

## 1. Сводка из нашей документации

### 1.1 Текущее состояние (из STATE_AND_ROADMAP, CURRENT_STATE_ANALYSIS)

- **Campaign Service:** не реализован (0%).
- В архитектуре описан как отдельный микросервис: CRUD кампаний, шаблоны сообщений, sequences (многошаговые сценарии), расписание, базовая статистика.
- Интеграция с Messaging/BD Accounts для отправки по выбранным каналам (сейчас — Telegram).
- Рекомендуемый порядок: после автосоздания лида из чата и Email/MFA; в NEXT_STEPS_PRIORITY — «Неделя 3: Campaign Service».

### 1.2 Существующие типы (shared/types)

- **Campaign:** id, organizationId, companyId, pipelineId, name, targetAudience, templates, sequences, schedule?, status, createdAt, updatedAt.
- **CampaignAudience:** filters (Record), limit?.
- **CampaignTemplate:** id, name, channel (MessageChannel), content, conditions?.
- **CampaignSequence:** id, order, templateId, delay (hours), conditions?.
- **CampaignSchedule:** timezone, workingHours { start, end }, daysOfWeek (number[]).
- **CampaignStatus:** draft | active | paused | completed.

### 1.3 События (shared/events)

- `campaign.created`, `campaign.started`, `campaign.paused`, `campaign.completed`.

### 1.4 Отправка сообщений (как вызывать из Campaign)

- **Messaging Service:** `POST /api/messaging/send` — body: `contactId`, `channel`, `channelId`, `content`, `bdAccountId`, опционально `fileBase64`, `fileName`, `replyToMessageId`.
- Для Telegram: нужны контакт (contact_id в CRM), channel_id (telegram chat id), bd_account_id. Контакт должен иметь привязку к чату (через messages или bd_account_sync_chats + contacts.telegram_id).

---

## 2. Лучшие практики и как делают другие CRM

### 2.1 Общие принципы

- **Multi-touch sequences:** 4–7 касаний дают в разы больше откликов, чем 1–3; 80% продаж требуют 5+ касаний.
- **Персонализация:** темы/первые строки с персонализацией дают заметно выше open rate (порядка +26% по данным по cold email).
- **Омниканал:** email + LinkedIn + звонки повышают конверсию (например, email+LinkedIn ~60% meeting rate vs только email ~46%); для нас v1 — Telegram, дальше — другие каналы.
- **Расписание:** отправка в рабочие часы по таймзоне получателя, ограничение по дням недели.
- **Лимиты и throttle:** не слать пачками, соблюдать rate limits каналов (Telegram, позже email/LinkedIn).

### 2.2 Модель данных (Outreach.io / Apollo-подобная)

- **Sequence (кампания/последовательность):** имя, статус, метрики (sent, delivered, opened, clicked, replied, bounced), настройки (лимиты, рабочие часы, правила по дубликатам).
- **Mailings (отправки):** каждая отправка — запись с delivered_at, opened_at, clicked_at, error, mailing_type (single/sequence/campaign).
- **Шаги последовательности:** порядок, задержка (часы/дни) или триггер «сразу после ответа», шаблон, условия (например, не слать follow-up если был reply).

### 2.3 AI в холодном аутриче (практики, у нас — заглушки)

- **Персонализация текста:** подстановка полей контакта/компании; позже — AI-генерация персонального фрагмента (заглушка: `{{ai.personalize}}` или фиксированный текст).
- **Оптимальное время отправки:** позже — модель по открытиям/ответам; заглушка: использование schedule кампани + случайный сдвиг в пределах окна.
- **A/B тесты шаблонов:** заглушка: одна версия шаблона; позже — несколько вариантов, выбор по метрикам.
- **Авто-стоп при ответе:** при получении message.received по контакту — выход из sequence (реализуем через события и флаг в participant).

---

## 3. Архитектура решения (база)

### 3.1 Сервисы

- **Campaign Service (новый):** порт 3012. CRUD кампаний, шаблоны, sequences, расписание. Формирует список «кого и когда» слать, вызывает Messaging Service (`POST /api/messaging/send`) или ставит задачи в очередь (Bull/BullMQ) для асинхронной отправки.
- **Messaging Service:** без изменений контракта; вызывается из Campaign или из worker’а по очереди.
- **BD Accounts Service:** без изменений; отправка идёт через Messaging → BD Accounts.

### 3.2 База данных (PostgreSQL)

- **campaigns** — основная таблица кампаний (organization_id, name, status, schedule JSONB, target_audience JSONB, created_at, updated_at). Опционально: company_id, pipeline_id для фильтра аудитории.
- **campaign_templates** — шаблоны (campaign_id или organization_id для глобальных), name, channel, content, conditions JSONB.
- **campaign_sequences** — шаги последовательности (campaign_id, order_index, template_id, delay_hours, trigger_type: delay | after_reply, conditions JSONB). При trigger_type = after_reply следующий шаг выполняется при получении ответа контакта (message.received), а не по таймеру. **Расширенные условия (conditions):** см. раздел 3.5.
- **campaign_participants** — участники кампании (campaign_id, contact_id, bd_account_id, channel_id, status: pending|sent|delivered|replied|bounced|stopped, current_step, next_send_at, metadata JSONB). Нужна для throttle и «не слать повторно если ответил».
- **campaign_sends** (опционально, для детальной статистики) — факт отправки (participant_id, sequence_step, message_id из messaging, sent_at, status).

Аудитория кампании задаётся через target_audience (filters по контактам/компаниям/воронке) и при старте кампании материализуется в campaign_participants.

### 3.3 Поток работы

1. Пользователь создаёт кампанию (draft), добавляет шаблоны и steps sequence (order, template_id, delay_hours).
2. Задаёт аудиторию (filters: по контактам с telegram_id, по компании, по стадии воронки и т.д.) и опционально schedule (working hours, days).
3. Запуск кампании: статус → active, расчёт участников (по filters), запись в campaign_participants, расчёт next_send_at для первого шага.
4. Worker/Cron или фоновый цикл в Campaign Service: выбор записей campaign_participants где next_send_at <= now и status = pending/sent (для следующего шага). Для каждой: подстановка в шаблон (contact first_name и т.д.), вызов POST /api/messaging/send (или постановка job). После отправки: обновление next_send_at = now + delay следующего шага или завершение sequence.
5. При message.received (событие): подписчик в Campaign Service помечает participant как replied/stopped и больше не шлёт follow-up.
6. Статистика: агрегация по campaign_id из campaign_participants и campaign_sends (sent, delivered, replied, stopped).

### 3.4 AI-заглушки (расширяемая база)

- **Персонализация:** в шаблоне поддерживать плейсхолдеры `{{contact.first_name}}`, `{{company.name}}`. Заглушка для AI: `{{ai.personalize}}` → подставлять пустую строку или короткий фиксированный текст; позже — вызов AI Service.
- **Оптимальное время:** при расчёте next_send_at использовать schedule + случайный offset в пределах окна; позже — подставлять предсказание от AI.
- **Генерация варианта сообщения:** отдельный endpoint «сгенерировать вариант» может возвращать заглушку («AI будет подключён позже»); позже — вызов AI Service с контекстом контакта/компании.

---

## 4. API Campaign Service (базовый)

- `GET /api/campaigns` — список кампаний организации (фильтр по status).
- `GET /api/campaigns/:id` — одна кампания с шаблонами и steps.
- `POST /api/campaigns` — создание (draft).
- `PATCH /api/campaigns/:id` — обновление (name, schedule, target_audience, status).
- `DELETE /api/campaigns/:id` — удаление (только draft или после завершения).
- `POST /api/campaigns/:id/start` — запуск (расчёт participants, статус active).
- `POST /api/campaigns/:id/pause` — пауза.
- `GET /api/campaigns/:id/templates` — шаблоны кампании (или общие).
- `POST /api/campaigns/:id/templates` — добавить шаблон.
- `GET /api/campaigns/:id/participants` — список участников (пагинация).
- `GET /api/campaigns/:id/stats` — базовая статистика (total, sent, delivered, replied, stopped).

Формат target_audience (пример):  
`{ "filters": { "hasTelegram": true, "companyId": "uuid?", "pipelineId": "uuid?" }, "limit": 1000, "onlyNew": false, "contactIds": ["uuid?"], "bdAccountId": "uuid?", "sendDelaySeconds": 60 }`

- **onlyNew:** при старте брать только контакты, которые ещё не участвовали ни в одной кампании организации.
- **contactIds:** при наличии — использовать только перечисленные контакты (точечный выбор из базы).
- **bdAccountId:** с какого BD-аккаунта слать (если не задан — первый активный).
- **sendDelaySeconds:** задержка между отправками (сек); использование в worker — в планах.

Дополнительные API (campaign-service):

- `GET /api/campaigns/agents` — список BD-аккаунтов организации с полем sentToday (отправлено сегодня).
- `GET /api/campaigns/presets` — org-level шаблоны сообщений (campaign_id IS NULL).
- `POST /api/campaigns/presets` — создать пресет (name, channel, content).
- `GET /api/campaigns/contacts-for-picker` — контакты с telegram_id и outreach_status (new | in_outreach), параметры limit, outreachStatus, search.
- `POST /api/campaigns/:id/audience/from-csv` — тело { content: string, hasHeader?: boolean }; парсинг CSV, поиск/создание контактов по telegram_id или email; возврат { contactIds, created, matched }.
- `GET /api/campaigns/group-sources` — список чатов/каналов (bd_account_sync_chats, peer_type chat/channel) по организации.
- `GET /api/campaigns/group-sources/contacts?bdAccountId=&telegramChatId=` — контактные id по сообщениям в указанном чате.

**Расписание и задержка в worker:** отправка только в working hours и daysOfWeek (таймзона кампании); при не попадании в окно next_send_at сдвигается на 15 мин. Между отправками разным участникам — пауза sendDelaySeconds (из target_audience).

**Создание лида в CRM:** в campaigns добавлено поле lead_creation_settings: { trigger: 'on_first_send' | 'on_reply', default_stage_id? }. При первой отправке (если trigger = on_first_send) или при ответе (message.received, если trigger = on_reply) campaign-service вызывает pipeline-service POST /api/pipeline/leads (contactId, pipelineId, stageId). Требуется PIPELINE_SERVICE_URL и pipeline_id у кампании.

---

### 3.5 Расширенные условия шага (conditions)

Поле `campaign_sequences.conditions` (JSONB) задаёт, при каких условиях шаг **отправляется**. Если условия не выполняются, шаг **пропускается** (participant переводится на следующий шаг без отправки и без записи в campaign_sends). Все указанные группы условий объединяются по **AND**.

**Схема условий:**

| Ключ | Тип | Описание |
|------|-----|----------|
| `stopIfReplied` | boolean | Не отправлять, если участник уже в статусе `replied` (страховка; участники с replied обычно не попадают в выборку due). |
| `contact` | массив правил | Правила по полям контакта. Каждое правило: `{ field, op, value? }`. Поле: `first_name`, `last_name`, `email`, `phone`, `telegram_id`, `company_name`. Оператор: `equals`, `not_equals`, `contains`, `empty`, `not_empty`. Для `empty`/`not_empty` value не используется. Все правила в массиве — AND. |
| `inPipelineStage` | `{ pipelineId, stageIds[] }` | Отправлять **только если** контакт в указанной воронке и на одном из этапов из `stageIds`. Если контакта нет в воронке — не отправлять. |
| `notInPipelineStage` | `{ pipelineId, stageIds[] }` | **Не** отправлять, если контакт в указанной воронке и на одном из этапов из `stageIds`. Если контакта нет в воронке — отправлять. |

**Пример:** «Отправлять только если email не пустой и контакт в воронке "Sales" на этапе "Lead" или "Qualified"»:
```json
{
  "contact": [{ "field": "email", "op": "not_empty" }],
  "inPipelineStage": { "pipelineId": "uuid-sales", "stageIds": ["uuid-lead", "uuid-qualified"] }
}
```

В worker перед вызовом Messaging загружаются контакт (в т.ч. email, phone, telegram_id) и при необходимости лиды по pipeline_id; при невыполнении условий participant переводится на следующий шаг с пересчётом next_send_at.

---

## 5. Этапы реализации

### Фаза 1 — База (реализовано)

1. **Миграции:** `20250217000001_campaigns.ts` — campaigns, campaign_templates, campaign_sequences, campaign_participants, campaign_sends.
2. **Campaign Service:** Express на порту 3012, CRUD кампаний/шаблонов/последовательностей, start (материализация участников по target_audience), pause, participants, stats. События campaign.created/started/paused публикуются в RabbitMQ.
3. **API Gateway:** прокси `/api/campaigns` на campaign-service, передача X-User-Id, X-Organization-Id.
4. **Docker:** campaign-service добавлен в docker-compose.yml.
5. Фоновая отправка по расписанию (worker) и подстановка шаблонов с вызовом Messaging — в Фазе 2.

### Фаза 2 — Отправка и расписание (реализовано)

5. **Интеграция с Messaging:** campaign-service вызывает POST /api/messaging/send (MESSAGING_SERVICE_URL), заголовки X-User-Id и X-Organization-Id (первый пользователь организации). bd_account_id на уровне участника (campaign_participants).
6. **Worker:** setInterval (CAMPAIGN_SEND_INTERVAL_MS, по умолчанию 60 с) обрабатывает campaign_participants с next_send_at <= now и status in ('pending','sent'); подстановка {{contact.first_name}}, {{contact.last_name}}, {{company.name}} в контенте шаблона; вызов send; обновление current_step, next_send_at, status; запись в campaign_sends.
7. **Подписка на message.received:** RabbitMQ consumer в campaign-service обновляет campaign_participants (status = 'replied') по contact_id для активных кампаний.

### Фаза 3 — AI и полировка

8. **Подстановка плейсхолдеров:** {{contact.*}}, {{company.*}} реализованы в worker и в превью на фронте; заглушка для {{ai.personalize}} — в Фазе 3.
9. Полноценный AI: генерация персонализации, оптимальное время, A/B варианты — по мере готовности AI Service.

**Что дальше (рекомендации):** учёт schedule в worker (отправка только в working hours и выбранные дни недели); rate limiting по Telegram; статус campaign «completed» при завершении всех участников; AI-заглушки.

---

## 6. Конкурент (CRMChat) и лучшие практики

- **Анализ конкурента:** см. [COMPETITOR_CRMCHAT_ANALYSIS.md](./COMPETITOR_CRMCHAT_ANALYSIS.md) — что у них есть (поиск групп по ключевым словам, парсинг участников, help center), что уже есть у нас, что взять в бэклог.
- **Лучшие практики по рассылкам:** [OUTREACH_BEST_PRACTICES.md](./OUTREACH_BEST_PRACTICES.md) — чеклист перед запуском, советы по лимитам, opt-out, персонализации; можно встроить в UI (модалка «Перед запуском», подсказки).

---

## 7. Связь с другими документами

- **ARCHITECTURE.md** — Campaign Service как микросервис.
- **STATE_AND_ROADMAP.md**, **NEXT_STEPS_PRIORITY.md** — приоритет и порядок работ.
- **MASTER_PLAN_MESSAGING_FIRST_CRM.md** — общий бэклог; Campaign в приоритетах дальше.
- **BD_CRM_ARCHITECTURE.md**, **TELEGRAM_MESSAGING_FLOW.md** — отправка через Messaging и BD Accounts.
- **COMPETITOR_CRMCHAT_ANALYSIS.md**, **OUTREACH_BEST_PRACTICES.md** — вдохновление от конкурента и чеклист для рассылок.

После реализации базы обновить STATE_AND_ROADMAP и CURRENT_STATE_ANALYSIS (раздел Campaign).
