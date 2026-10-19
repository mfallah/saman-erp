# =============================================================================
# Saman ERP — operator/developer entry points
# Production: `make up-prod` == docker compose -f docker-compose.yml \
#             -f docker-compose.prod.yml --profile tls up -d --build
# Docs: docs/06-deployment/INSTALL-FA.md, docs/07-operations/RUNBOOK.md
# =============================================================================
SHELL := /bin/bash
.DEFAULT_GOAL := help

COMPOSE       ?= docker compose
BASE          := -f docker-compose.yml
DEV           := $(BASE) -f docker-compose.dev.yml
PROD          := $(BASE) -f docker-compose.prod.yml
TOOLS         := --profile tools
BACKUP        := --profile backup
TLS           := --profile tls

.PHONY: help secrets check-env validate validate-compose build pull up up-prod up-dev down ps logs \
        migrate seed backup-now restore-drill smoke wait shell-api shell-db \
        db-shell redis-shell minio-ls lint typecheck test ci clean cert-info

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

secrets: ## Generate .env with strong secrets (fails if .env exists; use --force manually)
	@./scripts/gen-secrets.sh

check-env: ## Fail if .env is missing or still contains CHANGE_ME placeholders
	@test -f .env || { echo "ERROR: .env missing — run 'make secrets'"; exit 1; }
	@if grep -n 'CHANGE_ME' .env; then \
		echo "ERROR: .env still contains CHANGE_ME placeholders (see docs/06-deployment/INSTALL-FA.md §6)"; exit 1; \
	else echo "OK: .env has no CHANGE_ME placeholders"; fi
	@test "$(stat -c %a .env 2>/dev/null || stat -f %Lp .env)" = "600" \
		&& echo "OK: .env mode 600" || echo "WARN: .env permissions are not 600 — run chmod 600 .env"

validate: ## Validate YAML/JSON + compose contract (install-free, no Docker needed)
	@python3 scripts/validate-config.py

validate-compose: ## Semantic compose validation (requires a Docker daemon; CI runs this in compose-config job)
	$(COMPOSE) config -q
	$(COMPOSE) $(PROD) config -q
	$(COMPOSE) $(DEV) config -q
	@echo "compose files are semantically valid"

build: ## Build all images
	$(COMPOSE) build

pull: ## Pull pinned base images
	$(COMPOSE) pull --ignore-buildable

up: ## Start the baseline stack (loopback web on 127.0.0.1:8080)
	$(COMPOSE) up -d --build
	@./scripts/wait-for-health.sh 300

up-prod: ## Start production stack with Caddy TLS + backup sidecar
	$(COMPOSE) $(PROD) $(TLS) $(BACKUP) up -d --build
	@./scripts/wait-for-health.sh 300

up-dev: ## Start local development stack (ports, hot reload)
	$(COMPOSE) $(DEV) up -d --build
	@./scripts/wait-for-health.sh 300

down: ## Stop containers (NEVER removes volumes)
	$(COMPOSE) down

ps: ## Show service status
	$(COMPOSE) ps

logs: ## Follow all logs
	$(COMPOSE) logs -f --tail=200

migrate: ## Run database migrations (explicit release step)
	$(COMPOSE) $(TOOLS) run --rm migrate

seed: ## Idempotent seed (roles/permissions/CoA; first admin only if users is empty)
	$(COMPOSE) $(TOOLS) run --rm migrate pnpm db:seed

backup-now: ## Take an immediate backup and list remote objects
	@./scripts/backup-now.sh

restore-drill: ## Restore a dump into a scratch container: make restore-drill ARGS="--dump <path> --yes"
	@./scripts/restore-drill.sh $(ARGS)

smoke: ## Post-deploy smoke test (default http://127.0.0.1:8080)
	@./scripts/smoke.sh

wait: ## Wait for all services to become healthy
	@./scripts/wait-for-health.sh 300

shell-api: ## Open a shell in the API container
	$(COMPOSE) run --rm --entrypoint sh api

shell-db: ## Open psql as the container admin
	$(COMPOSE) exec -T postgres psql -U "$${POSTGRES_USER:-saman}" -d "$${POSTGRES_DB:-saman}"

db-shell: shell-db ## Alias for shell-db

redis-shell: ## Open redis-cli (password from .env via container env)
	$(COMPOSE) exec -T redis sh -c 'redis-cli -a "$$REDIS_PASSWORD"'

minio-ls: ## List MinIO buckets/objects through the mc one-shot container
	$(COMPOSE) run --rm --entrypoint sh minio-init -c 'mc alias set local "$$S3_ENDPOINT" "$$MINIO_ROOT_USER" "$$MINIO_ROOT_PASSWORD" >/dev/null && mc ls --recursive "local/$${BACKUP_BUCKET:-saman-backups}/$${BACKUP_S3_PREFIX:-backups/postgres}"'

cert-info: ## Show TLS certificate expiry (Caddy profile)
	$(COMPOSE) $(TLS) exec -T caddy caddy list-certificates

lint: ## ESLint
	pnpm lint

typecheck: ## TypeScript typecheck
	pnpm typecheck

test: ## Unit tests
	pnpm test

ci: ## Local equivalent of the CI quality gate
	pnpm lint && pnpm typecheck && pnpm test && pnpm build

clean: ## Remove dangling images/build cache (never volumes)
	docker image prune -f
	docker builder prune -f
	@echo "Volumes are intentionally NOT pruned (data safety). See docs/07-operations/RUNBOOK.md §6."
