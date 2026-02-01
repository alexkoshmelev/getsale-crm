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

**Важно:** на сервере должен быть **актуальный** `docker-compose.server.yml` из репозитория. Образы указываются как один репозиторий с тегами: `getsale-crm:api-gateway`, `getsale-crm:auth-service` и т.д. (не `getsale-crm-api-gateway:latest`). Если на сервере старая версия compose — будет ошибка `unauthorized` при pull.

Проверка на сервере: `grep "image:.*getsale" docker-compose.server.yml` — должно быть `getsale-crm:api-gateway`, а не `getsale-crm-api-gateway:latest`. Если видите старый формат — выполните `git pull origin main` в `/docker/getsale-crm` или скопируйте файл из репо вручную.

На сервере в каталоге с `docker-compose.server.yml` (например `/docker/getsale-crm`) должен быть файл **`.env`** с переменными окружения для прода. Локальный `.env` из репозитория — для разработки; на сервере используйте отдельные секреты.

Скопируйте шаблон и заполните значения:

```bash
cp env.server.example .env
# отредактируйте .env: пароли, JWT_SECRET, JWT_REFRESH_SECRET, OPENAI_API_KEY и т.д.
```

Обязательные переменные: `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `RABBITMQ_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET`. Остальные — см. `env.server.example`.

**Реестр DigitalOcean:** на сервере один раз выполните вход в registry, иначе `docker compose pull` выдаст `unauthorized`:

```bash
docker login registry.digitalocean.com -u <DO_REGISTRY_USERNAME> -p <DO_REGISTRY_PASSWORD>
```
