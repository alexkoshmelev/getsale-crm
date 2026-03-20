---
name: Proxy Delay Status Upgrade
overview: Внедрить прокси в onboarding, диапазон задержки в секундах с рандомом, и надежный lifecycle-статус BD-аккаунтов с явным отключением при фатальных Telegram auth-ошибках.
todos: []
isProject: false
---

# План доработок BD-аккаунтов и рассылок

## Цели

- Добавить прокси (SOCKS5/HTTP) прямо в шаг подключения аккаунта (phone/QR).
- Перейти с фиксированной задержки на диапазон `min-max` в секундах с рандомом на каждую отправку.
- Показать в UI статус прокси по аккаунту (включен/выключен + health).
- Ввести явный «фатально отключен» для аккаунтов при `AUTH_KEY_UNREGISTERED` и похожих ошибках, исключив их из reconnect-цикла и отправок.

## 1) Прокси в onboarding (phone/QR)

- **Frontend connect flow**: расширить форму подключения в [c:\Work\getsale-crm\frontend\app\dashboard\bd-accounts\components\ConnectModal.tsx](c:\Work\getsale-crm\frontend\app\dashboard\bd-accounts\components\ConnectModal.tsx) и состояние в [c:\Work\getsale-crm\frontend\app\dashboard\bd-accounts\hooks\useBdAccountsConnect.ts](c:\Work\getsale-crm\frontend\app\dashboard\bd-accounts\hooks\useBdAccountsConnect.ts):
  - toggle «Использовать прокси»
  - тип: `socks5 | http`
  - host/port/user/pass (опционально auth)
- **API contract**: добавить proxy payload в auth endpoints в [c:\Work\getsale-crm\services\bd-accounts-service\src\routes\auth.ts](c:\Work\getsale-crm\services\bd-accounts-service\src\routes\auth.ts) + схемы в [c:\Work\getsale-crm\services\bd-accounts-service\src\validation.ts](c:\Work\getsale-crm\services\bd-accounts-service\src\validation.ts).
- **Persistence**: сохранять `proxy_config` в `bd_accounts` на этапе connect (сейчас есть только PATCH после подключения) через существующую колонку из миграции `20260313120001`.
- **Telegram init**: пробросить proxy в `send-code`, `verify-code`, `start-qr-login` пути (использовать текущий `buildTelegramProxy` в telegram layer).

## 2) Диапазон задержки (секунды) + рандом

- **Новый контракт audience**:
  - `sendDelayMinSeconds`
  - `sendDelayMaxSeconds`
  - legacy fallback: если есть только `sendDelaySeconds`, трактовать как `min=max=sendDelaySeconds`.
- **Frontend UI**: заменить пресеты в [c:\Work\getsale-crm\frontend\components\campaigns\CampaignAudienceSchedule.tsx](c:\Work\getsale-crm\frontend\components\campaigns\CampaignAudienceSchedule.tsx) на секционный диапазон (двухпозиционный слайдер + точные секунды input), плюс формат `mm:ss`.
- **Validation/API**: обновить [c:\Work\getsale-crm\services\campaign-service\src\validation.ts](c:\Work\getsale-crm\services\campaign-service\src\validation.ts):
  - `0 <= min <= max`
  - разумный cap (например `<= 3600` или согласованный бизнес-лимит).
- **Worker usage**:
  - [c:\Work\getsale-crm\services\campaign-service\src\routes\execution.ts](c:\Work\getsale-crm\services\campaign-service\src\routes\execution.ts)
  - [c:\Work\getsale-crm\services\campaign-service\src\event-handlers.ts](c:\Work\getsale-crm\services\campaign-service\src\event-handlers.ts)
  - [c:\Work\getsale-crm\services\campaign-service\src\campaign-loop.ts](c:\Work\getsale-crm\services\campaign-service\src\campaign-loop.ts)
  - Семплировать случайную задержку `rand(min,max)` на каждый send cycle; использовать ее для enqueue/stagger и пост-send sleep консистентно.

## 3) Визуализация прокси по аккаунту

- **Backend list/detail**: добавить в list endpoint поля `proxy_config` и агрегированный `proxy_status` (например: `none | configured | ok | error`).
- **Health check**: реализовать lightweight proxy-check при connect/reconnect и периодически (или on-demand), писать `last_proxy_check_at`, `last_proxy_error`.
- **Frontend badges**:
  - [c:\Work\getsale-crm\frontend\app\dashboard\bd-accounts\page.tsx](c:\Work\getsale-crm\frontend\app\dashboard\bd-accounts\page.tsx)
  - [c:\Work\getsale-crm\frontend\components\messaging\AccountList.tsx](c:\Work\getsale-crm\frontend\components\messaging\AccountList.tsx)
  - Зеленый/красный индикатор + tooltip с причиной.

## 4) Реальный lifecycle-статус аккаунта и фатальные ошибки

- **Fatal classifier** в bd-accounts-service (`AUTH_KEY_UNREGISTERED`, `SESSION_REVOKED`, `USER_DEACTIVATED`, etc.) в connection/event error handlers.
- **State model**:
  - в `bd_accounts` добавить поля: `connection_state` (`connected|reconnecting|disconnected|reauth_required`), `disconnect_reason`, `last_error_code`, `last_error_at`.
  - при fatal: выставлять `reauth_required`, опционально `is_active=false`, и **не планировать reconnect**.
- **Routing guards**: send/read/typing должны быстро возвращать понятную ошибку «требуется переподключение».
- **UI**: показывать состояние «Отключен: требуется повторный вход» и CTA на re-login.

## 5) Совместимость и rollout

- Добавить обратную совместимость по задержке (`sendDelaySeconds` -> min/max).
- Для аккаунтов без новых полей отображать безопасные дефолты.
- Feature flags (опционально): `proxyOnConnect`, `delayRangeV2`, `accountLifecycleV2` для мягкого релиза.

## 6) Проверка и приемка

- Unit/integration для:
  - proxy schema + auth flow (phone и QR)
  - delay sampling + fallback
  - fatal auth classification and reconnect suppression
- E2E smoke:
  - подключение с/без прокси
  - запуск кампании с `3:13` диапазоном
  - симуляция `AUTH_KEY_UNREGISTERED` и проверка UI-статуса/исключения из цикла.

## Что еще улучшить в текущем вайбе

- Унифицировать «периодичности» во всем UI (кампании, ретраи, синк) на единый seconds-based control компонент.
- Добавить «журнал причин отключений» (последние N событий) для поддержки.
- Ввести account health score (auth/session/proxy/send-fail-rate) и фильтры в списке BD аккаунтов.
- Добавить автоматический guard в campaign loop:

