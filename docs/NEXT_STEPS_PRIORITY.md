# Приоритетные следующие шаги

**Дата:** 2025-01-21  
**Текущая готовность:** ~55%

Документ отражает **что делать дальше** после завершения Telegram-интеграции, WebSocket и Messaging. Детали по доменам — в [CURRENT_STATE_ANALYSIS.md](./CURRENT_STATE_ANALYSIS.md), план по фазам — в [ACTION_PLAN.md](./ACTION_PLAN.md).

**Для фокуса «Telegram-like CRM»** актуальные приоритеты и бэклог см. в **[MASTER_PLAN_MESSAGING_FIRST_CRM.md](./MASTER_PLAN_MESSAGING_FIRST_CRM.md)** — Часть 6 (текущее состояние и приоритеты).

---

## 1. Критично (MVP)

### 1.1 Полные CRUD по сервисам

- **CRM Service**
  - Добавить: `GET /api/crm/companies/:id`, `PUT /api/crm/companies/:id`, `DELETE /api/crm/companies/:id`
  - Добавить: `GET /api/crm/contacts/:id`, `DELETE /api/crm/contacts/:id` (PATCH уже есть)
  - Добавить: `GET /api/crm/deals/:id`, `PUT /api/crm/deals/:id`, `DELETE /api/crm/deals/:id`
  - Пагинация и поиск для списков companies/contacts/deals
- **Pipeline Service**
  - `PUT /api/pipeline/:id`, `DELETE /api/pipeline/:id`
  - `PUT /api/pipeline/stages/:id`, `DELETE /api/pipeline/stages/:id`
  - При необходимости: `GET /api/pipeline/stages/:id/history`
- Остальные сервисы (Automation, Team и т.д.) — по тому же принципу: GET by id, PUT, DELETE, пагинация где нужно.

### 1.2 Валидация

- Бэкенд: Zod (или Joi) для всех входных тел запросов (создание/обновление).
- Фронтенд: React Hook Form + та же схема (Zod) для форм создания/редактирования.
- Проверка бизнес-правил (например, стадия сделки из списка стадий воронки).

### 1.3 Централизованная обработка ошибок

- Общий error middleware: класс ошибки (например `AppError`) с `statusCode` и `code`.
- Единый формат ответа: `{ error: string, code?: string }`.
- Логирование (Winston/Pino) и при возможности интеграция с Sentry.

### 1.4 Безопасность

- API Gateway: rate limiting (по IP и/или по пользователю).
- Helmet для security headers.
- CORS только с разрешённых origins.
- Санитизация входных данных (escape, trim) на критичных полях.

### 1.5 Campaign Service

- Новый микросервис: CRUD кампаний, шаблоны сообщений, sequences (многошаговые сценарии), расписание, базовая статистика.
- Интеграция с Messaging/BD Accounts для отправки по выбранным каналам.

---

## 2. Важно (полноценный продукт)

- **Email:** отправка приглашений, восстановление пароля, уведомления (SendGrid/Resend и т.п.).
- **MFA:** TOTP (speakeasy + QR), верификация при входе, backup codes.
- **AI Service:** approve/reject для drafts, сохранение истории drafts в БД.
- **Мониторинг:** структурированные логи, метрики Prometheus, дашборды Grafana, алерты.
- **Тестирование:** unit (критичные сервисы), integration (API + RabbitMQ), E2E (ключевые сценарии).

---

## 3. Можно после MVP

- UX: skeletons, toasts, drag-and-drop Kanban, индикатор WebSocket в UI.
- Оптимизация: кеш в Redis, индексы БД, code splitting на фронте.
- Расширения: медиа в Telegram, Email/LinkedIn каналы, Campaign A/B тесты.

---

## Рекомендуемый порядок работ

1. **Неделя 1:** CRUD в CRM (companies, contacts, deals) + пагинация/поиск → затем валидация (Zod) и error handler в CRM и одном из сервисов как образец.
2. **Неделя 2:** Распространить CRUD + валидацию + error handling на Pipeline и остальные сервисы; включить безопасность (rate limit, Helmet, CORS) в API Gateway.
3. **Неделя 3:** Campaign Service (структура, CRUD, шаблоны, sequences, вызов отправки через Messaging).
4. **Далее:** Email, MFA, доработка AI, мониторинг, тесты — по приоритету из раздела «Важно».

После каждого блока — обновлять [CURRENT_STATE_ANALYSIS.md](./CURRENT_STATE_ANALYSIS.md) и чеклисты в [ACTION_PLAN.md](./ACTION_PLAN.md).
