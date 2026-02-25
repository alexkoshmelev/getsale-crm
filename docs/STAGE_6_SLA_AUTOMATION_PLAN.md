# ЭТАП 6 — SLA Automation (план)

**Предусловие:** ЭТАП 5 закрыт (observability, метрики, DLQ, health). Backend event-driven, идемпотентность и correlation на месте.  
**Цель:** триггеры по времени в стадии — «лид в стадии X больше N дней» / «сделка в стадии Y больше M дней» → уведомление, задача и т.д. Без отдельной системы правил: SLA как ещё один `trigger_type` в `automation_rules`, один движок, одна модель исполнений.

**Оценка:** 3–5 дней.

---

## 0. Design Lock (зафиксировано перед реализацией)

Три решения зафиксированы окончательно.

**1. Как считаем и храним breach_date**

- Считаем «текущую дату» в **org timezone** (или UTC, если у организации timezone не задан).
- Храним **breach_date** как **DATE** — логический день нарушения в org TZ. Без конвертаций в «полночь UTC», без timestamp.
- **DATE = логический день организации.** Это упрощает идемпотентность и запросы.

**2. Уникальность для SLA — только partial unique index**

- Использовать единственный вариант:
  ```sql
  CREATE UNIQUE INDEX automation_sla_unique
  ON automation_executions(rule_id, entity_type, entity_id, breach_date)
  WHERE breach_date IS NOT NULL;
  ```
- Существующий unique для non-SLA правил (без breach_date) остаётся без изменений.
- Вариант с COALESCE не использовать — ухудшает читаемость.

**3. Где проверять «уже обработан сегодня»**

- **Не проверять заранее.** Cron не фильтрует «уже есть execution на эту breach_date» перед публикацией.
- Последовательность: публикуем событие → consumer обрабатывает → при INSERT в automation_executions ловим **23505** (unique violation) → считаем «already processed» → ACK.
- Так проще и безопаснее при гонках (один источник истины — уникальный индекс).

---

## 1. Цель

- Дать продукту ценность «CRM управляет процессом продаж», а не только хранит сделки.
- Первый шаг к «умной CRM» и базе для AI scoring.
- Не ломать архитектуру: SLA — это просто ещё один триггер, cron — «виртуальный publisher».

**Примеры правил:**
- Если лид в стадии «Contacted» > 3 дней → уведомить команду.
- Если сделка в стадии «Proposal» > 7 дней → создать задачу.

---

## 2. Архитектурное решение: Вариант A (расширение automation_rules)

**Не делать:** отдельную таблицу `sla_rules` и параллельную систему правил.

**Делать:** расширение существующей модели.

- Новые `trigger_type`:
  - `lead.sla.breach`
  - `deal.sla.breach`
- В `trigger_conditions` для SLA хранить, например: `{ pipeline_id, stage_id, max_days }` (или `stage_id` + `max_days` при одном pipeline).
- **Cron** в automation-service раз в период (например, раз в час) выбирает лиды/сделки, превысившие порог, и **публикует внутренние события** `lead.sla.breach` / `deal.sla.breach`.
- Дальше всё идёт через тот же pipeline: подписка на события → выбор правил по `trigger_type` и `trigger_conditions` → выполнение actions → запись в `automation_executions`. Никакой новой логики движка.

---

## 3. Event contract

События публикуются в тот же exchange `events` (или внутренняя очередь), чтобы consumer automation-service обрабатывал их так же, как `lead.stage.changed`.

### 3.1 `lead.sla.breach`

- **Тип события:** `EventType.LEAD_SLA_BREACH = 'lead.sla.breach'` (добавить в shared/events).
- **Payload (data):**
  - `leadId: string`
  - `pipelineId: string`
  - `stageId: string`
  - `organizationId: string`
  - `contactId?: string`
  - `daysInStage: number`
  - `breachDate: string` (ISO date YYYY-MM-DD — логический день в org TZ, см. раздел 5).
  - `correlationId: string` (event.id или отдельный UUID для трассировки).

### 3.2 `deal.sla.breach`

- **Тип события:** `EventType.DEAL_SLA_BREACH = 'deal.sla.breach'`.
- **Payload (data):**
  - `dealId: string`
  - `pipelineId: string`
  - `stageId: string`
  - `organizationId: string`
  - `daysInStage: number`
  - `breachDate: string` (ISO date YYYY-MM-DD — логический день в org TZ)
  - `correlationId: string`

Публикатор: cron в automation-service (не отдельный сервис). События публикуются в RabbitMQ в тот же exchange `events` с соответствующим routing key; consumer подписывается на `lead.stage.changed`, `lead.sla.breach`, `deal.sla.breach`.  
*(В коде уже есть заготовка cron для `time_elapsed` по сделкам; ЭТАП 6 унифицирует подход через события и два новых trigger_type с идемпотентностью по breach_date.)*

---

## 4. Idempotency strategy

Проблема: если лид просрочен 5 дней, cron при каждом запуске будет видеть его снова. Без ограничения по «дню» будет дубли действий.

**Решение:** уникальность по **(rule_id, entity_type, entity_id, breach_date)** (Design Lock §0).

- В БД: колонка **`breach_date`** (DATE, nullable). Для не-SLA правил — NULL.
- **Partial unique index (единственный вариант):**
  ```sql
  CREATE UNIQUE INDEX automation_sla_unique
  ON automation_executions(rule_id, entity_type, entity_id, breach_date)
  WHERE breach_date IS NOT NULL;
  ```
- Текущий unique для правил без breach_date не меняем.

**Логика в коде:** не проверять «уже обработан за этот день» до публикации. Cron публикует все подходящие сущности; consumer при INSERT execution получает 23505 при повторной обработке того же (rule, entity, breach_date) → считаем «already processed», не повторяем action, ACK. Один источник истины — индекс.

---

## 5. Timezone handling (Design Lock)

**Зафиксировано:** не усложнять с timestamp и «полночью в UTC».

- **Текущая дата** считается в **org timezone** (если есть `organizations.timezone`; иначе UTC).
- **breach_date** в БД и в payload события — **DATE** этого логического дня (год-месяц-день в org TZ). Без конвертаций в «полночь UTC», без отдельного timestamp.
- В коде: `now` → перевести в org TZ → взять дату (YYYY-MM-DD) → сохранять как DATE. Идемпотентность «один раз в день» привязана к этой дате.

**Организация без timezone:** при отсутствии `organizations.timezone` использовать UTC для расчёта «текущей даты». Опционально: миграция ЭТАП 6 добавляет `organizations.timezone` (VARCHAR(50), default `'UTC'`).

---

## 6. Cron strategy (batch, limit, индексы)

- **Расписание:** например, раз в час (`0 * * * *`), при необходимости — раз в 15 минут для более быстрой реакции.
- **Выборка лидов:** например, `WHERE pipeline_id = $1 AND stage_id = $2 AND organization_id = $3 AND updated_at < (now_in_org_tz - max_days * interval '1 day')` (логика: «в стадии с момента updated_at дольше max_days»). Учитывать timezone: сравнивать с «сейчас минус N дней» в org TZ.
- **Batch:** не тянуть все подходящие строки разом. LIMIT (например, 100–500 за один запуск по одному правилу), обрабатывать батчами; при следующем запуске cron снова выберет ещё не обработанные (идемпотентность по breach_date не даст дублей).
- **Индексы:** для быстрой выборки «лиды/сделки в стадии X, обновлённые раньше T»:
  - `leads`: индекс по `(pipeline_id, stage_id, organization_id, updated_at)`.
  - `deals`: индекс по `(pipeline_id, stage_id, organization_id, updated_at)` (или уже есть подходящий составной индекс).
- **Не фильтровать по «уже обработан»** перед публикацией (Design Lock §0.3): cron публикует все подходящие сущности; дубли по тому же breach_date обрабатываются в consumer (23505 → already processed, ACK).

---

## 7. Performance considerations

- Один cron-job на инстанс automation-service; при нескольких репликах — один активный (leader) или распределённая блокировка по правилам, чтобы не дублировать публикации. MVP: один инстанс.
- Количество правил SLA × batch size — объём запросов к БД и сообщений в очередь за один запуск. Держать batch разумным (например, 100–200 на правило).
- Логирование и метрики: см. раздел **Метрики SLA** ниже.

---

## 8. Метрики SLA

Чтобы понимать нагрузку и сбои по SLA, ввести счётчики (prom-client, как в ЭТАП 5):

| Метрика | Описание |
|--------|----------|
| `automation_sla_published_total` | События lead.sla.breach / deal.sla.breach, опубликованные cron (labels: event_type). |
| `automation_sla_processed_total` | SLA-события успешно обработаны (action выполнен, execution записан). |
| `automation_sla_skipped_total` | SLA-события пропущены (23505 — уже обработан на эту breach_date). |

Без этих метрик будет трудно оценивать объём и поведение SLA в проде.

---

## 9. Migration plan

1. **shared/events:** добавить `LEAD_SLA_BREACH`, `DEAL_SLA_BREACH` в enum и типы payload.
2. **База:**
   - Добавить `automation_executions.breach_date` (DATE NULL).
   - Создать partial unique index `automation_sla_unique` (rule_id, entity_type, entity_id, breach_date) WHERE breach_date IS NOT NULL. Существующий unique для non-SLA не трогать.
3. **Опционально:** добавить `organizations.timezone` (VARCHAR(50), default 'UTC').
4. **automation-service:**
   - Подписка на `LEAD_SLA_BREACH`, `DEAL_SLA_BREACH`.
   - Обработчик: матч по trigger_type и trigger_conditions; выполнение actions; INSERT execution с breach_date; при 23505 — «already processed», ACK. Метрики: processed/skipped.
   - Cron: выборка активных SLA-правил; по каждому правилу — выборка лидов/deals (batch + limit); для каждой сущности — breach_date = текущая дата в org TZ (Design Lock §5); публикация события в RabbitMQ. Метрика: sla_published_total.
5. **Actions:** переиспользовать существующие (notify_team, create_task, move_to_stage и т.д.).

---

## 10. Чеклист задач

- [ ] Добавить в shared/events: `LEAD_SLA_BREACH`, `DEAL_SLA_BREACH` и типы данных события.
- [ ] Миграция: `automation_executions.breach_date` (DATE NULL); partial unique index `automation_sla_unique` (Design Lock §0.2).
- [ ] Миграция (опционально): `organizations.timezone` (default 'UTC').
- [ ] Индексы: leads/deals по (pipeline_id, stage_id, organization_id, updated_at) при необходимости.
- [ ] automation-service: подписка на lead.sla.breach, deal.sla.breach; обработчик с идемпотентностью по breach_date (23505 → skipped).
- [ ] automation-service: cron — выборка SLA-правил и сущностей, breach_date = дата в org TZ (Design Lock §0.1), публикация событий без предварительной проверки «уже обработан».
- [ ] Метрики SLA: `automation_sla_published_total`, `automation_sla_processed_total`, `automation_sla_skipped_total`.
- [ ] Ручное тестирование: правило lead.sla.breach / deal.sla.breach, лид/сделка с updated_at в прошлом, одно исполнение в день, при повторной доставке — 23505 и skip.

---

## 11. Связь с другими документами

- **STAGE_4_PLAN.md** — модель automation_rules, automation_executions, идемпотентность по (rule_id, entity_type, entity_id).
- **STAGE_5_OBSERVABILITY_PLAN.md** — логи, correlation, метрики; SLA события проходят тот же контур.
- **ROADMAP_AFTER_STAGE_4.md** — ЭТАП 6 как следующий продуктовый шаг после observability.

---

**Итог:** SLA встраивается в существующую event-driven архитектуру как новые типы триггеров и событий. Design Lock (§0) фиксирует: breach_date = DATE (логический день в org TZ), только partial unique index для SLA, проверка «уже обработан» только по 23505 при INSERT. Реализация — по Migration plan (§9) и чеклисту (§10).
