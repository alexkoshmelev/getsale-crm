# UI/UX Upgrade — в духе топовых SaaS

Обновление дизайн-системы и интерфейса GetSale CRM по мотивам Notion, HubSpot, Salesforce, Figma, Slack.

## Что сделано

### 1. Дизайн-система (Design Tokens)
- **globals.css**: фон светлой темы слегка приглушён (98% вместо 100%), тёмная — чуть мягче; добавлены семантические цвета `success`, `warning`; тени `--shadow-sm`, `--shadow`, `--shadow-md`, `--shadow-lg`; `--radius-lg` для карточек и модалок.
- **tailwind.config.js**: цвета `success`, `warning`; тени `shadow-soft`, `shadow-soft-md`, `shadow-soft-lg`; `rounded-xl`; `fontFamily.sans` и `fontFamily.heading` для типографики.

### 2. Типографика
- **layout.tsx**: шрифты Inter (body) и Plus Jakarta Sans (заголовки) через CSS-переменные; `font-heading` и `font-sans` в Tailwind.
- Заголовки используют классы `font-heading` и `tracking-tight` для единого стиля.

### 3. Компоненты UI
- **Button**: `focus-visible` кольцо, `active:scale-[0.98]`, тень у primary, `disabled:pointer-events-none`.
- **Input**: плейсхолдер `placeholder:text-muted-foreground`, фокус-кольцо, hover по границе.
- **Card**: токены `bg-card`, `border-border`, `shadow-soft`, `rounded-xl`, лёгкий hover по тени; заголовок через `font-heading`.
- **EmptyState**: мягкий контейнер иконки, `font-heading` для заголовка.
- **Modal / SlideOver**: токены `bg-card`, `border-border`, `shadow-soft-lg`, `rounded-2xl` у модалки; кнопка закрытия с `focus-visible`.
- **SearchInput**: токены `border-input`, `bg-background`, `text-muted-foreground`.
- **Skeleton / Pagination**: `bg-muted`, `divide-border`, `border-border`, `focus-visible` у кнопок.

### 4. Layout дашборда
- **Sidebar**: секции «Product» и «Account» с подписями; активный пункт — левая полоска `border-l-primary` (только при развёрнутом сайдбаре); логотип и пункты с `font-heading` где уместно.
- **Header**: полупрозрачный фон `bg-card/95 backdrop-blur-sm`, лёгкая тень `shadow-soft`; заголовок страницы — `font-heading`, `tracking-tight`.

### 5. Страницы
- **Dashboard (главная)**: карточки метрик с `border-l-4 border-l-primary`, hover (подъём + тень), ссылки на CRM/Messaging/Pipeline; быстрые действия — кнопки `Button` с иконками и стрелкой; секции через компонент `Card`.
- **Login**: фон через градиент с `primary`; карточка с `shadow-soft-lg`; форма на компонентах `Input` и `Button`; фокус и доступность у ссылки «Sign up».
- **CRM**: таблицы и вкладки на токенах (`bg-muted/50` заголовок, `divide-border`, `hover:bg-muted/30`); сообщения об ошибках — `bg-destructive/10`; SlideOver и детали сущностей — `font-heading`, `text-foreground` / `text-muted-foreground`.
- **Pipeline**: колонки воронки — `rounded-xl`, `border-border`, `bg-muted/30`, карточки сделок с hover; кнопка «Новая сделка» — компонент `Button` со ссылкой на CRM; пустые состояния — пунктирная граница и мягкий фон.

### 6. Локализация
- В **en.json** и **ru.json** добавлены ключи `nav.product` и `nav.account` для подписей секций сайдбара.

## Как проверить

```bash
cd frontend
npm install
npm run build
npm run dev
```

Откройте дашборд, CRM, воронку и страницу входа в светлой и тёмной теме и проверьте:
- единые тени, скругления и отступы;
- фокус и наведение на кнопках и полях;
- читаемость заголовков и текста.

## Дополнительные UX-доработки (фаза 2)

### Переводы (i18n)
- Расширены `en.json` и `ru.json`: добавлены ключи для **crm**, **pipeline**, **analytics**, **team**, **settings**, **bdAccounts**, **auth** (signup), **global**, **onboarding**, **common** (confirm, skip, deleting, success, company/contact/deal).
- Все страницы (CRM, Pipeline, Analytics, Settings, Team, Signup) используют `useTranslation()` и ключи из локалей; хардкод строк убран.

### UX-элементы
- **Toast** — контекст `ToastProvider`, хук `useToast()`, методы `success()`, `error()`, `info()`. Тосты отображаются в правом нижнем углу (заглушка для будущей интеграции с бэкендом).
- **Глобальный поиск** — кнопка в header с плейсхолдером и выпадающим списком быстрых ссылок (CRM, Pipeline, Messages). Горячая клавиша **⌘K** / **Ctrl+K**. Полноценный поиск — заглушка под бэкенд.
- **Хлебные крошки** — компонент `Breadcrumbs` по `pathname` (Dashboard > CRM и т.д.), в header на desktop и в начале main на mobile.
- **Уведомления** — иконка колокольчика в header, выпадающий блок «Нет новых уведомлений» (заглушка).
- **Помощь** — выпадающее меню «Документация» и «Связаться с поддержкой» (ссылки-заглушки).
- **Горячие клавиши** — модальное окно по **?** с подсказками: ⌘K — поиск, ? — показать подсказки.
- **Онбординг** — баннер на главной дашборда с приветствием и тремя шагами (компания, Telegram, сделка); закрытие сохраняется в `localStorage` (`getsale-onboarding-dismissed`).
- **Анимации** — в `globals.css` добавлены ключевые кадры и утилиты для `animate-in`, `fade-in`, `slide-in-from-top-2`, `slide-in-from-right-full`, `zoom-in-95`, `duration-150/200/300` (без зависимости tailwindcss-animate).

### Страницы
- **Analytics** — i18n, дизайн-токены (Card, text-foreground, muted), единый спиннер загрузки.
- **Settings** — вкладки через i18n, Card, Input, Button, токены.
- **Team** — i18n, Card, EmptyState, модалка приглашения с формой и переводами.
- **Signup** — полный i18n, Input/Button, градиент и карточка в едином стиле с логином.
- **CRM** — все подписи, кнопки, пустые состояния, модалка удаления и детали в SlideOver переведены через `t()`.
- **Pipeline** — заголовок, подзаголовок, кнопка, пустые состояния через i18n.

### Как использовать тосты
В любом клиентском компоненте под `ToastProvider`:
```tsx
import { useToast } from '@/lib/contexts/toast-context';

const { success, error, info } = useToast();
success('Saved');
error('Something went wrong');
info('Connecting...');
```

## Дальнейшие идеи (опционально)

- Подключить бэкенд для глобального поиска и уведомлений.
- Плотность таблиц (compact/comfortable) в настройках.
- Микро-анимации появления списков (stagger).
- Реальные ссылки для «Документация» и «Поддержка».
