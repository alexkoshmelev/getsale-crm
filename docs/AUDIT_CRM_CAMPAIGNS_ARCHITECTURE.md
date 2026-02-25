# Аудит архитектуры CRM-кампаний: Contact → Lead → Deal

**Дата:** 2025-02-23  
**Роль:** Senior System Architect / Technical Analyst  
**Цель:** Полный разбор сквозного бизнес-процесса кампаний, воронки и сделок.

---

## 1. Схема текущего флоу (по шагам)

### 1.1 Запуск кампании (от создания до загрузки контактов)

```
[1] Создание кампании
    → POST /api/campaigns (name, status=draft)
    → campaigns: organization_id, name, status, target_audience (null), schedule, pipeline_id, lead_creation_settings

[2] Настройка аудитории (источник контактов)

    Вариант A: База CRM
    → target_audience: { filters: { companyId?, pipelineId? }, onlyNew?, limit?, contactIds? }
    → Контакты с telegram_id; при onlyNew — исключаются уже участвовавшие в любой кампании
    → «Выбрать из базы»: модалка → contactIds сохраняются в target_audience

    Вариант B: CSV
    → POST /api/campaigns/:id/audience/from-csv { content, hasHeader? }
    → Парсинг CSV → поиск по telegram_id или email → match или создание contact → contactIds
    → Ответ: { contactIds, created, matched }
    → Фронт сохраняет contactIds в target_audience (явно или через повторный PATCH кампании)

    Вариант C: Группа Telegram
    → GET /api/campaigns/group-sources → список чатов (bd_account_sync_chats)
    → GET /api/campaigns/group-sources/contacts?bdAccountId=&telegramChatId= → contactIds из messages
    → contactIds сохраняются в target_audience

[3] Настройка рассылки
    → target_audience.bdAccountId, sendDelaySeconds
    → schedule: timezone, workingHours, daysOfWeek
    → lead_creation_settings: { trigger: on_first_send | on_reply, default_stage_id?, default_responsible_id? }

[4] Запуск
    → POST /api/campaigns/:id/start
    → По target_audience строится список контактов (с telegram_id); лимит до 10 000
    → Для каждого: резолв bd_account_id + channel_id (telegram) → INSERT campaign_participants (ON CONFLICT DO NOTHING)
    → status = active, next_send_at = now для первого шага
    → Событие campaign.started
```

### 1.2 Обработка контактов в кампании (worker + события)

```
[5] Worker отправки (каждые CAMPAIGN_SEND_INTERVAL_MS, по умолчанию 60 с)
    → Выборка: campaign_participants где campaign.status=active, participant.status IN (pending,sent), next_send_at <= NOW()
    → Для каждого: загрузка шага sequence, шаблона, контакта; evaluateStepConditions (conditions шага)
    → Если условия не выполнены → переход на следующий шаг без отправки
    → Иначе: подстановка {{contact.*}}, {{company.*}} → POST /api/messaging/send → campaign_sends
    → Обновление current_step, next_send_at (по delay_hours/trigger_type и расписанию), status=sent
    → Если current_step был 0 и lead_creation_settings.trigger=on_first_send → ensureLeadInPipeline() → POST /api/pipeline/leads

[6] Событие message.received (ответ контакта)
    → Campaign-service: для участников этой кампании по contact_id
    → Если ждали шаг after_reply → next_send_at = NOW()
    → Иначе → status = replied
    → Если lead_creation_settings.trigger=on_reply → ensureLeadInPipeline() → POST /api/pipeline/leads
```

### 1.3 Попадание в воронку (Lead) и правило

```
[7] Создание лида (Lead)
    → POST /api/pipeline/leads { contactId, pipelineId, stageId?, responsibleId? }
    → Pipeline-service: проверка contact, pipeline; stageId = первая стадия, если не передан
    → UNIQUE(organization_id, contact_id, pipeline_id) → 409 если уже в воронке
    → INSERT leads → событие lead.created

[8] Правило попадания в воронку (текущая реализация)
    → Явное добавление: только через POST /api/pipeline/leads (ручное или из кампании).
    → В кампании: lead_creation_settings (on_first_send / on_reply) + pipeline_id кампании.
    → Стадии воронки хранят entry_rules / exit_rules (JSONB), но в коде они не вычисляются — только хранение.
    → Триггеры: (1) первая отправка в кампании, (2) ответ контакта. Разные кампании могут задавать разные pipeline_id и стадии.
```

### 1.4 Сделка (Deal) и связь с Lead

```
[9] Создание сделки
    → Только через CRM: POST /api/crm/deals (companyId или contactId или bdAccountId+channel+channelId, pipelineId, stageId?, title, ...)
    → CRM-service: разрешение company при fromContactOnly, проверка pipeline/stage, INSERT deals + history[0]
    → Событие deal.created
    → Автоматического создания Deal при создании Lead нет.

[10] Связь Contact / Lead / Deal
    → Contact: сущность в contacts (имя, email, phone, telegram_id, company_id).
    → Lead: контакт в воронке (leads: contact_id, pipeline_id, stage_id). Один контакт — одна запись на воронку.
    → Deal: коммерческая сущность (deals: company_id, contact_id?, pipeline_id, stage_id, title, value, ...). Сделка не создаётся из лида автоматически.
```

### 1.5 Движение сделки по воронке

```
[11] Смена стадии сделки
    → Через CRM: PATCH /api/crm/deals/:id/stage { stageId, reason? }
    → deals.stage_id обновляется; в deals.history добавляется запись (stage_changed, fromStageId, toStageId, performedBy, timestamp)
    → Событие deal.stage.changed
    → stage_history в CRM при удалении сделки чистится (DELETE stage_history WHERE deal_id).

    → Через Pipeline: PUT /api/pipeline/clients/:clientId/stage { stageId, dealId?, reason?, autoMoved? }
    → Текущая стадия берётся из deals (id = dealId || clientId; в коде также проверка client_id — см. раздел проблем).
    → INSERT stage_history (client_id, deal_id, from_stage_id, to_stage_id, moved_by, auto_moved, reason)
    → UPDATE deals SET stage_id WHERE dealId
    → Событие DEAL_STAGE_CHANGED

[12] Логирование истории
    → В CRM: история в JSONB deals.history (created, stage_changed с fromStageId, toStageId, performedBy, reason).
    → В Pipeline: таблица stage_history (client_id, deal_id, from_stage_id, to_stage_id, moved_at, moved_by, auto_moved, reason).
```

---

## 2. Диаграмма сущностей (словесная)

```
Organization
    │
    ├── Contacts (id, organization_id, company_id?, first_name, last_name, email, phone, telegram_id, consent_flags)
    │       │
    │       ├── Участие в кампаниях: CampaignParticipants (campaign_id, contact_id, bd_account_id, channel_id, status, current_step, next_send_at)
    │       │
    │       └── В воронке: Leads (contact_id, pipeline_id, stage_id, order_index, responsible_id)
    │
    ├── Companies (id, organization_id, name, industry, size, ...)
    │
    ├── Pipelines (id, organization_id, name, is_default)
    │       └── Stages (pipeline_id, organization_id, name, order_index, color, automation_rules, entry_rules, exit_rules)
    │
    ├── Deals (organization_id, company_id, contact_id?, pipeline_id, stage_id, owner_id, title, value, currency, history JSONB, ...)
    │       └── Движение: stage_history (client_id, deal_id, from_stage_id, to_stage_id, moved_by, moved_at, auto_moved, reason)
    │
    └── Campaigns (organization_id, name, status, target_audience, schedule, pipeline_id, lead_creation_settings)
            ├── campaign_sequences (шаги: template_id, delay_hours, trigger_type, conditions)
            ├── campaign_templates
            ├── campaign_participants
            └── campaign_sends
```

**Связи:**
- **Contact → Lead:** 1:1 на пару (contact, pipeline). Lead = факт нахождения контакта в воронке на стадии.
- **Contact → Deal:** 0..n. Сделка может быть с контактом или без; у одной сделки один contact_id (опционально).
- **Lead ↔ Deal:** не связаны напрямую. Лид и сделка могут быть по одному контакту и одной воронке, но создаются и двигаются независимо.

---

## 3. Таблица различий Contact / Lead / Deal

| Критерий | Contact | Lead | Deal |
|----------|---------|------|------|
| **Суть** | Запись в базе: человек/контакт | Контакт, помещённый в воронку (pipeline) на определённую стадию | Коммерческая сущность: сумма, компания, контакт, воронка, стадия |
| **Таблица** | contacts | leads | deals |
| **Сервис** | crm-service (CRUD) | pipeline-service (CRUD, список по pipeline/stage) | crm-service (CRUD), pipeline-service (перемещение стадии + stage_history) |
| **Ключевые поля** | first_name, last_name, email, phone, telegram_id, company_id | contact_id, pipeline_id, stage_id, order_index, responsible_id | company_id, contact_id?, pipeline_id, stage_id, owner_id, title, value, currency, history |
| **Когда появляется** | Создание вручную, импорт CSV (CRM или кампания), из чата/группы Telegram | POST /api/pipeline/leads (вручную или из кампании: on_first_send / on_reply) | POST /api/crm/deals (только вручную или из UI создания сделки) |
| **Стадия воронки** | Нет | stage_id (одна стадия на воронку) | stage_id |
| **История переходов** | Нет | Нет отдельной таблицы; при PATCH lead публикуется lead.stage.changed | deals.history (JSONB) + stage_history (таблица) |
| **Денежные поля** | Нет | Нет | value, currency |

---

## 4. CSV-шаблон для аудитории кампании (POST /api/campaigns/:id/audience/from-csv)

Логика в коде: разбор по заголовкам (hasHeader=true по умолчанию). Имена колонок приводятся к нижнему регистру и пробелы заменяются на `_`. Используются: **telegram_id** (или **telegram**), **first_name** (или **name**), **last_name**, **email**. Для матча/создания контакта достаточно **либо telegram_id, либо email**; строка без обоих пропускается.

| Поле | Обязательность | Формат | Примеры | Валидация |
|------|----------------|--------|---------|-----------|
| telegram_id (или telegram) | Рекомендуется (для рассылки в Telegram обязателен контакт с telegram_id) | Строка, цифры или username без @ | 123456789, @username | При создании контакта сохраняется как есть; для рассылки в кампании берутся только контакты с telegram_id |
| email | Рекомендуется (если нет telegram_id) | Email | user@example.com | Не валидируется форматом в campaign-service; используется для поиска/создания контакта |
| first_name (или name) | Необязательно | Текст | Иван | При создании нового контакта по умолчанию "Contact" |
| last_name | Необязательно | Текст | Петров | — |

**Правила:**
- В каждой строке должен быть хотя бы один из: `telegram_id`/`telegram` или `email`; иначе строка пропускается.
- Разделитель — запятая; поля в кавычках поддерживаются (parseCsvLine).
- Кодировка не указана в коде — разумно использовать UTF-8.
- Порядок колонок произвольный (поиск по имени заголовка). Если заголовка нет (hasHeader=false), используются индексы по умолчанию: 0=telegram, 1=first_name/name, 2=last_name, 3=email (см. код: idxTelegram=0, idxFirst=1, idxLast=2, idxEmail).

**Пример CSV с заголовком:**

```csv
telegram_id,first_name,last_name,email
123456789,Иван,Петров,ivan@example.com
@johndoe,John,Doe,john@example.com
987654321,,,lead@company.com
```

**Отдельно: массовый импорт контактов в CRM** (POST /api/crm/contacts/import) использует другой контракт: `mapping` с ключами firstName, lastName, email, phone, telegramId и 0-based индексами колонок; по умолчанию 0–4. Валидация: в каждой строке должен быть email или telegramId.

---

## 5. Найденные проблемы архитектуры

1. **Lead и Deal не связаны автоматически**  
   При создании лида (в т.ч. из кампании) сделка не создаётся. В CRM_API сказано «попадание контакта/компании в воронку = создание сделки», но в коде «попадание контакта в воронку» = только Lead. Консистентность между лидами и сделками в одной воронке обеспечивается только процессами/UI.

2. **Два места смены стадии сделки**  
   CRM: PATCH /api/crm/deals/:id/stage (обновляет только deals.stage_id и deals.history). Pipeline: PUT /api/pipeline/clients/:clientId/stage (пишет в stage_history и обновляет deals). Возможны расхождения: смена через CRM не пишет в stage_history; смена через Pipeline пишет в stage_history. Нет единой точки истины для «истории переходов сделки».

3. **Pipeline PUT /api/pipeline/clients/:clientId/stage**  
   В коде: `SELECT stage_id FROM deals WHERE id = $1 OR client_id = $1`. В схеме БД у таблицы deals есть только contact_id, а не client_id. Либо это ошибка (колонки client_id в deals нет), либо устаревший код/миграция. Требует проверки схемы БД и исправления.

4. **Терминология client_id в stage_history**  
   stage_history.client_id обязателен; deal_id опциональный. Неочевидно, когда в client_id лежит contact_id, а когда deal_id. Усложняет отчётность и аналитику по переходам.

5. **entry_rules / exit_rules стадий не используются**  
   В stages хранятся entry_rules и exit_rules (JSONB), но в pipeline-service и campaign-service они не вычисляются. «Правило попадания в воронку» реализовано только как явное добавление лида (ручное или из кампании по триггеру).

6. **Дублирование парсинга CSV**  
   Логика parseCsvLine/parseCsv есть и в campaign-service, и в crm-service. Разные контракты (campaign: по именам колонок; CRM: mapping по индексам). Имеет смысл вынести в shared и унифицировать контракт/документацию.

7. **Нет явного «исхода» лида в сделку**  
   Нет поля lead_id в deals или связи «сделка создана из лида». Невозможно без доработок строить воронку «лид → сделка» и метрики конверсии лид→сделка.

---

## 6. Предложения по улучшению

1. **Чётко разделить ответственность за смену стадии сделки**  
   - Либо все переходы идут через CRM (PATCH deals/:id/stage), а pipeline только читает и пишет stage_history по событию deal.stage.changed.  
   - Либо один сервис (например pipeline) — единственная точка записи stage_history и обновления deals.stage_id, а CRM проксирует запросы туда.  
   Это устранит расхождение между deals.history и stage_history.

2. **Исправить pipeline PUT clients/:clientId/stage**  
   Проверить наличие client_id в deals; если колонки нет — убрать условие OR client_id = $1 и явно документировать, что clientId в пути = deal_id для смены стадии сделки. При необходимости переименовать путь в /api/pipeline/deals/:dealId/stage.

3. **Опциональное автосоздание сделки при создании лида**  
   Ввести настройку (на уровне воронки или организации): «при добавлении контакта в воронку создавать сделку». Тогда POST /api/pipeline/leads может вызывать внутренний вызов к CRM (или событие), создающий сделку с company_id=null или из контакта, с привязкой lead_id → deal (если добавить lead_id в deals).

4. **Связь Deal с Lead**  
   Добавить в deals опциональное поле lead_id (или source_lead_id). При создании сделки «из лида» заполнять его. Это даст консистентность и аналитику.

5. **Единый CSV-парсер и контракт**  
   Вынести парсинг CSV в shared (или утилиту), описать единый шаблон колонок для кампании и для CRM-импорта (с маппингом по имени или по индексу) в одной документации.

6. **Использование entry_rules или явная модель «правила входа»**  
   Либо реализовать вычисление entry_rules при добавлении в воронку/стадию (pipeline-service), либо убрать поле из схемы и явно описать в документации, что правила входа = только явное добавление + настройки кампании.

7. **Документация и типы**  
   В shared/types добавить тип Lead (сейчас есть Contact, Deal). В CRM_API и CAMPAIGN_COLD_OUTREACH явно описать: Contact vs Lead vs Deal, кто кого создаёт и когда создаётся сделка.

---

## 7. Файлы для дополнительного изучения

- **automation-service** — как срабатывают automation_rules стадий и влияют ли они на лидов/сделки.
- **frontend:** создание сделки из карточки контакта/лида (есть ли кнопка «Создать сделку» из лида и как заполняются pipeline/stage).
- **Миграции после 20241225** — уточнить, добавлялась ли в deals колонка client_id и как она используется.
- **analytics-service** — как считаются конверсии и используются ли stage_history и deals.history.
- **TELEGRAM_MESSAGING_FLOW.md** — как по message.received определяется contactId и как это стыкуется с campaign_participants.

---

*Документ подготовлен по коду и документации проекта; при изменении логики кампаний или воронки целесообразно обновить этот аудит.*
