#!/bin/bash

# Скрипт для тестирования всех сервисов

BASE_URL="http://localhost:8000"
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "🧪 Тестирование сервисов BD CRM Platform"
echo "=========================================="
echo ""

# Функция для проверки health endpoint
check_health() {
    local service=$1
    local port=$2
    local response=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:$port/health)
    
    if [ "$response" = "200" ]; then
        echo -e "${GREEN}✅${NC} $service (port $port) - OK"
        return 0
    else
        echo -e "${RED}❌${NC} $service (port $port) - FAILED (HTTP $response)"
        return 1
    fi
}

# Проверка health checks (v2 services)
echo "📋 Проверка Health Checks:"
check_health "Gateway" 8000
check_health "Auth Service" 4001
check_health "Core API" 4002
check_health "Messaging API" 4003
check_health "Telegram Session Manager" 4005
check_health "Campaign Orchestrator" 4006
check_health "Automation Engine" 4007
check_health "Notification Hub" 4008
check_health "User Service" 4009
check_health "AI Service" 4010

echo ""
echo "=========================================="
echo "✅ Тестирование завершено"

