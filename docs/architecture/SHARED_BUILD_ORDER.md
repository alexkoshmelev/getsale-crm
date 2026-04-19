# Порядок сборки shared-пакетов

**Дата:** 2026-04-12

## Назначение

Пакеты в `shared/*` собираются через `tsc`. Порядок должен соответствовать графу зависимостей: у каждого пакета уже есть собранные `dist/` у зависимостей.

## Канонический порядок

См. [`services/Dockerfile.template`](../../services/Dockerfile.template) и скрипт **`build:stack`** в корневом [`package.json`](../../package.json):

**types → logger → events → cache → queue → service-framework → telegram**

Затем собирается нужный сервис в `services/<name>`.

## Где соблюдать порядок

- **`services/Dockerfile.template`** — прод-образы бэкендов
- **`npm run build:stack`** — локальная полная сборка

При добавлении пакета или новой зависимости обновите порядок в этих местах и здесь.

## Проверка локально

```bash
npm run build:stack
```
