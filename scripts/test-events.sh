#!/bin/bash

# Скрипт для тестирования event-driven коммуникации

BASE_URL="http://localhost:8000"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "🧪 Тестирование Event-Driven коммуникации"
echo "========================================="
echo ""

# Регистрация
echo "1. Регистрация пользователя..."
SIGNUP_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/signup" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test-events@example.com",
    "password": "test123456",
    "organizationName": "Test Events Company"
  }')

if echo "$SIGNUP_RESPONSE" | grep -q "accessToken"; then
    echo -e "${GREEN}✅${NC} Пользователь создан"
    ACCESS_TOKEN=$(echo "$SIGNUP_RESPONSE" | grep -o '"accessToken":"[^"]*' | cut -d'"' -f4)
else
    echo -e "${RED}❌${NC} Регистрация failed"
    exit 1
fi

echo ""

# Создание компании (должно опубликовать событие)
echo "2. Создание компании (проверка события company.created)..."
COMPANY_RESPONSE=$(curl -s -X POST "$BASE_URL/api/crm/companies" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Event Test Company",
    "industry": "Technology"
  }')

if echo "$COMPANY_RESPONSE" | grep -q "id"; then
    echo -e "${GREEN}✅${NC} Компания создана"
    COMPANY_ID=$(echo "$COMPANY_RESPONSE" | grep -o '"id":"[^"]*' | cut -d'"' -f4)
else
    echo -e "${RED}❌${NC} Создание компании failed"
fi

echo ""

# Создание контакта (должно опубликовать событие contact.created)
echo "3. Создание контакта (проверка события contact.created)..."
CONTACT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/crm/contacts" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "Event",
    "lastName": "Test",
    "email": "event@test.com",
    "companyId": "'"$COMPANY_ID"'"
  }')

if echo "$CONTACT_RESPONSE" | grep -q "id"; then
    echo -e "${GREEN}✅${NC} Контакт создан"
    CONTACT_ID=$(echo "$CONTACT_RESPONSE" | grep -o '"id":"[^"]*' | cut -d'"' -f4)
else
    echo -e "${RED}❌${NC} Создание контакта failed"
fi

echo ""

# Проверка RabbitMQ
echo "4. Проверка событий в RabbitMQ..."
echo -e "${YELLOW}ℹ️${NC} Откройте http://localhost:15672 для просмотра очередей"
echo -e "${YELLOW}ℹ️${NC} Username: getsale, Password: getsale_dev"

echo ""
echo "========================================="
echo -e "${GREEN}✅${NC} Тестирование событий завершено"
echo ""
echo "Проверьте RabbitMQ Management UI для просмотра опубликованных событий"

