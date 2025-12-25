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

# Проверка health checks
echo "📋 Проверка Health Checks:"
check_health "API Gateway" 8000
check_health "Auth Service" 3001
check_health "User Service" 3006
check_health "BD Accounts Service" 3007
check_health "CRM Service" 3002
check_health "Pipeline Service" 3008
check_health "Messaging Service" 3003
check_health "Automation Service" 3009
check_health "Analytics Service" 3010
check_health "Team Service" 3011
check_health "WebSocket Service" 3004
check_health "AI Service" 3005

echo ""
echo "=========================================="
echo "✅ Тестирование завершено"

