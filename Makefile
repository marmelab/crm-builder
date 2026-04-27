.DEFAULT_GOAL := help

.PHONY: help build up up-full down restart logs shell test test-smoke bench bench-update clean-sessions reset

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make <target>\n\nTargets:\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

build: ## Build the atomic-crm-dev Docker image
	docker build -t atomic-crm-dev .

up: ## Start the stack in demo mode (FakeRest, no Supabase)
	docker compose --profile demo up

up-full: ## Start the stack in full mode (Supabase, host network)
	docker compose --profile full up

down: ## Stop and remove containers (volumes preserved)
	docker compose --profile demo --profile full down

restart: down up ## Restart the demo stack

logs: ## Tail logs of the running stack
	docker compose logs -f

shell: ## Open a shell inside the running demo container
	docker exec -it atomic-crm-demo bash

test: ## Run chat-service unit tests
	cd chat-service && npm test

test-smoke: ## Run chat-service WebSocket smoke test
	cd chat-service && npm run test:smoke

bench: ## Replay tests/cases.json against ws://localhost:8080
	cd chat-service && npm run bench

bench-update: ## Rewrite the bench baseline with the current run
	cd chat-service && npm run bench:update

reset: ## Full reset: down + archive sessions + rebuild image + up (demo)
	$(MAKE) down
	$(MAKE) clean-sessions
	$(MAKE) build
	$(MAKE) up

clean-sessions: ## Archive ./sessions into ./old-sessions/<timestamp>/ (non-destructive)
	@if [ ! -d sessions ] || [ -z "$$(ls -A sessions 2>/dev/null)" ]; then \
		echo "sessions/ is empty — nothing to archive."; \
	else \
		ts="$$(date +%Y-%m-%dT%H-%M-%S)"; \
		mkdir -p "old-sessions/$$ts" && \
		find sessions -mindepth 1 -maxdepth 1 -exec mv -t "old-sessions/$$ts/" {} + && \
		echo "sessions/ → old-sessions/$$ts/"; \
	fi
