# Database Migrations & Seeding

## 🚀 Production-Ready Setup

Мы используем **Knex.js** - industry standard для миграций в Node.js, используемый тысячами компаний в продакшене.

## Быстрый старт

После запуска `docker compose up -d` миграции выполняются автоматически через сервис `migrations`.

## Ручной запуск

### Миграции

```bash
# Запустить все миграции
docker compose run --rm migrations npm run migrate

# Откатить последнюю миграцию
docker compose run --rm migrations npm run migrate:rollback

# Проверить статус миграций
docker compose run --rm migrations npm run migrate:status

# Или локально (если установлены зависимости)
cd migrations
npm install
npm run migrate
```

### Seed данных

```bash
# Запустить seed
docker compose run --rm migrations npm run seed

# Или локально
cd migrations
npm run seed
```

## Структура

```
migrations/
  migrations/              # Файлы миграций (с timestamp)
    - 20241225000001_initial_schema.ts
  seeds/                   # Seed файлы
    - 001_initial_data.ts
  knexfile.ts             # Конфигурация Knex
  run-migrations.ts        # Скрипт запуска миграций
```

## Дефолтные учетные данные

После выполнения seed:

- **Админ**: `admin@getsale.com` / `admin123`
- **Тестовый пользователь**: `test@getsale.com` / `test123`

## Создание новых миграций

```bash
cd migrations
npm run migrate:make название_миграции
```

Knex автоматически создаст файл с timestamp в формате `YYYYMMDDHHMMSS_название_миграции.ts`.

## Почему Knex.js?

✅ **Production-ready** - Используется в продакшене тысячами компаний
✅ **Надежный** - Проверен временем, отличная обработка ошибок
✅ **Транзакционный** - Каждая миграция выполняется в транзакции
✅ **Версионирование** - Автоматическое отслеживание выполненных миграций
✅ **Откат** - Легкий откат миграций
✅ **TypeScript** - Полная поддержка TypeScript
✅ **Без ORM** - Работает с raw SQL, идеально для микросервисов

## Best Practices для продакшена

1. **Всегда тестируйте миграции** - Тестируйте `up` и `down` локально
2. **Бэкап перед миграцией** - Всегда делайте бэкап продакшн БД
3. **Транзакции** - Knex автоматически выполняет миграции в транзакциях
4. **Версионирование** - Коммитьте все файлы миграций в git
5. **Не изменяйте выполненные миграции** - Создавайте новые миграции
6. **Мониторинг** - Проверяйте таблицу `knex_migrations` для статуса
7. **План отката** - Всегда имейте стратегию отката
