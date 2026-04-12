.PHONY: help dev dev-logs dev-down dev-clean obs obs-down obs-logs obs-clean k6-reset k6 k6-load k6-smoke k6-auth dev-v1 dev-v1-logs dev-v1-down dev-v1-clean build test lint typecheck test-services test-api test-events frontend-dev

help: ## Показать справку
	@echo "Доступные команды:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

dev: ## Запустить все сервисы в Docker (docker-compose.yml)
	docker compose -f docker-compose.yml up -d --build 

dev-logs: ## Показать логи всех сервисов (docker-compose.yml)
	docker compose -f docker-compose.yml logs -f

dev-down: ## Остановить все сервисы
	docker compose -f docker-compose.yml down

dev-clean: ## Остановить стек и удалить volumes
	docker compose -f docker-compose.yml down -v

# Observability stack (Prometheus, Grafana, Loki)
obs: ## Запустить приложение + observability (Prometheus, Grafana, Loki)
	docker compose -f docker-compose.yml -f docker-compose.observability.yml up -d --build 
# --scale core-api=3 --scale messaging-api=2 --scale gateway=2

obs-down: ## Остановить приложение + observability
	docker compose -f docker-compose.yml -f docker-compose.observability.yml down

obs-logs: ## Логи prometheus, grafana, loki (app + observability)
	docker compose -f docker-compose.yml -f docker-compose.observability.yml logs -f prometheus grafana loki

obs-clean: ## Остановить приложение + observability и удалить volumes
	docker compose -f docker-compose.yml -f docker-compose.observability.yml down -v

# Load testing (k6 via Docker — no local install needed)
K6_COMMON = docker run --rm -i --network getsale-crm_default \
	  --env-file .env \
	  -v "$(CURDIR)/load-tests:/scripts" \
	  -e BASE_URL=http://gateway:8000 \
	  -e AUTH_SERVICE_URL=http://auth-service:4001

k6-reset: ## Сбросить rate limit ключи перед нагрузочным тестом
	@echo "Flushing rate-limit keys in Redis..."
	@docker compose -f docker-compose.yml exec -T redis redis-cli EVAL "local c=0; for _,k in pairs(redis.call('KEYS','auth:*')) do redis.call('DEL',k); c=c+1 end; for _,k in pairs(redis.call('KEYS','rl:*')) do redis.call('DEL',k); c=c+1 end; return c" 0 || true

k6: k6-reset ## Запустить k6 smoke-тест (метрики → Prometheus → Grafana)
	$(K6_COMMON) \
	  -e K6_PROMETHEUS_RW_PUSH_INTERVAL=5s \
	  -e K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=true \
	  grafana/k6 run \
	  -o experimental-prometheus-rw \
	  -e K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write \
	  /scripts/mixed-load.js

k6-load: k6-reset ## Запустить k6 нагрузочный тест (high) с метриками в Grafana
	$(K6_COMMON) \
	  -e K6_PROMETHEUS_RW_PUSH_INTERVAL=5s \
	  -e K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=true \
	  grafana/k6 run \
	  -o experimental-prometheus-rw \
	  -e K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write \
	  -e LOAD_LEVEL=high \
	  /scripts/mixed-load.js

k6-smoke: k6-reset ## Запустить k6 быстрый smoke-тест (без Prometheus, консольный вывод)
	$(K6_COMMON) \
	  grafana/k6 run /scripts/mixed-load.js

k6-auth: k6-reset ## Запустить k6 тест auth-flow (метрики → Prometheus → Grafana)
	$(K6_COMMON) \
	  -e K6_PROMETHEUS_RW_PUSH_INTERVAL=5s \
	  -e K6_PROMETHEUS_RW_TREND_AS_NATIVE_HISTOGRAM=true \
	  grafana/k6 run \
	  -o experimental-prometheus-rw \
	  -e K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write \
	  /scripts/auth-flow.js

dev-v1: ## Запустить все сервисы v1 (legacy) в Docker
	docker-compose up -d

dev-v1-logs: ## Показать логи всех сервисов v1 (legacy)
	docker-compose logs -f

dev-v1-down: ## Остановить все сервисы v1 (legacy)
	docker-compose down

dev-v1-clean: ## Остановить v1 (legacy) и удалить volumes
	docker-compose down -v

build: ## Собрать все сервисы
	npm run build --workspaces

test: ## Запустить тесты
	npm run test --workspaces

lint: ## Проверить код линтером
	npm run lint --workspaces

typecheck: ## Проверить типы TypeScript
	npm run typecheck --workspaces

install: ## Установить зависимости
	npm install

test-services: ## Проверить health checks всех сервисов
	@bash scripts/test-services.sh

test-api: ## Протестировать базовые API endpoints
	@bash scripts/test-api.sh

test-events: ## Протестировать event-driven коммуникацию
	@bash scripts/test-events.sh

frontend-dev: ## Запустить фронтенд локально (без Docker)
	cd frontend && npm install && npm run dev

k8s-apply: ## Применить все Kubernetes манифесты
	kubectl apply -f k8s/

k8s-delete: ## Удалить все Kubernetes ресурсы
	kubectl delete -f k8s/

k8s-logs: ## Показать логи всех подов
	kubectl logs -f -l app -n getsale
