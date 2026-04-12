# Порядок сборки shared-пакетов (v2)

**Дата:** 2026-04-12

## Назначение

Пакеты в `shared-v2/*` собираются через `tsc`. Порядок должен соответствовать графу зависимостей: у каждого пакета уже есть собранные `dist/` у зависимостей.

## Канонический порядок (v2)

См. [`services-v2/Dockerfile.template`](../../services-v2/Dockerfile.template) и скрипт **`build:v2`** в корневом [`package.json`](../../package.json):

**types → logger → events → cache → queue → service-framework → telegram**

Затем собирается нужный сервис в `services-v2/<name>`.

## Где соблюдать порядок

- **`services-v2/Dockerfile.template`** — прод-образы бэкендов
- **`npm run build:v2`** — локальная полная сборка

При добавлении пакета или новой зависимости обновите порядок в этих местах и здесь.

## Проверка локально

```bash
npm run build:v2
```
