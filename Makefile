.DEFAULT_GOAL := help

.PHONY: help build up up-full down wipe restart logs shell claude test test-unit test-smoke bench bench-update clean-sessions reset \
        start demo full stop kill image log tail bash exec tests smoke clean archive reload

# Detect running container — used by claude/shell targets
RUNNING_CONTAINER = $$(docker ps --filter "name=atomic-crm-" --filter "status=running" --format "{{.Names}}" | head -1)

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

wipe: ## Stop and remove containers AND volumes (wipes atomic-crm checkout, deps, sessions)
	docker compose --profile demo --profile full down -v

restart: down up ## Restart the demo stack

logs: ## Tail logs of the running stack
	docker compose logs -f

shell: ## Open a shell inside the running container (demo or full)
	@c=$(RUNNING_CONTAINER); \
	if [ -z "$$c" ]; then \
		echo "Error: no atomic-crm container running. Run 'make up' first."; \
		exit 1; \
	fi; \
	docker exec -it $$c bash

claude: ## Open Claude inside the running container (also triggers OAuth on first run)
	@c=$(RUNNING_CONTAINER); \
	if [ -z "$$c" ]; then \
		echo "Error: no atomic-crm container running. Run 'make up' in another shell first."; \
		exit 1; \
	fi; \
	docker exec -it -u developer -e HOME=/home/developer -w /app $$c claude --dangerously-skip-permissions

test: ## Run all tests
	$(MAKE) test-unit test-smoke

test-unit: ## Run chat-service unit tests
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

# --- Aliases (synonyms) ---
start: up           ## Alias for `up`
demo: up            ## Alias for `up`
full: up-full       ## Alias for `up-full`
stop: down          ## Alias for `down`
kill: down          ## Alias for `down`
reload: restart     ## Alias for `restart`
image: build        ## Alias for `build`
log: logs           ## Alias for `logs`
tail: logs          ## Alias for `logs`
bash: shell         ## Alias for `shell`
exec: shell         ## Alias for `shell`
tests: test         ## Alias for `test`
smoke: test-smoke   ## Alias for `test-smoke`
clean: clean-sessions   ## Alias for `clean-sessions`
archive: clean-sessions ## Alias for `clean-sessions`
