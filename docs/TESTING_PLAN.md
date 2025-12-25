# План тестирования и разработки платформы

## Этап 1: Базовое тестирование сервисов ✅

### 1.1 Инфраструктура
- [x] PostgreSQL запускается и доступен
- [x] Redis запускается и доступен
- [x] RabbitMQ запускается и доступен
- [x] MongoDB запускается (для сообщений)
- [x] Все сервисы подключаются к инфраструктуре

### 1.2 Health Checks
- [ ] API Gateway `/health`
- [ ] Auth Service `/health`
- [ ] User Service `/health`
- [ ] BD Accounts Service `/health`
- [ ] CRM Service `/health`
- [ ] Pipeline Service `/health`
- [ ] Messaging Service `/health`
- [ ] Automation Service `/health`
- [ ] Analytics Service `/health`
- [ ] Team Service `/health`
- [ ] WebSocket Service `/health`
- [ ] AI Service `/health`

## Этап 2: Тестирование Auth Flow

### 2.1 Регистрация и авторизация
- [ ] POST `/api/auth/signup` - создание пользователя
- [ ] POST `/api/auth/signin` - вход
- [ ] POST `/api/auth/verify` - проверка токена
- [ ] POST `/api/auth/refresh` - обновление токена

### 2.2 JWT токены
- [ ] Access token работает
- [ ] Refresh token работает
- [ ] Токены истекают корректно

## Этап 3: Тестирование User Service

### 3.1 Профиль пользователя
- [ ] GET `/api/users/profile` - получение профиля
- [ ] PUT `/api/users/profile` - обновление профиля

### 3.2 Подписки
- [ ] GET `/api/users/subscription` - получение подписки
- [ ] POST `/api/users/subscription/upgrade` - обновление подписки

### 3.3 Команды
- [ ] GET `/api/users/team/members` - список участников
- [ ] POST `/api/users/team/invite` - приглашение

## Этап 4: Тестирование BD Accounts

### 4.1 Управление аккаунтами
- [ ] GET `/api/bd-accounts` - список аккаунтов
- [ ] POST `/api/bd-accounts/connect` - подключение Telegram
- [ ] GET `/api/bd-accounts/:id/status` - статус аккаунта
- [ ] PUT `/api/bd-accounts/:id/config` - настройка лимитов

## Этап 5: Тестирование CRM

### 5.1 Компании
- [ ] GET `/api/crm/companies` - список компаний
- [ ] POST `/api/crm/companies` - создание компании

### 5.2 Контакты
- [ ] GET `/api/crm/contacts` - список контактов
- [ ] POST `/api/crm/contacts` - создание контакта

### 5.3 Сделки
- [ ] GET `/api/crm/deals` - список сделок
- [ ] POST `/api/crm/deals` - создание сделки
- [ ] PATCH `/api/crm/deals/:id/stage` - изменение стадии

## Этап 6: Тестирование Pipeline

### 6.1 Воронки
- [ ] GET `/api/pipeline` - список воронок
- [ ] POST `/api/pipeline` - создание воронки

### 6.2 Стадии
- [ ] GET `/api/pipeline/stages` - список стадий
- [ ] POST `/api/pipeline/stages` - создание стадии
- [ ] PUT `/api/pipeline/clients/:id/stage` - перемещение по стадии

## Этап 7: Тестирование Messaging

### 7.1 Сообщения
- [ ] GET `/api/messaging/inbox` - входящие
- [ ] GET `/api/messaging/messages` - список сообщений
- [ ] POST `/api/messaging/send` - отправка сообщения
- [ ] PATCH `/api/messaging/messages/:id/read` - отметка прочитанным

### 7.2 Telegram интеграция
- [ ] Подключение Telegram аккаунта
- [ ] Получение сообщений из Telegram
- [ ] Отправка сообщений в Telegram

## Этап 8: Тестирование Automation

### 8.1 Правила автоматизации
- [ ] GET `/api/automation/rules` - список правил
- [ ] POST `/api/automation/rules` - создание правила
- [ ] Триггеры на события работают
- [ ] Cron jobs работают

## Этап 9: Тестирование Analytics

### 9.1 Метрики
- [ ] GET `/api/analytics/conversion-rates` - конверсии
- [ ] GET `/api/analytics/pipeline-value` - значение воронки
- [ ] GET `/api/analytics/team-performance` - производительность команды
- [ ] GET `/api/analytics/export` - экспорт данных

## Этап 10: Тестирование Team

### 10.1 Команды
- [ ] GET `/api/team/members` - участники
- [ ] POST `/api/team/members/invite` - приглашение
- [ ] PUT `/api/team/members/:id/role` - изменение роли
- [ ] POST `/api/team/clients/assign` - назначение клиента
- [ ] GET `/api/team/clients/shared` - общие клиенты

## Этап 11: Тестирование WebSocket

### 11.1 Real-time обновления
- [ ] Подключение к WebSocket
- [ ] Получение событий в реальном времени
- [ ] Подписки на комнаты
- [ ] Отключение и переподключение

## Этап 12: Тестирование AI Service

### 12.1 AI Drafts
- [ ] POST `/api/ai/drafts/generate` - генерация draft
- [ ] GET `/api/ai/drafts/:id` - получение draft
- [ ] POST `/api/ai/drafts/:id/approve` - одобрение draft

## Этап 13: Event-Driven коммуникация

### 13.1 События
- [ ] `user.created` публикуется и обрабатывается
- [ ] `message.received` публикуется и обрабатывается
- [ ] `deal.stage.changed` публикуется и обрабатывается
- [ ] `ai.draft.generated` публикуется и обрабатывается
- [ ] Все события доставляются корректно

## Этап 14: Фронтенд разработка

### 14.1 Настройка Next.js
- [ ] Создать Next.js проект
- [ ] Настроить TypeScript
- [ ] Настроить Tailwind CSS
- [ ] Настроить shadcn/ui

### 14.2 Аутентификация UI
- [ ] Страница входа
- [ ] Страница регистрации
- [ ] Защита роутов
- [ ] Управление токенами

### 14.3 Dashboard
- [ ] Главная страница
- [ ] Навигация
- [ ] Sidebar
- [ ] Header с профилем

### 14.4 CRM UI
- [ ] Список клиентов
- [ ] Создание/редактирование клиента
- [ ] Kanban воронка
- [ ] Детали сделки

### 14.5 Messaging UI
- [ ] Список чатов
- [ ] Чат интерфейс
- [ ] Отправка сообщений
- [ ] Real-time обновления

### 14.6 Settings UI
- [ ] Настройки профиля
- [ ] Управление подпиской
- [ ] Управление BD аккаунтами
- [ ] Управление командой

### 14.7 Analytics UI
- [ ] Dashboard с метриками
- [ ] Графики конверсий
- [ ] Отчеты
- [ ] Экспорт данных

## Этап 15: End-to-End тестирование

### 15.1 Полные сценарии
- [ ] Регистрация → Создание компании → Создание контакта → Создание сделки
- [ ] Подключение Telegram → Получение сообщения → Ответ → Перемещение по стадии
- [ ] Создание правила автоматизации → Триггер события → Выполнение действия
- [ ] Приглашение в команду → Назначение клиента → Просмотр общих клиентов

## Этап 16: Оптимизация и финализация

### 16.1 Производительность
- [ ] Оптимизация запросов к БД
- [ ] Кеширование в Redis
- [ ] Оптимизация фронтенда
- [ ] Lazy loading

### 16.2 Безопасность
- [ ] Валидация всех входных данных
- [ ] Защита от SQL injection
- [ ] Rate limiting работает
- [ ] CORS настроен правильно

### 16.3 UX улучшения
- [ ] Loading states
- [ ] Error handling
- [ ] Toast notifications
- [ ] Optimistic updates

