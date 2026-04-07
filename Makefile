.PHONY: help dev dev-logs dev-down dev-clean dev-v1 dev-v1-logs dev-v1-down dev-v1-clean build test lint typecheck test-services test-api test-events frontend-dev

help: ## Показать справку
	@echo "Доступные команды:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

dev: ## Запустить все сервисы v2 в Docker
	docker compose -f docker-compose.v2.yml up -d

dev-logs: ## Показать логи всех сервисов v2
	docker compose -f docker-compose.v2.yml logs -f

dev-down: ## Остановить все сервисы v2
	docker compose -f docker-compose.v2.yml down

dev-clean: ## Остановить v2 и удалить volumes
	docker compose -f docker-compose.v2.yml down -v

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
	kubectl logs -f -l app -n getsale-v2
