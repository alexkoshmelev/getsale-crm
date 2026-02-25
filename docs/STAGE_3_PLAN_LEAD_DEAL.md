# ЭТАП 3 — План: связь Lead → Deal

**Приоритет:** выполнить до ЭТАПА 2 (нормализация stage_history).  
**Зависимости:** ЭТАП 1 завершён (CRM = single source of truth для смены стадии сделки).  
**Статус:** План усилен; реализация после показа финального SQL, контракта и примера события.

---

## 0.1 Подтверждённые решения

- **1.** Модель **1 Lead → 1 Deal** принимается.
- **2.** Backfill для существующих сделок **не выполняем** — lead_id остаётся NULL.
- **3.** Добавление **leadId** в POST /api/crm/deals — принимается.
- **4.** Уникальность: использовать **partial unique index** (см. §3), а не обычный UNIQUE(lead_id).
- **5.** При создании сделки с **leadId** — **строгая консистентность** с лидом (см. §4.1).
- **6.** ЭТАП 4: защита от race/double creation (транзакция или обработка unique violation) — зафиксировать при реализации ЭТАПА 4.
- **7.** Multi-tenant: проверка **lead.organization_id** в API при любом использовании leadId обязательна (БД не защищает от cross-tenant).
- **8.** При leadId: **pipelineId и contactId берутся из лида**; если переданы в body — проверяем совпадение; без leadId pipelineId обязателен.
- **9.** Жизненный цикл лида при создании сделки: **вариант B** — в одной транзакции создаётся deal, лид переводится в стадию **Converted**, пишется stage_history лида; после коммита публикуется **lead.converted** (leadId, dealId, pipelineId, convertedAt). Converted — финальная системная стадия, переходы из неё запрещены.

---

## 0. Порядок этапов (подтверждённое изменение)

| Порядок | Этап | Содержание |
|--------|------|------------|
| 1 | ЭТАП 1 | Single source of truth для смены стадии сделки (CRM) — **выполнен** |
| 2 | **ЭТАП 3** | **Связь Lead → Deal** — **реализован** |
| 3 | Стабилизация | Ручная проверка по чек-листу: **docs/STAGE_3_MANUAL_TEST_CHECKLIST.md** |
| 4 | ЭТАП 2 | Нормализация stage_history (entity_type + entity_id): **docs/STAGE_2_PLAN.md** |
| 5 | ЭТАП 4 | Опциональное автосоздание сделки при создании лида |

**Почему ЭТАП 2 до ЭТАПА 4:**  
Сначала стабилизировать конверсию и события, затем привести в порядок stage_history. Если добавить автосоздание до нормализации истории, миграция stage_history усложнится. ЭТАП 2 выполнять после прогона сценариев A–D (см. чек-лист).

---

## 1. Проблема

Сейчас:
- **Contact** — человек в базе (contacts).
- **Lead** — факт нахождения контакта в pipeline (leads: contact_id, pipeline_id, stage_id).
- **Deal** — коммерческая сущность (deals: company_id, contact_id?, pipeline_id, stage_id).

Связи Lead ↔ Deal **нет**: нельзя однозначно сказать, какая сделка выросла из какого лида. Это блокирует:
- конверсию «лид → сделка»;
- аналитику и отчёты по воронке;
- автоматизации вида «если лид стал сделкой»;
- ЭТАП 4 (автосоздание сделки из лида с заполнением lead_id).

---

## 2. Архитектурное решение: 1 Lead → 1 Deal

### 2.1 Варианты

| Вариант | Смысл | Плюсы | Минусы |
|---------|--------|--------|--------|
| **A. 1 Lead → 1 Deal** | Один лид (вхождение в воронку) даёт максимум одну сделку. Вторая сделка по тому же контакту = новый лид. | Простая модель, чистая аналитика конверсии, однозначные автоматизации. | Нельзя явно завести несколько сделок «из одного лида» без нового лида. |
| **B. 1 Lead → N Deals** | Один лид может быть связан с несколькими сделками. | Гибко для сценариев «один контакт — много сделок». | Сложнее конверсия (что считать «первой сделкой»?), размытая семантика лида. |

### 2.2 Рекомендация: 1 Lead → 1 Deal

- **Lead** = вхождение контакта в pipeline (один раз на пару contact + pipeline).
- **Deal** = реализация этого лида в коммерческую сделку.
- Новая сделка по тому же контакту/воронке = новый лид (новое вхождение в воронку или новая запись в leads при необходимости).

Итог:
- В БД: у сделки опциональное поле **lead_id** (FK → leads.id).
- Ограничение: **один лид может быть привязан не более чем к одной сделке** — через **partial unique index** по lead_id WHERE lead_id IS NOT NULL (явная семантика, без edge-case с NULL).

Это даёт:
- однозначную конверсию «лид → сделка»;
- простую аналитику и автоматизации;
- ЭТАП 4: при автосоздании сделки из лида заполняем deal.lead_id и не создаём дубликаты связи.

---

## 3. Схема миграции

### 3.1 Изменения в БД

- Таблица **deals**:
  - Добавить колонку **lead_id** (UUID, nullable, FK → leads.id, ON DELETE SET NULL).
  - Добавить индекс по **lead_id** (для джойнов и проверок).
  - Добавить **partial unique index** — один лид не более чем у одной сделки, семантика явная:
    `CREATE UNIQUE INDEX deals_lead_id_unique ON deals (lead_id) WHERE lead_id IS NOT NULL;`

**Multi-tenant безопасность:** FK ссылается только на leads(id); в индексе нет organization_id. Защита от cross-tenant привязки (deal из org A к lead из org B) **обязательна на уровне API**: при любом использовании leadId проверять `lead.organization_id = user.organizationId`. В коде эта проверка должна быть явной и не пропускаемой. Опциональное усиление в будущем: composite FK `(lead_id, organization_id) REFERENCES leads(id, organization_id)` — потребует composite unique на leads(id, organization_id).

### 3.2 Финальный SQL миграции

```sql
-- up
ALTER TABLE deals
  ADD COLUMN lead_id UUID NULL
  REFERENCES leads(id) ON DELETE SET NULL;

CREATE INDEX idx_deals_lead_id ON deals (lead_id);

CREATE UNIQUE INDEX deals_lead_id_unique
  ON deals (lead_id)
  WHERE lead_id IS NOT NULL;

-- down
DROP INDEX IF EXISTS deals_lead_id_unique;
DROP INDEX IF EXISTS idx_deals_lead_id;
ALTER TABLE deals DROP COLUMN IF EXISTS lead_id;
```

### 3.3 Миграция (Knex)

Knex не поддерживает partial unique index «из коробки», поэтому в миграции использовать **raw**:

```ts
// up
await knex.schema.alterTable('deals', (table) => {
  table.uuid('lead_id').nullable().references('id').inTable('leads').onDelete('SET NULL');
  table.index('lead_id');
});
await knex.raw('CREATE UNIQUE INDEX deals_lead_id_unique ON deals (lead_id) WHERE lead_id IS NOT NULL');

// down
await knex.raw('DROP INDEX IF EXISTS deals_lead_id_unique');
await knex.schema.alterTable('deals', (table) => {
  table.dropIndex('lead_id');
  table.dropColumn('lead_id');
});
```

### 3.4 Backfill (существующие сделки)

**Рекомендация: не заполнять lead_id для старых сделок автоматически.**

Причины:
- Нет однозначного соответствия: у одного контакта в одной воронке могла быть одна запись в leads и несколько сделок (сейчас связи не было).
- Backfill «по (contact_id, pipeline_id)» привязал бы одну сделку к лиду и оставил бы остальные без lead_id или создал бы неоднозначность (какую сделку считать «от» этого лида).
- Старые данные остаются с **lead_id = NULL** = «сделка не привязана к лиду». Новая логика (создание сделки из лида, ЭТАП 4) будет проставлять lead_id только для новых кейсов.

**Опциональный точечный backfill (если понадобится позже):**  
Для сделок с заполненными contact_id и pipeline_id можно один раз выполнить: «найти лид по (contact_id, pipeline_id, organization_id) и, если у этого лида ещё нет сделки (по новому unique), проставить deal.lead_id». Делать только при явном решении продукта и с ручным контролем.

---

## 4. API и валидация

### 4.1 Создание сделки (POST /api/crm/deals)

- Добавить в body опциональное поле **leadId** (UUID).

**Правило по полям pipelineId и contactId:**
- **Если передан leadId:** pipelineId и contactId **берутся из лида**. Если они при этом переданы в body — проверяем на совпадение с лидом; при несовпадении — **400** («pipelineId must match lead's pipeline» / «contactId must match lead's contact»). Иначе подставляем из лида и не требуем их в body (т.е. при leadId они фактически необязательны).
- **Если leadId не передан:** pipelineId обязателен (как сейчас, с учётом fromChat/fromContactOnly); contactId по текущим правилам.

Валидация при переданном **leadId** (обязательная):
1. **Multi-tenant:** лид существует и принадлежит организации: `SELECT contact_id, pipeline_id, organization_id FROM leads WHERE id = $1 AND organization_id = $2`. Иначе 404. Проверка organization_id обязательна и не должна пропускаться.
2. У лида ещё нет сделки: `SELECT 1 FROM deals WHERE lead_id = $1` → если есть, **409 Conflict** «This lead is already linked to a deal».
3. Если в body есть pipelineId или contactId — они должны совпадать с полями лида; иначе 400.
4. При INSERT: contact_id и pipeline_id сделки устанавливать из лида (если не переданы — из лида; если переданы — уже провалидированы).

Обратная совместимость: без leadId поведение как сейчас; с leadId — жёсткая привязка к данным лида.

### 4.2 Обновление сделки (PUT /api/crm/deals/:id)

- Опционально: разрешить установку/сброс **leadId** (например, только если у лида ещё нет другой сделки).  
  Для ЭТАПА 3 минимум — только создание с leadId; обновление можно добавить позже.

### 4.3 Чтение (GET deal, список)

- В ответ включать **leadId** (или **lead_id**), если есть в БД.

---

## 5. Типы (shared/types)

- В интерфейс **Deal** добавить **leadId?: string | null**.
- При необходимости отдельный тип для создания: **DealCreate** с опциональным **leadId**.

---

## 6. Обновлённая диаграмма: Contact → Lead → Deal

```text
                    ┌─────────────────────────────────────────────────────────────────┐
                    │                     Organization                                 │
                    └─────────────────────────────────────────────────────────────────┘
                                              │
         ┌────────────────────────────────────┼────────────────────────────────────┐
         │                                    │                                      │
         ▼                                    ▼                                      ▼
┌─────────────────┐                 ┌─────────────────┐                    ┌─────────────────┐
│    Contact      │                 │      Lead       │                    │      Deal       │
│  (contacts)     │                 │    (leads)      │                    │    (deals)      │
├─────────────────┤                 ├─────────────────┤                    ├─────────────────┤
│ id              │◄────────────────│ contact_id (FK) │                    │ id              │
│ organization_id │                 │ pipeline_id     │                    │ organization_id│
│ company_id?     │                 │ stage_id        │                    │ company_id     │
│ first_name      │                 │ order_index     │                    │ contact_id? (FK)│
│ last_name       │                 │ responsible_id? │                    │ pipeline_id     │
│ email, phone    │                 │ id (PK)         │───────────────────►│ stage_id        │
│ telegram_id     │                 └─────────────────┘     lead_id (FK)   │ lead_id? (FK)   │
└─────────────────┘                          │             (1 : 1)        │ owner_id        │
         │                                    │                            │ title, value   │
         │                                    │ UNIQUE(contact_id,         │ history         │
         │                                    │        pipeline_id)        └─────────────────┘
         │                                    │
         └────────────────────────────────────┘
              Один контакт в одной воронке = один лид (одна запись в leads).

Связи:
  • Contact 1 ── N Lead    (один контакт может быть лидом в разных воронках)
  • Lead 1 ── 0..1 Deal   (один лид — не более одной сделки; deal.lead_id уникален)
  • Contact 1 ── N Deal   (у контакта может быть много сделок; у части сделок lead_id = NULL)
```

Кратко:
- **Contact** — человек в базе.
- **Lead** — контакт в воронке (одна запись на пару contact + pipeline).
- **Deal** — коммерческая сущность; опционально привязана к одному лиду через **lead_id** (1 Lead → 1 Deal).

---

## 7. Event и подписчики

- При создании сделки с **leadId** в **deal.created** можно добавить в data поле **leadId** (опционально), чтобы подписчики (аналитика, автоматизации) могли строить сценарии «лид стал сделкой».
- Обратная совместимость: старые подписчики игнорируют новое поле.

---

## 8. Защита от дублирования (1 Lead → 1 Deal)

- В БД: **partial unique index** `deals_lead_id_unique` ON deals(lead_id) WHERE lead_id IS NOT NULL.
- В API при POST /api/crm/deals с leadId: до вставки проверить `SELECT 1 FROM deals WHERE lead_id = $1`; если есть — 409 Conflict «This lead is already linked to a deal».
- **ЭТАП 4 (автосоздание сделки при создании лида):** защита от race/double creation — вставку сделки выполнять в транзакции и/или обрабатывать unique constraint violation (повторный запрос на создание сделки для того же лида → идемпотентный ответ или 409).

---

## 9. Жизненный цикл лида при создании сделки — вариант B (утверждён)

**Решение:** при создании сделки с **leadId** лид переводится в системную финальную стадию **Converted** в одной транзакции с созданием сделки; публикуется доменное событие **lead.converted**.

### 9.1 Почему не A и не C

- **Не A (ничего не менять):** лид остаётся в активной воронке → конверсия считается некорректно, автоматизации и UI путают, архитектурный разрыв «лид В работе / сделка Negotiation».
- **Не C (архивировать/удалять):** удаление ломает аналитику и историю; архивация усложняет модель без необходимости.

### 9.2 Правила стадии Converted

- **Системная:** зарезервированное имя стадии (например `Converted`), семантика «лид конвертирован в сделку».
- **Финальная:** из неё **не допускаются переходы** (при попытке перевести лида из Converted в другую стадию — 400 или игнорирование; проверка в pipeline-service при PATCH /api/pipeline/leads/:id).
- **Одна на воронку:** у каждого pipeline должна быть ровно одна стадия с именем `Converted` (или с системным флагом), используемая при конверсии лида.

### 9.3 Создание и обнаружение стадии Converted

- **Существующие воронки:** миграция добавляет стадию `Converted` во все существующие pipelines (например `order_index = MAX(order_index)+1` по pipeline, имя `'Converted'`, цвет/метаданные — фиксированные).
- **Новые воронки:** при создании pipeline (POST /api/pipeline) в список стадий по умолчанию включается стадия `Converted` (последней).
- **При создании сделки с leadId:** в коде находится стадия Converted воронки лида: `SELECT id FROM stages WHERE pipeline_id = $1 AND organization_id = $2 AND name = 'Converted' LIMIT 1`. Если не найдена — 400 «Pipeline must have a Converted stage» (или создание стадии on-the-fly по решению продукта; по умолчанию — требовать наличие).

### 9.4 Транзакция (обязательно)

Операции выполняются **в одной транзакции** (один BEGIN/COMMIT в CRM или общая координация):

1. INSERT deal (с lead_id, contact_id, pipeline_id из лида).
2. UPDATE leads SET stage_id = &lt;converted_stage_id&gt;, updated_at = NOW() WHERE id = &lt;leadId&gt;.
3. INSERT в stage_history для лида: client_id = lead.contact_id, deal_id = NULL, from_stage_id = текущая стадия лида, to_stage_id = Converted, moved_by, reason = 'Converted to deal'.

При любой ошибке — ROLLBACK; событие **lead.converted** публикуется **только после успешного COMMIT** (вне транзакции или после commit).

### 9.5 Доменное событие lead.converted

Публиковать **lead.converted** (не только lead.stage.changed), чтобы явно обозначить бизнес-событие «лид стал сделкой».

**Тип события:** `lead.converted` (добавить в shared/events, например `LEAD_CONVERTED = 'lead.converted'`).

**Пример payload:**

```json
{
  "id": "event-uuid",
  "type": "lead.converted",
  "timestamp": "2025-02-23T14:00:00.000Z",
  "organizationId": "org-uuid",
  "userId": "user-uuid",
  "data": {
    "leadId": "lead-uuid",
    "dealId": "deal-uuid",
    "pipelineId": "pipeline-uuid",
    "convertedAt": "2025-02-23T14:00:00.000Z"
  }
}
```

Это даёт возможность строить аналитику (время до сделки, % конверсии), запускать автоматизации по «лид сконвертирован» и не зависеть от имени стадии в логике.

### 9.6 Итоговая последовательность при POST /api/crm/deals с leadId

1. Валидация (лид в организации, нет сделки по лиду, совпадение contact_id/pipeline_id).
2. Разрешить стадию Converted для pipeline лида; при отсутствии — 400.
3. BEGIN.
4. INSERT deal (в т.ч. lead_id).
5. UPDATE leads SET stage_id = &lt;converted_stage_id&gt; WHERE id = &lt;leadId&gt;.
6. INSERT stage_history (lead transition: client_id = contact_id лида, deal_id = NULL, from/to, moved_by, reason).
7. COMMIT.
8. Publish deal.created (с leadId в data).
9. Publish lead.converted (leadId, dealId, pipelineId, convertedAt).

---

## 10. Критерии готовности ЭТАПА 3

- [x] Миграция: в deals добавлены lead_id (nullable FK), индекс, partial unique index deals_lead_id_unique.
- [x] Миграция или обновление pipeline: стадия **Converted** присутствует во всех воронках (миграция 20250301000002; при создании новой воронки — в DEFAULT_STAGES).
- [x] POST /api/crm/deals с leadId: валидация лида, отсутствия другой сделки, строгая консистентность; **в одной транзакции**: INSERT deal, UPDATE lead → stage_id = Converted, INSERT stage_history для лида; после COMMIT — публикация deal.created и **lead.converted**.
- [x] GET deal(s) возвращает leadId в ответе.
- [x] Типы (shared/types) обновлены: Deal.leadId.
- [x] Событие **lead.converted** добавлено в shared/events; payload: leadId, dealId, pipelineId, convertedAt.
- [x] Pipeline: переход лида **из** стадии Converted запрещён (400 при PATCH lead stage).
- [x] Документация (CRM_API) обновлена: связь Lead → Deal, 1:1, конверсия в Converted, lead.converted.
- [x] Обратная совместимость: создание сделки без leadId не меняется; существующие сделки с lead_id = NULL.

---

## 11. Что не делать в ЭТАПЕ 3

- Не менять stage_history (это ЭТАП 2).
- Не реализовывать автосоздание сделки при создании лида (это ЭТАП 4).
- Не добавлять обратное поле в leads (например lead.deal_id) — достаточно FK со стороны deals.

---

## 12. Перед началом реализации (чек-лист)

Ниже — финальные артефакты; после их утверждения можно переходить к коду.

### 12.1 Финальный SQL миграции

См. **§3.2** — добавление колонки `lead_id`, индекс `idx_deals_lead_id`, partial unique index `deals_lead_id_unique`.

### 12.2 Обновлённый контракт POST /api/crm/deals

| Поле (body) | Тип | Обязательность | Описание |
|-------------|-----|----------------|----------|
| companyId | UUID | опц. (см. refine) | Как сейчас |
| contactId | UUID | опц. | **При leadId:** игнорируется как источник — берётся из лида; если передан — должен совпадать с lead.contact_id, иначе 400. **Без leadId:** по текущим правилам |
| pipelineId | UUID | см. ниже | **При leadId:** необязателен — берётся из лида; если передан — должен совпадать с lead.pipeline_id, иначе 400. **Без leadId:** обязателен (кроме fromChat/fromContactOnly) |
| stageId | UUID | опц. | Как сейчас (первая стадия по умолчанию) |
| **leadId** | **UUID** | **опц.** | Если передан: лид в организации, у лида нет сделки; contact_id и pipeline_id сделки = из лида (при несовпадении переданных — 400) |
| title | string | обяз. | Как сейчас |
| value, currency, probability, expectedCloseDate, comments | — | опц. | Как сейчас |
| bdAccountId, channel, channelId | — | опц. (для fromChat) | Как сейчас |

**Ответ:** 201 + объект сделки (в т.ч. **lead_id**).  
**Ошибки:** 400 (валидация, несовпадение с лидом), 404 (лид не найден или не в организации), 409 (у лида уже есть сделка).

### 12.3 Пример события deal.created с leadId

```json
{
  "id": "event-uuid",
  "type": "deal.created",
  "timestamp": "2025-02-23T14:00:00.000Z",
  "organizationId": "org-uuid",
  "userId": "user-uuid",
  "data": {
    "dealId": "deal-uuid",
    "pipelineId": "pipeline-uuid",
    "stageId": "stage-uuid",
    "leadId": "lead-uuid"
  }
}
```

Поле **leadId** в data — опциональное; добавляется только при создании сделки с привязкой к лиду. Подписчики могут использовать его для сценариев «лид стал сделкой».

### 12.4 Событие lead.converted (при создании сделки с leadId)

Публикуется **после успешного COMMIT** транзакции (создание deal + перевод лида в Converted + stage_history). См. **§9.5** — тип `lead.converted`, data: leadId, dealId, pipelineId, convertedAt.

---

**Статус:** Вариант B по §9 утверждён (Converted, транзакция, lead.converted). Утверждены §12 (SQL, контракт, пример события). **Можно приступать к реализации ЭТАПА 3.**
