# bd-accounts-service: TIMEOUT из GramJS (runbook)

## Что за ошибка

В логах может появляться:

```
Error: TIMEOUT
    at .../node_modules/telegram/client/updates.js:250:85
    at async attempts (.../telegram/client/updates.js:234:20)
    at async _updateLoop (.../telegram/client/updates.js:184:17)
```

**Источник:** библиотека [GramJS](https://github.com/gram-js/gramjs) (пакет `telegram`). Внутренний цикл `_updateLoop` ждёт апдейты от серверов Telegram; если за заданный интервал данные не приходят (тишина на соединении, сетевая задержка, миграция ДЦ), библиотека выбрасывает `Error: TIMEOUT`. Это не баг нашего кода и не обязательно обрыв TCP.

Известные issues: [gram-js/gramjs#302](https://github.com/gram-js/gramjs/issues/302), [gram-js/gramjs#494](https://github.com/gram-js/gramjs/issues/494).

## Связка GetDialogs и TIMEOUT другого аккаунта

При долгом `getDialogsAll` (много диалогов, flood wait) один аккаунт может занимать event loop десятки секунд. В том же процессе крутятся все аккаунты: цикл апдейтов GramJS (`_updateLoop`) у **других** аккаунтов не успевает получить «тик» в свой таймаут — в логах появляется TIMEOUT у другого `accountId`, а не у того, кто тянет диалоги. Чтобы снизить вероятность такого сценария, в цикле `getDialogsAll` раз в 25 диалогов выполняется yield в event loop (`setImmediate`), чтобы успевали сработать update loop и keepalive остальных клиентов. По умолчанию при `GET .../dialogs-by-folders?refresh=1` загружается не более 1000 диалогов на папку; опционально `?days=N` ограничивает выборку по дате активности. При TIMEOUT роут возвращает **503** с телом `{ error: 'TELEGRAM_UPDATE_TIMEOUT', message: '...' }`, а не 500.

## Что делает сервис

- **Keepalive:** каждые **30 секунд** вызывается `updates.GetState()`, чтобы Telegram не переставал слать апдейты.
- **Обработка TIMEOUT:** при TIMEOUT из `updates.js` сервис планирует переподключение **только этого** аккаунта (debounce 8 с), чтобы не обрывать долгие запросы других (например GetDialogs).
- **Логирование:** TIMEOUT логируется как **warning** с текстом вроде «Update loop TIMEOUT (GramJS), scheduling reconnect», а не как error.

## Рекомендации

- **Мониторинг/алерты:** не считать TIMEOUT критичной ошибкой; при желании фильтровать по сообщению или уровню (warning).
- **Если таймауты учащаются:** проверить сеть до Telegram, нагрузку на инстанс; при необходимости скорректировать интервал keepalive в `TelegramManager.UPDATE_KEEPALIVE_MS` (сейчас 30 сек).
- **Версия GramJS:** в `package.json` указана `telegram: ^2.26.22`. При обновлении библиотеки сверяться с [changelog](https://github.com/gram-js/gramjs/releases) на тему update loop и таймаутов.

## Proxy policy (актуально)

- В текущей интеграции поддерживается только **SOCKS5** для подключения GramJS.
- HTTP/HTTPS proxy на auth/patch потоках отклоняется валидацией.
- Это соответствует рабочему профилю использования GramJS proxy options для MTProto-сессий: SOCKS5/MTProxy, а не HTTP CONNECT как основной канал.
