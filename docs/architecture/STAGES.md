# Этапы разработки (Stage 1–7)

Краткая сводка целей и статуса. Детальные планы по этапам были объединены в этот документ; ключевые архитектурные решения отражены в [ARCHITECTURE.md](ARCHITECTURE.md) и [ROADMAP.md](../ROADMAP.md).

---

## ЭТАП 1 — Single source of truth для смены стадии сделки

**Цель:** Единственная точка смены стадии сделки — CRM (`PATCH /api/crm/deals/:id/stage`). Pipeline при наличии `dealId` — deprecated proxy в CRM.

**Ключевые решения:** Deal — доменная сущность CRM; stage_history при смене через CRM пишется из CRM; для сделки в transitional-режиме `client_id = deal_id` (нормализация в ЭТАПЕ 2).

**Статус:** Выполнен.

---

## ЭТАП 2 — Нормализация stage_history

**Цель:** Одна таблица `stage_history` для лидов и сделок с полями `entity_type` ('lead' | 'deal'), `entity_id`, `source` ('manual' | 'system' | 'automation'), `correlation_id`. Чистый старт (DROP/CREATE) при отсутствии продакшен-данных.

**Статус:** Закрыт (миграция и код приведены в соответствие).

**Дальше:** ЭТАП 4 (Automation Engine).

---

## ЭТАП 3 — Связь Lead → Deal

**Цель:** Модель 1 Lead → 1 Deal; при создании сделки с `leadId` — строгая консистентность, partial unique index по lead_id; в одной транзакции создаётся deal, лид переводится в стадию Converted, пишется stage_history; публикуется `lead.converted`.

**Статус:** Реализован. Ручная проверка по чек-листу (ранее STAGE_3_MANUAL_TEST_CHECKLIST).

---

## ЭТАП 4 — Automation Engine (автосоздание сделки из лида)

**Цель:** При переходе лида в стадию X → создание сделки через событие `lead.stage.changed`. Consumer в automation-service; идемпотентность через `automation_executions` (UNIQUE rule_id, entity_type, entity_id); вызов POST /api/crm/deals с leadId; 409 = успех.

**Архитектура:** Событие публикует pipeline-service; consumer обрабатывает по правилам (pipeline_id, to_stage_id); ACK только после записи execution. Без прямой связи «в коде смены стадии вызвать создание сделки».

**Статус:** Реализован (event-driven, идемпотентность, стресс-тесты).

---

## ЭТАП 5 — Observability

**Цель:** Наблюдаемость как контракт: структурированное логирование (обязательные поля: service, correlation_id, event_id, entity_type, entity_id, status), publish/consume tracing, корректная передача correlation_id. Без Prometheus/OpenTelemetry на первом шаге — сначала дисциплина логов.

**Статус:** В плане (см. [ROADMAP.md](../ROADMAP.md), приоритет «Надёжность»). После ЭТАПА 5 — ЭТАП 6 (DLQ).

---

## ЭТАП 6 — SLA Automation

**Цель:** Триггеры по времени в стадии («лид в стадии X больше N дней» → уведомление/задача). Расширение `automation_rules` новыми trigger_type (`lead.sla.breach`, `deal.sla.breach`), cron как виртуальный publisher. Идемпотентность через partial unique index по (rule_id, entity_type, entity_id, breach_date).

**Предусловие:** ЭТАП 5 закрыт (в т.ч. DLQ).

**Статус:** План зафиксирован; реализация после Observability и DLQ.

---

## ЭТАП 7 — Conversation-Driven CRM UX

**Цель:** Messaging-first: чат = центр управления. Conversation — тонкий слой над чатом (lead_id, campaign_id, became_lead_at, first_manager_reply_at и т.д.). Единый inbox: папка «Новые лиды», список диалогов с бейджами Lead/Contact, правая панель Lead Panel (pipeline, stage, timeline). Без backfill, без дублирования сущностей.

**Статус:** Реализован (conversations, new-leads, lead-context API, Lead Panel, системные события won/lost/shared).

---

## Порядок и следующие шаги

Текущий порядок: 1 → 3 → стабилизация → 2 → 4. Далее: **ЭТАП 5 (Observability)** — затем DLQ и при необходимости ЭТАП 6 (SLA). Приоритеты и чеклист к продакшену — в [ROADMAP.md](../ROADMAP.md).
