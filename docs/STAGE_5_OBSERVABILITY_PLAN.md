# ЭТАП 5 — Observability как фича

**Предусловие:** ЭТАП 4 закрыт (event-driven automation, идемпотентность, стресс-тесты). Core работает, документы синхронизированы, архитектура не расползлась.  
**Цель:** не «добавить логи», а оформить наблюдаемость как полноценный этап с контрактом логирования и сквозной трассировкой. Без Prometheus/OpenTelemetry на первом шаге — сначала чистая дисциплина логирования.  
**После ЭТАПА 5:** ЭТАП 6 = DLQ (без логов DLQ бессмысленна — не поймёте, что сломалось).

---

## 0. Зачем это этапом

Большинство команд в этот момент начинают пилить фичи. Правильный следующий шаг — устойчивость. Вы строите не просто CRM, а **event-driven platform с automation ядром**. Если правильно сделать Observability:

- упростится поддержка;
- можно будет масштабировать consumer'ы;
- можно безопасно добавлять новые action types.

---

## 1. Structured logging — как контракт

Не просто «логируем JSON», а:

- описать **обязательные поля**;
- **запретить** `console.log` для бизнес-событий (использовать единый logger);
- **унифицировать формат** во всех сервисах.

### 1.1 Минимальный лог-контракт

Каждая запись лога (для событий automation/CRM/pipeline) — один JSON-объект в stdout. Поля:

| Поле | Тип | Обязательность | Описание |
|------|-----|----------------|----------|
| `timestamp` | string (ISO 8601) | да | Время события |
| `service` | string | да | Имя сервиса (crm-service, pipeline-service, automation-service, …) |
| `level` | string | да | `info` \| `error` \| `warn` |
| `message` | string | да | Краткое человекочитаемое сообщение |
| `correlation_id` | string (UUID) | при наличии | Сквозной идентификатор запроса/события |
| `event_id` | string (UUID) | при consume/publish | ID события RabbitMQ |
| `entity_type` | string | при наличии | lead, deal, … |
| `entity_id` | string (UUID) | при наличии | ID сущности |
| `rule_id` | string (UUID) | при наличии | ID правила automation |
| `status` | string | при действии | success \| skipped \| failed |

**Пример (automation consume):**

```json
{
  "timestamp": "2025-03-03T12:00:00.000Z",
  "service": "automation-service",
  "level": "info",
  "message": "consume lead.stage.changed",
  "correlation_id": "a1b2c3d4-...",
  "event_id": "e5f6g7h8-...",
  "entity_type": "lead",
  "entity_id": "...",
  "rule_id": "...",
  "status": "success"
}
```

Одинаковый формат во **всех** сервисах, участвующих в цепочке (pipeline, automation, crm при приёме запросов с X-Correlation-Id).

### 1.2 Правила

- Для бизнес-событий и трассировки использовать **только** структурированный лог (один вызов logger с объектом). Не использовать `console.log` для событий automation/publish/consume.
- Опционально: вынести общий тип/хелпер в shared (например, `@getsale/utils` или отдельный пакет logger) с сигнатурой `log({ service, level, message, correlation_id, ... })` и выводом `JSON.stringify` в stdout.

---

## 2. Publish / Consume tracing

Явное логирование границ «событие ушло» / «событие пришло» даёт сквозную трассировку без APM.

### 2.1 Pipeline-service (publish)

При публикации `lead.stage.changed` (и при необходимости других событий) логировать **сразу после** успешной отправки в RabbitMQ:

- `message`: `"publish lead.stage.changed"` (или обобщённо `"publish <event.type>"`);
- `event_id`: ID опубликованного события (из объекта event);
- `correlation_id`: из event.data или сгенерировать и положить в event.data для consumer'а;
- `level`: `info`.

Чтобы consumer мог использовать тот же correlation_id, его нужно передать в payload события (например, `event.data.correlationId = event.id` или заголовок, если брокер поддерживает).

### 2.2 Automation-service (consume)

При получении события `lead.stage.changed` логировать **в начале** обработки:

- `message`: `"consume lead.stage.changed"`;
- `event_id`: event.id;
- `correlation_id`: event.data?.correlationId ?? event.id;
- `entity_type`: `"lead"`;
- `entity_id`: event.data?.leadId;
- `level`: `info`.

После обработки (success/skipped/failed) — повторный лог с `status` и при необходимости `rule_id`, `deal_id`.

---

## 3. Correlation Propagation Audit (обязательный шаг)

**Не двигаться дальше, пока audit не подтверждён.** Вы строите систему причинно-следственной прозрачности: когда что-то сломается через месяцы, цепочку можно восстановить за минуты. Если где-то correlation_id теряется или меняется — чинить сейчас.

### 3.1 Как прогнать (прямо сейчас)

1. **Чистый сценарий:** создать новый лид → перевести его в стадию из правила (to_stage_id из seed) → дождаться создания сделки.
2. **Логи automation-service:** найти по `correlation_id`:
   - лог `consume lead.stage.changed`;
   - лог `lead.stage.changed processed` (success/skipped).
   Убедиться: один и тот же `correlation_id` в обоих (и во всех промежуточных логах этого потока).
3. **База данных:**
   - `SELECT correlation_id, trigger_event_id, entity_id, status FROM automation_executions ORDER BY created_at DESC LIMIT 5;` — значение `correlation_id` должно совпадать с логами automation.
   - После внедрения CRM: `SELECT correlation_id, entity_type, entity_id FROM stage_history ...` — тот же correlation_id (пока CRM может не заполнять correlation_id; тогда проверять только automation_executions).
4. **CRM HTTP:** automation передаёт `X-Correlation-Id` в POST /api/crm/deals; после доработки CRM этот id будет записываться в stage_history.correlation_id. На этапе audit достаточно убедиться, что в логах и automation_executions один и тот же correlation_id.

Если всё совпадает — сквозная трассировка работает. Если где-то id другой — исправить до перехода к pipeline publish.

**Автоматическая проверка (сценарий J + метрики):** в E2E-скрипте добавлен сценарий J (ЭТАП 5 — Correlation Propagation Audit) и после него — проверка GET /metrics у каждого сервиса. Запуск при поднятых CRM, Pipeline, RabbitMQ, Automation и выполненном seed 004:

```bash
npm run stage3-e2e
```

Сценарий J: создаётся лид → перевод в стадию правила → проверяется наличие сделки; запрашиваются из БД `automation_executions.correlation_id`, `trigger_event_id`, `status`; проверяется, что correlation_id заполнен и является валидным UUID, status = success или skipped; при наличии записи в `stage_history` с correlation_id проверяется совпадение с automation_executions; проверка цепочки в логах (pipeline publish, automation consume и processed). БД должна быть доступна (DATABASE_URL или localhost:5432).

**Проверка метрик (после J):** скрипт запрашивает GET /metrics у crm-service, pipeline-service и automation-service, проверяет ответ 200 и наличие в теле ожидаемых имён метрик (deal_created_total, deal_stage_changed_total; event_publish_total, event_publish_failed_total; automation_events_total, automation_processed_total, …). При необходимости можно вручную открыть `http://localhost:3002/metrics`, `http://localhost:3008/metrics`, `http://localhost:3009/metrics` и сверить значения счётчиков после прогона сценария J.

### 3.2 Цепочка (для справки)

- **HTTP → event:** запрос PATCH lead stage; при публикации в event.data кладётся correlationId (сейчас automation использует event.id, если data.correlationId нет).
- **Event → consumer:** automation читает event.data.correlationId ?? event.id, пишет в логи и в X-Correlation-Id при вызове CRM.
- **Consumer → CRM:** заголовок X-Correlation-Id.
- **CRM → stage_history:** поле correlation_id из заголовка (если реализовано).
- **automation_executions:** correlation_id и trigger_event_id сохраняются при INSERT.

---

## 4. Базовые метрики (без Prometheus пока)

Даже без Prometheus полезно считать и периодически выводить в лог:

- `events_processed_total` — сколько событий lead.stage.changed обработано;
- `events_success_total` — создана сделка (201);
- `events_skipped_total` — 409 или уже execution есть;
- `events_failed_total` — ошибка вызова CRM или исключение.

Реализация: счётчики в памяти в automation-service + раз в N секунд (например, 60) логировать один structured log с полями `metrics: { events_processed_total, events_success_total, events_skipped_total, events_failed_total }`. Так можно убедиться, что метрики собираются, и позже заменить вывод на экспорт в Prometheus.

---

## 5. Чего сейчас НЕ делать

- **Не внедрять** Prometheus/Grafana на этом этапе.
- **Не внедрять** OpenTelemetry.
- **Не строить** полноценную distributed tracing систему.

Сначала — **чистая дисциплина логирования** и один и тот же контракт во всех сервисах. После этого DLQ и метрики-экспорт будут осмысленны.

---

## 6. Порядок внедрения (не менять)

- [x] **Automation consume** — переведён на structured logging (lead.stage.changed).
- [ ] **Correlation audit** — обязательно прогнать и подтвердить сквозной correlation_id (логи + automation_executions + stage_history + X-Correlation-Id). Не переходить к следующему шагу, пока не подтверждено.
- [ ] **Pipeline publish** — подключить logger, логировать publish lead.stage.changed, гарантированно передавать correlation_id в event.data. Сейчас видно только consume; нужна граница HTTP → publish → consume → CRM; publish — missing link.
- [ ] **CRM** — логирование + запись correlation_id в stage_history из заголовка (если ещё не везде).
- [ ] **Метрики** — счётчики в automation-service + периодический лог.
- [ ] **DLQ** — только после того, как publish переведён и трассировка двусторонняя.

**Важно:** не переходить к метрикам или DLQ, пока pipeline publish не переведён — иначе трассировка остаётся односторонней.

---

## 7. Чек-лист реализации ЭТАПА 5

### Часть 1 — shared logger + automation + audit

- [x] Создать пакет **shared/logger** (`@getsale/logger`).
- [x] Подключить logger в **automation-service** для потока lead.stage.changed.
- [ ] Провести **correlation propagation audit** по §3.1; зафиксировать результат (успех / что поправлено). Закоммитить: «ЭТАП 5 — часть 1 (audit confirmed)».

### План на ближайшие 2 коммита

**Коммит 1:** Провести correlation audit → зафиксировать результат в STAGE_5 (или в отдельном audit-чек-листе) → закоммитить как «ЭТАП 5 — часть 1 (audit confirmed)».

**Коммит 2:** Подключить logger в pipeline-service → логировать publish lead.stage.changed (event_id, correlation_id) → гарантированно передавать correlation_id в event.data (например event.data.correlationId = event.id). После этого можно считать: observability-фундамент заложен.

### Дальше (по одному сервису)

- [x] **Pipeline publish** (Коммит 2).
- [x] **CRM:** логирование + stage_history.correlation_id из заголовка где нужно.
- [x] **ЭТАП 5 часть 4:** Метрики (prom-client), DLQ, Health/Ready.

### ЭТАП 5 — часть 4 (реализовано)

**Метрики (prom-client, GET /metrics):**
- **automation-service:** `automation_events_total` (event_type), `automation_processed_total`, `automation_skipped_total`, `automation_failed_total`, `deal_created_total`, `automation_dlq_total` (event_type).
- **pipeline-service:** `event_publish_total` (event_type), `event_publish_failed_total` (event_type).
- **crm-service:** `deal_created_total`, `deal_stage_changed_total`.

**DLQ:**
- Очередь `lead.stage.changed.dlq`. После 3 неудачных попыток вызова CRM событие публикуется в DLQ (`RabbitMQClient.publishToDlq`), логируется `correlation_id`, инкремент `automation_dlq_total`.

**Health:**
- **automation-service:** GET /ready — проверка RabbitMQ (`isConnected`) и Postgres (`SELECT 1`); 503 при недоступности.
- **crm-service:** GET /ready — проверка Postgres.
- **pipeline-service:** GET /ready — проверка Postgres (RabbitMQ опционально в ответе).

---

## 8. После ЭТАПА 5 — ЭТАП 6 (DLQ)

Когда логирование и трассировка готовы:

- настраивать DLX в RabbitMQ;
- задать max retry и политику «после N неудач → DLQ»;
- при попадании сообщения в DLQ логировать структурированно (event_id, correlation_id, reason).

Без логов DLQ бессмысленна — вы не поймёте, что сломалось.

---

## 9. Связь с другими документами

- **ROADMAP_AFTER_STAGE_4.md** — три направления; Observability — первый. Конкретизация этапа — данный документ.
- **STAGE_4_PLAN.md** — automation (create_deal, идемпотентность); ЭТАП 5 добавляет наблюдаемость поверх него.
- **STAGE_6** (после 5) — DLQ и retry policy.
