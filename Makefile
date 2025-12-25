.PHONY: help dev dev-logs dev-down dev-clean build test lint typecheck test-services test-api test-events frontend-dev

help: ## Показать справку
	@echo "Доступные команды:"
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}'

dev: ## Запустить все сервисы в Docker
	docker-compose up -d

dev-logs: ## Показать логи всех сервисов
	docker-compose logs -f

dev-down: ## Остановить все сервисы
	docker-compose down

dev-clean: ## Остановить и удалить volumes
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
	kubectl logs -f -l app -n getsale-crm
