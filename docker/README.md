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

Обязательные переменные в `.env`: `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `RABBITMQ_PASSWORD`, `JWT_SECRET`, `JWT_REFRESH_SECRET`. Остальные — см. `env.server.example`. На сервере используется только `RABBITMQ_PASSWORD`; `RABBITMQ_URL` в контейнерах собирается из него (`amqp://getsale:${RABBITMQ_PASSWORD}@rabbitmq:5672`). Если при `docker compose` видите предупреждение *The "RABBITMQ_PASSWORD" variable is not set* — создайте `.env` из `env.server.example` и задайте все переменные.

**TELEGRAM_API_ID / TELEGRAM_API_HASH (ошибка «must be set in environment»):** (1) **Деплой через GitHub Actions:** добавьте в настройках репозитория (Settings → Secrets) секреты `TELEGRAM_API_ID` и `TELEGRAM_API_HASH` — при каждом деплое они записываются в `.env` на сервере. (2) **Ручной запуск на сервере:** создайте/отредактируйте `.env` в каталоге с `docker-compose.server.yml` (например `/docker/getsale-crm/.env`), затем `docker compose -f docker-compose.server.yml up -d --force-recreate bd-accounts-service`.

**Реестр DigitalOcean:** на сервере один раз выполните вход в registry, иначе `docker compose pull` выдаст `unauthorized`:

```bash
docker login registry.digitalocean.com -u <DO_REGISTRY_USERNAME> -p <DO_REGISTRY_PASSWORD>
```

**Frontend (https://app.getsale.ai):** приложение отдаёт Traefik по правилу `Host(\`app.getsale.ai\`)`. Проверьте: (1) контейнер `getsale-crm-frontend` запущен: `docker ps | grep frontend`; (2) Traefik запущен и контейнеры CRM в сети `traefik`: `docker network inspect traefik`; (3) DNS `app.getsale.ai` указывает на сервер с Traefik.

**Не трогать Traefik при деплое:** в `docker-compose.server.yml` задано `name: getsale-crm`, чтобы проект Compose всегда назывался `getsale-crm`. Тогда `docker compose down` в каталоге CRM останавливает только контейнеры CRM и не затрагивает Traefik (другой проект). Для стека Traefik в его compose-файле тоже лучше задать явное имя проекта, например `name: traefik`.

**Миграции не подключаются к БД:** на сервере есть два контейнера Postgres (CRM и другой стек). В compose для миграций указан хост `getsale-crm-postgres`, чтобы подключаться именно к БД CRM. Проверьте: (1) в `/docker/getsale-crm/.env` задан `POSTGRES_PASSWORD` (тот же, что у контейнера postgres); (2) сеть общая: `docker inspect getsale-crm-migrations --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}'` и то же для `getsale-crm-postgres` — должен быть `getsale-crm_default`; (3) из контейнера миграций: `docker exec getsale-crm-migrations getent hosts getsale-crm-postgres`.
