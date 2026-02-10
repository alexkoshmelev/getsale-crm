# UX/UI мессенджера: папки, производительность, workspace

Документ описывает схему и шаги реализации папок в боковой панели, производительности (кэш, виртуальный список) и workspace (инвайты, переключатель).

---

## 1. Папки

### 1.1 Отображение папок в боковой панели ✅

- **Источник данных:** `bd_account_sync_folders` (folder_id, folder_title, order_index, **is_user_created**, icon). Флаг `is_user_created` отличает папки из синхронизации с Telegram от созданных в CRM.
- **UI (как в Telegram):** Вертикальная полоска слева от списка чатов: иконка + название каждой папки, сверху «Все», внизу кнопка «Синхр. с TG» и кнопка **«Изменить»** (Edit). По нажатию «Изменить» открывается диалог управления папками: полный список с drag-and-drop сортировкой, добавление новой папки (название до 12 символов, выбор иконки из набора emoji), редактирование названия в списке. API: GET sync-folders; POST `/api/bd-accounts/:id/sync-folders/custom` (folder_title, icon); PATCH `/api/bd-accounts/:id/sync-folders/order` (order: id[]); PATCH `/api/bd-accounts/:id/sync-folders/:folderRowId` (icon, folder_title).
- **Реализовано:** вертикальная полоска, диалог FolderManageModal (компонент messaging), создание/сортировка/редактирование папок.

### 1.2 «Добавить в папку» из контекстного меню чата ✅

- По ПКМ на чате — контекстное меню «Добавить в папку»: подставляется **список папок пользователя** из GET sync-folders (те же данные, что и в полоске); опция «Без папки»; при отсутствии папок показывается пункт «Нет папок» (disabled).
- При выборе: PATCH `/api/bd-accounts/:id/chats/:chatId/folder` с телом `{ folder_id: number | null }`; бэкенд обновляет `bd_account_sync_chats.folder_id`.
- Реализовано в bd-accounts-service и на странице messaging.

### 1.3 Различие папок: синхронизация vs вручную ✅

- **Схема:** В таблице `bd_account_sync_folders` поле **is_user_created** (boolean). `false` — папка из синхронизации; `true` — создана в CRM.
- **Сделано:** Миграция 20250205000002; GET/POST sync-folders возвращают и принимают is_user_created; при сохранении папок из Telegram передаётся false; в UI мессенджера подпись TG/CRM. API создания пользовательской папки (POST sync-folders/custom) — при появлении передавать is_user_created = true.

### 1.5 Иконки папок ✅

- Поле **icon** в `bd_account_sync_folders`, PATCH для обновления icon, выбор emoji в UI мессенджера (кнопка у каждой папки). См. раздел 3.8.

### 1.4 Обратная синхронизация в Telegram ✅

- **Реализовано:** Кнопка «Синхр. с TG» в блоке папок (только для владельца аккаунта). По клику вызывается POST `/api/bd-accounts/:id/sync-folders-push-to-telegram`: для каждой папки с folder_id >= 2 из bd_account_sync_folders собираются чаты из sync_chats, для каждого чата получается InputPeer, вызывается Telegram API messages.UpdateDialogFilter (название, иконка, include_peers). Возвращается количество обновлённых папок и список ошибок; на фронте показывается результат.

---

## 2. Производительность

### 2.1 Кэш аватарок и медиа ✅

- **Реализовано (вариант A — LRU):** Модуль `frontend/lib/cache/blob-url-cache.ts`: один инстанс с Map, `get(key)`, `set(key, blobUrl)`, максимум 200 записей, при evict вызывается `URL.revokeObjectURL`. Ключи: `avatar:account:${id}`, `avatar:chat:${bdAccountId}:${chatId}`, `media:${mediaUrl}`. Подключён в BDAccountAvatar, ChatAvatar и useMediaUrl на странице messaging.
- **Вариант B — Cache API:** при необходимости можно добавить отдельно (TTL, кэш между вкладками).

### 2.2 Виртуальный список истории сообщений ✅

- **Когда нужен:** При большом числе сообщений в чате (например >200) скролл и рендер всех DOM-узлов могут давать лаги.
- **Сделано:** Подгрузка вверх с cooldown 2.5 с; восстановление позиции скролла после prepend — двойной `requestAnimationFrame`. При **>200 сообщений** используется **react-virtuoso**: `firstItemIndex` для prepend без скачка скролла, `startReached` для подгрузки старых, `followOutput="smooth"`, прокрутка к последнему при смене чата.

### 2.3 Контекстные меню ✅

- **Реализовано:** Переиспользуемый компонент `frontend/components/ui/ContextMenu.tsx` (ContextMenu, ContextMenuSection, ContextMenuItem). Позиция по клику (x, y), секции с заголовками, пункты с иконкой и стилем (destructive). На странице мессенджера используется для ПКМ по чату (Закрепить, Добавить в папку, Удалить чат), по аккаунту (Настройки), по сообщению (Реакция, Удалить). См. MASTER_PLAN 2.2.

---

## 3. Workspace

### 3.1 Состояния инвайтов (invited / accepted / declined) ✅

- **invited (pending):** Пользователь приглашён по ссылке или по email; запись в `team_invitations` или `organization_invite_links`; статус «ожидает принятия».
- **accepted:** Пользователь перешёл по ссылке и зарегистрировался с `?invite=TOKEN` (signup с `inviteToken`) — создаётся user в приглашённой организации и запись в `organization_members`. Либо уже залогиненный пользователь — POST `/api/invite/:token/accept` → добавление в `organization_members`.
- **declined:** Истечение срока ссылки (410 при GET invite или при signup/accept); явное «Отклонить» — при необходимости.
- **Реализовано:** Signup с `inviteToken` в auth-service (создание user в приглашённой org + organization_members); страница signup читает `?invite=`, подставляет inviteToken и скрывает поле «Организация»; UI создания ссылки на странице Team (POST `/api/team/invite-links`, отображение ссылки и копирование). Единая ссылка для приглашения — `/invite/TOKEN`: для гостя показываются «Войти» и «Регистрация», для залогиненного — кнопка «Присоединиться»; после accept вызываются `fetchWorkspaces()` и `switchWorkspace(organizationId)`, редирект в dashboard в новом воркспейсе.

### 3.2 Защита от дублей ✅ (частично)

- Перед созданием инвайта по email: проверять, что этот email ещё не в организации и не в pending приглашениях (team-service возвращает 409 при дубле).
- При accept по invite-link: проверка в `organization_members` — если уже член, возвращается 200 с сообщением «Already a member»; при signup с inviteToken дубль по email обрабатывается как 409 «Email already exists».

### 3.3 Переключатель активного workspace ✅

- Пользователь может состоять в нескольких организациях (после введения `organization_members`). В сайдбаре dashboard — блок «Рабочее пространство» с dropdown текущего воркспейса и списком остальных организаций из `organization_members`.
- При выборе другого воркспейса: вызов POST `/api/auth/switch-workspace` с body `{ organizationId }`, получение нового JWT; на фронте обновление auth-store и редирект на `/dashboard`.
- **Реализовано:** GET `/api/auth/workspaces` (список организаций пользователя), POST `/api/auth/switch-workspace`; в сайдбаре — загрузка workspaces при монтировании, dropdown с названием текущей организации и переключением; при смене — `switchWorkspace(organizationId)` и редирект.

### 3.4 Список и отзыв инвайт-ссылок ✅

- GET `/api/team/invite-links` — список ссылок организации (id, token, role, expiresAt, expired); DELETE `/api/team/invite-links/:id` — отзыв. На странице Team в блоке «Пригласить по ссылке»: кнопка «Создать ссылку», список активных и истёкших ссылок с копированием и отзывом.

### 3.5 Роли участников на странице Team ✅

- **Унификация ролей:** owner, admin, supervisor, bidi, viewer (соответствие UserRole); в UI — Owner, Admin, Manager, Agent, Viewer. Миграция: team_members.role 'member' → 'bidi'. team-service: нормализация роли (member→bidi), допустимые значения в invite и PUT.
- **Права:** смену роли может только owner или admin; gateway передаёт X-User-Role в team-service; PUT `/api/team/members/:id/role` возвращает 403, если роль вызывающего не owner/admin.
- **UI:** dropdown с пятью ролями; если у текущего пользователя не owner и не admin — роль отображается текстом без изменения.

### 3.6 Реакции на сообщения ✅

- Поле `messages.reactions` (JSONB), PATCH `/api/messaging/messages/:id/reaction` с телом `{ emoji }`. В чате: контекстное меню по сообщению — секция «Реакция» с выбором emoji; под сообщением отображаются реакции (emoji + счётчик). См. MASTER_PLAN 2.2, Фаза 2 п.18.

### 3.7 Настройки воркспейса ✅

- GET `/api/auth/organization` — текущая организация (id, name, slug) по JWT. PATCH `/api/auth/organization` — обновление полей name и slug (проверка прав через role_permissions workspace.update; при смене slug проверка уникальности, при конфликте 409). На странице Настройки вкладка «Рабочее пространство»: форма название и slug; редактирование и кнопка «Сохранить» только для owner/admin, иначе — подсказка и поля только для чтения.
- **Передача владения:** POST `/api/auth/organization/transfer-ownership` с телом `{ newOwnerUserId }`. Только текущий owner может вызвать; новый владелец должен быть участником организации. В organization_members: у текущего owner роль → admin, у выбранного → owner. Дополнительно обновляется `users.role` для обоих пользователей, если у них `users.organization_id` совпадает с этой организацией (синхронизация primary org). В настройках вкладка «Рабочее пространство» для owner: блок «Передать владение» — выбор участника и кнопка; после успеха — перезагрузка страницы.
- **Signup без инвайта:** при создании новой организации slug формируется из префикса email (нормализация a-z0-9-); проверка уникальности, при коллизии — суффикс из случайных символов (до 10 попыток).

### 3.8 Иконки папок ✅

- В таблице `bd_account_sync_folders` добавлено поле **icon** (VARCHAR, nullable). GET sync-folders возвращает icon; POST при сохранении папок принимает icon в каждом элементе; PATCH `/api/bd-accounts/:id/sync-folders/:folderId` — обновление только icon. В мессенджере: рядом с названием папки отображается emoji (если задан); кнопка-иконка открывает выбор emoji (набор вариантов + сброс).

### 3.9 Отзыв приглашения по email ✅

- GET `/api/team/invitations` — список ожидающих приглашений по email (id, email, role, expiresAt, teamName). DELETE `/api/team/invitations/:id` — отзыв приглашения (проверка права invitations.delete через role_permissions). На странице Team блок «Ожидающие приглашения»: список с кнопкой «Отозвать приглашение».

### 3.10 Аудит и гранулярные права ✅

- **audit_logs:** таблица (organization_id, user_id, action, resource_type, resource_id, old_value, new_value, ip, created_at). Запись событий: auth-service — organization.updated (PATCH organization), organization.ownership_transferred (transfer-ownership); team-service — team.member_role_changed (PUT member role), team.invitation_revoked (DELETE invitation). GET `/api/auth/audit-logs` — список последних записей по организации (право audit.read через role_permissions; иначе только owner/admin). Настройки: вкладка «Журнал аудита» (видна только owner/admin) — таблица дата, действие, пользователь, детали.
- **role_permissions:** таблица (role, resource, action). Дефолты: owner — всё; admin — workspace read/update, team *, audit read, invitations *; supervisor/bidi/viewer — ограниченно. Функция canPermission(pool, role, resource, action) в auth-service и team-service; при отсутствии таблицы — fallback owner/admin. Используется: PATCH organization (workspace.update), GET audit-logs (audit.read), PUT members/:id/role (team.update), DELETE invitations/:id (invitations.delete).

---

## 4. Telegram-like детали (реализовано)

- **Ответ на сообщение (reply):** при отправке можно выбрать сообщение для ответа; в бабле отображается превью цитаты (текст или «Медиа»); по клику на превью — скролл к исходному сообщению (`scrollToMessageByTelegramId`). Поле `reply_to_telegram_id` в messages, передача `replyToMessageId` при отправке.
- **Реакции:** `messages.reactions` (сводка) и `messages.our_reactions` (наши до 3 эмодзи); отправка в Telegram полным списком; отображение под сообщением и в ПКМ.

---

## Связь с MASTER_PLAN

Задачи из этого документа отражены в **MASTER_PLAN_MESSAGING_FIRST_CRM.md** в разделах «Папки и чаты», «Производительность», «Workspace». Приоритеты и бэклог — **Часть 6** MASTER_PLAN (текущее состояние, что не сделано, приоритеты дальше).
