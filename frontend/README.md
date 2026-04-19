# GetSale CRM Frontend

Frontend на **Next.js 16** (App Router), **React 19**.

## Требования

- **Node.js 24+** (как в корневом репозитории: `.nvmrc`, `engines` в `package.json`)

## Технологии

- **Next.js 16** — React framework, App Router
- **TypeScript** — типизация
- **Tailwind CSS 4** — стилизация
- **Zustand** - State management
- **Socket.io Client** - WebSocket для real-time
- **Axios** - HTTP клиент

## Запуск

### Локально (без Docker)

```bash
cd frontend
npm install
npm run dev
```

Приложение будет доступно на http://localhost:3000

### В Docker

```bash
# Из корня проекта
docker compose -f docker-compose.yml up frontend
```

Приложение: http://localhost:5173 (хост 5173 → порт 3000 внутри контейнера). Полный стек: `docker compose -f docker-compose.yml up -d`.

## Структура

```
frontend/
├── app/                    # Next.js App Router
│   ├── auth/              # Страницы аутентификации
│   ├── dashboard/         # Dashboard страницы
│   └── layout.tsx         # Root layout
├── components/            # React компоненты
│   └── layout/           # Layout компоненты
├── lib/                  # Утилиты и stores
│   ├── stores/           # Zustand stores
│   └── hooks/            # Custom hooks
└── public/               # Статические файлы
```

## API Integration

Все запросы идут через API Gateway на `http://localhost:8000`.

Авторизация через JWT токены, которые хранятся в Zustand store с persist.

## WebSocket

WebSocket подключение для real-time обновлений через `useWebSocket` hook.

