# BD CRM System - Обновленная архитектура

## Обзор

Система построена по микросервисной архитектуре с event-driven подходом, полностью соответствующая требованиям BD CRM промпта.

## Микросервисы

### 1. Auth Service (Port 3001)
**Технологии**: Node.js + Express + JWT + bcryptjs

**Функции**:
- Регистрация и авторизация пользователей
- Управление JWT токенами (access + refresh)
- OAuth интеграции (Google, GitHub, Telegram) - TODO
- Двухфакторная аутентификация (2FA) - TODO

**API Endpoints**:
```
POST /api/auth/signup
POST /api/auth/signin
POST /api/auth/verify
POST /api/auth/refresh
```

### 2. User Service (Port 3006)
**Технологии**: Node.js + Express + Stripe SDK

**Функции**:
- Управление профилями пользователей
- Подписки и биллинг (Stripe)
- Управление командами и ролями
- User preferences

**API Endpoints**:
```
GET    /api/users/profile
PUT    /api/users/profile
GET    /api/users/subscription
POST   /api/users/subscription/upgrade
POST   /api/users/team/invite
```

### 3. BD Accounts Service (Port 3007)
**Технологии**: Node.js + Express + GramJS (telegram)

**Функции**:
- CRUD BD аккаунтов
- Подключение собственных аккаунтов (Telegram через GramJS)
- Покупка/аренда аккаунтов
- Управление статусами и лимитами

**API Endpoints**:
```
GET    /api/bd-accounts
POST   /api/bd-accounts/connect
POST   /api/bd-accounts/purchase
GET    /api/bd-accounts/:id/status
PUT    /api/bd-accounts/:id/config
```

**Telegram Integration (GramJS)**:
```javascript
// Подключение Telegram аккаунта
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');

async function connectTelegramAccount(apiId, apiHash, phoneNumber) {
  const client = new TelegramClient(
    new StringSession(''),
    apiId,
    apiHash,
    { connectionRetries: 5 }
  );
  
  await client.start({
    phoneNumber: async () => phoneNumber,
    password: async () => await input.text('Password?'),
    phoneCode: async () => await input.text('Code?'),
    onError: (err) => console.log(err),
  });
  
  return client.session.save();
}
```

### 4. CRM Service (Port 3002)
**Технологии**: Node.js + Express + PostgreSQL

**Функции**:
- CRUD клиентов (contacts)
- CRUD компаний
- CRUD сделок (deals)
- Базовая фильтрация и поиск

**API Endpoints**:
```
GET    /api/crm/clients (contacts)
POST   /api/crm/clients
GET    /api/crm/companies
POST   /api/crm/companies
GET    /api/crm/deals
POST   /api/crm/deals
PATCH  /api/crm/deals/:id/stage
```

### 5. Pipeline Service (Port 3008)
**Технологии**: Node.js + Express + PostgreSQL

**Функции**:
- Управление воронкой продаж
- CRUD стадий
- Перемещение клиентов по стадиям
- История переходов

**API Endpoints**:
```
GET    /api/pipeline
POST   /api/pipeline
GET    /api/pipeline/stages
POST   /api/pipeline/stages
PUT    /api/pipeline/clients/:clientId/stage
```

**База данных (PostgreSQL)**:
```sql
-- Таблица воронок
CREATE TABLE pipelines (
  id UUID PRIMARY KEY,
  organization_id UUID NOT NULL,
  name VARCHAR(255) NOT NULL,
  is_default BOOLEAN DEFAULT false
);

-- Таблица стадий
CREATE TABLE stages (
  id UUID PRIMARY KEY,
  pipeline_id UUID REFERENCES pipelines(id),
  name VARCHAR(100) NOT NULL,
  order_index INTEGER NOT NULL,
  color VARCHAR(20),
  automation_rules JSONB
);

-- Таблица истории перемещений
CREATE TABLE stage_history (
  id UUID PRIMARY KEY,
  client_id UUID NOT NULL,
  deal_id UUID,
  from_stage_id UUID REFERENCES stages(id),
  to_stage_id UUID REFERENCES stages(id),
  moved_by UUID,
  moved_at TIMESTAMP DEFAULT NOW(),
  auto_moved BOOLEAN DEFAULT FALSE
);
```

### 6. Messaging Service (Port 3003)
**Технологии**: Node.js + Express + GramJS + MongoDB

**Функции**:
- Получение и отправка сообщений
- Синхронизация чатов из разных платформ
- Webhook обработка входящих сообщений
- Real-time уведомления через WebSocket

**API Endpoints**:
```
GET    /api/messaging/inbox
GET    /api/messaging/messages
POST   /api/messaging/send
PATCH  /api/messaging/messages/:id/read
```

**MongoDB структура сообщений**:
```javascript
{
  _id: ObjectId,
  bdAccountId: UUID,
  chatId: String,
  platform: 'telegram' | 'linkedin' | 'email' | 'twitter',
  sender: {
    id: String,
    name: String,
    type: 'client' | 'bd'
  },
  content: {
    text: String,
    media: [{ type: String, url: String }]
  },
  clientId: UUID,
  timestamp: ISODate,
  read: Boolean,
  metadata: Object
}
```

### 7. Automation Service (Port 3009)
**Технологии**: Node.js + Express + node-cron + PostgreSQL

**Функции**:
- Автоматический переход по стадиям
- Триггеры на основе времени (cron)
- Триггеры на основе действий клиента
- Уведомления и напоминания

**Правила автоматизации**:
```javascript
const automationRules = [
  {
    id: 'time-based-lead-to-qualified',
    trigger: 'time_elapsed',
    condition: {
      stage: 'lead',
      elapsed_hours: 24,
      has_response: true
    },
    action: {
      move_to_stage: 'qualified'
    }
  },
  {
    id: 'client-responded',
    trigger: 'message.received',
    condition: {
      stage: 'lead',
      is_first_response: true
    },
    action: {
      move_to_stage: 'qualified',
      notify_team: true
    }
  }
];
```

**API Endpoints**:
```
GET    /api/automation/rules
POST   /api/automation/rules
```

### 8. Analytics Service (Port 3010)
**Технологии**: Node.js + Express + PostgreSQL + Redis

**Функции**:
- Сбор метрик конверсии
- Аналитика воронки
- Отчеты по командам
- Экспорт данных

**API Endpoints**:
```
GET /api/analytics/conversion-rates
GET /api/analytics/pipeline-value
GET /api/analytics/team-performance
GET /api/analytics/export
```

### 9. Team Service (Port 3011)
**Технологии**: Node.js + Express + PostgreSQL

**Функции**:
- Управление командами
- Распределение клиентов
- Права доступа
- Общая база клиентов с фильтрацией

**API Endpoints**:
```
GET    /api/team/members
POST   /api/team/members/invite
PUT    /api/team/members/:id/role
POST   /api/team/clients/assign
GET    /api/team/clients/shared
```

### 10. WebSocket Service (Port 3004)
**Технологии**: Node.js + Socket.io + Redis Adapter

**Функции**:
- Real-time обновления для всех сервисов
- Broadcasting событий по организациям
- Подписки на комнаты

**События**:
```javascript
// Новое сообщение
io.to(`bd-account-${bdAccountId}`).emit('new-message', {
  chatId,
  message,
  unreadCount
});

// Обновление клиента в CRM
io.to(`team-${teamId}`).emit('client-updated', {
  clientId,
  changes
});

// Изменение стадии
io.to(`team-${teamId}`).emit('stage-changed', {
  clientId,
  fromStage,
  toStage,
  autoMoved
});
```

### 11. AI Service (Port 3005)
**Технологии**: Node.js + Express + OpenAI

**Функции**:
- Генерация AI drafts для ответов
- Предложения по переходам стадий
- Анализ тона сообщений

**API Endpoints**:
```
POST   /api/ai/drafts/generate
GET    /api/ai/drafts/:id
POST   /api/ai/drafts/:id/approve
```

## База данных

### PostgreSQL (Главная БД)
**Хранит**:
- Пользователи и аутентификация
- BD аккаунты
- Клиенты и воронка
- Команды и права доступа
- Подписки и платежи
- Автоматизация правила

### MongoDB (Сообщения и логи)
**Хранит**:
- Все сообщения из всех платформ
- История переписок
- Медиа файлы (ссылки на S3)
- Логи событий системы

### Redis
**Использование**:
- Кэширование данных
- Сессии пользователей
- WebSocket состояния (Socket.io Redis Adapter)
- Rate limiting
- Message Queue (опционально, сейчас RabbitMQ)

## Интеграции мессенджеров

### Telegram (GramJS) ✅
- Получение всех чатов
- Отправка сообщений
- Получение новых сообщений (event handlers)
- Обработка медиа файлов

### LinkedIn (Future)
**Технологии**: Puppeteer + LinkedIn API (limited) + Proxies

### Email (Future)
**Технологии**: Nodemailer + IMAP

### Twitter (Future)
**Технологии**: Twitter API v2

## Автоматизация

### Bull Queue Jobs (TODO - сейчас RabbitMQ + node-cron)
**Типы задач**:
- Проверка времени для автоматических переходов
- Синхронизация сообщений
- Отправка уведомлений
- Генерация отчетов

**Пример задачи**:
```javascript
// Проверка клиентов для автоматического перехода
automationQueue.process('check-stage-transitions', async (job) => {
  const clients = await Client.findAll({
    where: {
      stage_id: job.data.stageId,
      created_at: {
        [Op.lt]: new Date(Date.now() - 24 * 60 * 60 * 1000)
      }
    }
  });
  
  for (const client of clients) {
    const hasResponse = await checkClientResponded(client.id);
    if (hasResponse) {
      await moveClientToStage(client.id, 'qualified');
      await notifyTeam(client.assigned_to, client.id);
    }
  }
});
```

## Безопасность

### Аутентификация
- JWT токены (access + refresh)
- Secure HTTP-only cookies (TODO)
- Rate limiting на все endpoints

### Авторизация
- Role-based access control (RBAC)
- Team-based permissions
- Row-level security в PostgreSQL (через organization_id)

### Защита данных
- Шифрование паролей (bcryptjs)
- Шифрование чувствительных данных (API ключи, токены) - TODO
- HTTPS везде
- Input validation и sanitization

## Масштабирование

### Горизонтальное масштабирование
- Stateless микросервисы
- Load balancer (API Gateway)
- Redis для shared state
- Database connection pooling
- Socket.io Redis Adapter для WebSocket scaling

### Оптимизация
- Кэширование в Redis
- Database indexes
- Pagination для больших списков
- Lazy loading в UI

## Мониторинг

### Инструменты
- **Prometheus + Grafana**: Метрики
- **ELK Stack**: Централизованные логи (TODO)
- **Jaeger**: Distributed tracing
- **Sentry**: Error tracking (TODO)

### Ключевые метрики
- API response times
- Database query performance
- Message delivery rate
- WebSocket connections
- Error rates

## Деплой

### Инфраструктура
- **Backend**: Docker Compose (dev) / Kubernetes (prod)
- **Database**: PostgreSQL + MongoDB
- **Cache**: Redis
- **Storage**: AWS S3 (TODO)
- **CDN**: CloudFlare (TODO)

### CI/CD
- GitHub Actions (TODO)
- Automated testing (TODO)
- Staging environment (TODO)
- Blue-green deployment (TODO)

## Этапы разработки (MVP)

### Phase 1 (4-6 недель) ✅
- ✅ Auth Service + User Service
- ✅ BD Accounts Service (базовый)
- ✅ Messaging Service (Telegram GramJS)
- ⏳ Базовый UI для чатов

### Phase 2 (4-6 недель) ⏳
- ✅ CRM Service (воронка)
- ⏳ UI для Kanban и списка
- ✅ Ручное перемещение по стадиям
- ✅ Team Service (базовый)

### Phase 3 (3-4 недели) ⏳
- ✅ Automation Service
- ✅ Analytics Service
- ⏳ Dashboard с метриками
- ✅ Stripe интеграция

### Phase 4 (4-6 недель) ⏳
- ⏳ LinkedIn интеграция
- ⏳ Email интеграция
- ⏳ Twitter интеграция
- ⏳ Расширенная автоматизация

