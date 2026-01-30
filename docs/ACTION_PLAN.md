# План действий - От текущего состояния к продакшену

**Дата:** 2025-01-21  
**Текущая готовность:** ~55%  
**Целевая готовность:** 100% (продакшен)  
**Срок:** 4-6 недель

---

## 📊 Текущее состояние (кратко)

### ✅ Что работает хорошо
- Все 12 микросервисов запускаются
- Базовая архитектура и event-driven коммуникация работают
- **Telegram (GramJS):** BD Accounts — connect, dialogs, sync-chats, sync-start, send, disconnect; Messaging — полный API (inbox, messages, chats, stats, send)
- **WebSocket:** верификация JWT, heartbeat, rate limiting, комнаты org/user/bd-account/chat, события sync и new-message
- **AI Service:** OpenAI, генерация drafts по событиям и POST/GET endpoints
- Frontend: страницы Auth, Dashboard, CRM, Pipeline, Messaging, BD Accounts, Analytics, Team, Settings; useWebSocket, WebSocket Context
- Миграции БД (в т.ч. bd_account_sync_chats, messages telegram_full)
- Docker Compose для разработки

### ❌ Критичные пробелы
1. **Неполные CRUD операции** — нет GET by id, PUT, DELETE для companies/contacts/deals в CRM; то же для Pipeline и др.
2. **Нет валидации** — ни на бэкенде (Zod/Joi), ни на фронтенде (React Hook Form)
3. **Слабая обработка ошибок** — нет централизованного error handler и структурированных ответов
4. ~~**Telegram интеграция**~~ ✅ реализована
5. **Безопасность** — rate limiting на API Gateway, sanitization, security headers (Helmet)
6. **Campaign Service** — не создан (обязателен для MVP)

---

## 🎯 План по фазам

### ФАЗА 1: Критичные пробелы (2-3 недели)

#### Неделя 1: CRUD + Валидация

**День 1-2: Полные CRUD операции для CRM Service**

```typescript
// Добавить в services/crm-service/src/index.ts:

// Companies
PUT    /api/crm/companies/:id      - Обновление
DELETE /api/crm/companies/:id     - Удаление  
GET    /api/crm/companies/:id      - Детали

// Contacts  
PUT    /api/crm/contacts/:id       - Обновление
DELETE /api/crm/contacts/:id      - Удаление
GET    /api/crm/contacts/:id       - Детали

// Deals
PUT    /api/crm/deals/:id          - Обновление
DELETE /api/crm/deals/:id         - Удаление
GET    /api/crm/deals/:id          - Детали

// Пагинация и поиск
GET    /api/crm/companies?page=1&limit=20&search=...
GET    /api/crm/contacts?page=1&limit=20&search=...
```

**День 3-4: Валидация (Zod)**

```bash
# Установить в каждый сервис
npm install zod
```

```typescript
// Создать shared/validation/src/schemas.ts
import { z } from 'zod';

export const CompanySchema = z.object({
  name: z.string().min(1).max(255),
  industry: z.string().max(100).optional(),
  size: z.enum(['1-10', '11-50', '51-100', '101-500', '500+']).optional(),
  description: z.string().max(5000).optional(),
});

// Использовать в endpoints
app.post('/api/crm/companies', async (req, res) => {
  const validation = CompanySchema.safeParse(req.body);
  if (!validation.success) {
    return res.status(400).json({ error: validation.error });
  }
  // ...
});
```

**День 5: Error Handling**

```typescript
// Создать shared/utils/src/errors.ts
export class AppError extends Error {
  constructor(
    public statusCode: number,
    public message: string,
    public code?: string
  ) {
    super(message);
  }
}

// Централизованный handler
app.use((err, req, res, next) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
    });
  }
  // Логирование
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});
```

**Результат недели 1:**
- ✅ Полные CRUD для CRM
- ✅ Валидация на бэкенде
- ✅ Централизованная обработка ошибок

---

#### Неделя 2: Безопасность + Telegram (начало)

**День 1-2: Безопасность**

```bash
# Установить в api-gateway
npm install express-rate-limit helmet express-validator
```

```typescript
// Rate limiting
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';

app.use(helmet());
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, // 15 минут
  max: 100 // 100 запросов
}));

// Input sanitization
import { body, validationResult } from 'express-validator';
app.post('/api/crm/companies', 
  body('name').trim().escape(),
  // ...
);
```

**День 3-7: Безопасность (остальное) + Campaign Service (начало)**

- Telegram интеграция уже реализована (GramJS, sync-chats, WebSocket события).
- Фокус: доработка безопасности (Helmet, CORS, sanitization) и начало Campaign Service (структура сервиса, CRUD кампаний).

**Результат недели 2:**
- ✅ Безопасность усилена
- ✅ Campaign Service создан (базовый CRUD)

---

#### Неделя 3: Campaign Service (доработка) + Тестирование

**День 1-3: Campaign Service**
- Шаблоны сообщений, sequences, расписание
- Статистика кампаний

**День 4-5: Тестирование**
- Тестирование всех CRUD
- Тестирование Telegram
- Исправление багов

**Результат недели 3:**
- ✅ Campaign Service в базовом виде готов
- ✅ Критичные пути протестированы

---

### ФАЗА 2: Важные пробелы (2-3 недели)

#### Неделя 4: Email + MFA

**Email сервис:**
```bash
npm install @sendgrid/mail
# или
npm install resend
```

**MFA:**
```bash
npm install speakeasy qrcode
```

#### Неделя 5-6: Campaign Service

Создать новый сервис с нуля:
- CRUD для кампаний
- Шаблоны
- Sequences
- Расписание
- Статистика

#### Неделя 7: AI Service + Мониторинг

**AI Service:**
```bash
npm install openai
```

**Мониторинг:**
- Winston для логирования
- Prometheus метрики
- Grafana dashboards

---

### ФАЗА 3: Production готовность (1-2 недели)

- Production Dockerfiles
- Kubernetes манифесты
- CI/CD pipeline
- Database backups
- Load testing
- Security audit

---

## 🚀 Начинаем СЕЙЧАС - Шаг 1

### Задача: Добавить полные CRUD для CRM Service

**Файл:** `services/crm-service/src/index.ts`

**Что добавить:**

1. **PUT `/api/crm/companies/:id`**
2. **DELETE `/api/crm/companies/:id`**
3. **GET `/api/crm/companies/:id`**
4. **PUT `/api/crm/contacts/:id`**
5. **DELETE `/api/crm/contacts/:id`**
6. **GET `/api/crm/contacts/:id`**
7. **PUT `/api/crm/deals/:id`**
8. **DELETE `/api/crm/deals/:id`**
9. **GET `/api/crm/deals/:id`**
10. **Пагинация для всех GET списков**

**Оценка времени:** 1-2 дня

**После завершения:**
- Повторить для Pipeline Service
- Повторить для Messaging Service
- И так далее для всех сервисов

---

## 📋 Чеклист прогресса

### Фаза 1 (Критичные)
- [ ] Полные CRUD для всех сервисов (CRM, Pipeline и др.)
- [ ] Валидация на бэкенде
- [ ] Error handling централизован
- [ ] Безопасность усилена (rate limit, Helmet, sanitization)
- [x] Telegram интеграция работает (GramJS, sync-chats, WebSocket)

### Фаза 2 (Важные)
- [ ] Email отправка работает
- [ ] MFA работает
- [ ] Campaign Service создан
- [ ] AI Service работает
- [ ] Мониторинг настроен

### Фаза 3 (Production)
- [ ] Production конфигурация
- [ ] CI/CD настроен
- [ ] Тестирование завершено
- [ ] Документация готова

---

## 💡 Рекомендации

1. **Делать по одному сервису** - не пытаться все сразу
2. **Тестировать после каждого изменения** - не накапливать баги
3. **Коммитить часто** - маленькие коммиты легче откатывать
4. **Документировать изменения** - важно для команды
5. **Использовать feature flags** - для постепенного rollout

---

## 🎯 Цель

**Через 6-8 недель:**
- ✅ Полностью рабочий продукт
- ✅ Все критичные функции из MVP
- ✅ Готов к продакшену
- ✅ Безопасен и масштабируем

---

## 📞 Следующий шаг

**Начинаем с добавления полных CRUD операций в CRM Service.**

Готов начать реализацию?

