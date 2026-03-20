# Runbook: orphan сообщений при удалении BD-аккаунта

**Связь:** фаза A2 [MIGRATION_TO_TARGET_ARCHITECTURE.md](MIGRATION_TO_TARGET_ARCHITECTURE.md), [TABLE_OWNERSHIP_A1.md](../ai_docs/develop/TABLE_OWNERSHIP_A1.md).

## Нормальный путь

1. Пользователь удаляет BD-аккаунт в UI.
2. `bd-accounts-service` вызывает `POST /internal/messages/orphan-by-bd-account` в `messaging-service` (тело `{ bdAccountId }`, заголовок `X-Organization-Id`).
3. Messaging выполняет `UPDATE messages SET bd_account_id = NULL` для строк этой организации и аккаунта.
4. BD-аккаунт и строки `bd_account_sync_*` удаляются.

## Fallback (когда messaging недоступен)

Если вызов internal API завершается ошибкой (сеть, 5xx, circuit breaker), bd-accounts логирует предупреждение и выполняет **тот же SQL** локально, чтобы не нарушить FK при `DELETE FROM bd_accounts`.

**Логи:** искать `Messaging orphan-by-bd-account failed, orphaning messages locally`.

**Метрики:** `bd_accounts_messaging_orphan_fallback_total` на `/metrics` у **bd-accounts-service** (счётчик увеличивается на каждый delete с локальным orphan). В Prometheus: правило `BdAccountsMessagingOrphanFallback` в `infrastructure/prometheus/alert_rules.yml`.

**Действия SRE:**

1. Убедиться, что messaging-service снова здоров.
2. Проверить, что для затронутых `organization_id` нет рассинхрона (сообщения без `bd_account_id` — ожидаемо после orphan).
3. Если fallback срабатывал часто — разобрать причину недоступности messaging (сеть, CB, 5xx); держать график/алерт по метрике выше.

## Будущее улучшение

Заменить одношаговый fallback на очередь «retry orphan» с дедупликацией по `(organization_id, bd_account_id)`, чтобы единственный писатель `messages` оставался messaging-service.
