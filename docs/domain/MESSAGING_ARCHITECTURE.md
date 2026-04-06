# Архитектура мессенджера и связь с CRM

Объединённый документ: модель клиент/чат, папки, UX и производительность.

---

## 1. Модель: карточка клиента vs чат

**Вывод:** Воронка двигает **клиентов** (contacts); чаты — каналы коммуникации, привязанные к карточке.

- **Contact** — одна запись на клиента в рамках организации; идентификация через telegram_id, phone, email. При удалении BD-аккаунта контакты не удаляются.
- **Chat** — один диалог = один аккаунт + канал + channel_id. Личный чат ↔ один contact; групповой/канал ↔ много contacts (участники).
- **Message** — принадлежит Chat и Contact (автор/адресат). Поля: contact_id, bd_account_id, channel, channel_id.
- **Deal** — привязывается к контакту (и опционально к чату). Движение по воронке по сделке/клиенту.

**Плюсы модели:** один клиент = одна запись в воронке; единая история и контекст для AI; командная работа на уровне клиента. **Минусы:** дедупликация при синхронизации; в групповых чатах нужна явная связь чат ↔ контакты.

---

## 2. Папки и синхронизация

- **Папки в Telegram:** «Все чаты» (folderId 0), «Архив» (1), кастомные фильтры (2+). У нас: `bd_account_sync_folders` (folder_id, folder_title, order_index, is_user_created, icon).
- **Чаты:** `bd_account_sync_chats` с `folder_id`; при выборе папок — getDialogs по каждой папке, обновление sync_chats. Пользовательские папки: POST sync-folders/custom, PATCH order, удаление пользовательской папки (DELETE sync-folders/:folderRowId).
- **UI:** вертикальная полоска папок (как в Telegram), «Синхр. с TG», диалог управления папками (FolderManageModal). ПКМ по чату — «Добавить в папку» (PATCH chats/:chatId/folder).
- **Обратная синхронизация в TG:** кнопка «Синхр. с TG» → POST sync-folders-push-to-telegram (папки 0/1 не трогаем; folder_id >= 2 → UpdateDialogFilter).

---

## 3. Производительность

- **Кэш аватарок и медиа:** LRU в `frontend/lib/cache/blob-url-cache.ts` (max 200, revoke при evict). Ключи: avatar:account:id, avatar:chat:bdAccountId:chatId, media:url. Используется в BDAccountAvatar, ChatAvatar, useMediaUrl.
- **Виртуальный список сообщений:** при >200 сообщений — react-virtuoso (firstItemIndex, startReached, followOutput). Подгрузка вверх с cooldown; восстановление скролла после prepend (двойной rAF).
- **Контекстные меню:** компонент `ContextMenu` (ContextMenuSection, ContextMenuItem). ПКМ по чату (Закрепить, в папку, Удалить), по аккаунту (Настройки), по сообщению (Реакция, Удалить).

---

## 4. Workspace (кратко)

- **Инвайты:** organization_invite_links, страница /invite/[token], accept для нового и существующего пользователя; переключатель воркспейса в сайдбаре (GET workspaces, POST switch-workspace).
- **Роли:** owner, admin, supervisor, bidi, viewer; смена на странице Team (только owner/admin). role_permissions, canPermission в auth и team.
- **Настройки воркспейса:** PATCH organization (name, slug), передача владения (POST transfer-ownership). Аудит: audit_logs, вкладка «Журнал аудита» в Настройках.

---

## 5. Conversation-driven UX (Stage 7)

- **Conversation** — тонкий слой над чатом: lead_id, campaign_id, became_lead_at, first_manager_reply_at и т.д. Один диалог = одна строка; не дублирует Telegram chat.
- Папка «Новые лиды» (first_manager_reply_at IS NULL), бейджи Lead/Contact в списке чатов, правая панель Lead Panel (pipeline, stage, timeline). Детали — в [STAGES.md](../architecture/STAGES.md) (ЭТАП 7).

Приоритеты и бэклог — [ROADMAP.md](../ROADMAP.md).
