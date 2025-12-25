#!/bin/bash

# Скрипт для тестирования API endpoints

BASE_URL="http://localhost:8000"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo "🧪 Тестирование API Endpoints"
echo "=============================="
echo ""

# Тест 1: Регистрация
echo "1. Тестирование регистрации..."
SIGNUP_RESPONSE=$(curl -s -X POST "$BASE_URL/api/auth/signup" \
  -H "Content-Type: application/json" \
  -d '{
    "email": "test@example.com",
    "password": "test123456",
    "organizationName": "Test Company"
  }')

if echo "$SIGNUP_RESPONSE" | grep -q "accessToken"; then
    echo -e "${GREEN}✅${NC} Регистрация успешна"
    ACCESS_TOKEN=$(echo "$SIGNUP_RESPONSE" | grep -o '"accessToken":"[^"]*' | cut -d'"' -f4)
    echo "Token: ${ACCESS_TOKEN:0:20}..."
else
    echo -e "${RED}❌${NC} Регистрация failed"
    echo "Response: $SIGNUP_RESPONSE"
    exit 1
fi

echo ""

# Тест 2: Получение профиля
echo "2. Тестирование получения профиля..."
PROFILE_RESPONSE=$(curl -s -X GET "$BASE_URL/api/users/profile" \
  -H "Authorization: Bearer $ACCESS_TOKEN")

if echo "$PROFILE_RESPONSE" | grep -q "user_id"; then
    echo -e "${GREEN}✅${NC} Профиль получен"
else
    echo -e "${YELLOW}⚠️${NC} Профиль не найден (это нормально для нового пользователя)"
fi

echo ""

# Тест 3: Создание компании
echo "3. Тестирование создания компании..."
COMPANY_RESPONSE=$(curl -s -X POST "$BASE_URL/api/crm/companies" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Company",
    "industry": "Technology",
    "size": "50-100"
  }')

if echo "$COMPANY_RESPONSE" | grep -q "id"; then
    echo -e "${GREEN}✅${NC} Компания создана"
    COMPANY_ID=$(echo "$COMPANY_RESPONSE" | grep -o '"id":"[^"]*' | cut -d'"' -f4)
else
    echo -e "${RED}❌${NC} Создание компании failed"
    echo "Response: $COMPANY_RESPONSE"
fi

echo ""

# Тест 4: Создание контакта
echo "4. Тестирование создания контакта..."
CONTACT_RESPONSE=$(curl -s -X POST "$BASE_URL/api/crm/contacts" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "firstName": "John",
    "lastName": "Doe",
    "email": "john@example.com",
    "companyId": "'"$COMPANY_ID"'"
  }')

if echo "$CONTACT_RESPONSE" | grep -q "id"; then
    echo -e "${GREEN}✅${NC} Контакт создан"
else
    echo -e "${RED}❌${NC} Создание контакта failed"
    echo "Response: $CONTACT_RESPONSE"
fi

echo ""

# Тест 5: Создание воронки
echo "5. Тестирование создания воронки..."
PIPELINE_RESPONSE=$(curl -s -X POST "$BASE_URL/api/pipeline" \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Sales Pipeline",
    "description": "Main sales pipeline",
    "isDefault": true
  }')

if echo "$PIPELINE_RESPONSE" | grep -q "id"; then
    echo -e "${GREEN}✅${NC} Воронка создана"
    PIPELINE_ID=$(echo "$PIPELINE_RESPONSE" | grep -o '"id":"[^"]*' | cut -d'"' -f4)
else
    echo -e "${RED}❌${NC} Создание воронки failed"
    echo "Response: $PIPELINE_RESPONSE"
fi

echo ""

echo "=============================="
echo -e "${GREEN}✅${NC} Базовое тестирование API завершено"

