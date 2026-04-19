# Contributing

## Окружение

- **Node.js 24+** и **npm 10+** (см. [`package.json`](package.json) `engines`, [`.nvmrc`](.nvmrc)). На другой версии Node возможны предупреждения `EBADENGINE` и расхождение с CI/Docker.
- Репозиторий задаёт [`.npmrc`](.npmrc) с `include=dev`, чтобы devDependencies ставились даже при глобальном `omit=dev` в npm.

## Быстрый старт

1. Ознакомьтесь с [docs/INDEX.md](docs/INDEX.md) — архитектура, API, runbooks, дорожная карта.
2. Соберите затронутые пакеты/сервисы (`npm run build` в изменённых `services/*` или `shared/*`).
3. Следуйте [.cursor/rules/](.cursor/rules/) (backend/frontend, security, git).

## Мажорные апгрейды зависимостей

Выполняйте **отдельными PR** с чтением changelog и регрессией: **Zod 3 → 4**, **OpenAI SDK 6+**, **Stripe 22+**, **bcryptjs 3**, **amqplib 1.x** — затрагивают API и данные. Уже поднято в репозитории: **Vitest 4**, **`@types/node` для Node 24**, патчи по `npm audit`.

## Pull requests

- Один PR — сфокусированная задача; избегайте смешивать рефакторинг и новую фичу без необходимости.
- Сообщения коммитов: см. [.cursor/rules/commit-messages.md](.cursor/rules/commit-messages.md).

## Architecture Decision Records (ADR)

**Канон:** каталог [docs/adr/](docs/adr/README.md).

Новые архитектурные решения (границы сервисов, смена контрактов, долговременные компромиссы) оформляйте отдельным файлом `docs/adr/NNNN-short-title.md` и при необходимости добавьте строку в таблицу оглавления в `docs/adr/README.md`.
