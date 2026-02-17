# Database Migrations

This directory contains database migrations and seed scripts using **Knex.js** - the industry standard for production-ready database migrations in Node.js.

## Why Knex.js?

✅ **Production-ready** - Used by thousands of companies in production  
✅ **Reliable** - Battle-tested with excellent error handling  
✅ **Transactional** - Each migration runs in a transaction  
✅ **Versioning** - Automatic tracking of executed migrations  
✅ **Rollback support** - Easy rollback with `migrate:rollback`  
✅ **TypeScript support** - Full TypeScript support out of the box  
✅ **No ORM required** - Works with raw SQL, perfect for microservices  

## Structure

```
migrations/
  migrations/              # Migration files (timestamped)
    - 20241225000001_initial_schema.ts
  seeds/                   # Seed files
    - 001_initial_data.ts   # Admin/Test workspaces, pipelines, teams
    - 002_demo_access.ts   # Demo workspace (5 users, demo Telegram accounts, chats, messages)
  knexfile.ts             # Knex configuration
  run-migrations.ts       # Migration runner script
  package.json            # Dependencies
  Dockerfile              # Docker image for migrations
```

## Usage

### Automatic Migrations

Migrations run automatically when you start the Docker Compose stack:

```bash
docker compose up -d
```

The `migrations` service will:
1. Wait for PostgreSQL to be ready
2. Run all pending migrations in transactions
3. Track executed migrations in `knex_migrations` table
4. Exit successfully

### Manual Migration Commands

```bash
# Run all pending migrations
npm run migrate

# Rollback last migration
npm run migrate:rollback

# Rollback all migrations
npm run migrate:rollback -- --all

# Check migration status
npm run migrate:status

# Create new migration
npm run migrate:make migration_name
```

### Seeding Database

```bash
# Run all seeds
npm run seed

# Create new seed file
npm run seed:make seed_name
```

Or using Docker:

```bash
docker compose run --rm migrations npm run seed
```

## Default Credentials and Workspaces

After seeding, two users and two workspaces are created with cross-membership:

- **Admin**: `admin@getsale.com` / `admin123`  
  - Owner in **Admin Workspace** (slug: `admin-workspace`)  
  - Admin in **Test Workspace** (slug: `test-workspace`)
- **Test User**: `test@getsale.com` / `test123`  
  - Owner in **Test Workspace**  
  - Admin in **Admin Workspace**

Each workspace has: default pipeline and stages, team, company, contact, deal, subscription, and invite link. Use the workspace switcher in the sidebar to change context.

### Demo workspace (для показа заказчикам)

Сид `002_demo_access.ts` создаёт отдельный воркспейс **Demo Workspace** (slug: `demo-workspace`) с готовыми данными «как после 1–2 недель работы»:

- **5 пользователей в команде:** `demo1@getsale.com` … `demo5@getsale.com`, пароль: `demo123`
- **5 демо-аккаунтов Telegram** (по одному на пользователя): чаты и сообщения только в БД, **без подключения к серверам Telegram**
- **50 контактов**, по **10 чатов на аккаунт**, в каждом **15–40 сообщений** за последние 14 дней
- **Воронка и сделки** для фильтрации и сортировки

Демо-аккаунты помечены флагом `is_demo`: отправка сообщений и подключение к Telegram для них отключены. Удобно использовать для демонстрации продукта без риска и нагрузки на Telegram API.

После выполнения сидов (`npm run seed`) войдите под любым из `demo1@getsale.com` … `demo5@getsale.com` и выберите воркспейс **Demo Workspace**.

## Production Best Practices

1. **Always test migrations** - Test both `up` and `down` migrations locally
2. **Backup before migration** - Always backup production database before running migrations
3. **Use transactions** - Knex runs each migration in a transaction automatically
4. **Version control** - Commit all migration files to git
5. **Never modify executed migrations** - Create new migrations instead
6. **Monitor migration execution** - Check `knex_migrations` table for status
7. **Rollback plan** - Always have a rollback strategy

## Migration Naming

Knex automatically generates timestamps for migrations:
- Format: `YYYYMMDDHHMMSS_migration_name.ts`
- Example: `20241225000001_initial_schema.ts`

This ensures migrations run in the correct order.
