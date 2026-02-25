# ЭТАП 2 — План: нормализация stage_history (чистый старт)

**Условие:** проект можно перезапустить с нуля; старые данные не важны; только тестировщики, потоков пользователей нет.  
**Стратегия:** не backfill и не двухфазные миграции, а **чистый старт** — удалить старую таблицу, создать её в финальной форме, обновить код, прогнать e2e.

---

## 0. Почему чистый старт

Сложные миграции нужны, когда есть клиенты, реальные данные, SLA, риски потери истории. В лабораторной стадии рационально:

- **DROP** старую `stage_history`
- **CREATE** таблицу сразу в целевой форме
- Обновить код под новую схему
- Прогнать e2e и забыть про legacy

Без: backfill, unknown-lead, временных колонок, двухфазной миграции. Не будет исторического мусора и «временного кода на 2 года».

---

## 1. Исправление client_id в Pipeline

- В таблице `deals` колонки `client_id` нет (есть только `contact_id`).
- В pipeline-service убрать условие `OR client_id = $1` в запросах к deals; при необходимости переименовать endpoint и оставить deprecated proxy до удаления.

---

## 2. Финальная схема stage_history

Одна таблица для всех переходов стадий (лиды и сделки):

```
stage_history
--------------
id                  UUID, PK
organization_id     UUID, NOT NULL
entity_type         'lead' | 'deal', NOT NULL
entity_id           UUID, NOT NULL
pipeline_id         UUID, NOT NULL
from_stage_id       UUID, nullable
to_stage_id         UUID, NOT NULL
changed_by          UUID, nullable
reason              text, nullable
source              'manual' | 'system' | 'automation', NOT NULL
created_at          timestamptz, NOT NULL
correlation_id      UUID, nullable   -- см. §7 (миграция 20250302000002)
```

**Обязательно:**

- `entity_type` NOT NULL  
- `entity_id` NOT NULL  
- `source` NOT NULL  
- Индекс `(entity_type, entity_id)`  
- Индекс `(pipeline_id, created_at)`

**Семантика source:** сейчас в основном `manual`; позже consumer ЭТАПА 4 → `system`, автоматизации → `automation`. Различать источник нужно сразу.

---

## 3. Миграция (единственный шаг)

1. **DROP TABLE** `stage_history`.
2. **CREATE TABLE** `stage_history` с колонками и индексами выше (см. миграцию в `migrations/`).
3. Дальше — только обновление кода и e2e.

---

## 4. Обновление кода

- **CRM:** при INSERT (конверсия лида и PATCH stage сделки) писать `organization_id`, `entity_type`, `entity_id`, `pipeline_id`, `from_stage_id`, `to_stage_id`, `changed_by`, `reason`, `source`, `created_at`. При DELETE сделки — `WHERE entity_type = 'deal' AND entity_id = :id`.
- **Analytics:** запросы по `entity_type`, `entity_id`, `organization_id`, `created_at`; партиционирование/окна по `(entity_type, entity_id)`, фильтры по `pipeline_id`, `created_at`.

---

## 5. После ЭТАПА 2

Универсальная история даёт базу для: время в стадии, SLA, velocity, funnel drop-off, ретроспектива по `changed_by` и `source`.  

**ЭТАП 2 можно считать закрытым** после выполнения чек-листа §6 (e2e зелёный, race держится, индексы используются, analytics чистый).  

**Дальше — ЭТАП 4 (Automation Engine):** см. **STAGE_4_PLAN.md** и **STAGE_4_ARCHITECTURE.md**.

---

## 6. Чек-лист закрытия ЭТАПА 2

**Не считать ЭТАП 2 закрытым, пока не выполнены все пункты.**

### Как выполнить

1. Применить миграции и прогнать E2E (п. 6.1).
2. Запустить скрипт проверки (выполняет 6.2, 6.3, 6.4 и выводит напоминание по 6.1):

```bash
cd migrations && npx knex migrate:latest
npm run stage3-e2e
npm run stage2-closure
```

Скрипт `stage2-closure` подключается к БД (DATABASE_URL или localhost:5432), выводит последние записи `stage_history`, план запроса по индексу и проверку analytics-service на отсутствие `moved_at`/`client_id`. При отсутствии pg или БД выводит SQL для ручной проверки (6.2, 6.3).

### 6.1 Прогнать E2E после миграции

```bash
cd migrations && npx knex migrate:latest
npm run stage3-e2e
```

Убедиться:

- Сценарии A–G проходят.
- Race (сценарий G) по-прежнему стабилен.
- Conversion считается корректно.
- Нигде не всплывают `moved_at` / `client_id` (ошибки или логи).

Зелёный e2e — первый сигнал, что всё в порядке.

### 6.2 Проверить INSERT в stage_history вручную

После создания сделки с `leadId` выполнить:

```sql
SELECT * FROM stage_history ORDER BY created_at DESC LIMIT 5;
```

Проверить:

- `entity_type = 'lead'`.
- `entity_id = leadId`.
- `source = 'manual'`.
- `pipeline_id`, `organization_id` заполнены.
- `created_at` корректен.

Так подтверждается, что CRM пишет в новую модель.

### 6.3 Проверить использование индекса

```sql
EXPLAIN ANALYZE
SELECT * FROM stage_history
WHERE entity_type = 'lead' AND entity_id = '<любой-uuid-лида>';
```

Должен использоваться индекс `(entity_type, entity_id)`. Если нет — разобрать план и при необходимости поправить индексы.

### 6.4 Проверить analytics-service

- Нет сюрпризов с timezone (все времена в одной зоне или явно учтены).
- В коде нет обращений к `moved_at` или `client_id`.
- Нет join по `client_id`.

**Если все четыре пункта пройдены** — ЭТАП 2 можно официально считать закрытым.

---

## 7. Перед ЭТАПОМ 4: correlation_id

Когда появится consumer (ЭТАП 4), понадобится понимать:

- какая смена стадии породила какую сделку;
- какой consumer вызвал какой INSERT.

Для этого в `stage_history` добавлено поле **`correlation_id`** (nullable): идентификатор запроса или события, с которым связана запись. Сейчас его можно не заполнять или передавать из заголовка `X-Correlation-Id`; в ЭТАПЕ 4 consumer будет проставлять его из `event.id` (или своего trace-id). Сейчас добавить — легко; через полгода — болезненно. См. миграцию `20250302000002_stage_history_correlation_id.ts`.

---

## 8. Когда снова понадобятся сложные миграции

Когда появятся: активные клиенты, нельзя остановить сервис, нельзя потерять историю, юридическая ответственность за данные. До той поры не усложнять.
