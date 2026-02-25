# ЭТАП 4 — План: Automation Engine (автосоздание сделки из лида)

**Статус ЭТАПА 2:** закрыт.  
**Цель ЭТАПА 4:** минимальная рабочая автоматизация — один вертикальный срез: «если лид попал в стадию X → создать сделку». Без UI, без универсального rule-engine, без JSONB-магии. Один seed rule, один сценарий, end-to-end.

---

## 0. Порядок реализации (вертикальный срез)

Не начинать с rule-engine. Порядок:

1. **Подключить consumer к LEAD_STAGE_CHANGED** — подписка, логирование event.id и correlation_id. Пока без правил. Цель: убедиться, что событие стабильно приходит.
2. **Таблица automation_executions под идемпотентность** — колонки organization_id, entity_type, entity_id, deal_id, correlation_id, created_at; **UNIQUE(rule_id, entity_type, entity_id)**. Запись execution только после успешного вызова CRM (или 409); ACK только после записи execution.
3. **Один rule через seed** — trigger_type = `lead.stage.changed`, trigger_conditions = { pipeline_id, to_stage_id }, actions = [{ type: 'create_deal' }].
4. **Обработка события** — найти активные правила по organization_id; match по pipeline_id + to_stage_id; проверить automation_executions; если записи нет — вызвать POST /crm/deals с leadId; 409 считать успехом; записать automation_executions; затем ACK.

**Критично:** ACK только после записи automation_executions. Иначе при падении после создания сделки redelivery приведёт к повторной попытке; unique (rule_id, entity_type, entity_id) + запись до ACK — настоящая идемпотентность.

**MVP:** не разрешать два активных правила на одну и ту же стадию (гонки двух правил → одна сделка).

---

## 0.1 Почему сейчас

- Уже есть `source = manual | automation`, entity abstraction (lead/deal), stage_history, correlation_id, защита от двойной сделки и race.
- Архитектура стабильна, продукт ещё не перегружен фичами — удобный момент для automation.

---

## 1. Шаг 1 — Event-driven автоматизация

**Событие:** `lead.stage.changed` (уже есть в shared/events, публикуется из **pipeline-service** при смене стадии лида).

**Payload события (уже публикуется):** leadId, pipelineId, contactId, fromStageId, toStageId (см. pipeline-service при PATCH lead stage).

**Consumer:** automation-service (уже подписан на часть событий; добавить подписку на `LEAD_STAGE_CHANGED`).

**Требования к consumer:**

- Идемпотентность: повторная доставка или retry не должны создавать вторую сделку.
- Использовать `correlation_id`: при вызове CRM передавать/логировать correlation_id (event.id или свой trace-id), при записи в stage_history (если consumer будет что-то писать) — проставлять correlation_id.
- Не создавать вторую сделку: проверка по leadId перед вызовом или полагаться на 409 от CRM и трактовать 409 как успех.

**Публикатор:** pipeline-service (при PATCH lead stage уже публикует LEAD_STAGE_CHANGED). При необходимости добавить в payload `correlationId` (или event.id) для трассировки.

---

## 2. Шаг 2 — Rule model (минимальный)

Минимальная модель правил для «при переходе лида в стадию X → создать сделку»:

**Вариант A — расширить существующую таблицу `automation_rules`:**

- Уже есть: id, organization_id, name, trigger_type, trigger_conditions (jsonb), actions (jsonb), is_active.
- Для lead→deal: trigger_type = `lead.stage.changed`; в trigger_conditions хранить pipeline_id, to_stage_id (и при необходимости from_stage_id); в actions — `[{ "type": "create_deal" }]`.
- Плюс: один механизм правил. Минус: общая таблица под разные триггеры.

**Схема automation_executions (идемпотентность):**

```
automation_executions
---------------------
id                UUID PK
organization_id   UUID
rule_id           UUID NOT NULL
entity_type       TEXT NOT NULL   -- 'lead' | 'legacy'
entity_id         UUID NOT NULL
deal_id           UUID NULL
status            TEXT NOT NULL
correlation_id    UUID NULL
trigger_event_id  UUID NULL       -- event.id: какой event вызвал эту сделку
created_at        timestamptz NOT NULL

UNIQUE(rule_id, entity_type, entity_id)   -- без partial; entity_* NOT NULL
```

**Чего не делать:** проверка «lead уже Converted» через GET; сложная транзакция через два сервиса; усложнённая retry-логика. CRM уже защищает от дубля (409) — это страховка.

**Где сложность:** (1) Гонки двух правил — если два правила match одному событию, могут создаться две сделки; MVP: не разрешать два активных rule на одну стадию. (2) Повторная доставка — решение: unique (rule_id, entity_type, entity_id) и запись execution до ACK.

---

## 3. Шаг 3 — Идемпотентность

Защита от:

- повторной доставки события (RabbitMQ redelivery);
- retry после частичного выполнения;
- падения consumer после INSERT сделки;
- двойного создания сделки при двух одновременных сообщениях.

**Решения (использовать комбинацию):**

1. **Проверка по leadId:** перед вызовом `POST /api/crm/deals` с leadId проверить (GET deal по lead_id или GET lead и проверка «уже Converted»). Если сделка уже есть — не вызывать API, считать успехом.
2. **409 = успех:** при вызове POST /api/crm/deals с leadId ответ 409 (Conflict) трактовать как «сделка уже создана» и не ретраить, возвращать успех (идемпотентность на стороне API уже есть).
3. **automation_executions:** записывать факт выполнения (rule_id, lead_id, deal_id при успехе, status, event_id/correlation_id). Перед выполнением проверять: уже есть успешная execution для этого rule + lead_id? → skip. Это даёт защиту от повторной обработки одного и того же события.
4. **Уникальность:** в automation_executions можно ввести unique (rule_id, entity_type, entity_id) для «правило + лид», чтобы одна пара правило–лид обрабатывалась один раз (при entity_type='lead', entity_id=leadId).

Итог: проверка «уже есть сделка по lead_id» + запись в automation_executions с (rule_id, lead_id, deal_id|null, status) + 409 как успех. При повторной доставке: по execution видим, что уже обработали, — skip.

---

## 4. Чего не делать сейчас

- **Не делать:** UI rule-builder, сложные DSL, temporal workflows, saga orchestration.
- **Сначала:** минимальная рабочая автоматизация (событие → правила → одно действие create_deal с идемпотентностью).

---

## 5. Чек-лист реализации ЭТАПА 4

- [ ] Pipeline публикует `lead.stage.changed` с нужным payload (уже есть; при необходимости добавить correlationId в data).
- [ ] Automation-service подписан на `LEAD_STAGE_CHANGED`; в processEvent обрабатывать этот тип.
- [ ] Правила: automation_rules с trigger_type = `lead.stage.changed`, trigger_conditions (pipeline_id, to_stage_id), actions `[{ type: 'create_deal' }]`.
- [ ] Вызов POST /api/crm/deals с leadId; 409 обрабатывать как успех.
- [ ] **Порядок:** вызов CRM → при 201/409 → INSERT execution → return (ACK). Не вставлять execution до вызова CRM.
- [ ] **23505 (unique violation):** считать успехом и не бросать exception — иначе redelivery. Два consumer: один 201, другой 409; оба INSERT — второй получит 23505 → treat as success, ACK.
- [ ] В automation_executions хранить trigger_event_id = event.id (какой event вызвал сделку).
- [ ] entity_type и entity_id NOT NULL; обычный UNIQUE(rule_id, entity_type, entity_id) без partial.

---

## 5.1 Финальная проверка перед запуском

1. **Миграции и seed:** `npx knex migrate:latest`, `npx knex seed:run`.
2. **Ручной сценарий:** создать лид → перевести в стадию из правила → в логах automation-service: POST /crm/deals вызван, 201 или 409, execution записан, correlation_id совпадает.
3. **Стресс-тест:** одновременно 10 PATCH стадии одного лида. Ожидание: одна сделка, один execution success, остальные skipped или 23505 (treat as success). Если так — архитектура выдержит прод.

**Автоматический прогон (сценарии H и I):** в том же E2E-скрипте добавлены сценарии ЭТАПА 4. Запуск (CRM, Pipeline, RabbitMQ, Automation подняты; seed 004 выполнен):

```bash
npm run stage3-e2e
```

- **Сценарий H:** лид создаётся в «другой» стадии, переводится в стадию правила → проверяется появление одной сделки по этому лиду и запись в `automation_executions`.
- **Сценарий I:** один лид, 10 параллельных PATCH в стадию правила → проверяется ровно одна сделка и одна запись execution. При недоступном Automation или отсутствии правила lead.stage.changed сценарии H–I пропускаются (skip).

---

## 6. Опционально: observability перед или параллельно ЭТАПУ 4

Если хочется усилить систему до автоматизации:

- Прокинуть correlation_id во все логи (request-scoped).
- Structured logging (JSON с correlation_id, event_id, rule_id).
- Логировать event publish/consume с event.id и correlation_id.
- При записи в stage_history со стороны consumer заполнять reason или отдельное поле trace (например, «automation rule_id=… event_id=…»).

Это «качество», а не «фича», но сильно упростит отладку после внедрения ЭТАПА 4.

---

## 7. Связь с существующими документами

- **STAGE_4_ARCHITECTURE.md** — общая архитектура (событие → consumer → идемпотентное создание); данный план конкретизирует шаги и модель правил.
- **STAGE_2_PLAN.md** — correlation_id в stage_history уже добавлен; использовать в ЭТАПЕ 4 для трассировки.
- **ROADMAP_AFTER_STAGE_4.md** — куда масштабироваться дальше: Observability (structured logging, publish/consume), DLQ, метрики; расширение automation; production readiness.
