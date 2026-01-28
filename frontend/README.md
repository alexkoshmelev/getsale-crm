# GetSale CRM Frontend

Frontend приложение на Next.js 14 с App Router.

## Технологии

- **Next.js 14** - React framework с App Router
- **TypeScript** - Типизация
- **Tailwind CSS** - Стилизация
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
docker-compose up frontend
```

Приложение будет доступно на http://localhost:5173 (порт 5173 на хосте маппится на порт 3000 внутри контейнера)

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

