# Руководство по развертыванию

> **Актуальный стек (2026):** v2 — [`docker-compose.v2.yml`](../../docker-compose.v2.yml) локально, [`docker-compose.server.v2.yml`](../../docker-compose.server.v2.yml) на сервере, переменные окружения — раздел «production server» в [`.env.example`](../../.env.example). См. также [docs/README.md](../README.md). Ниже остаются детали, часть путей к старому `services/*` может быть устаревшей.

## Локальная разработка

### Требования

- Docker & Docker Compose
- Node.js 22+ (для локальной разработки без Docker)

### Запуск (v2)

```bash
docker compose -f docker-compose.v2.yml up -d
docker compose -f docker-compose.v2.yml logs -f
docker compose -f docker-compose.v2.yml down
docker compose -f docker-compose.v2.yml down -v
```

### Доступные сервисы

- **API Gateway**: http://localhost:8000
- **RabbitMQ Management**: http://localhost:15672 (getsale/getsale_dev)
- **Grafana**: http://localhost:3000 (admin/admin)
- **Prometheus**: http://localhost:9090
- **Jaeger**: http://localhost:16686

### Переменные окружения

Создайте `.env` файл в корне проекта:

```env
# Обязательно для работы gateway и бэкендов: один и тот же секрет для внутренней аутентификации запросов gateway → backend.
# Если не задан, бэкенды отвечают 503 (см. аудит S1). В production запрещено использовать значение по умолчанию (api-gateway не запустится).
INTERNAL_AUTH_SECRET=your_internal_auth_secret

# Опционально: межсервисный HTTP (ServiceHttpClient) — таймауты, ретраи, circuit breaker.
# Значения по умолчанию подставляются в коде; переопределяйте при деградации сети или длинных операциях.
# SERVICE_HTTP_TIMEOUT_MS=10000
# SERVICE_HTTP_RETRIES=2
# SERVICE_HTTP_RETRY_DELAY_MS=500
# SERVICE_HTTP_CB_THRESHOLD=5
# SERVICE_HTTP_CB_RESET_MS=30000
#
# messaging-service → ai-service (summarize / analyze): таймаут по умолчанию 65s; при необходимости:
# MESSAGING_AI_HTTP_TIMEOUT_MS=90000
#
# automation-service → crm / pipeline: по умолчанию 15s на клиент; при необходимости:
# AUTOMATION_CRM_HTTP_TIMEOUT_MS=30000
# AUTOMATION_PIPELINE_HTTP_TIMEOUT_MS=30000

OPENAI_API_KEY=your_openai_key
TELEGRAM_BOT_TOKEN=your_telegram_token
# Для BD Accounts (подключение Telegram аккаунтов) — получить на https://my.telegram.org/apps
TELEGRAM_API_ID=12345
TELEGRAM_API_HASH=your_api_hash
# FLOOD_WAIT: GramJS/MTProto возвращает время ожидания в ошибке (`seconds`). `telegramInvokeWithFloodRetry` сначала спит min(seconds, cap), затем один повтор — без паузы повтор бессмысленен. cap защищает воркер от многочасовой блокировки (если Telegram просит дольше — после retry ошибка уйдёт наверх, CRM может ротировать BD).
# TELEGRAM_FLOOD_WAIT_CAP_SECONDS=600
```

### Безопасность: gateway и бэкенды

- **INTERNAL_AUTH_SECRET:** Должен быть задан одним и тем же значением для API Gateway и всех бэкенд-сервисов. В production API Gateway при старте проверяет, что переменная задана и не равна значению по умолчанию `dev_internal_auth_secret` — иначе процесс завершается с ошибкой. В dev и staging также задайте непустой и не дефолтный секрет, если бэкенды доступны с других машин или по сети — иначе internal-маршруты останутся без проверки (аудит S3).
- **Прямой доступ к бэкендам запрещён:** К бэкенд-сервисам (auth, crm, pipeline, messaging, bd-accounts, campaign, automation, ai, user, team, analytics, activity) не должен быть доступ из интернета. Единственная точка входа для клиентских запросов — API Gateway. Бэкенды доверяют заголовкам `X-User-Id`, `X-Organization-Id`, `X-User-Role` только при наличии валидного заголовка `X-Internal-Auth` (INTERNAL_AUTH_SECRET). Если бэкенд окажется доступен напрямую, злоумышленник при компрометации или отсутствии секрета сможет подделать контекст пользователя. В продакшене бэкенды должны слушать только внутреннюю сеть (например, Kubernetes cluster IP или private subnet).

Подробнее о контрактах между сервисами: [INTERNAL_API.md](../api/INTERNAL_API.md).

### RabbitMQ: события, DLQ и метрики

Доменные события публикуются в exchange **`events`** (topic, durable). Потребители объявляют **именованные** очереди, например `messaging-service`, `campaign-service`, `websocket-service`, `pipeline-service`, `automation-service`, `analytics-service`, `activity-service`, `ai-service`. Для каждой такой очереди клиент в `@getsale/utils` создаёт парную **DLQ** `<имя_очереди>.dlq`: после **3** неудачных обработок (с заголовком `x-retry-count`) сообщение снимается с основной очереди и отправляется в DLQ.

**Prometheus** (эндпоинт `/metrics` у бэкендов):

- `event_publish_failed_total` — не удалось опубликовать событие (канал не готов, ошибка записи).
- `rabbitmq_dlq_messages_total{queue="…"}` — сообщения, отправленные в DLQ после исчерпания ретраев у consumer.

Правила алертов: `infrastructure/prometheus/alert_rules.yml` (`EventPublishFailures`, `RabbitMqConsumerDlq`, `BdAccountsMessagingOrphanFallback`, **`BdAccountsMessageDbSqlBypass`** (A3: локальный SQL в `message-db` без клиента messaging), **`InterServiceHttpErrorShareElevated`** / **`InterServiceHttpCircuitReject`** (B1: доля неуспешных исходящих `ServiceHttpClient` и отказы при открытом circuit), **`CampaignMinGapDeferElevated`** — информативный: рост `campaign_min_gap_defer_total` при включённом `CAMPAIGN_MIN_GAP_MS_SAME_BD_ACCOUNT`). Локально: Management UI — см. список сервисов выше (логин в dev: см. раздел «Доступные сервисы»).

**Эксплуатация DLQ:** сначала устранить причину (логи сервиса по `event_type` / stack trace). Повторная постановка сообщений из DLQ в рабочую очередь — вручную через RabbitMQ Management (или shovel) только после фикса, иначе цикл повторится.

### Fallback: orphan сообщений при удалении BD-аккаунта (A2)

Нормальный путь — `bd-accounts` → `POST messaging /internal/messages/orphan-by-bd-account`. Если вызов падает, bd-accounts выполняет локальный `UPDATE messages` (см. [ORPHAN_MESSAGES.md](../runbooks/ORPHAN_MESSAGES.md)). Метрика **`bd_accounts_messaging_orphan_fallback_total`** на `/metrics` у bd-accounts-service; алерт **`BdAccountsMessagingOrphanFallback`** в `infrastructure/prometheus/alert_rules.yml`.

### A3: прямой SQL в `message-db.ts` (обход internal messaging)

В штатном деплое `TelegramManager` всегда получает HTTP-клиент к messaging; запись сообщений идёт через internal API. Если клиент отсутствует (тесты, ошибка конфигурации), `MessageDb` пишет в `messages`/`conversations` напрямую — это **осознанный bypass** (см. [TABLE_OWNERSHIP.md](../architecture/TABLE_OWNERSHIP.md) §A3). Метрика **`bd_accounts_message_db_sql_bypass_total{operation="…"}`** на `/metrics` bd-accounts; алерт **`BdAccountsMessageDbSqlBypass`**.

**Строгий режим (опционально):** `BD_ACCOUNTS_MESSAGE_DB_STRICT=1` или `true` у **bd-accounts-service** — при отсутствии рабочего `messagingClient` любой SQL-bypass в `MessageDb` **не выполняется** (ошибка с кодом `MESSAGE_DB_STRICT_NO_CLIENT`). Имеет смысл в staging/production после проверки, что `MESSAGING_SERVICE_URL` и internal-auth настроены; в локальных тестах без mock messaging обычно не включать.

## Если сервисы не запускаются: INTERNAL_AUTH_SECRET

При ошибке вида `INTERNAL_AUTH_SECRET must be set to a non-default value in production` API Gateway и все бэкенды (websocket-service, ai-service и др.) требуют переменную окружения. Сделайте:

1. В каталоге с `docker-compose.server.v2.yml` создайте или отредактируйте `.env`.
2. Добавьте строку (подставьте свой сгенерированный секрет):
   ```bash
   INTERNAL_AUTH_SECRET=<ваш_секрет>
   ```
   Сгенерировать секрет: `openssl rand -hex 32`. Один и тот же результат подставьте в `.env` — он будет передан и API Gateway, и всем бэкендам.
3. Перезапустите контейнеры: `docker compose -f docker-compose.server.v2.yml up -d`.

Без этого в production сервисы намеренно не стартуют (защита от подделки внутренних запросов).

## Чек-лист перед выходом в прод

Перед первым деплоем в production убедитесь:

1. **Сборка:** Все сервисы пересобраны (`npm run build` в корне или через CI). В деплое не должны использоваться устаревшие `dist/` (например, с устаревшей логикой в bd-accounts).
2. **Переменные окружения (production):**
   - `JWT_SECRET` — задан и надёжный (не дефолтное значение).
   - `INTERNAL_AUTH_SECRET` — задан и **не** равен `dev_internal_auth_secret` (иначе API Gateway не запустится).
   - `CORS_ORIGIN` — задан списком разрешённых фронтовых доменов (в production обязателен).
3. **Сеть:** Бэкенды (auth, crm, messaging, bd-accounts, pipeline, campaign, automation, ai, user, team, analytics, activity) не открыты в интернет; единственная точка входа для клиентов — API Gateway; бэкенды доступны только из внутренней сети.
4. **Один и тот же INTERNAL_AUTH_SECRET** у API Gateway и всех бэкендов (как описано выше в разделе «Безопасность»).

После выполнения пунктов выше выход в прод по текущему аудиту допустим.

## AI: репрайз текста в кампаниях (OpenRouter)

Для опции «рандомизация через AI» в кампаниях:

1. **ai-service (v2):** задать `OPENROUTER_API_KEY`. Модели — **по фичам**: `OPENROUTER_CAMPAIGN_MODEL`, `OPENROUTER_AUTO_RESPOND_MODEL`, `OPENROUTER_CHAT_SUMMARIZE_MODEL`. В **[docker-compose.server.v2.yml](../../docker-compose.server.v2.yml)** у `ai-service` заданы дефолты для прода; переопределение — в `.env` на хосте рядом с `docker compose`. Устаревший `OPENROUTER_MODEL` лучше не использовать. `OPENROUTER_MAX_TOKENS`, `OPENROUTER_TIMEOUT_MS` — общие. См. [CAMPAIGN_AI.md](../domain/CAMPAIGN_AI.md) (пути к коду: `services-v2/ai-service`).
2. **Кампании (v2):** оркестрация — `campaign-orchestrator`, отправки — `campaign-worker`. `AI_SERVICE_URL` в compose указывает на `http://ai-service:4010`.

### Воркер отправок кампаний (campaign-worker)

Переменные окружения см. в [`services-v2/campaign-worker/src/index.ts`](../../services-v2/campaign-worker/src/index.ts) и в `docker-compose.server.v2.yml` для сервиса `campaign-worker` (в т.ч. `CAMPAIGN_MAX_SENDS_PER_ACCOUNT_PER_DAY`).

Межсервисные таймауты/ретраи/circuit breaker задаются общими `SERVICE_HTTP_*` (см. раздел выше про `interServiceHttpDefaults`).

Локально: при запуске `services-v2/ai-service` через `npm run dev` переменные из корневого `.env` подгружаются автоматически, если так настроено в сервисе.

## Продакшн (Kubernetes)

### Требования

- Kubernetes кластер (1.24+)
- kubectl настроен
- Доступ к registry для Docker образов

### Подготовка

1. Создать namespace:

```bash
kubectl apply -f k8s/namespace.yaml
```

2. Создать secrets:

```bash
# Создать secrets из примера
kubectl create secret generic postgres-secret \
  --from-literal=username=getsale \
  --from-literal=password=CHANGE_ME \
  --from-literal=url=postgresql://getsale:CHANGE_ME@postgres:5432/getsale_crm \
  -n getsale-crm

kubectl create secret generic rabbitmq-secret \
  --from-literal=username=getsale \
  --from-literal=password=CHANGE_ME \
  --from-literal=url=amqp://getsale:CHANGE_ME@rabbitmq:5672 \
  -n getsale-crm

kubectl create secret generic jwt-secret \
  --from-literal=secret=CHANGE_ME_JWT_SECRET \
  --from-literal=refresh-secret=CHANGE_ME_REFRESH_SECRET \
  -n getsale-crm

kubectl create secret generic openai-secret \
  --from-literal=api-key=CHANGE_ME \
  -n getsale-crm

kubectl create secret generic telegram-secret \
  --from-literal=token=CHANGE_ME \
  -n getsale-crm
```

3. Развернуть инфраструктуру:

```bash
kubectl apply -f k8s/postgres.yaml
kubectl apply -f k8s/redis.yaml
kubectl apply -f k8s/rabbitmq.yaml
```

4. Собрать и загрузить Docker образы:

```bash
# v2: один образ на сервис — см. services-v2/Dockerfile.template и .github/workflows/deploy.yml
docker build --build-arg SERVICE=gateway -f services-v2/Dockerfile.template -t getsale-crm-v2:gateway .
docker push getsale-crm-v2:gateway
# ... повторить для остальных SERVICE (auth-service, core-api, …)
```

5. Развернуть сервисы:

```bash
kubectl apply -f k8s/api-gateway.yaml
kubectl apply -f k8s/auth-service.yaml
kubectl apply -f k8s/crm-service.yaml
kubectl apply -f k8s/messaging-service.yaml
kubectl apply -f k8s/websocket-service.yaml
kubectl apply -f k8s/ai-service.yaml
```

### Проверка статуса

```bash
# Проверить поды
kubectl get pods -n getsale-crm

# Проверить сервисы
kubectl get svc -n getsale-crm

# Просмотр логов
kubectl logs -f deployment/api-gateway -n getsale-crm
```

### Масштабирование

```bash
# Увеличить количество реплик
kubectl scale deployment api-gateway --replicas=5 -n getsale-crm
```

### Автомасштабирование

Создайте HPA (Horizontal Pod Autoscaler):

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: api-gateway-hpa
  namespace: getsale-crm
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: api-gateway
  minReplicas: 2
  maxReplicas: 10
  metrics:
  - type: Resource
    resource:
      name: cpu
      target:
        type: Utilization
        averageUtilization: 70
```

## CI/CD (Docker + DigitalOcean Registry + SSH)

### Автоматический деплой на сервер

Workflow `.github/workflows/deploy.yml` при пуше в `main` (или по кнопке):

1. Собирает образы всех сервисов и пушит в DigitalOcean Container Registry.
2. По SSH подключается к серверу и обновляет контейнеры через `docker compose -f docker-compose.server.v2.yml`.

**Секреты в GitHub (Settings → Secrets):**

- `DO_REGISTRY_USERNAME` — логин для registry.digitalocean.com
- `DO_REGISTRY_PASSWORD` — токен/пароль registry
- `PROD_SERVER_HOST` — IP или хост сервера
- `SERVER_USERNAME` — пользователь SSH
- `PROD_SERVER_KEY` — приватный ключ SSH
- `SERVER_PORT` — порт SSH (обычно 22)

**Переменные репозитория (Settings → Variables), опционально для фронта:**

- `NEXT_PUBLIC_API_URL` — публичный URL API (например `https://api.getsale.example`)
- `NEXT_PUBLIC_WS_URL` — публичный URL WebSocket (например `wss://ws.getsale.example`)

**WebSocket за Traefik:** В `docker-compose.server.v2.yml` для `websocket-service` задан `responseForwarding.flushInterval=1ms`, чтобы фреймы Socket.IO не буферизовались прокси. Если соединения всё равно обрываются, в статической конфигурации Traefik для entrypoint `websecure` задайте большие таймауты: `respondingTimeouts.readTimeout=0`, `writeTimeout=0`, `idleTimeout=3600s`.

**На сервере:**

1. Создать каталог: `mkdir -p /docker/getsale-crm && cd /docker/getsale-crm`
2. Скопировать туда `docker-compose.server.v2.yml` из репозитория.
3. Создать `.env`: скопировать из [`.env.example`](../../.env.example) раздел **§2 — production server**, раскомментировать и заполнить. Обязательно: `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `RABBITMQ_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, `INTERNAL_AUTH_SECRET`. На сервере задаётся `RABBITMQ_PASSWORD`; `RABBITMQ_URL` в контейнерах собирается из него.
4. При первом деплое образы подтянутся через `docker compose pull`; далее workflow сам делает `down` → `pull` → `up -d` и запуск миграций.

Путь на сервере по умолчанию: `/docker/getsale-crm`. Его можно поменять в шаге «Deploy to Prod Server» в workflow.

### GitHub Actions пример (Kubernetes)

```yaml
name: Build and Deploy

on:
  push:
    branches: [main]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - name: Build Docker images
        run: |
          docker build --build-arg SERVICE=gateway -f services-v2/Dockerfile.template -t getsale-crm-v2:gateway:${{ github.sha }} .
          docker push getsale-crm-v2:gateway:${{ github.sha }}
      - name: Deploy to Kubernetes
        run: |
          kubectl set image deployment/gateway \
            gateway=getsale-crm-v2:gateway:${{ github.sha }} \
            -n getsale-crm
```

## Мониторинг

### Prometheus

Метрики доступны на `http://prometheus:9090`

**Межсервисный HTTP (B1):** у сервисов с `ServiceHttpClient` и переданным `metricsRegistry` в конструкторе клиента — счётчики **`inter_service_http_requests_total{client,method,outcome}`** (`outcome`: `success`, `client_4xx`, `server_or_downstream`, `timeout_abort`, `network_error`, `circuit_open`) и **`inter_service_http_circuit_reject_total{client}`**. См. HTTP-клиент в `shared-v2/service-framework`. Алерты по доле неуспешных исходов и по circuit-reject: **`InterServiceHttpErrorShareElevated`**, **`InterServiceHttpCircuitReject`** в `infrastructure/prometheus/alert_rules.yml` (лейблы `job`, `client`).

### Grafana

Дашборды доступны на `http://grafana:3000`

### Логирование

Настройте централизованное логирование (ELK или Loki):

```yaml
# Пример с Fluentd
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluentd-config
  namespace: getsale-crm
data:
  fluent.conf: |
    <source>
      @type tail
      path /var/log/containers/*.log
      pos_file /var/log/fluentd-containers.log.pos
      tag kubernetes.*
      read_from_head true
      <parse>
        @type json
      </parse>
    </source>
```

## Резервное копирование

### PostgreSQL

```bash
# Backup
kubectl exec -it postgres-0 -n getsale-crm -- \
  pg_dump -U getsale getsale_crm > backup.sql

# Restore
kubectl exec -i postgres-0 -n getsale-crm -- \
  psql -U getsale getsale_crm < backup.sql
```

### Redis

```bash
# Backup
kubectl exec -it redis-0 -n getsale-crm -- redis-cli SAVE
kubectl cp getsale-crm/redis-0:/data/dump.rdb ./redis-backup.rdb
```

## Troubleshooting

### Проблемы с подключением

```bash
# Проверить сетевые политики
kubectl get networkpolicies -n getsale-crm

# Проверить DNS
kubectl run -it --rm debug --image=busybox --restart=Never -- nslookup postgres
```

### Проблемы с ресурсами

```bash
# Проверить использование ресурсов
kubectl top pods -n getsale-crm

# Проверить события
kubectl get events -n getsale-crm --sort-by='.lastTimestamp'
```

