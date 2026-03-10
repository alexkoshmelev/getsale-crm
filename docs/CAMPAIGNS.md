# Кампании холодного аутрича

Цели, статус реализации и связь с продуктом. Детальный статус и приоритеты — [STATE_AND_ROADMAP.md](STATE_AND_ROADMAP.md).

---

## Цели

- Массовые рассылки с sequences (многошаговые сценарии), шаблонами и расписанием.
- Источники аудитории: база CRM (фильтры), CSV, группа в Telegram.
- Один BD-аккаунт на кампанию; отправка через Messaging Service.
- Управление: Запустить, Приостановить, Продолжить, Остановить (completed).
- Создание лида в CRM (при первой отправке / при ответе); динамические кампании (автодобавление по этапу лида).

---

## Статус реализации

**Сделано:** Campaign Service (порт 3012), миграции (campaigns, campaign_templates, campaign_sequences, campaign_participants, campaign_sends). CRUD кампаний, шаблоны, sequence steps (в т.ч. trigger_type: delay | after_reply), start/pause, participants, stats. Worker отправки по расписанию (workingHours, daysOfWeek, sendDelaySeconds); подписка на message.received (replied, after_reply). Расширенные условия шага (stopIfReplied, правила по полям контакта, inPipelineStage/notInPipelineStage). Фронтенд: список кампаний, страница кампании (Обзор, Аудитория, Последовательность), вкладка «Аудитория» (источник: CRM/CSV/группа TG, BD-аккаунт, расписание, создание лида), редактор последовательности (canvas, drag-and-drop, условия). API Gateway прокси `/api/campaigns`.

**Не сделано / бэклог:** статус campaign «completed» при завершении всех участников; rate limiting по каналу в worker; AI-персонализация ({{ai.personalize}} — заглушка); оптимальное время отправки (модель). См. также [COMPETITOR_CRMCHAT_ANALYSIS.md](COMPETITOR_CRMCHAT_ANALYSIS.md) и [OUTREACH_BEST_PRACTICES.md](OUTREACH_BEST_PRACTICES.md).

---

## Связь с архитектурой

- **Campaign Service** — формирует «кого и когда» слать, вызывает Messaging (`POST /api/messaging/send`) или ставит задачи в очередь. Общая БД с messaging (conversations, messages, campaign_*).
- События: campaign.created/started/paused; подписка на message.received и lead.stage.changed для динамических кампаний.
