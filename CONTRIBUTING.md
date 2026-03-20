# Contributing

## Быстрый старт

1. Ознакомьтесь с [docs/INDEX.md](docs/INDEX.md) — целевая архитектура, as-is, internal API, runbooks.
2. Соберите затронутые пакеты/сервисы (`npm run build` в изменённых `services/*` или `shared/*`).
3. Следуйте [.cursor/rules/](.cursor/rules/) (backend/frontend, security, git).

## Pull requests

- Один PR — сфокусированная задача; избегайте смешивать рефакторинг и новую фичу без необходимости.
- Сообщения коммитов: см. [.cursor/rules/commit-messages.md](.cursor/rules/commit-messages.md).

## Architecture Decision Records (ADR)

**Канон:** каталог [docs/adr/](docs/adr/README.md).

Новые архитектурные решения (границы сервисов, смена контрактов, долговременные компромиссы) оформляйте отдельным файлом `docs/adr/NNNN-short-title.md` и при необходимости добавьте строку в таблицу оглавления в `docs/adr/README.md`.
