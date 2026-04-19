# Индекс документации

Точка входа для разработчиков. Вся документация организована по категориям в поддиректориях `docs/`.

---

## Участие и решения

- [CONTRIBUTING.md](../CONTRIBUTING.md) — PR, стиль, ADR
- [ADR (архитектурные решения)](adr/README.md) — каталог `docs/adr/`

## Архитектура

- [ARCHITECTURE.md](architecture/ARCHITECTURE.md) — архитектура системы, принципы, границы сервисов, потоки данных
- [TABLE_OWNERSHIP.md](architecture/TABLE_OWNERSHIP.md) — владение таблицами между сервисами
- [SHARED_BUILD_ORDER.md](architecture/SHARED_BUILD_ORDER.md) — порядок сборки shared пакетов (monorepo)
- [STAGES.md](architecture/STAGES.md) — этапы разработки

## API и контракты

- [CRM_API.md](api/CRM_API.md) — публичное CRM API
- [INTERNAL_API.md](api/INTERNAL_API.md) — межсервисные HTTP-контракты
- [SERVICE_HTTP_CLIENT_INVENTORY.md](api/SERVICE_HTTP_CLIENT_INVENTORY.md) — инвентаризация `ServiceHttpClient`, env и таймауты
- [EVENT_HANDLER_POLICY.md](api/EVENT_HANDLER_POLICY.md) — политика обработки событий

## Предметная область

- [MESSAGING_ARCHITECTURE.md](domain/MESSAGING_ARCHITECTURE.md) — архитектура мессенджера
- [TELEGRAM_MESSAGING_FLOW.md](domain/TELEGRAM_MESSAGING_FLOW.md) — поток Telegram сообщений
- [TELEGRAM_API_ANALYSIS.md](domain/TELEGRAM_API_ANALYSIS.md) — анализ Telegram API
- [CAMPAIGNS.md](domain/CAMPAIGNS.md) — кампании холодного outreach
- [CAMPAIGN_FLOW_AND_LOGS.md](domain/CAMPAIGN_FLOW_AND_LOGS.md) — поток кампаний и логирование
- [CAMPAIGN_AI.md](domain/CAMPAIGN_AI.md) — AI-репрайз в кампаниях
- [TELEGRAM_PARSE_FLOW.md](domain/TELEGRAM_PARSE_FLOW.md) — парсинг Telegram (поиск, участники, ротация)
- [OUTREACH_BEST_PRACTICES.md](domain/OUTREACH_BEST_PRACTICES.md) — лучшие практики рассылок

## Продукт

- [MASTER_PLAN.md](product/MASTER_PLAN.md) — мастер-план Messaging-First AI-CRM
- [COMPETITOR_ANALYSIS.md](product/COMPETITOR_ANALYSIS.md) — анализ конкурентов (CRMChat)
- [ROADMAP.md](ROADMAP.md) — дорожная карта и приоритеты

## Операции

- [DEPLOYMENT.md](operations/DEPLOYMENT.md) — развёртывание и безопасность
- [GETTING_STARTED.md](operations/GETTING_STARTED.md) — быстрый старт для разработчиков
- [TESTING.md](operations/TESTING.md) — тестирование
- [MIGRATIONS.md](operations/MIGRATIONS.md) — миграции БД (Knex)

## Runbooks

- [ORPHAN_MESSAGES.md](runbooks/ORPHAN_MESSAGES.md) — orphan сообщения при удалении BD-аккаунта
- [BD_ACCOUNTS_TIMEOUT.md](runbooks/BD_ACCOUNTS_TIMEOUT.md) — таймауты GramJS
