# Архитектура: AI-репрайз в кампаниях

## Поток данных

1. **campaign-service** (`campaign-loop.ts`) при `target_audience.randomizeWithAI` вызывает **ai-service** `POST /api/ai/campaigns/rephrase` с телом `{ text }` (уже подставлены переменные и spintax).
2. **ai-service** проверяет лимит по организации, вызывает **OpenRouter** Chat Completions, возвращает `{ content, model, provider }`.
3. При ошибке или пустом ответе campaign-service логирует предупреждение и отправляет **исходный** текст (деградация без остановки рассылки).

## Почему не `openrouter/free` по умолчанию

Пул `openrouter/free` может отдать **reasoning/thinking** модели. Они часто заполняют `choices[0].message.reasoning` и оставляют `message.content: null`, особенно при ограниченном `max_tokens` → 502 «empty response».

**Дефолт в репозитории:** `openai/gpt-5-mini` (константа `DEFAULT_OPENROUTER_CAMPAIGN_MODEL` в ai-service). Переопределение: `OPENROUTER_MODEL`. Fallback при пустом ответе первичной модели — бесплатные instruct Gemma (`FALLBACK_OPENROUTER_CAMPAIGN_MODELS`).

## Обогащение контактов и FLOOD_WAIT

Галочка «обогатить контакт перед отправкой» (`enrichContactsBeforeStart` в `target_audience`) при старте кампании вызывает только пакетное `enrichContactsFromTelegram` во фронте; **без галочки этого шага нет**. Отдельно от этого, при рассылке по **username** (как `channel_id` участника) bd-accounts `MessageSender` при отправке вызывает `contacts.ResolveUsername` для разрешения peer — это не «лишние» запросы от enrich, а необходимость API для доставки по @username. Чтобы снизить число resolve, нужен peer в виде числового user id (и успешная отправка без ветки username), что может потребовать иной приоритет `telegram_id` vs `username` при формировании `channel_id` у участников.

## Переменные окружения

| Сервис | Переменные |
|--------|------------|
| **ai-service** | `OPENROUTER_API_KEY`, `OPENROUTER_MODEL`, `OPENROUTER_MAX_TOKENS`, `OPENROUTER_TIMEOUT_MS` |
| **campaign-service** | `AI_SERVICE_URL` (в Docker: `http://ai-service:3005`), HTTP client timeout ≥ времени ответа ai-service |

Локальный `npm run dev` для ai-service: корневой `.env` подхватывается через `src/load-env.ts`.

## Операционные заметки

- Ретраи и circuit breaker в `ServiceHttpClient`: 502/429 от downstream не должны «убивать» весь канал messaging (см. shared `http-client.ts`).
- Рекомендуется мониторить логи: `Campaign AI rephrase requested`, `Using AI rephrased content`, `AI rephrase failed`.

См. также: [DEPLOYMENT.md](DEPLOYMENT.md) (секция про OpenRouter).
