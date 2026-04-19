#!/bin/sh
set -e
if [ -z "${TELEGRAM_BOT_TOKEN}" ] || [ -z "${TELEGRAM_CHAT_ID}" ]; then
  echo "alertmanager: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must be set for Telegram notifications" >&2
fi
# Use # as delimiter so bot tokens containing / do not break substitution
sed -e "s#__TELEGRAM_BOT_TOKEN__#${TELEGRAM_BOT_TOKEN:-}#g" \
    -e "s#__TELEGRAM_CHAT_ID__#${TELEGRAM_CHAT_ID:-}#g" \
    /etc/alertmanager/alertmanager-template.yml > /tmp/alertmanager.yml
exec /bin/alertmanager --config.file=/tmp/alertmanager.yml "$@"
