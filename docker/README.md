# Docker — конфигурация образов

Все Dockerfile вынесены в папку `docker/` по аналогии с `k8s/` для удобного администрирования.

## Структура

```
docker/
├── Dockerfile.service      # Продакшн: все бэкенд-сервисы (build-arg SERVICE_PATH)
├── services/
│   └── Dockerfile.dev      # Разработка: все бэкенд-сервисы (build-arg SERVICE_PATH)
├── frontend/
│   ├── Dockerfile          # Продакшн: Next.js
│   └── Dockerfile.dev      # Разработка: Next.js
├── migrations/
│   └── Dockerfile          # Миграции БД (context: ./migrations)
└── README.md
```

## Сборка

- **Бэкенд (prod):** из корня репозитория  
  `docker build -f docker/Dockerfile.service --build-arg SERVICE_PATH=services/api-gateway -t getsale-crm-api-gateway .`
- **Бэкенд (dev):** `docker-compose` использует `docker/services/Dockerfile.dev` с разным `SERVICE_PATH`.
- **Фронт (prod):** `docker build -f docker/frontend/Dockerfile ./frontend -t getsale-crm-frontend`
- **Миграции:** `docker build -f docker/migrations/Dockerfile ./migrations -t getsale-crm-migrations`

Скрипт `docker-entrypoint.sh` для dev-сервисов остаётся в корне репозитория (копируется в образ из контекста).
