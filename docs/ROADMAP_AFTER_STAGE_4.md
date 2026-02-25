# Roadmap после ЭТАПА 4 — куда масштабироваться

**Текущее состояние:** event-driven CRM с идемпотентной автоматизацией. E2E зелёный, race держится, automation выдерживает 10 PATCH. Это уже production-grade core, не прототип. Вопрос не «чинить», а куда масштабироваться.

**Конкретный следующий шаг:** реализовать **ЭТАП 5 = Observability** по плану **STAGE_5_OBSERVABILITY_PLAN.md** (structured logging, publish/consume tracing, correlation audit, базовые метрики). Только после этого переходить к ЭТАПУ 6 (DLQ).

---

## 0. Где вы находитесь сейчас

- CRM API с защитой от дублей (409, unique lead_id)
- Pipeline с доменными событиями (lead.stage.changed и др.)
- Automation-service: event-driven, идемпотентный (UNIQUE rule_id + entity_type + entity_id), 23505 = success + ACK
- stage_history с correlation_id, source (manual/system/automation)
- automation_executions с trigger_event_id, UNIQUE
- E2E + стресс-тесты

---

## 1. Три направления (стратегически правильный порядок)

### 1.1 Направление №1 — Observability (правильный следующий шаг)

**Почему первым:** автоматизация без наблюдаемости через 3 месяца превращается в неразбираемый поток. correlation_id уже прокинут — следующий шаг сделать систему наблюдаемой.

**Что добавить:**

1. **Structured logging (везде)**  
   Во всех сервисах единый формат, например:
   ```json
   {
     "service": "automation-service",
     "correlation_id": "...",
     "event_id": "...",
     "rule_id": "...",
     "entity_id": "...",
     "status": "success"
   }
   ```
   Это спасёт при разборе инцидентов через полгода.

2. **Логирование publish/consume**  
   - В pipeline-service при публикации `lead.stage.changed`: event_id, correlation_id.  
   - В automation-service при consume: event_id, correlation_id.  
   Must-have перед ростом нагрузки.

3. **Проверить timestamptz**  
   Убедиться, что `created_at` (и аналоги) везде `TIMESTAMPTZ` и используются единообразно (зона, сериализация).

---

### 1.2 Направление №2 — Production readiness (DLQ, retry, health)

Перед реальными пользователями:

1. **DLQ (Dead Letter Queue)**  
   Если consumer падает N раз подряд — куда уходит сообщение? Нужна явная DLQ и политика (retry → DLQ → алерт/ручной разбор).

2. **Retry policy**  
   Сейчас полагаемся на retry RabbitMQ. Зафиксировать: сколько попыток, с какой задержкой, когда в DLQ.

3. **Health check automation-service**  
   Проверять:
   - соединение с БД;
   - доступность CRM (или хотя бы конфиг);
   - канал RabbitMQ.

---

### 1.3 Направление №3 — Расширение automation (аккуратно)

Сейчас: `lead.stage.changed` → `create_deal`.

Безопасные расширения по одному action type:

- `move_stage` — автоматически переводить сделку в стадию;
- `notify` — webhook / email;
- auto-assign user;
- SLA escalation.

**Не делать:** UI rule builder, сложный DSL, temporal workflows. Добавлять по одному action type и тестировать.

---

## 2. Рекомендуемый порядок действий

| Шаг | Действие | Документ |
|-----|----------|----------|
| **1** | **ЭТАП 5 — Observability** — structured logging как контракт, publish/consume tracing, correlation propagation audit, базовые метрики (in-memory + лог). Без Prometheus/OpenTelemetry на первом шаге. | **STAGE_5_OBSERVABILITY_PLAN.md** |
| **2** | **ЭТАП 6 — DLQ** — Dead Letter Queue, max retry, лог при попадании в DLQ. Только после готовности логов. | (план после ЭТАПА 5) |
| **3** | Метрики — при необходимости экспорт в Prometheus; до этого достаточно счётчиков в памяти + периодический structured log. | — |

После ЭТАПА 5 и 6 можно безопасно наращивать фичи automation и нагрузку.

---

## 3. Стратегический выбор

Сейчас развилка:

- **Делать фичи** — больше правил, больше action types.
- **Делать устойчивость** — observability, DLQ, метрики, health.

Если цель — реальный продукт, а не демо, правильнее вложиться в устойчивость: observability + DLQ дают базу, на которой automation сможет расти без хаоса.

---

## 4. Связь с другими документами

- **STAGE_4_PLAN.md** — реализация вертикального среза automation (create_deal, идемпотентность).
- **STAGE_4_ARCHITECTURE.md** — архитектура событие → consumer → идемпотентное действие.
- **STAGE_5_OBSERVABILITY_PLAN.md** — следующий шаг: Observability как фича (лог-контракт, publish/consume tracing, correlation audit, базовые метрики). Реализовать перед DLQ.
- **PRODUCTION_ROADMAP.md** — общий чек-лист к продакшену. Наблюдаемость и DLQ дополняют его.
