# Руководство по развертыванию

## Локальная разработка

### Требования

- Docker & Docker Compose
- Node.js 18+ (для локальной разработки без Docker)

### Запуск

```bash
# Запустить все сервисы
docker-compose up -d

# Просмотр логов
docker-compose logs -f

# Остановить все сервисы
docker-compose down

# Остановить и удалить volumes
docker-compose down -v
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
OPENAI_API_KEY=your_openai_key
TELEGRAM_BOT_TOKEN=your_telegram_token
# Для BD Accounts (подключение Telegram аккаунтов) — получить на https://my.telegram.org/apps
TELEGRAM_API_ID=12345
TELEGRAM_API_HASH=your_api_hash
```

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
# Для каждого сервиса
docker build -t getsale/api-gateway:latest ./services/api-gateway
docker push getsale/api-gateway:latest
# ... и т.д.
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
2. По SSH подключается к серверу и обновляет контейнеры через `docker compose -f docker-compose.server.yml`.

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

**На сервере:**

1. Создать каталог: `mkdir -p /docker/getsale-crm && cd /docker/getsale-crm`
2. Скопировать туда `docker-compose.server.yml` из репозитория.
3. Создать `.env`: `cp env.server.example .env` и заполнить значения. Обязательно: `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `RABBITMQ_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET`. На сервере задаётся только `RABBITMQ_PASSWORD`; `RABBITMQ_URL` в контейнерах собирается из него. Остальные переменные — см. `env.server.example`.
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
          docker build -t getsale/api-gateway:${{ github.sha }} ./services/api-gateway
          docker push getsale/api-gateway:${{ github.sha }}
      - name: Deploy to Kubernetes
        run: |
          kubectl set image deployment/api-gateway \
            api-gateway=getsale/api-gateway:${{ github.sha }} \
            -n getsale-crm
```

## Мониторинг

### Prometheus

Метрики доступны на `http://prometheus:9090`

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

