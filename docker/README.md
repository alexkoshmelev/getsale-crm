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

## Продакшн на сервере (docker-compose.server.yml)

На сервере в каталоге с `docker-compose.server.yml` (например `/docker/getsale-crm`) должен быть файл **`.env`** с переменными окружения для прода. Локальный `.env` из репозитория — для разработки; на сервере используйте отдельные секреты.

Скопируйте шаблон и заполните значения:

```bash
cp env.server.example .env
# отредактируйте .env: пароли, JWT_SECRET, JWT_REFRESH_SECRET, OPENAI_API_KEY и т.д.
```

Обязательные переменные: `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `RABBITMQ_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET`. Остальные — см. `env.server.example`.
