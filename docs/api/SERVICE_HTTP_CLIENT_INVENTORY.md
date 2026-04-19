# Инвентаризация ServiceHttpClient (фаза B1)

**Назначение:** единая картина межсервисного HTTP через `@getsale/service-core` (`ServiceHttpClient` + `interServiceHttpDefaults`, env `SERVICE_HTTP_*`).

**Аудит репозитория (2026-03-20):** экземпляры `new ServiceHttpClient` создаются **только** в перечисленных ниже сервисах. Сервисы **analytics-service**, **activity-service**, **team-service**, **websocket-service** (и др. без таблицы) **не** используют `ServiceHttpClient` — обмен с миром через PostgreSQL, RabbitMQ и/или Redis.

---

## Таблица клиентов по сервисам

| Сервис | Клиент `name` | `baseUrl` (env) | Таймаут / особенности |
|--------|---------------|-----------------|------------------------|
| **bd-accounts-service** | `messaging-service` | `MESSAGING_SERVICE_URL` | `interServiceHttpDefaults`; явный `retries: 2` (как дефолт env) |
| **messaging-service** | `bd-accounts-service` | `BD_ACCOUNTS_SERVICE_URL` | defaults + `retries: 2` |
| **messaging-service** | `ai-service` | `AI_SERVICE_URL` | **65s** по умолчанию; `MESSAGING_AI_HTTP_TIMEOUT_MS` (мин. 5000 мс) |
| **crm-service** | `bd-accounts-service` | `BD_ACCOUNTS_SERVICE_URL` | **60s**; retry из defaults |
| **crm-service** | `campaign-service` | `CAMPAIGN_SERVICE_URL` | **60s**; `retries: 0` |
| **campaign-service** | `pipeline-service` | `PIPELINE_SERVICE_URL` | defaults |
| **campaign-service** | `messaging-service` | `MESSAGING_SERVICE_URL` | `retries: 2` |
| **campaign-service** | `bd-accounts-service` | `BD_ACCOUNTS_SERVICE_URL` | `retries: 2` |
| **campaign-service** | `ai-service` | `AI_SERVICE_URL` | **65s**; `retries: 1` |
| **automation-service** | `crm-service` | `CRM_SERVICE_URL` | **15s**; `AUTOMATION_CRM_HTTP_TIMEOUT_MS` (мин. 3000 мс) |
| **automation-service** | `pipeline-service` | `PIPELINE_SERVICE_URL` | **15s**; `AUTOMATION_PIPELINE_HTTP_TIMEOUT_MS` (мин. 3000 мс) |

**Общее:** `SERVICE_HTTP_TIMEOUT_MS`, `SERVICE_HTTP_RETRIES`, `SERVICE_HTTP_RETRY_DELAY_MS`, `SERVICE_HTTP_CB_THRESHOLD`, `SERVICE_HTTP_CB_RESET_MS` — см. [DEPLOYMENT.md](../operations/DEPLOYMENT.md).

**Метрики (B1):** при создании клиента передаётся `metricsRegistry` из `createServiceApp` — на `/metrics` публикуются `inter_service_http_requests_total` и `inter_service_http_circuit_reject_total` (см. [DEPLOYMENT.md](../operations/DEPLOYMENT.md) → Prometheus).

---

## Связанные документы

- [INTERNAL_API.md](INTERNAL_API.md) — смысловые контракты вызовов  
- [ROADMAP.md](../ROADMAP.md) — фаза B1  
- [ARCHITECTURE.md](../architecture/ARCHITECTURE.md) — строки таблицы сервисов  

При добавлении нового `ServiceHttpClient` обновляйте эту таблицу и при необходимости INTERNAL_API / DEPLOYMENT.
