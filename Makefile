.DEFAULT_GOAL := help

.PHONY: help build build-instance up up-full up-instance down down-instance wipe restart restart-full logs shell claude test test-unit test-smoke bench bench-update clean-sessions reset \
        start demo full stop kill image log tail bash exec tests smoke clean archive reload

# Resolve the target container for claude/shell. Prefer INSTANCE=<name>;
# otherwise pick the single running atomic-crm[-*]. Errors if ambiguous.
define RESOLVE_CONTAINER
	if [ -n "$(INSTANCE)" ]; then \
		c=atomic-crm-$(INSTANCE); \
		if ! docker ps --filter "name=^$$c$$" --filter "status=running" -q | grep -q .; then \
			echo "Error: container $$c is not running."; \
			exit 1; \
		fi; \
	else \
		matches=$$(docker ps --filter "name=atomic-crm" --filter "status=running" --format "{{.Names}}"); \
		count=$$(printf "%s" "$$matches" | grep -c . || true); \
		if [ "$$count" -eq 0 ]; then \
			echo "Error: no atomic-crm container running. Run 'make up' first."; \
			exit 1; \
		elif [ "$$count" -gt 1 ]; then \
			echo "Error: multiple atomic-crm containers running, pass INSTANCE=<name>:"; \
			printf "%s\n" "$$matches" | sed 's/^/  /'; \
			exit 1; \
		fi; \
		c=$$matches; \
	fi
endef

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "Usage: make <target>\n\nTargets:\n"} /^[a-zA-Z_-]+:.*?##/ { printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

build: ## Build the atomic-crm-dev Docker image
	docker build -t atomic-crm-dev .

build-instance: ## Build a uniquely-tagged image for an instance: make build-instance INSTANCE=wt1
	@if [ -z "$(INSTANCE)" ]; then \
		echo "Usage: make build-instance INSTANCE=<name>"; \
		exit 1; \
	fi
	docker build -t atomic-crm-dev:$(INSTANCE) .

up: ## Start in demo mode (FakeRest, no Supabase)
	docker compose up

up-full: ## Start in full mode (Supabase)
	MODE=full docker compose up

up-instance: ## Start a named instance: make up-instance INSTANCE=feat-x CRM=5174 CHAT=8081 [IMAGE=<tag>]
	@if [ -z "$(INSTANCE)" ] || [ -z "$(CRM)" ] || [ -z "$(CHAT)" ]; then \
		echo "Usage: make up-instance INSTANCE=<name> CRM=<host-port> CHAT=<host-port> [IMAGE=<tag>]"; \
		exit 1; \
	fi
	INSTANCE=$(INSTANCE) PORT_CRM=$(CRM) PORT_CHAT=$(CHAT) \
	IMAGE=$(if $(IMAGE),$(IMAGE),atomic-crm-dev:$(INSTANCE)) \
	docker compose -p $(INSTANCE) \
	  -f docker-compose.yml -f docker-compose.multi.yml up

down: ## Stop container (graceful Supabase teardown if needed)
	./scripts/down.sh

down-instance: ## Stop a named instance: make down-instance INSTANCE=feat-x
	@if [ -z "$(INSTANCE)" ]; then \
		echo "Usage: make down-instance INSTANCE=<name>"; \
		exit 1; \
	fi
	docker compose -p $(INSTANCE) \
	  -f docker-compose.yml -f docker-compose.multi.yml down

wipe: ## Stop container AND remove all volumes (wipes crm checkout, deps, sessions)
	./scripts/down.sh -v

restart: down up ## Restart the demo stack

restart-full: down up-full ## Restart the full stack

logs: ## Tail logs of the running stack
	docker compose logs -f

shell: ## Open a shell inside the running container (pass INSTANCE=<name> to target a specific instance)
	@$(RESOLVE_CONTAINER); \
	docker exec -it $$c bash

claude: ## Open Claude inside the running container (pass INSTANCE=<name>; also triggers OAuth on first run)
	@$(RESOLVE_CONTAINER); \
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
