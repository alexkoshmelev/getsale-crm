# Порядок сборки shared-пакетов (monorepo)

**Дата:** 2026-03-16

## Назначение

В монорепозитории пакеты `shared/types`, `shared/events`, `shared/logger`, `shared/utils`, `shared/service-core` собираются через `tsc`. Порядок сборки должен соответствовать графу зависимостей: каждый пакет собирается только после того, как собраны все его зависимости (чтобы были доступны `dist/*.js` и `dist/*.d.ts`).

## Канонический порядок

1. **shared/types** — нет зависимостей от других shared
2. **shared/events** — зависит от `@getsale/types`
3. **shared/logger** — не зависит от других shared
4. **shared/utils** — зависит от `@getsale/events`, `@getsale/logger`
5. **shared/service-core** — зависит от `@getsale/events`, `@getsale/logger`, `@getsale/utils`

Кратко: **types → events → logger → utils → service-core**.

## Где соблюдать порядок

- **docker/Dockerfile.service** — prod-сборка бэкенд-сервисов
- **docker/services/Dockerfile.dev** — dev-образы бэкенд-сервисов
- **docker-entrypoint.sh** — сборка shared при старте dev-контейнера

При добавлении нового shared-пакета или новой зависимости между пакетами нужно обновить порядок во всех трёх местах и в этой документации.

## Проверка локально

Из корня репозитория:

```bash
npm run build --workspace=shared/types && \
npm run build --workspace=shared/events && \
npm run build --workspace=shared/logger && \
npm run build --workspace=shared/utils && \
npm run build --workspace=shared/service-core
```

Успешное выполнение подтверждает, что порядок и код shared-пакетов корректны.
