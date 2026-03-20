# Индекс документации (вход для разработчиков)

## Участие и решения

- [CONTRIBUTING.md](../CONTRIBUTING.md) — PR, стиль, **ADR**  
- [ADR (архитектурные решения)](adr/README.md) — канонический каталог `docs/adr/`  

## Архитектура и целевое состояние

- [ARCHITECTURE.md](ARCHITECTURE.md) — текущий стек и сервисы  
- [TARGET_SAAS_CRM_ARCHITECTURE.md](TARGET_SAAS_CRM_ARCHITECTURE.md) — целевая модель SaaS CRM под нагрузку  
- [CURRENT_SYSTEM_AS_IS.md](CURRENT_SYSTEM_AS_IS.md) — как устроено в коде сейчас (границы, дубли, SRP)  
- [MIGRATION_TO_TARGET_ARCHITECTURE.md](MIGRATION_TO_TARGET_ARCHITECTURE.md) — фазы перехода к целевому состоянию  

## Контракты и операции

- [INTERNAL_API.md](INTERNAL_API.md) — межсервисные HTTP-вызовы  
- [SERVICE_HTTP_CLIENT_INVENTORY.md](SERVICE_HTTP_CLIENT_INVENTORY.md) — где создан `ServiceHttpClient`, env и таймауты (B1)  
- [CRM_API.md](CRM_API.md) — публичное CRM API (обзор)  
- [DEPLOYMENT.md](DEPLOYMENT.md) — развёртывание и безопасность  

## Предметная область (флоу)

- [MESSAGING_ARCHITECTURE.md](MESSAGING_ARCHITECTURE.md)  
- [TELEGRAM_MESSAGING_FLOW.md](TELEGRAM_MESSAGING_FLOW.md)  
- [CAMPAIGNS.md](CAMPAIGNS.md), [CAMPAIGN_FLOW_AND_LOGS.md](CAMPAIGN_FLOW_AND_LOGS.md)  
- [PLAN_TELEGRAM_PARSE_FLOW.md](PLAN_TELEGRAM_PARSE_FLOW.md)  

## Состояние продукта

- [STATE_AND_ROADMAP.md](STATE_AND_ROADMAP.md)  

## Runbooks

- [RUNBOOK_ORPHAN_MESSAGES.md](RUNBOOK_ORPHAN_MESSAGES.md) — удаление BD-аккаунта и orphan `messages`  

## Владение данными

- [TABLE_OWNERSHIP_A1.md](../ai_docs/develop/TABLE_OWNERSHIP_A1.md)  
